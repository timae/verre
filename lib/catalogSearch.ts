import { prisma } from '@/lib/prisma'

// ── catalogSearch: THE fuzzy matcher. There is exactly one. ────────────────
//
// 🔒 ONE MATCHER, THREE CALLERS. Add-time search (phase 2), review-queue
// suggestions (phase 3), and post-import rescans (phase 4) ALL run the queries
// in this file. That is a deliberate design constraint from the RFC
// (§ Add-a-wine flow), not an incidental convenience: PR #82 carried a TS
// re-implementation alongside the SQL one plus a CI gate to keep them in
// parity, and that debt is struck precisely because a second matcher WILL
// drift. If a caller needs different ranking or filtering, add a parameter
// here — never a second query somewhere else.
//
// 🔒 AND THE MATCH IS ONLY EVER A SUGGESTION. Nothing in this file may become a
// find-or-create hook. An entry is created DISTINCT; combining entries is a
// separate, deliberate, reversible merge (RFC, the invariant everything hangs
// on). These functions return candidates for a HUMAN to choose from — a caller
// that auto-selects the top hit and links to it has reintroduced exactly the
// auto-dedup model that got PR #82's schema rejected.

// ⚠️ HISTORICAL — the GIN `<%` filter this module used to run.
//
// Kept as a short note because its traps still apply to ANY similarity query
// added later (the review queue, a future containment search), and because the
// third one is the reason a threshold constant still exists below:
//
//  1. `word_similarity(...) >= x` is NEVER indexable — a function call is not
//     an indexable operator, in any operand order.
//  2. Operator and operand order must MATCH (`<%` takes the query on the left,
//     `%>` the column). Mismatched pairings seq-scan while returning correct
//     rows. The KNN ordering below has the SAME trap in a different spelling.
//  3. Those operators read a GUC defaulting to 0.6, not the tuned 0.3 — so an
//     unset threshold silently stops matching typos.
//
// Two measurement caveats, recorded because they mislead anyone re-running
// these plans: `LIMIT n` with NO `ORDER BY` lets the planner stop early and
// makes even a correct form look like it seq-scans; and a non-selective query
// (10%+ of the table matching) legitimately seq-scans on cost. Plan shape is
// only meaningful for a selective query measured with its real ORDER BY.

// The tuned similarity threshold, now applied as a POST-FILTER (see
// `withinThreshold`) rather than as a GUC.
export const WORD_SIMILARITY_THRESHOLD = 0.3

