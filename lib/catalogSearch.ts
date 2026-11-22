import { prisma } from '@/lib/prisma'
import { resolveEffectiveIds, MERGE_DEPTH_CAP } from '@/lib/catalogEntries'
import { isCatalogYear, yearMax, YEAR_MIN } from '@/lib/catalogWrite'

// ── catalogSearch: THE fuzzy matcher. There is exactly one. ────────────────
//
// 🔒 TWO QUERY FAMILIES since catalogue model change step 7b (one module, one
// fold, one place to change ranking):
//   • EVERY-WORD (add time, the people who pick a bottle): `searchBottles` (one
//     field: producer, wine, region and year in any order, one row per wine)
//     and `searchProducers` ("Add Wine to Catalogue"'s producer field, and the web's).
//     Every typed word must match, the last as a prefix, small typos count;
//     nothing fits → an empty list ("Add Wine to Catalogue"). Over Verre's own search docs
//     (migration 20261121180000_catalog_search), section "Every-word search"
//     below.
//   • SIMILARITY (trigram KNN, everything below until that section):
//     `similarProducers` (phase 3 / 4 duplicate finding, staff review scope),
//     `searchProducts` (a chosen producer's wines: the web's wine step and
//     "Add Wine to Catalogue"'s wine field), `browseProducts`, `findProducerByExactName`.
//
// ⚠️ REFINED 2026-07-26: ONE MODULE and one set of normalization/scoring
// semantics, but TWO QUERY SHAPES. The interactive callers below are KNN
// top-N — they rank and always return n candidates. Phase 4's post-import bulk
// duplicate detection needs "everything above a threshold", which top-N cannot
// express at any n. Sharing the fold + scoring here is what prevents drift;
// forcing one shape onto both would truncate bulk detection.
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

// 🔒 The threshold is now a POST-FILTER, applied to the rows a KNN scan
// returned (`limit * 3`, ≤60, plus any exact matches) rather than to the whole catalog. KNN always
// returns the n nearest rows however far away they are, so without this a query
// matching nothing would still return its least-bad rows — the "no bad matches" guarantee
// the `<%` threshold used to provide.
function withinThreshold<T extends { score: number }>(rows: T[]): T[] {
  return rows.filter(r => r.score >= WORD_SIMILARITY_THRESHOLD)
}

// 🔒 RE-RANK AMONG TIES, never in the ORDER BY. `<->>` scores every name that
// CONTAINS the query as a full match, so "Robert Weil" and "Robert Weil Junior"
// tie at distance 0 and their order was the index's. The ORDER BY must stay a
// bare distance (the index scan), so the rows it returned are sorted here: an
// exact folded match first, then the score, then two-way `similarity()` (the
// closer of two containing names). Measured on a copy of the real catalogue
// (rehearsal, model change step 1): the typed-out producer name came first in
// 149 of 150 flows instead of 138,
// at ~0.2 ms per search. The two columns are computed in an OUTER select over
// the limited rows (inside, a scoped search would evaluate them on every product
// of the producer before its sort), and never leave this module (`dropRankFields`).
function rankSql(column: string): string {
  return `${column} = catalog_fold_v1($1) AS exact, similarity(${column}, catalog_fold_v1($1)) AS sim`
}
type RankFields = { exact: boolean; sim: number }
function byRank(a: { name: string; score: number } & RankFields, b: { name: string; score: number } & RankFields): number {
  return Number(b.exact) - Number(a.exact) || b.score - a.score || b.sim - a.sim || a.name.localeCompare(b.name)
}
function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter(r => !seen.has(r.id) && !!seen.add(r.id))
}
function dropRankFields<T extends RankFields>(rows: T[]): Omit<T, keyof RankFields>[] {
  for (const r of rows) { delete (r as Partial<RankFields>).exact; delete (r as Partial<RankFields>).sim }
  return rows
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
  colour: string | null
  sparkling: boolean
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
// The chain walk itself (visited set + depth cap) is the ONE resolver in
// lib/catalogEntries.ts, shared with every other catalogue read.
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
// Each is a plain autocommit statement (the `SET LOCAL` transaction of the old
// `<%` form is gone, see `searchProducers`). The ORDER BY is the bare KNN
// distance (the index scan); the score, the threshold and the tie re-rank are
// computed on the rows it returned.

// The trigram KNN producer search (until step 7b the add-time one, named
// `searchProducers`): similarity, not every-word, so it ranks names that look
// alike, which duplicate finding needs (phase 3's review queue, phase 4's
// post-import rescans). No add-time caller since step 7b.
export async function similarProducers(
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
  //
  // 🔒 TWO ARMS, ONE STATEMENT. More than `limit * 3` names can tie at distance 0
  // (184 producers contain "tenuta", 1,885 "chateau"), and KNN returns ties in index order, so
  // the producer named exactly "Tenuta" was never offered (model change step 1:
  // 13 of 15,772 one-word names). The first arm fetches the exact folded matches
  // through the covering B-tree. ⚠️ Spelled as a RANGE (`>= f AND <= f`, equal
  // to `=` under the deterministic collation), because for `=` the planner
  // prices GiST below the B-tree as soon as part of the table is not
  // all-visible (an index-only estimate charges a whole heap page), and the
  // GiST `=` read 338–429 buffers where the B-tree reads 4. Duplicates of the
  // second arm are dropped by id below.
  const cols = `p.id, p.name, p.country, p.region, p.status, p.name_folded, ${trgmScoreSql('p.name_folded')} AS score`
  const rows = await prisma.$queryRawUnsafe<(ProducerMatch & RankFields)[]>(
    `SELECT x.id, x.name, x.country, x.region, x.status, x.score, ${rankSql('x.name_folded')}
       FROM ((SELECT ${cols} FROM producers p
               WHERE p.name_folded >= catalog_fold_v1($1) AND p.name_folded <= catalog_fold_v1($1)
                 AND p.status = ANY($2)
               LIMIT ${limit * 3})
             UNION ALL
             (SELECT ${cols} FROM producers p
               WHERE p.status = ANY($2)
               ORDER BY ${trgmOrderSql('p.name_folded')}
               LIMIT ${limit * 3})) x`,
    q,
    matchStatuses,
  )
  const near = withinThreshold(uniqueById(rows))
  const resolved = (await resolveMatchesToSurvivors(near, statuses)).sort(byRank)
  return stripAddTimeFields(dropRankFields(resolved.slice(0, limit)), scope)
}

// Replace every tombstone hit with the row it was merged into, de-duplicating
// when an alias and its survivor both matched, and preserving the best score so
// ranking still reflects how well the QUERY matched (the alias may match far
// better than the survivor's own name — that is the entire point of surfacing
// it). A survivor that is itself not surfaceable (e.g. `rejected`, or
// `archived` on the add path) drops out rather than being offered.
async function resolveMatchesToSurvivors(
  rows: (ProducerMatch & RankFields)[],
  surfaceable: readonly string[],
): Promise<(ProducerMatch & RankFields)[]> {
  const tombstones = rows.filter(r => r.status === 'linked')
  if (!tombstones.length) return rows
  const effective = await resolveEffectiveIds('producers', tombstones.map(r => r.id))
  const targetIds = [...new Set([...effective.values()])]
  const survivors = await prisma.$queryRawUnsafe<ProducerMatch[]>(
    `SELECT id, name, country, region, status FROM producers WHERE id = ANY($1)`,
    targetIds,
  )
  const byId = new Map(survivors.map(s => [s.id, s]))
  const out = new Map<string, ProducerMatch & RankFields>()
  for (const r of rows) {
    const resolved = r.status === 'linked' ? byId.get(effective.get(r.id)!) : r
    if (!resolved || !surfaceable.includes(resolved.status!)) continue
    const prev = out.get(resolved.id)
    // Keep the better-ranked match (the same order as the sort, so an exact
    // alias is not lost to its survivor's earlier index position) — the alias
    // that matched the query is the reason this row is here at all.
    const cand = { ...resolved, score: r.score, exact: r.exact, sim: r.sim }
    if (!prev || byRank(cand, prev) < 0) out.set(resolved.id, cand)
  }
  return [...out.values()]
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
    // 🔒 `pp.role = 'lead'` in BOTH joins below (here and the survivor re-read)
    // is why multi-producer is currently write-only: collaborator links exist in
    // the schema and the write path builds them, but nothing reads them back, so
    // a collaborator makes a product findable under no second name.
    //
    // ⚠️ Widening the role filter is a SHAPE change, not a predicate tweak.
    // `ProductMatch` carries ONE producer, and this join is what guarantees one
    // row per product. Admitting collaborators fans a product into N rows, so
    // the survivor re-read map (keyed by product id) would keep an arbitrary
    // one and the de-dup below would silently drop the rest. Decide the result
    // shape first — one row per product carrying a producer LIST, or one row
    // per link — then change the join.
    //
    // Note the alias machinery here is NOT the problem: `groupIds` filters
    // `pp.producer_id` regardless of role, and the `resolveEffectiveIds`
    // pass below resolves whatever `producerId` came back, role-agnostically.
    // The merge-resolution risk lives in any NEW collaborator read surface
    // built outside this function, which must resolve tombstones the same way
    // (producer merges are a continuous stream on the maintenance side). See
    // the model-change proposal § 8b → "Collaborator links must resolve too",
    // which also records the merge-proposal contract question this depends on.
    const scopeFilter = groupIds ? `AND pp.producer_id = ANY($3)` : ''
    const sql =
      `SELECT x.*, ${rankSql('x.name_folded')} FROM (
       SELECT wp.id, wp.name, wp.style, wp.colour, wp.sparkling, wp.region, wp.status, wp.links_to AS "linksTo",
              wp.name_folded, ${trgmScoreSql('wp.name_folded')} AS score,
              pr.id AS "producerId", pr.name AS "producerName", pr.status AS "producerStatus"
         FROM wine_products wp
         JOIN product_producers pp
           ON pp.product_id = wp.id AND pp.role = 'lead'
         JOIN producers pr ON pr.id = pp.producer_id
        WHERE wp.status = ANY($2)
          AND wp.scope = 'shared'
          ${scopeFilter}
        ORDER BY ${trgmOrderSql('wp.name_folded')}
        LIMIT ${limit * 3}) x`
    const args: unknown[] = [q, [...statuses, 'linked']]
    if (groupIds) args.push(groupIds)
    return prisma.$queryRawUnsafe<MatchedProduct[]>(sql, ...args)
  })()
  const near = withinThreshold(rows)
  const resolved = (await resolveProductMatches(near, statuses)).sort(byRank)
  return stripAddTimeFields(dropRankFields(resolved.slice(0, limit)), scope)
}