// ══════════════════════════════════════════════════════════════════════════
// 🔒 THE ONE DEFINITION OF THE INDEXED ORDERING — a GiST KNN distance order.
//
// ⚠️ THIS REPLACED A GIN `<%` FILTER, AND THE REASON IS SCALE, NOT STYLE.
//
// The GIN form was correct and DID use its index — but `<%` at threshold 0.3
// is not SELECTIVE: candidate counts scale 1:1 with the catalog. Measured on
// PG16, a "selective" multi-word producer name still admitted 25,691 rows
// (8.5% of a 300k catalog), and the cost was the heap RECHECK over those rows,
// not the index probe (22 ms of a 163 ms query). So latency grew linearly with
// the catalog, and under load it stopped being slow and became an outage: at
// 300k rows with 50 concurrent searches, 15 requests failed outright on pool
// timeouts; at 100 concurrent, 66 failed. Raising the pool did not help — it
// was CPU saturation, and each search additionally pinned a connection inside
// an interactive transaction for its whole duration (needed for `SET LOCAL`).
//
// A GiST KNN scan returns the nearest 20 rows straight from the index, so cost
// is bounded by the LIMIT rather than by the match count. Measured on the same
// 60k fixture, broad query "chateau": GIN ~22 ms, GiST KNN ~0.26 ms.
//
// ⚠️ OPERATOR AND OPERAND ORDER MUST MATCH — the operator alone is not the
// rule, and getting this wrong FAILS SILENTLY by returning correct rows from a
// full table scan.
//
// `<->>` and `<<->` are declared COMMUTATORS of each other (verified in
// pg_operator), so the planner rewrites one into the other. What must line up
// is which side the COLUMN is on:
//
//   column <->> query   → Index Scan   (this module's form)
//   query  <<-> column  → Index Scan   (the commutator; equally fine)
//   column <<-> query   → Seq Scan + Sort over the whole table
//   query  <->> column  → Seq Scan + Sort over the whole table
//
// Measured on a 60k fixture: the indexable pairings planned an Index Scan at
// ~4.9 ms; the mismatched ones seq-scanned 60,001 rows at ~116 ms. Only
// `<->`, `<->>` and `<->>>` appear in `gist_trgm_ops` as ordering operators —
// but that does NOT make `<<->` unusable, it makes `<<->` usable only with the
// query on the left. Exactly the same operand-order trap the GIN `<%`/`%>`
// pair had, which is why it is spelled out rather than assumed.
//
// 🔒 `<->>` IS EXACTLY `1 - word_similarity` — the identical metric the old
// query sorted on, verified numerically: 'chateu margux' vs 'Château Margaux'
// gives word_similarity 0.5294 and distance 0.4706. So ranking and typo
// tolerance are unchanged, and the 0.3 threshold is applied as a post-filter
// on the ≤20 returned rows (see `withinThreshold`) instead of as a WHERE
// clause — which also removes the `SET LOCAL` requirement, and with it the
// interactive transaction that was pinning a pool connection per search.
//
// `column` is a fixed identifier chosen by this module, never caller input;
// the query text is passed separately as a BOUND PARAMETER by the callers.
export function trgmOrderSql(column: string): string {
  return `${column} <->> catalog_fold_v1($1)`
}

// The score (0..1, higher is better) for a row, derived from the same distance
// so ranking and scoring cannot disagree.
export function trgmScoreSql(column: string): string {
  return `1 - (${trgmOrderSql(column)})`
}

// The same form as a template for tests that need the literal SQL text. Kept
// beside trgmOrderSql so the two cannot drift — the plan assertion in
// scripts/tests/catalog-addflow-integration.mjs § 1 EXPLAINs THIS, so changing
// the operator here changes what CI checks.
export function trgmOrderWith(queryLiteral: string, column: string): string {
  return trgmOrderSql(column).replace('$1', queryLiteral)
}

// 🔒 The threshold is now a POST-FILTER, applied to the ≤20 rows a KNN scan
// returned rather than to the whole catalog. KNN always returns the n nearest
// rows however far away they are, so without this a query matching nothing
// would still return its 20 least-bad rows — the "no bad matches" guarantee
// the `<%` threshold used to provide.
function withinThreshold<T extends { score: number }>(rows: T[]): T[] {
  return rows.filter(r => r.score >= WORD_SIMILARITY_THRESHOLD)
}

// Hard cap on rows returned to any caller. Suggestions are for a human to read;
// beyond ~20 the list is noise, and an unbounded LIMIT on a trigram scan over a
// large catalog is a cheap way to make search expensive.
const MAX_LIMIT = 20

// 🔒 `status` IS DELIBERATELY OPTIONAL, AND IS PRESENT ONLY FOR scope: 'review'.
//
// RFC ruling 3 (blind-session provisional discoverability — "the catalog stays
// open") is explicitly CONTINGENT on catalog records being visually
// indistinguishable by state to end users: no provisional badge, no "recently
// added", no adder identity. Exposing `status` on the ADD-TIME path breaks that
// contingency and reopens the ruling, because `provisional` is a strong
// recency/user-authored proxy — imported rows land `confirmed`, so a blind
// taster could filter candidate labels down to "entries minted recently",
// which is precisely the capability the ruling says is unavailable.
//
// The phase-3 review queue genuinely needs the field, so it is not removed —
// it is SCOPED. `stripAddTimeFields` below is what enforces that, and the
// add-time callers go through it.
export type ProducerMatch = {
  id: string
  name: string
  country: string | null
  region: string | null
  status?: string
  score: number
}

// `status` scoped exactly as on ProducerMatch above — see that note.
export type ProductMatch = {
  id: string
  name: string
  style: string | null
  region: string | null
  status?: string
  score: number
  producerId: string
  producerName: string
}

// 🔒 Statuses a live search may surface. `linked` (merge tombstone) and
// `rejected` (curator junk verdict) are excluded HERE, at the query, rather
// than filtered by callers — a caller that forgets would offer a tombstone as a
// link target and re-point new tasting data at a row that has already been
// merged away. `archived` is excluded from ADD-TIME suggestions but stays
// findable by the review queue (RFC § Lifecycle table: archived is
// "findable / excluded"), hence the parameter rather than a constant.
const ADD_TIME_STATUSES = ['provisional', 'confirmed'] as const
const REVIEW_STATUSES = ['provisional', 'confirmed', 'archived'] as const

export type MatchScope = 'add' | 'review'

function statusesFor(scope: MatchScope): readonly string[] {
  return scope === 'review' ? REVIEW_STATUSES : ADD_TIME_STATUSES
}

// 🔒 MERGE TOMBSTONES RESOLVE TO THEIR SURVIVOR — they are not simply hidden.
//
// The RFC's lifecycle table is explicit that `linked` "resolves to survivor" in
// both search and links, and that chains are KEPT rather than flattened (with
// A→B then B→C, flattening A to A→C would break single-update unmerge). Merely
// EXCLUDING linked rows, which is what the status filter does on its own, gets
// the "don't offer a tombstone" half right and the "resolve to the survivor"
// half wrong: searching a merged alias returned NOTHING instead of the entry it
// was merged into. That breaks the moment phase 3 starts merging — the same
// phase that permits public release.
//
// Reads resolve the chain transitively with a VISITED SET and a DEPTH CAP, so
// corrupt data (a cycle that slipped past the write-side guards) fails safely
// instead of looping forever. `links_to <> id` and the `(status='linked') =
// (links_to IS NOT NULL)` CHECKs make a self-link or a pointerless tombstone
// impossible, but a longer cycle is not structurally excluded, so the cap is
// real defence rather than decoration.
const MERGE_DEPTH_CAP = 10

async function resolveEffectiveIds(
  table: 'producers' | 'wine_products',
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!ids.length) return out
  let frontier = [...new Set(ids)]
  const seen = new Set(frontier)
  // Each round follows one hop for every id still pointing somewhere.
  const chain = new Map<string, string>()
  for (let depth = 0; depth < MERGE_DEPTH_CAP && frontier.length; depth++) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; links_to: string | null }[]>(
      `SELECT id, links_to FROM ${table} WHERE id = ANY($1)`,
      frontier,
    )
    const next: string[] = []
    for (const r of rows) {
      if (!r.links_to) continue
      chain.set(r.id, r.links_to)
      if (!seen.has(r.links_to)) { seen.add(r.links_to); next.push(r.links_to) }
    }
    frontier = next
  }
  // Walk each starting id to the end of its chain, bounded by the same cap.
  for (const id of ids) {
    let cur = id
    const walked = new Set([cur])
    for (let i = 0; i < MERGE_DEPTH_CAP; i++) {
      const nxt = chain.get(cur)
      if (!nxt || walked.has(nxt)) break
      walked.add(nxt)
      cur = nxt
    }
    out.set(id, cur)
  }
  return out
}

// 🔒 Drop lifecycle state from ADD-TIME results — the ruling-3 contingency
// (see the ProducerMatch note). Applied HERE, inside the search functions,
// rather than in the route: a strip that lived in one caller would leak the
// moment a second caller appeared, which is the same review finding that moved
// the `showProvenance` strip into `wineToWire`. `scope: 'review'` keeps the
// field for the phase-3 curator surfaces, which are staff-gated.
function stripAddTimeFields<T extends { status?: string }>(rows: T[], scope: MatchScope): T[] {
  if (scope === 'review') return rows
  for (const r of rows) delete r.status
  return rows
}