// The wines of ONE chosen producer, with no query or a query shorter than a
// trigram (review r1: such a name could not be found at all, which nudged a
// person to create a duplicate; r2: a 1–2 character query filters by PREFIX of
// the folded name, so a short name beyond the first page is still found).
// Alphabetical by the folded name, add-time statuses, shared scope, the
// producer's alias group like the scoped search; merges resolved the same way.
// Two statements; the second reads one producer's products (the
// product_producers producer index), so the prefix filter is cheap.
export async function browseProducts(producerId: string, opts: { limit?: number; prefix?: string } = {}): Promise<ProductMatch[]> {
  // One over the page size is allowed here (the answer's "is there more").
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? MAX_LIMIT)), MAX_LIMIT + 1)
  const statuses = statusesFor('add')
  const groupIds = await producerAliasGroup(producerId)
  if (!groupIds.length) return []
  const rows = await prisma.$queryRawUnsafe<MatchedProduct[]>(
    `SELECT wp.id, wp.name, wp.style, wp.colour, wp.sparkling, wp.region, wp.status, wp.links_to AS "linksTo",
            1::float AS score, false AS exact, 0::float AS sim,
            pr.id AS "producerId", pr.name AS "producerName", pr.status AS "producerStatus"
       FROM wine_products wp
       JOIN product_producers pp ON pp.product_id = wp.id AND pp.role = 'lead'
       JOIN producers pr ON pr.id = pp.producer_id
      WHERE wp.status = ANY($1) AND wp.scope = 'shared' AND pp.producer_id = ANY($2)
        AND starts_with(wp.name_folded, catalog_fold_v1($3))
      ORDER BY wp.name_folded, wp.id
      LIMIT ${limit}`,
    [...statuses, 'linked'], groupIds, (opts.prefix ?? '').trim().slice(0, 2))
  const resolved = (await resolveProductMatches(rows, statuses)).sort((a, b) => a.name.localeCompare(b.name))
  return stripAddTimeFields(dropRankFields(resolved), 'add')
}