// Normalize the user's query the SAME way the stored column is normalized.
//
// 🔒 The stored side is a GENERATED column — catalog_fold_v1(name) — and it
// is the single normalization path precisely so display and fold cannot drift
// (prisma/CLAUDE.md). The QUERY side has no such guarantee: it is a string from
// a request body. So it is folded by the DATABASE too, via catalog_fold_v1($1)
// in the queries below, rather than by a TypeScript approximation of unaccent
// that would be a second normalization path — the very thing the generated
// column exists to prevent. Here we only trim and bound length.
//
// ⚠️ BOTH SIDES CHANGE TOGETHER. There are exactly TWO query-side operands —
// `trgmOrderSql` and `findProducerByExactName` — and both must name the same
// function version as the columns. A half-applied change is invisible: trigram
// search keeps working while exact lookup silently stops matching (that is
// what 20260725140000 shipped and 20260725220000 pins with a round-trip test).
function prepareQuery(raw: string): string | null {
  const q = raw.trim()
  if (!q) return null
  // A query shorter than 3 chars cannot produce a meaningful trigram match (a
  // trigram is 3 characters), and matching on 1–2 chars would return a large
  // arbitrary slice of the catalog. Reject rather than return junk.
  if (q.length < 3) return null
  return q.slice(0, 200)
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || !limit || limit < 1) return MAX_LIMIT
  return Math.min(limit, MAX_LIMIT)
}

// ── The searches ───────────────────────────────────────────────────────────
//
// 🔒 Each runs inside its own transaction, and that is NOT incidental: the
// threshold must be set with `SET LOCAL`, which only exists inside one. A bare
// `SET` would persist on the pooled connection and leak 0.3 into every later
// query that borrows it — verified above: SET LOCAL reverted to 0.6 at COMMIT.
// That leak is exactly why the moments-search migration inlined
// word_similarity() instead of using the operator; SET LOCAL is what buys the
// index back without reintroducing the hazard.
//
// `word_similarity()` in ORDER BY is correct and wanted: the OPERATOR does the
// indexed filtering, the FUNCTION scores the survivors. The function is only a
// trap in the WHERE clause.

export async function searchProducers(
  rawQuery: string,
  opts: { limit?: number; scope?: MatchScope } = {},
): Promise<ProducerMatch[]> {
  const q = prepareQuery(rawQuery)
  if (!q) return []
  const limit = clampLimit(opts.limit)
  const scope = opts.scope ?? 'add'
  const statuses = statusesFor(scope)
  // 🔒 `linked` is included in the MATCH set so a merged alias still matches,
  // then resolved to its survivor below — the RFC's "resolves to survivor", not
  // "is hidden". Excluding it at the query (which is what the status filter
  // alone did) made a merged alias unfindable by the name it was merged under.
  // `rejected` stays excluded: a junk verdict has left the catalog entirely and
  // has no survivor to resolve to.
  const matchStatuses = [...statuses, 'linked']
  // 🔒 NO TRANSACTION, deliberately. The old `<%` form needed one to hold
  // `SET LOCAL pg_trgm.word_similarity_threshold`; a KNN order reads no GUC, so
  // the search is a single autocommit statement. That is not a tidy-up — under
  // load the interactive transaction pinned a pool connection for the whole
  // query duration, which is half of why 50 concurrent searches produced pool
  // timeouts at 300k rows.
  //
  // ⚠️ `matchStatuses` is applied as a WHERE alongside a KNN ORDER BY, so the
  // index walks nearest-first and discards non-matching statuses as it goes.
  // Over-fetching guards against a run of excluded rows starving the result:
  // `linked`/`rejected` are a small minority, so 3x the limit is ample, and the
  // post-filter + resolution below trims back to `limit`.
  const rows = await prisma.$queryRawUnsafe<ProducerMatch[]>(
    `SELECT p.id, p.name, p.country, p.region, p.status,
            ${trgmScoreSql('p.name_folded')} AS score
       FROM producers p
      WHERE p.status = ANY($2)
      ORDER BY ${trgmOrderSql('p.name_folded')}
      LIMIT ${limit * 3}`,
    q,
    matchStatuses,
  )
  const near = withinThreshold(rows)
  const resolved = await resolveMatchesToSurvivors(near, statuses)
  return stripAddTimeFields(resolved.slice(0, limit), scope)
}

// Replace every tombstone hit with the row it was merged into, de-duplicating
// when an alias and its survivor both matched, and preserving the best score so
// ranking still reflects how well the QUERY matched (the alias may match far
// better than the survivor's own name — that is the entire point of surfacing
// it). A survivor that is itself not surfaceable (e.g. `rejected`, or
// `archived` on the add path) drops out rather than being offered.
async function resolveMatchesToSurvivors(
  rows: ProducerMatch[],
  surfaceable: readonly string[],
): Promise<ProducerMatch[]> {
  const tombstones = rows.filter(r => r.status === 'linked')
  if (!tombstones.length) return rows
  const effective = await resolveEffectiveIds('producers', tombstones.map(r => r.id))
  const targetIds = [...new Set([...effective.values()])]
  const survivors = await prisma.$queryRawUnsafe<ProducerMatch[]>(
    `SELECT id, name, country, region, status FROM producers WHERE id = ANY($1)`,
    targetIds,
  )
  const byId = new Map(survivors.map(s => [s.id, s]))
  const out = new Map<string, ProducerMatch>()
  for (const r of rows) {
    const resolved = r.status === 'linked' ? byId.get(effective.get(r.id)!) : r
    if (!resolved || !surfaceable.includes(resolved.status!)) continue
    const prev = out.get(resolved.id)
    // Keep the better score — the alias that matched the query is the reason
    // this row is here at all.
    if (!prev || r.score > prev.score) out.set(resolved.id, { ...resolved, score: r.score })
  }
  return [...out.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

// Products, joined to their LEAD producer.
//
// The lead join is INNER, not left: every product has exactly one lead by
// database invariant (the deferred trigger), so a product with no lead cannot
// exist — and if one somehow did, silently rendering it with a blank producer
// would be worse than omitting it. Collaborators are deliberately not joined
// here: a suggestion list needs the identifying producer, and fanning out
// collaborators would multiply rows per product.
//
// 🔒 `producerId` scopes the search when the user has already CHOSEN a producer
// (add-flow branch 3). That is not merely a filter for relevance — generic
// product names ("Réserve", "Brut") collide constantly across producers and
// must never merge across them (RFC § v1 data model), so an unscoped product
// search would surface candidates that are not legitimate matches at all.
export async function searchProducts(
  rawQuery: string,
  opts: { limit?: number; scope?: MatchScope; producerId?: string } = {},
): Promise<ProductMatch[]> {
  const q = prepareQuery(rawQuery)
  if (!q) return []
  const limit = clampLimit(opts.limit)
  const scope = opts.scope ?? 'add'
  const statuses = statusesFor(scope)
  // 🔒 SCOPE ON THE *EFFECTIVE* PRODUCER, NOT THE STORED ONE. After a producer
  // merge the products stay children of the loser (nothing re-parents — RFC
  // § Product × vintage merges compose), so filtering on the stored
  // `pp.producer_id` returns NOTHING for a caller holding the survivor's id,
  // and equally nothing for a caller holding the alias's. Both must resolve to
  // the same effective producer and see the same products.
  //
  // ⚠️ HOW THIS IS RESOLVED IS A PERFORMANCE DECISION, NOT A STYLE ONE. The
  // first version expressed it as a recursive CTE over the WHOLE producers
  // table, joined unconditionally — including on the unscoped path, where the
  // filter is not even used. Measured on PG16 with 60k producers / 60k
  // products: a SELECTIVE product search went from 0.16 ms to 60 ms (~385x),
  // with a Seq Scan over all 60,000 producers and 1,130 blocks of temp-disk
  // sort spill, to find ONE product. At several hundred thousand rows that is
  // the difference between a search box and a timeout.
  //
  // So: resolve ONLY the chosen producer's alias GROUP, in a small bounded
  // query, and hand the resulting id list to an otherwise-plain indexed query.
  // The unscoped path never touches producers at all beyond its display join.
  const producerId = opts.producerId
  // The alias group of the chosen producer: its effective survivor plus every
  // tombstone that resolves to that survivor. Bounded by the same depth cap and
  // served by `producers_links_to_idx` for the reverse walk — never a full scan.
  const groupIds = producerId ? await producerAliasGroup(producerId) : null
  if (groupIds && !groupIds.length) return []
  const rows = await (async () => {
    // The `wp.scope = 'shared'` predicate is 🔒 load-bearing: 'owned' is the
    // deferred ownership axis and must never surface in a public search.
    // Filtering in the query (not in a caller) means a future owned entry
    // cannot leak through a call site that forgot to exclude it.
    //
    // 🔒 `linked` products are MATCHED here and resolved to their survivor
    // below — same rule as producers. Excluding them made a merged product
    // alias unfindable by the name it was merged under.
    //
    // ⚠️ TWO DISTINCT SQL SHAPES, deliberately, rather than one query with a
    // nullable parameter: `($3 IS NULL OR …)` leaves the join and the filter in
    // the plan even when unused, which is half of how the CTE version became
    // slow. The scoped shape adds exactly one indexed `= ANY` predicate.
    //
    // Both shapes order by the KNN distance, so the index walks nearest-first
    // and the LIMIT bounds the work regardless of how many rows would match.
    // Measured at 300k: the SCOPED path was already flat at ~2 ms (it probes
    // product_producers_producer_id_idx for one producer's handful of
    // products), and stays so; the UNSCOPED path is the one this rescues —
    // broad "reserve" went from ~108 ms to sub-millisecond.
    const scopeFilter = groupIds ? `AND pp.producer_id = ANY($3)` : ''
    const sql =
      `SELECT wp.id, wp.name, wp.style, wp.region, wp.status, wp.links_to AS "linksTo",
              ${trgmScoreSql('wp.name_folded')} AS score,
              pr.id AS "producerId", pr.name AS "producerName"
         FROM wine_products wp
         JOIN product_producers pp
           ON pp.product_id = wp.id AND pp.role = 'lead'
         JOIN producers pr ON pr.id = pp.producer_id
        WHERE wp.status = ANY($2)
          AND wp.scope = 'shared'
          ${scopeFilter}
        ORDER BY ${trgmOrderSql('wp.name_folded')}
        LIMIT ${limit * 3}`
    const args: unknown[] = [q, [...statuses, 'linked']]
    if (groupIds) args.push(groupIds)
    return prisma.$queryRawUnsafe<(ProductMatch & { linksTo: string | null })[]>(sql, ...args)
  })()
  const near = withinThreshold(rows)
  const resolved = await resolveProductMatches(near, statuses)
  return stripAddTimeFields(resolved.slice(0, limit), scope)
}

// Resolve matched product tombstones to their survivor, and report the
// EFFECTIVE producer rather than the stored one.
//
// 🔒 Both halves matter and both were wrong before. A merged product alias
// returned nothing at all (the status filter excluded it); and a product whose
// lead producer had been merged reported the TOMBSTONE's id and name — so the
// UI would show a producer that no longer exists, and a caller acting on that
// id would link new tasting data to a row already merged away.
//
// ⚠️ Resolution works from the MATCHED CANDIDATE SET (at most `limit` rows),
// never from a catalog-wide scan — that distinction is what keeps this off the
// hot path. Two small `= ANY` lookups against primary keys.
async function resolveProductMatches(
  rows: (ProductMatch & { linksTo: string | null })[],
  surfaceable: readonly string[],
): Promise<ProductMatch[]> {
  if (!rows.length) return []

  // 1. Product tombstones → their survivors, fetched with the survivor's own
  //    lead producer (the tombstone's producer is not the survivor's).
  const tombstoneIds = rows.filter(r => r.status === 'linked').map(r => r.id)
  const toSurvivor = tombstoneIds.length
    ? await resolveEffectiveIds('wine_products', tombstoneIds)
    : new Map<string, string>()
  const survivorIds = [...new Set(toSurvivor.values())]
  const survivors = survivorIds.length
    ? await prisma.$queryRawUnsafe<(ProductMatch & { linksTo: string | null })[]>(
        `SELECT wp.id, wp.name, wp.style, wp.region, wp.status, wp.links_to AS "linksTo",
                pr.id AS "producerId", pr.name AS "producerName"
           FROM wine_products wp
           JOIN product_producers pp ON pp.product_id = wp.id AND pp.role = 'lead'
           JOIN producers pr ON pr.id = pp.producer_id
          WHERE wp.id = ANY($1) AND wp.scope = 'shared'`,
        survivorIds)
    : []
  const bySurvivor = new Map(survivors.map(s => [s.id, s]))

  // 2. Whatever rows SURVIVE step 1, resolve their producers through their own
  //    alias chains and fetch the effective names — one bounded lookup each.
  const kept = rows
    .map(r => ({ score: r.score, row: r.status === 'linked' ? bySurvivor.get(toSurvivor.get(r.id)!) : r }))
    .filter((x): x is { score: number; row: ProductMatch & { linksTo: string | null } } =>
      !!x.row && surfaceable.includes(x.row.status!))
  if (!kept.length) return []
  const effProducer = await resolveEffectiveIds('producers', kept.map(x => x.row.producerId))
  const names = await prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
    `SELECT id, name FROM producers WHERE id = ANY($1)`, [...new Set(effProducer.values())])
  const nameById = new Map(names.map(p => [p.id, p.name]))

  // 3. De-duplicate (an alias and its survivor can both match), keeping the
  //    better score — the alias that matched the query is why the row is here.
  const out = new Map<string, ProductMatch>()
  for (const { score, row } of kept) {
    const prev = out.get(row.id)
    if (prev && prev.score >= score) continue
    const effId = effProducer.get(row.producerId) ?? row.producerId
    const { linksTo: _drop, ...rest } = row
    out.set(row.id, { ...rest, score, producerId: effId, producerName: nameById.get(effId) ?? row.producerName })
  }
  return [...out.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

// The alias GROUP of one producer: its effective survivor plus every tombstone
// resolving to that survivor. Bounded and index-served — the reverse walk uses
// `producers_links_to_idx`, so this never scans the table.
//
// Returns every id a caller-supplied producerId is equivalent to, which is what
// makes "scoped by the alias" and "scoped by the survivor" return the same
// products.
async function producerAliasGroup(producerId: string): Promise<string[]> {
  const effective = (await resolveEffectiveIds('producers', [producerId])).get(producerId)
  if (!effective) return [producerId]
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `WITH RECURSIVE grp(id, depth) AS (
       SELECT id, 0 FROM producers WHERE id = $1
       UNION ALL
       SELECT p.id, g.depth + 1
         FROM producers p JOIN grp g ON p.links_to = g.id
        WHERE g.depth < ${MERGE_DEPTH_CAP}
     )
     SELECT DISTINCT id FROM grp`,
    effective,
  )
  const ids = rows.map(r => r.id)
  return ids.includes(producerId) ? ids : [...ids, producerId]
}

// Exact-match lookup on the folded name, for the EAN/exact paths and the
// phase-5 legacy backfill.
//
// 🔒 This is EQUALITY, not similarity, and the distinction is the whole reason
// it is a separate function. The legacy backfill is the SOLE exception to
// "links are never set by strings" (RFC § Legacy backfill) and it is
// exact-match-only — routing it through the fuzzy matcher would auto-link
// approximate matches, which is the auto-dedup failure the model forbids.
export async function findProducerByExactName(name: string): Promise<{ id: string; status: string }[]> {
  const n = name.trim()
  if (!n) return []
  return prisma.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status FROM producers
     WHERE name_folded = catalog_fold_v1(${n})
       AND status IN ('provisional', 'confirmed')
     ORDER BY id
  `
}