type MatchedProduct = ProductMatch & RankFields & { status: string; linksTo: string | null; producerStatus: string }

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
//
// `mapProductMatches` resolves WITHOUT de-duplicating, carrying each matched
// row along (step 7b: the every-word ranking is computed on the MATCHED row,
// and the best alias wins the de-dup, plan r8 § 2); `resolveProductMatches` is
// the similarity searches' de-dup on `byRank`.
type MatchedCore = Omit<ProductMatch, 'score'> & { status: string; linksTo: string | null; producerStatus: string }
type MappedProduct<R> = { from: R; out: Omit<ProductMatch, 'score'> & { status: string }; viaTombstone: boolean }
async function mapProductMatches<R extends MatchedCore>(rows: R[], surfaceable: readonly string[], opts: { dropRejectedProducers?: boolean } = {}): Promise<MappedProduct<R>[]> {
  if (!rows.length) return []

  // 1. Product tombstones → their survivors, fetched with the survivor's own
  //    lead producer (the tombstone's producer is not the survivor's).
  const tombstoneIds = rows.filter(r => r.status === 'linked').map(r => r.id)
  const toSurvivor = tombstoneIds.length
    ? await resolveEffectiveIds('wine_products', tombstoneIds)
    : new Map<string, string>()
  const survivorIds = [...new Set(toSurvivor.values())]
  const survivors = survivorIds.length
    ? await prisma.$queryRawUnsafe<MatchedCore[]>(
        `SELECT wp.id, wp.name, wp.style, wp.colour, wp.sparkling, wp.region, wp.status, wp.links_to AS "linksTo",
                pr.id AS "producerId", pr.name AS "producerName", pr.status AS "producerStatus"
           FROM wine_products wp
           JOIN product_producers pp ON pp.product_id = wp.id AND pp.role = 'lead'
           JOIN producers pr ON pr.id = pp.producer_id
          WHERE wp.id = ANY($1) AND wp.scope = 'shared'`,
        survivorIds)
    : []
  const bySurvivor = new Map(survivors.map(s => [s.id, s]))

  // 2. Whatever rows SURVIVE step 1, resolve their producers through their own
  //    alias chains and fetch the effective names — one bounded lookup each.
  //    ⚠️ Only when one of those producers IS a tombstone: by the
  //    `(status = 'linked') = (links_to IS NOT NULL)` CHECK every other producer
  //    resolves to itself, and its name is the one the search already joined.
  //    Skipping is exact, and it took the scoped search from 5 statements to 2
  //    and the unscoped one from 3 to 1 (model change step 1, § 2c pins it).
  const kept = rows
    .map(r => ({ r, row: r.status === 'linked' ? bySurvivor.get(toSurvivor.get(r.id)!) : r }))
    .filter((x): x is { r: R; row: MatchedCore } => !!x.row && surfaceable.includes(x.row.status)
      && !(opts.dropRejectedProducers && x.row.producerStatus === 'rejected'))
  if (!kept.length) return []
  const merged = [...new Set(kept.filter(x => x.row.producerStatus === 'linked').map(x => x.row.producerId))]
  const effProducer = merged.length ? await resolveEffectiveIds('producers', merged) : new Map<string, string>()
  const nameById = new Map<string, string>()
  const rejected = new Set<string>()
  if (merged.length) {
    const names = await prisma.$queryRawUnsafe<{ id: string; name: string; status: string }[]>(
      `SELECT id, name, status FROM producers WHERE id = ANY($1)`, [...new Set(effProducer.values())])
    for (const n of names) { nameById.set(n.id, n.name); if (n.status === 'rejected') rejected.add(n.id) }
  }
  return kept.filter(({ row }) => !(opts.dropRejectedProducers && rejected.has(effProducer.get(row.producerId) ?? row.producerId))).map(({ r, row }) => {
    const effId = effProducer.get(row.producerId) ?? row.producerId
    return {
      from: r, viaTombstone: r.status === 'linked',
      out: {
        id: row.id, name: row.name, style: row.style, colour: row.colour, sparkling: row.sparkling, region: row.region,
        status: row.status, producerId: effId, producerName: nameById.get(effId) ?? row.producerName,
      },
    }
  })
}

// 3. De-duplicate (an alias and its survivor can both match), keeping the
//    better-ranked match (`byRank`, the caller's sort order) — the alias that
//    matched the query is why the row is here, and its rank fields come with it.
async function resolveProductMatches(
  rows: MatchedProduct[],
  surfaceable: readonly string[],
): Promise<(ProductMatch & RankFields)[]> {
  const out = new Map<string, ProductMatch & RankFields>()
  for (const { from: r, out: row } of await mapProductMatches(rows, surfaceable)) {
    const cand = { ...row, score: r.score, exact: r.exact, sim: r.sim }
    const prev = out.get(row.id)
    if (!prev || byRank(cand, prev) < 0) out.set(row.id, cand)
  }
  return [...out.values()]
}

// The alias GROUP of one producer: its effective survivor plus every tombstone
// resolving to that survivor. Bounded and index-served — the reverse walk uses
// `producers_links_to_idx`, so this never scans the table.
//
// Returns every id a caller-supplied producerId is equivalent to, which is what
// makes "scoped by the alias" and "scoped by the survivor" return the same
// products.
//
// ONE statement (it was two: the walk up through `resolveEffectiveIds`, then
// the walk down): `up` follows `links_to` from the chosen producer with the
// same depth cap and the same stop-on-a-revisit as `resolveEffectiveIds`, the
// deepest row is the survivor, `grp` walks down from it. Both walks start from
// ONE id and move by primary key / `producers_links_to_idx`: never the
// catalogue-wide CTE (lib/CLAUDE.md). An unknown id yields nothing, and the id
// itself is appended below, as before.
async function producerAliasGroup(producerId: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `WITH RECURSIVE up(id, links_to, depth, path) AS (
       SELECT id, links_to, 0, ARRAY[id::text] FROM producers WHERE id = $1
       UNION ALL
       SELECT p.id, p.links_to, u.depth + 1, u.path || p.id::text
         FROM producers p JOIN up u ON p.id = u.links_to
        WHERE u.depth < ${MERGE_DEPTH_CAP} AND p.id::text <> ALL(u.path)
     ),
     survivor AS (SELECT id FROM up ORDER BY depth DESC LIMIT 1),
     grp(id, depth) AS (
       SELECT id, 0 FROM survivor
       UNION ALL
       SELECT p.id, g.depth + 1
         FROM producers p JOIN grp g ON p.links_to = g.id
        WHERE g.depth < ${MERGE_DEPTH_CAP}
     )
     SELECT DISTINCT id FROM grp`,
    producerId,
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

// ══════════════════════════════════════════════════════════════════════════
// ── Every-word search (catalogue model change step 7b) ────────────────────
//
// Rulings (Simon, 2026-11-21; plan `.local/catalog-model-change/step7b-plan.md`
// r8): Postgres only; EVERY typed word must match, in the producer's name, the
// wine's name or its region, in any order; the start of a word (the last word)
// and small typos count; nothing fits → an empty list (the app then offers
// "Add Wine to Catalogue"). Filler words ("Weingut", "Domaine", …) are optional: present,
// the row ranks higher; absent, ignored. One row per wine, the typed year
// CARRIED (a wine that lacks it still shows; picking fills the year field).
//
// Over Verre's own search docs (migration 20261121180000_catalog_search):
// stored word arrays + two tsvectors per product (with and without region), one
// per producer, and a word list with a trigram GiST index for typo lookups.
// The read joins the catalogue LIVE for names, status, scope and lead, so a
// stale doc can at worst fail to find a renamed wine, never show a removed one.
//
// TWO statements per search (words, candidates), FOUR on an empty answer (the
// fallback below), plus merge resolution only when a matched row or its
// producer is a tombstone. Each is a round trip plus app CPU on a
// fractional-core instance, so don't add one casually (§ 2c and the bottle
// suite pin the counts).
//
// 🔒 AND STILL ONLY A SUGGESTION: these lists are for a human to pick from; a
// caller that auto-picks the top hit reintroduces auto-dedup (header).

export type SearchAnswer<T> = { results: T[]; more: boolean; tooLong: boolean }
// The producer search also says whether a listed producer carries EXACTLY the
// typed name (folded by the database, `catalog_fold_v1`: "Strass" = "Straß"),
// so the app offers "Add Producer" only when none does (Codex 2026-11-21: a
// fold in the app missed ß → ss, œ → oe and offered a duplicate).
export type ProducerAnswer = SearchAnswer<ProducerMatch> & { exact: boolean }
// `close`: no wine holds every typed word; these hold all but one (3 or more
// required words typed, ruled 2026-11-22).
export type BottleAnswer = SearchAnswer<BottleMatch> & { close: boolean }
// A wine, with the typed year when it is CARRIED: shown on the row and filled
// into the year field on a pick (null: no year typed, or the wine's own name
// holds that number, "Cuvée 2000").
export type BottleMatch = ProductMatch & { year: number | null }

// 🔒 THE filler list (ruling 8): query side only, in FOLDED form, each entry
// its own `catalog_fold_v1` and a single token of the tokeniser (pinned by
// scripts/tests/catalog-bottle-search.mts). Optional words: never required
// unless every typed word is one ("domaine" alone searches for it).
export const SEARCH_FILLERS: readonly string[] = [
  'agricola', 'azienda', 'bodega', 'bodegas', 'cantina', 'cantine', 'cave', 'caves', 'cellars', 'chateau',
  'domaine', 'domaines', 'estate', 'estates', 'maison', 'quinta', 'schloss', 'tenuta', 'vineyard', 'vineyards',
  'weinbau', 'weingut', 'weinhof', 'winery', 'wines',
]
const FILLER_SET = new Set(SEARCH_FILLERS)
// "nv" is a ranking boost on a bottle search, never required and never the NV
// choice (341 product names contain it, dev DB 2026-11-21).
const NV_WORD = 'nv'

// Caps. 🔒 A query over the word or character cap is REFUSED (`tooLong`, an
// empty list), never silently cut (Codex r1 / r2: dropping words broke "every
// word must match").
export const SEARCH_MAX_WORDS = 16
export const SEARCH_MAX_CHARS = 200
// Candidates per arm and in all: one over the 400 ranked, so "the server
// stopped early" is visible (`more`).
export const SEARCH_CANDIDATES = 400
const ARM_LIMIT = SEARCH_CANDIDATES + 1
// Typo lookups: the 30 nearest words by trigram KNN AMONG THOSE WITH THE SAME
// FIRST LETTER (a typo keeps it; `LIKE first || '%'` is an index condition of
// the trigram GiST, 8.7 → 1.0 ms a word with siglen 256, dev DB 2026-11-22;
// words hold only [[:alnum:]], so no LIKE wildcard can occur in one), for at
// most the first 3 unknown words (≥ 4 letters, not all digits); a further
// unknown word keeps only its literal alternative. Then OSA distance ≤ 1
// (4–7 letters) / ≤ 2 (8+), at most 6 per word.
const KNN_NEAREST = 30
const KNN_WORDS = 3
const TYPO_ALTERNATIVES = 6
// The empty-answer fallback (a typo that is itself some other doc's word, so
// no lookup ran): typo alternatives for at most 2 KNOWN words of ≥ 4 letters,
// not fillers or numbers, held by at most this many docs, rarest first (the
// word the person meant is the common one). Dev DB 2026-11-21: 50.
export const FALLBACK_NDOC = 50
const FALLBACK_WORDS = 2
// Ruled 2026-11-22 ("most confident first, then widen"): the same typo pass
// also runs when the first answer is SHORT (fewer than this many wines), its
// wines below the exact ones ("picher": La Picherie, then the Pichlers).
export const SHORT_LIST = 5
// Ruled 2026-11-22: when nothing holds every word and at least this many
// REQUIRED words were typed (fillers, the year and "nv" don't count), the wines
// holding all but one of them, flagged `close` ("pichler kellerberg magnum").
// Two words stay strict: "christoph pichler" still finds nothing.
export const CLOSE_MIN_WORDS = 3
const ADD_TIME_MATCH = [...ADD_TIME_STATUSES, 'linked']
// The vintage lookup's admissible statuses (lib/catalogEntries.ts LINKABLE):
// a wine "has" the typed year only when a pick could name that vintage.
const YEAR_LINKABLE = ['provisional', 'confirmed', 'archived']

type Near = { word: string; ndoc: number }
type Token = { i: number; w: string; ndoc: number | null; pre: boolean; near: Near[] }
type Alt = { word: string; typos: number; prefix: boolean }
type Group = { token: Token; alts: Alt[] }
type QueryPlan = { required: Group[]; optional: Group[]; year: number | null; typed: number; tokens: Token[]; close?: boolean }

const EMPTY = <T>(tooLong = false): SearchAnswer<T> => ({ results: [], more: false, tooLong })

// The query's words, each with what the word list knows (one statement). Per
// word: `ndoc` (held as a whole word), `pre` (some word starts with it, a
// byte-order range on the primary key: read for every word, since which one is
// the plan's LAST word is decided after the year and a one-letter word are
// taken off, review 2026-11-21), and, only for an UNKNOWN word (the last
// non-numeric word of ≥ 2 letters: no word starts with it; another: not a word),
// ≥ 4 letters, not all digits, among the first KNN_WORDS such words, its
// KNN_NEAREST nearest words that some LIVE doc holds (`ndoc > 0`, the rebuild's
// count: a word only rejected or owned entries hold is never a typo
// alternative) with their `ndoc` (`forced`: the fallback names the words
// instead). ⚠️ The KNN lateral's
// condition reads only the outer row, so the planner makes it a one-time filter
// and the index scan never executes for a known word (a plan-node pin).
// ⚠️ The exact lookup is spelled as a RANGE (`>= w AND <= w`, equal to `=` in
// byte order): for `=` the planner chose the trigram GiST (it serves `=` too)
// over the primary key, 1.3 ms a word instead of ~0.02 (dev DB 2026-11-21; the
// producers' exact arm has the same spelling for the same reason).
function wordsSql(forced: boolean): string {
  return `WITH t AS (
      SELECT x.w COLLATE "C" AS w, x.i::int AS i
        FROM unnest(public.catalog_search_words_v1(public.catalog_fold_v1($1))) WITH ORDINALITY AS x(w, i)
       WHERE x.i <= ${SEARCH_MAX_WORDS + 1}
    ), m AS (SELECT max(i) AS last FROM t WHERE w !~ '^[0-9]+$' AND length(w) >= 2),
    k AS (
      SELECT t.i, t.w, t.i IS NOT DISTINCT FROM m.last AS is_last, e.ndoc, p.hit IS NOT NULL AS pre
        FROM t CROSS JOIN m
        -- ⚠️ LIMIT 1: the range spelling (the GiST trap, below) is estimated as a
        -- range, 9,038 of 81k words, and times the 30-word lookups that put the
        -- statement past jit_above_cost (100,000): every search was JIT-compiled
        -- first, 215 ms for a 1.3 ms statement (dev DB, 2026-11-22). The word is
        -- the primary key: one row at most.
        LEFT JOIN LATERAL (SELECT ndoc FROM catalog_search_words WHERE word >= t.w AND word <= t.w LIMIT 1) e ON true
        LEFT JOIN LATERAL (SELECT true AS hit FROM catalog_search_words
                            WHERE word >= t.w AND word < (t.w || chr(1114111)) COLLATE "C" LIMIT 1) p ON true
    ), r AS (
      SELECT k.*, (CASE WHEN k.is_last THEN NOT k.pre ELSE k.ndoc IS NULL END) AND length(k.w) >= 4 AND k.w !~ '^[0-9]+$' AS unknown FROM k
    ), s AS (SELECT r.*, row_number() OVER (PARTITION BY r.unknown ORDER BY r.i) AS urank FROM r)
    SELECT s.i, s.w, s.ndoc, s.pre, n.word AS near, n.ndoc AS near_ndoc
      FROM s LEFT JOIN LATERAL (
        SELECT word, ndoc, word <-> s.w AS d FROM catalog_search_words
         WHERE ${forced ? 's.w = ANY($2::text[])' : `s.unknown AND s.urank <= ${KNN_WORDS}`} AND ndoc > 0
           AND word LIKE left(s.w, 1) || '%'
         ORDER BY word <-> s.w LIMIT ${KNN_NEAREST}) n ON true
     ORDER BY s.i, n.d`
}

async function readWords(q: string, forced: string[] | null): Promise<Token[]> {
  type Row = { i: number; w: string; ndoc: number | null; pre: boolean; near: string | null; near_ndoc: number | null }
  const rows = forced
    ? await prisma.$queryRawUnsafe<Row[]>(wordsSql(true), q, forced)
    : await prisma.$queryRawUnsafe<Row[]>(wordsSql(false), q)
  const out: Token[] = []
  for (const r of rows) {
    const near = r.near ? [{ word: r.near, ndoc: Number(r.near_ndoc ?? 0) }] : []
    const last = out[out.length - 1]
    if (last && last.i === r.i) { last.near.push(...near); continue }
    out.push({ i: r.i, w: r.w, ndoc: r.ndoc === null ? null : Number(r.ndoc), pre: !!r.pre, near })
  }
  return out
}

// Optimal string alignment distance (Damerau without repeated edits).
export function osaDistance(a: string, b: string): number {
  const A = [...a], B = [...b]
  const d = Array.from({ length: A.length + 1 }, (_, i) => [i, ...Array<number>(B.length).fill(0)])
  for (let j = 1; j <= B.length; j++) d[0][j] = j
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1))
    if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
  }
  return d[A.length][B.length]
}
const typoBudget = (w: string) => { const n = [...w].length; return n >= 8 ? 2 : n >= 4 ? 1 : 0 }
const isNumber = (w: string) => /^[0-9]+$/.test(w)

function typoAlternatives(t: Token): Alt[] {
  if (isNumber(t.w)) return []
  const max = typoBudget(t.w)
  const first = [...t.w][0]
  const out: Alt[] = []
  const ndoc = new Map<string, number>()
  for (const { word, ndoc: n } of t.near) {
    if (word === t.w || [...word][0] !== first) continue
    const d = osaDistance(t.w, word)
    if (d >= 1 && d <= max) { out.push({ word, typos: d, prefix: false }); ndoc.set(word, n) }
  }
  // Fewer typos first, then the word MORE docs hold (the person meant the
  // common word; and a handful of junk words minted next to "riesling" never
  // crowds it out of the six, security review 2026-11-21), then KNN order.
  return out.sort((a, b) => a.typos - b.typos || (ndoc.get(b.word) ?? 0) - (ndoc.get(a.word) ?? 0)).slice(0, TYPO_ALTERNATIVES)
}

// Turn the words into what must match and what only ranks (pure; units in the
// bottle suite). `bottles`: a typed year is detected and carried, "nv" is a
// boost; a producer search has neither.
function planQuery(tokens: Token[], bottles: boolean): QueryPlan | null {
  let toks = tokens
  let year: number | null = null
  if (bottles) {
    // The LAST word in the catalogue's year range is the year, unless nothing
    // else would be left to search for ("2019" alone stays a word).
    let yi = -1
    toks.forEach((t, j) => { if (/^[0-9]{4}$/.test(t.w) && isCatalogYear(Number(t.w))) yi = j })
    if (yi >= 0 && toks.some((t, j) => j !== yi && [...t.w].length >= 2)) { year = Number(toks[yi].w); toks = toks.filter((_, j) => j !== yi) }
  }
  // A one-letter last word is ignored while other words exist (it matches
  // half the catalogue as a prefix).
  if (toks.length > 1 && [...toks[toks.length - 1].w].length < 2) toks = toks.slice(0, -1)
  if (!toks.length) return null
  const lastI = toks.length - 1
  // The word still being typed = the last NON-NUMERIC word of ≥ 2 letters,
  // the same definition as the words statement's `is_last` (re-review
  // 2026-11-21: with the plan's own last token, "pichler kell 20" made "kell"
  // an exact word, and "rieslin 12" lost its prefix). A trailing number is a
  // whole word unless it is the final token (a prefix then, below), and a
  // half-typed year is optional.
  let prefixI = -1
  toks.forEach((t, j) => { if (!isNumber(t.w) && [...t.w].length >= 2) prefixI = j })
  const required: Group[] = [], optional: Group[] = [], fillers: Group[] = []
  // A half-typed year as the last word ("…20", "…201"): optional while it is
  // typed (review 2026-11-21: as a required prefix it emptied the list on every
  // pause before the year was complete).
  const halfYear = (t: Token) => bottles && /^[0-9]{2,3}$/.test(t.w)
    && Array.from({ length: yearMax() - YEAR_MIN + 1 }, (_, k) => String(YEAR_MIN + k)).some(y => y.startsWith(t.w))
  toks.forEach((t, j) => {
    const isLast = j === prefixI
    const typos = typoAlternatives(t)
    const literalKnown = isLast ? t.pre || t.ndoc !== null : t.ndoc !== null
    // 🔒 The typed word is ALWAYS its own first alternative (exact, or a prefix
    // for the last word), whether or not the word list holds it: the list only
    // decides whether a typo lookup runs, never whether a wine is found.
    // A number typed LAST is a prefix too ("bin 38" on the way to "bin 389";
    // re-review round 2): numbers take no typo lookup, so the words
    // statement's classification is unaffected.
    const g: Group = { token: t, alts: [{ word: t.w, typos: 0, prefix: isLast || (j === lastI && isNumber(t.w)) }, ...typos] }
    // Filler: the word itself, a half-typed last word (≥ 3 letters) of one, or
    // an unknown word whose typo alternatives hold one ("weingutt"): decided
    // AFTER typo resolution.
    const filler = FILLER_SET.has(t.w)
      || (isLast && [...t.w].length >= 3 && SEARCH_FILLERS.some(f => f.startsWith(t.w)))
      || (!literalKnown && typos.some(a => FILLER_SET.has(a.word)))
    if (filler) { optional.push(g); fillers.push(g) }
    else if ((bottles && t.w === NV_WORD) || (j === lastI && toks.length > 1 && halfYear(t))) optional.push(g)
    else required.push(g)
  })
  // Only fillers typed: they are what is searched for, and "nv" or a half-typed
  // year stay boosts (Codex 2026-11-21: "chateau 20" made the 20 required). With
  // nothing but hints, the hints are searched.
  if (!required.length) {
    const promote = fillers.length ? fillers : [...optional]
    for (const g of promote) optional.splice(optional.indexOf(g), 1)
    required.push(...promote)
  }
  return { required, optional, year, typed: toks.length + (year === null ? 0 : 1), tokens: toks }
}

const lexeme = (w: string) => `'${w.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
const tsq = (groups: Group[]) => groups.map(g => '(' + g.alts.map(a => lexeme(a.word) + (a.prefix ? ':*' : '')).join(' | ') + ')').join(' & ')
// All but one of the groups: one AND per left-out group, OR'ed (16 groups at
// most: 16 terms of 15).
const tsqAllButOne = (groups: Group[]) => groups.map((_, skip) => '(' + tsq(groups.filter((_, j) => j !== skip)) + ')').join(' | ')

// Per row: how well the MATCHED row's own words answer the query. The order of
// the key is the ranking cascade (never one blended score).
type Fit = { key: number[]; exact: number; yearInName: boolean }
function fitRow(plan: QueryPlan, producer: string[], survivor: string[], name: string[], region: string[], hasYear: boolean): Fit {
  const named = new Set([...producer, ...survivor, ...name])
  const all = [...named, ...region.filter(w => !named.has(w))]
  let typos = 0, alt = 0, full = 0, inName = 0, boosts = 0, exact = 0
  const used = new Set<string>()
  for (const g of plan.required) {
    // Every word of the row this typed word matches, at its fewest typos; a
    // full word and a match in the name count INDEPENDENTLY (review 2026-11-21:
    // picking one match first let "wachauer" in the name hide a full "wachau"
    // in the region).
    // The alternatives are in confidence order (the literal, then fewer typos,
    // then the word more docs hold: `typoAlternatives`): at equal typos the row
    // holding the MORE COMMON correction ranks first (ruled 2026-11-22, "most
    // confident first": "picher" → the Pichlers, 105 docs, before Pircher, 6).
    let least = Infinity, bestAlt = Infinity
    const hits: { full: boolean; word: string; named: boolean }[] = []
    g.alts.forEach((a, ai) => { for (const w of all) {
      if (!(a.prefix ? w.startsWith(a.word) : w === a.word)) continue
      if (a.typos < least) { least = a.typos; hits.length = 0; bestAlt = ai }
      if (a.typos === least) { hits.push({ full: w === a.word, word: w, named: named.has(w) }); bestAlt = Math.min(bestAlt, ai) }
    } })
    if (!hits.length) { typos += 9; continue }
    typos += least
    alt += bestAlt
    if (hits.some(h => h.full)) full++
    if (hits.some(h => h.named)) inName++
    if (least === 0 && hits.some(h => h.full)) exact++
    const rep = hits.find(h => h.named && h.full) ?? hits.find(h => h.named) ?? hits.find(h => h.full) ?? hits[0]
    used.add(rep.word)
  }
  for (const g of plan.optional) {
    const hit = [...named].find(w => g.alts.some(a => (a.prefix ? w.startsWith(a.word) : w === a.word)))
    if (!hit) continue
    boosts++
    used.add(hit)
    if (hit === g.token.w) exact++
  }
  const yearInName = plan.year !== null && named.has(String(plan.year))
  if (yearInName) { full++; used.add(String(plan.year)) }
  const yearOk = plan.year === null || yearInName || hasYear
  if (plan.year !== null && yearOk) exact++
  const untyped = (ws: string[]) => new Set(ws.filter(w => !used.has(w) && !FILLER_SET.has(w))).size
  const untypedP = survivor.length ? Math.min(untyped(producer), untyped(survivor)) : untyped(producer)
  const untypedPN = survivor.length ? Math.min(untyped([...producer, ...name]), untyped([...survivor, ...name])) : untyped([...producer, ...name])
  return { key: [typos, alt, -full, -inName, yearOk ? 0 : 1, -boosts, untypedP, untypedPN], exact, yearInName }
}
function byKey(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
// 🔒 `score` = the share of typed words the row holds exactly (1 = all; the
// year counts when the row carries it or names it). Pinned.
const shareOf = (exact: number, plan: QueryPlan) => Math.round((exact / plan.typed) * 1000) / 1000

// The fallback's words: at most FALLBACK_WORDS known, rare, non-filler,
// non-numeric required words of ≥ 4 letters, rarest first; plus the LAST word
// when it matched only as a prefix of some word (a stale `kelerberg…` in the
// list must not block the correction of "kelerberg").
function fallbackWords(plan: QueryPlan): string[] {
  const rare = plan.required.map(g => g.token)
    .filter(t => t.ndoc !== null && t.ndoc <= FALLBACK_NDOC && [...t.w].length >= 4 && !isNumber(t.w) && !FILLER_SET.has(t.w))
    .sort((a, b) => a.ndoc! - b.ndoc!).slice(0, FALLBACK_WORDS).map(t => t.w)
  const last = [...plan.tokens].reverse().find(t => !isNumber(t.w) && [...t.w].length >= 2)
  if (last && last.ndoc === null && last.pre && [...last.w].length >= 4) rare.push(last.w)
  return [...new Set(rare)]
}
function withForcedNear(plan: QueryPlan, forced: Token[], words: string[], bottles: boolean): QueryPlan | null {
  const near = new Map(forced.filter(t => words.includes(t.w)).map(t => [t.i, t.near]))
  return planQuery(plan.tokens.map(t => (near.has(t.i) ? { ...t, near: near.get(t.i)! } : t)).concat(
    // planQuery re-detects the year from the words it is given: put it back.
    plan.year === null ? [] : [{ i: 1e9, w: String(plan.year), ndoc: null, pre: false, near: [] }]), bottles)
}

function prepareEveryWord(raw: string): { q: string } | { refuse: SearchAnswer<never> } | null {
  const q = raw.trim()
  if ([...q].length < 3) return null
  if ([...q].length > SEARCH_MAX_CHARS) return { refuse: EMPTY(true) }
  return { q }
}

type BottleRow = MatchedCore & { arm: number; ny: number; na: number; nb: number; nc: number; words: string; has_year: boolean }

// ⚠️ The word arrays travel as ONE text column (`wordsColumn`), split here:
// decoding four text[] columns for 401 rows cost the app 4.78 ms of CPU per
// search, one text column 1.33 ms, a cap of 201 rows with the arrays 1.90 ms
// (sandbox, in-process, "riesling", 2026-11-21; on a 1/8-core container a
// 401-row search cost 9.6 ms of CPU against 4.2 for a selective one). So the
// cap stays 400 (ranking quality) and the encoding changed. Words hold only
// [[:alnum:]] (the tokeniser), so a space and U+001F never occur inside one.
const WORDS_SEP = '\u001f'
const wordsColumn = (...arrays: string[]) => `concat_ws(chr(31), ${arrays.map(a => `array_to_string(${a}, ' ')`).join(', ')})`
const splitWords = (col: string): string[][] => col.split(WORDS_SEP).map(f => (f ? f.split(' ') : []))

// THE candidates statement, TIERED (review r2 P1: region and optional fillers
// widen the set, "margaux" 345 docs by name / 439 with region, "mosel" 29 /
// 3,781, dev DB; an arbitrary 400 could cut Château Margaux's own wines), each
// arm LIMIT 401, in this order: (y) the required words AND the typed year as a
// WORD on tsv_name (the wine NAMED 2000; only when a year was typed, fillers
// out); (a) every typed word incl. fillers on tsv_name (only when one was
// typed); (b) the required words on tsv_name; (c) the required words on tsv
// (region too), skipped when (b) already holds 401 non-tombstone rows.
// 🔒 Live eligibility INSIDE every arm, before its LIMIT (Codex r1 P1: limiting
// doc ids first let rejected / archived / owned / stale docs fill every slot):
// add-time statuses + `linked` (resolved after), shared scope, a lead. De-duped
// in arm order, ONE outer LIMIT 401. `more` = any arm or the outer cap hit its
// limit: the server stopped early (tombstones included), never "there are more
// live results".
function bottleCandidatesSql(plan: QueryPlan): { sql: string; args: unknown[] } {
  // `close`: the required words become "all but one" in every arm.
  const req = plan.close ? `(${tsqAllButOne(plan.required)})` : tsq(plan.required)
  const args: unknown[] = [req, ADD_TIME_MATCH, plan.year, YEAR_LINKABLE]
  // 🔒 A product whose lead producer is REJECTED (a junk verdict) is never
  // offered, nor found by that producer's name (security review 2026-11-21:
  // the one field made a rejected producer's name searchable through its
  // products). An archived producer's wines stay findable (real wines of a
  // closed house); a tombstone lead's survivor is checked after resolution.
  const arm = (name: string, n: number, col: string, param: string) => `${name} AS (
      SELECT d.product_id, ${n} AS arm, wp.status = 'linked' AS linked FROM catalog_search_docs d
        JOIN wine_products wp ON wp.id = d.product_id AND wp.status = ANY($2) AND wp.scope = 'shared'
        JOIN product_producers pp ON pp.product_id = wp.id AND pp.role = 'lead'
        JOIN producers lp ON lp.id = pp.producer_id AND lp.status <> 'rejected'
       WHERE d.${col} @@ ${param}::tsquery LIMIT ${ARM_LIMIT})`
  const ctes: string[] = [], arms: string[] = []
  if (plan.year !== null) {
    args.push(`${req} & ${lexeme(String(plan.year))}`)
    ctes.push(arm('y', 0, 'tsv_name', `$${args.length}`)); arms.push('y')
  }
  if (plan.optional.length) {
    args.push(`${req} & ${tsq(plan.optional)}`)
    ctes.push(arm('a', 1, 'tsv_name', `$${args.length}`)); arms.push('a')
  }
  ctes.push(arm('b', 2, 'tsv_name', '$1')); arms.push('b')
  ctes.push(`c AS (
      SELECT d.product_id, 3 AS arm, wp.status = 'linked' AS linked FROM catalog_search_docs d
        JOIN wine_products wp ON wp.id = d.product_id AND wp.status = ANY($2) AND wp.scope = 'shared'
        JOIN product_producers pp ON pp.product_id = wp.id AND pp.role = 'lead'
        JOIN producers lp ON lp.id = pp.producer_id AND lp.status <> 'rejected'
       WHERE (SELECT count(*) FROM b WHERE NOT b.linked) < ${ARM_LIMIT} AND d.tsv @@ $1::tsquery LIMIT ${ARM_LIMIT})`)
  arms.push('c')
  const count = (n: string) => (arms.includes(n) ? `(SELECT count(*) FROM ${n})::int` : '0')
  const sql = `WITH ${ctes.join(',\n    ')},
    u AS (SELECT DISTINCT ON (product_id) product_id, arm FROM (${arms.map(a => `SELECT product_id, arm FROM ${a}`).join(' UNION ALL ')}) x ORDER BY product_id, arm),
    top AS (SELECT product_id, arm FROM u ORDER BY arm LIMIT ${ARM_LIMIT})
    SELECT top.arm, ${count('y')} AS ny, ${count('a')} AS na, ${count('b')} AS nb, ${count('c')} AS nc,
           wp.id, wp.name, wp.style, wp.colour, wp.sparkling, wp.region, wp.status, wp.links_to AS "linksTo",
           pr.id AS "producerId", pr.name AS "producerName", pr.status AS "producerStatus",
           ${wordsColumn('d.producer_words', 'd.survivor_words', 'd.name_words', 'd.region_words')} AS words,
           ($3::int IS NOT NULL AND EXISTS (SELECT 1 FROM wine_vintages v WHERE v.product_id = wp.id AND v.year = $3::int AND v.status = ANY($4))) AS has_year
      FROM top
      JOIN catalog_search_docs d ON d.product_id = top.product_id
      JOIN wine_products wp ON wp.id = top.product_id
      JOIN product_producers pp ON pp.product_id = wp.id AND pp.role = 'lead'
      JOIN producers pr ON pr.id = pp.producer_id`
  return { sql, args }
}

async function bottlePass(plan: QueryPlan, limit: number): Promise<{ results: BottleMatch[]; more: boolean; raw: number }> {
  const { sql, args } = bottleCandidatesSql(plan)
  const rows = await prisma.$queryRawUnsafe<BottleRow[]>(sql, ...args)
  const more = rows.length >= ARM_LIMIT || rows.some(r => r.ny >= ARM_LIMIT || r.na >= ARM_LIMIT || r.nb >= ARM_LIMIT || r.nc >= ARM_LIMIT)
  if (!rows.length) return { results: [], more, raw: 0 }
  const words = new Map(rows.map(r => [r.id, splitWords(r.words)]))
  const fitOf = (r: BottleRow, hasYear: boolean) => { const [p, sv, n, rg] = words.get(r.id)!; return fitRow(plan, p, sv, n, rg, hasYear) }
  const fits = new Map(rows.map(r => [r.id, fitOf(r, r.has_year)]))
  const mapped = await mapProductMatches(rows, ADD_TIME_STATUSES, { dropRejectedProducers: true })
  // `has_year` is read on the RESOLVED product (plan r8 § 2): a tombstone's
  // survivor answers for itself, one statement and only when one matched.
  const viaTomb = plan.year === null ? [] : [...new Set(mapped.filter(m => m.viaTombstone).map(m => m.out.id))]
  const survivorYears = viaTomb.length
    ? new Set((await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT DISTINCT product_id AS id FROM wine_vintages WHERE product_id = ANY($1) AND year = $2::int AND status = ANY($3)`,
        viaTomb, plan.year, YEAR_LINKABLE)).map(r => r.id))
    : null
  const best = new Map<string, { out: BottleMatch; key: number[] }>()
  for (const m of mapped) {
    const r = m.from
    const fit = m.viaTombstone && survivorYears
      ? fitOf(r, survivorYears.has(m.out.id))
      : fits.get(r.id)!
    // `status` stays in the module (ruling 3: add-time results carry none).
    const { id, name, style, colour, sparkling, region, producerId, producerName } = m.out
    const out: BottleMatch = { id, name, style, colour, sparkling, region, producerId, producerName, score: shareOf(fit.exact, plan), year: plan.year !== null && !fit.yearInName ? plan.year : null }
    const prev = best.get(out.id)
    // The best alias wins the de-dup, its key and its year decision with it.
    if (!prev || byKey(fit.key, prev.key) < 0) best.set(out.id, { out, key: fit.key })
  }
  const ranked = [...best.values()].sort((a, b) => byKey(a.key, b.key)
    || a.out.producerName.localeCompare(b.out.producerName) || a.out.name.localeCompare(b.out.name) || (a.out.id < b.out.id ? -1 : 1))
  // `more` also when the ranked list is longer than what is sent (review
  // 2026-11-21): the person sees 20 of 150 and is told to type more.
  return { results: ranked.slice(0, limit).map(x => x.out), more: more || ranked.length > limit, raw: rows.length }
}

// One field: producer, wine name, region and year, any order (the app's bottle
// picker; ruling 7: the web keeps producer → wine → year). Scrubbed input.
export async function searchBottles(raw: string, opts: { limit?: number } = {}): Promise<BottleAnswer> {
  const prep = prepareEveryWord(raw)
  if (!prep) return { ...EMPTY<BottleMatch>(), close: false }
  if ('refuse' in prep) return { ...prep.refuse, close: false }
  const limit = clampLimit(opts.limit)
  const tokens = await readWords(prep.q, null)
  if (tokens.length > SEARCH_MAX_WORDS) return { ...EMPTY<BottleMatch>(true), close: false }
  const plan = planQuery(tokens, true)
  if (!plan) return { ...EMPTY<BottleMatch>(), close: false }
  const answer = (p: { results: BottleMatch[]; more: boolean }, close = false): BottleAnswer => ({ results: p.results, more: p.more, tooLong: false, close })
  const first = await bottlePass(plan, limit)
  if (first.results.length >= SHORT_LIST) return answer(first)
  // 🔒 THE TYPO PASS for a word that is itself some other doc's word (no
  // lookup ran for it): on an EMPTY answer (counted after merge resolution,
  // Codex r4 P2: an exact-word tombstone with an archived survivor is a raw
  // candidate that resolution drops), and on a SHORT one (ruled 2026-11-22).
  // Every word keeps its own spelling as an alternative, so the widened list
  // holds the first one, and a wine found only through a fixed typo ranks after
  // them (fewer typos first).
  const words = fallbackWords(plan)
  const forced = words.length ? withForcedNear(plan, await readWords(prep.q, words), words, true) : null
  const widened = forced ? await bottlePass(forced, limit) : null
  if (widened && widened.results.length > first.results.length) return answer(widened)
  if (first.results.length) return answer(first)
  // 🔒 CLOSE MATCHES (ruled 2026-11-22): nothing holds every word and 3 or
  // more required words were typed → the wines holding all but one, flagged.
  const base = forced ?? plan
  // Only real words count (a search of nothing but fillers promotes them).
  if (base.required.filter(g => !FILLER_SET.has(g.token.w)).length < CLOSE_MIN_WORDS) return answer(widened ?? first)
  const close = await bottlePass({ ...base, close: true }, limit)
  return close.results.length ? answer(close, true) : answer(widened ?? first)
}

type ProducerRow = { arm: number; nx: number; na: number; nb: number; id: string; name: string; country: string | null; region: string | null; status: string; words: string }

// The same rules over producer docs ("Add Wine to Catalogue"'s producer field, the web's
// producer step): every typed word, fillers optional, no year, no region (a
// producer doc is its name). TIERED like the bottles: (x) the EXACT folded name
// on `producers_name_folded_idx` (an exact name survives more than 400
// candidates: 1,885 producers contain "chateau"; spelled as a range, see
// `similarProducers`), (a) every typed word incl. fillers, (b) the required
// words. ⚠️ TWO statements (step 1 recorded ONE for the old producer search;
// deliberate, lib/CLAUDE.md).
async function producerPass(q: string, plan: QueryPlan, limit: number): Promise<{ results: ProducerMatch[]; more: boolean; exact: boolean }> {
  const args: unknown[] = [q, ADD_TIME_MATCH, tsq(plan.required)]
  const ctes = [`x AS (SELECT p.id, 0 AS arm FROM producers p
      WHERE p.name_folded >= catalog_fold_v1($1) AND p.name_folded <= catalog_fold_v1($1) AND p.status = ANY($2) LIMIT ${ARM_LIMIT})`]
  const arms = ['x']
  const arm = (name: string, n: number, param: string) => `${name} AS (SELECT d.producer_id AS id, ${n} AS arm FROM catalog_search_producer_docs d
      JOIN producers p ON p.id = d.producer_id AND p.status = ANY($2) WHERE d.tsv @@ ${param}::tsquery LIMIT ${ARM_LIMIT})`
  if (plan.optional.length) { args.push(tsq([...plan.required, ...plan.optional])); ctes.push(arm('a', 1, `$${args.length}`)); arms.push('a') }
  ctes.push(arm('b', 2, '$3')); arms.push('b')
  const count = (n: string) => (arms.includes(n) ? `(SELECT count(*) FROM ${n})::int` : '0')
  const rows = await prisma.$queryRawUnsafe<ProducerRow[]>(
    `WITH ${ctes.join(',\n    ')},
     u AS (SELECT DISTINCT ON (id) id, arm FROM (${arms.map(a => `SELECT id, arm FROM ${a}`).join(' UNION ALL ')}) z ORDER BY id, arm),
     top AS (SELECT id, arm FROM u ORDER BY arm LIMIT ${ARM_LIMIT})
     SELECT top.arm, ${count('x')} AS nx, ${count('a')} AS na, ${count('b')} AS nb,
            p.id, p.name, p.country, p.region, p.status,
            array_to_string(coalesce(tsvector_to_array(d.tsv), public.catalog_search_words_v1(p.name_folded)), ' ') AS words
       FROM top JOIN producers p ON p.id = top.id LEFT JOIN catalog_search_producer_docs d ON d.producer_id = p.id`, ...args)
  const more = rows.length >= ARM_LIMIT || rows.some(r => r.nx >= ARM_LIMIT || r.na >= ARM_LIMIT || r.nb >= ARM_LIMIT)
  if (!rows.length) return { results: [], more, exact: false }
  const fitted = rows.map(r => {
    const fit = fitRow(plan, r.words ? r.words.split(' ') : [], [], [], [], false)
    // The key minus the year and region places, the exact name before the name order.
    return { row: r, key: [fit.key[0], fit.key[1], fit.key[4], fit.key[5], r.arm === 0 ? 0 : 1], score: shareOf(fit.exact, plan) }
  })
  // Tombstones resolve to their survivor (read time, as today), the best match wins.
  const tomb = fitted.filter(f => f.row.status === 'linked')
  const eff = tomb.length ? await resolveEffectiveIds('producers', tomb.map(f => f.row.id)) : new Map<string, string>()
  const survivors = tomb.length
    ? new Map((await prisma.$queryRawUnsafe<ProducerRow[]>(`SELECT id, name, country, region, status FROM producers WHERE id = ANY($1)`, [...new Set(eff.values())])).map(s => [s.id, s]))
    : new Map<string, ProducerRow>()
  const best = new Map<string, { out: ProducerMatch; key: number[] }>()
  let exact = false
  for (const f of fitted) {
    const p = f.row.status === 'linked' ? survivors.get(eff.get(f.row.id)!) : f.row
    if (!p || !(ADD_TIME_STATUSES as readonly string[]).includes(p.status)) continue
    // The exact arm's rows ARE the folded equals (an exact alias counts: a
    // producer of that name exists, merged into its survivor).
    if (f.row.arm === 0) exact = true
    const out: ProducerMatch = { id: p.id, name: p.name, country: p.country, region: p.region, score: f.score }
    const prev = best.get(p.id)
    if (!prev || byKey(f.key, prev.key) < 0) best.set(p.id, { out, key: f.key })
  }
  const ranked = [...best.values()].sort((a, b) => byKey(a.key, b.key) || a.out.name.localeCompare(b.out.name) || (a.out.id < b.out.id ? -1 : 1))
  return { results: ranked.slice(0, limit).map(x => x.out), more: more || ranked.length > limit, exact }
}

export async function searchProducers(raw: string, opts: { limit?: number } = {}): Promise<ProducerAnswer> {
  const none = (tooLong = false): ProducerAnswer => ({ ...EMPTY<ProducerMatch>(tooLong), exact: false })
  const prep = prepareEveryWord(raw)
  if (!prep) return none()
  if ('refuse' in prep) return none(true)
  const limit = clampLimit(opts.limit)
  const tokens = await readWords(prep.q, null)
  if (tokens.length > SEARCH_MAX_WORDS) return none(true)
  const plan = planQuery(tokens, false)
  if (!plan) return none()
  const first = await producerPass(prep.q, plan, limit)
  if (first.results.length) return { ...first, tooLong: false }
  const words = fallbackWords(plan)
  if (!words.length) return { ...first, tooLong: false }
  const forced = withForcedNear(plan, await readWords(prep.q, words), words, false)
  if (!forced) return { ...first, tooLong: false }
  return { ...(await producerPass(prep.q, forced, limit)), tooLong: false }
}

// For the units (scripts/tests/catalog-bottle-search.mts): the pure planner.
export const __everyWordForTests = { planQuery, fitRow, typoAlternatives, fallbackWords, tsq, readWords, wordsSql, bottleCandidatesSql, FILLER_SET }
