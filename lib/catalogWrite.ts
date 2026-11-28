import { nanoid } from 'nanoid'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import { scrub, cleanUrl, cleanCountry } from '@/lib/textSafe'

// ── catalogWrite: THE catalog mutation chokepoint ──────────────────────────
//
// 🔒 EVERY catalog row minted by the application goes through this module.
// That is a structural decision taken now to pay for a phase-4 requirement:
// the pull leg needs a change journal, and 🔒 "every write path appends to it,
// no exceptions" (implementation plan § The journal sequence). A single
// mutation path that skips the journal reintroduces the silent-omission class
// the journal exists to eliminate — and it would be invisible in testing,
// because the affected rows simply never appear in the feed.
//
// The plan gives whoever starts phase 2 the choice: route everything through
// one helper now, or retrofit appends into every mutation site later. This is
// the helper. Phase 4 adds `appendJournal(tx, …)` inside the transactions
// below, in ONE place, and "did we cover every path?" stays a structural
// question instead of an audit question — the same reasoning as the
// `mutateWines` and `lib/identityStore.ts` chokepoints elsewhere.
//
// Consequence, stated plainly: do NOT call `prisma.producer.create` /
// `prisma.wineProduct.create` / `prisma.wineVintage.create` from a route.
//
// 🔒 AND `tx` IS REQUIRED ON ALL THREE MINT HELPERS, not optional. Phase 4
// demands that every pull-visible mutation append its journal event IN THE SAME
// TRANSACTION as the domain change — an event written separately can be lost,
// duplicated, or ordered independently of what it describes, which is the exact
// silent-omission class the journal exists to eliminate. A helper that
// transparently falls back to the module-level client when `tx` is omitted
// cannot honour that, and the fallback would be invisible at the call site.
// Requiring the parameter makes the compiler enforce it: when the journal
// lands, there is no path that could have skipped a transaction. (Every
// production call site already passed one; this closes the door on the next.)
//
// 🔒 NOTHING HERE IS A FIND-OR-CREATE. Each function MINTS A DISTINCT ROW. The
// caller has already made an explicit choice (link to this existing entry, or
// create a new one); the fuzzy matcher only ever produced suggestions for a
// human. An "if it looks similar, reuse it" branch added here would be the
// auto-dedup model that got PR #82's schema rejected.

// Every user-minted entry starts here. Curators move it on (phase 3); the
// import path assigns 'confirmed' server-side (phase 4).
const PROVISIONAL = 'provisional'

// 🔒 Set EXPLICITLY on every product write, never left to a column default —
// the column deliberately HAS no default (schema comment): an omitted scope
// must fail loudly as a NOT NULL violation rather than silently landing
// 'shared', i.e. public. This constant exists so the value is spelled once;
// it does not make omission safe, and the DB is still the backstop.
const SHARED_SCOPE = 'shared'

// 🔒 EVERY USER MINT IS RECORDED AS AWAITING REVIEW, in the mint's own
// transaction (catalogue model change § 7): the fence opens before the review
// queue exists, and `status = 'provisional'` alone is not that record (a
// delivery may later move a user's entry to 'confirmed', and then nothing would
// say no curator ever looked at it). A mint with no user (an import, a fixture)
// writes none. Rolls back with the mint.
async function recordUserMint(tx: Prisma.TransactionClient, entityType: 'producer' | 'product' | 'vintage', entityId: string, addedBy: number | null): Promise<void> {
  if (addedBy === null) return
  await tx.catalogReviewItem.create({ data: { entityType, entityId, reason: 'user-mint' }, select: { id: true } })
}

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogValidationError'
  }
}

// 🔒 ONE MESSAGE FOR EVERY "that catalog row is not available to you" OUTCOME.
//
// Distinguishing "no such id" from "it's owned" / "rejected" / "merged away" /
// "belongs to another product" turns any endpoint reporting it into a
// classifier over the catalog's contents. EVERY catalog-facing route uses this
// helper so the property holds uniformly: the link paths (reachable outside the
// release fence by any wine-adder, including an anonymous host of their own
// session) AND /api/catalog/entries, which is staff-only today but becomes
// public the moment CATALOG_PUBLIC_ENABLED flips in phase 3 — fixing only the
// currently-reachable one would have re-introduced the classifier on release
// day.
//
// Same leak-prevention reasoning as the 404-not-403 rule in app/api/CLAUDE.md:
// a response must not let an outsider distinguish "absent" from "present but
// not for you".
//
// ⚠️ The dev-only log is the deliberate escape hatch that keeps the generic
// message debuggable. Keep the NODE_ENV gate — the generic-message property is
// asserted byte-for-byte by the phase-2 suite.
export function denyCatalogRef(reason: string): CatalogValidationError {
  if (process.env.NODE_ENV !== 'production') console.warn('[catalog] denied:', reason)
  return new CatalogValidationError('invalid catalog reference')
}

// 🔒 The rate-limit key for the catalog-LINK paths (the wine + check-in routes
// that accept productId/vintageId from a body). Shared by every such route so
// they cannot stack N+N — the shared-counter pattern in app/api/CLAUDE.md.
//
// ⚠️ ANONYMOUS CALLERS ARE KEYED ON IP, NOT ON THEIR IDENTITY ID, and this is
// the whole reason the helper exists rather than each route spelling the key
// itself. An `a:<uuid>` anon identity is MINTED FRESH ON EVERY JOIN (a
// successful join charges nothing; guest joins are capped at 60 per address
// per moment per 10 min) — so a caller who holds one valid session code
// (trivially, one they created themselves) can rejoin in a loop, collect many
// identities, and get a fresh budget with each one. Keying those on identity bounded nothing: measured, 20 rotated
// identities bought 20x the budget. Logged-in callers keep the user-scoped key,
// which is not rotatable.
export function catalogLinkRateKey(identityId: string, clientIp: string): string {
  return identityId.startsWith('u:')
    ? `rl:catalog-link:${identityId}:1h`
    : `rl:catalog-link:ip:${clientIp}:1h`
}

// ── Boundary normalization ─────────────────────────────────────────────────
//
// 🔒 The empty-string trap, which the implementation plan calls out as a real
// defect class rather than a hypothetical. `f_unaccent(lower(''))` is `''`, not
// NULL — so if a blank name reached the catalog, EVERY blank-named entry would
// fold to the same key and fuzzy-match as an exact collision, minting one
// shared catalog identity where there should be none.
//
// The live precedent is in lib/session.ts: `clean()` is `scrub(v) ?? ''`
// (null → '' on the way into Redis) while the Postgres mirror uses
// `wine.producer || null` ('' → null on the way out). Same value, two
// representations, decided by different operators in different files — `??`
// only catches null/undefined, so `''` sails straight through it.
//
// Two rules, matching the DB CHECKs exactly (which are the real enforcement —
// these produce good error messages, the constraints produce the guarantee):
//   • Required identity names: trimmed, and REJECTED when blank.
//   • Optional matching facts (region): blank normalizes to NULL.

function requiredName(raw: unknown, field: string): string {
  const s = scrub(typeof raw === 'string' ? raw : '') ?? ''
  const trimmed = s.trim()
  if (!trimmed) throw new CatalogValidationError(`${field} is required`)
  if (trimmed.length > 255) throw new CatalogValidationError(`${field} is too long`)
  return trimmed
}

// Blank → NULL, per the boundary rule above. Note this is NOT the same as the
// fill-null predicate: 🔒 never widen fill-null beyond `IS NULL` (plan
// § Arrays are non-null). Normalizing at the boundary is what keeps a blank
// from ever BECOMING a value that fill-null would then have to reason about.
function optionalFact(raw: unknown, max = 255): string | null {
  if (raw === null || raw === undefined) return null
  const s = scrub(typeof raw === 'string' ? raw : '') ?? ''
  const trimmed = s.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

// ISO 3166-1 alpha-2, via the repo's ALLOW-LIST (`cleanCountry` in
// lib/textSafe.ts — the same one `wines.country` uses). Anything else → null
// rather than a stored value every downstream surface has to defend against.
//
// 🔒 AN ALLOW-LIST, NOT A SHAPE CHECK. A `/^[A-Za-z]{2}$/` test accepts 676
// strings of which only ~250 are real countries, so 'ZZ' and 'QQ' stored
// happily and would render as broken flags / unmatchable filters forever.
//
// ⚠️ AND VALIDATE THE WHOLE VALUE, THEN TRUNCATE — never the reverse. Passing a
// max-length to `optionalFact` first made the check meaningless because it
// TRUNCATED before validating: 'FRANCE' became 'FR' and passed. Harmless for
// France, not in general — 'Germany' would have been stored as 'GE', which is
// Georgia. A wrong-but-plausible code is worse than no code at all, because
// nothing downstream can tell it was a guess.
function optionalCountry(raw: unknown): string | null {
  return cleanCountry(optionalFact(raw, 64)) || null
}

// `grapes` is a NON-NULL text[] where `{}` means "no grapes recorded"
// (schema comment + plan § Arrays are non-null). So a missing/null incoming
// value normalizes to `{}` HERE, at the boundary, and the column never sees
// null — which matters because the phase-4 fill is
// `CASE WHEN cardinality(existing) = 0 …` and `cardinality(NULL)` is NULL, not
// 0, making a NULL row permanently unenrichable.
// 🔒 STRICT variant for the VINTAGE grain, where normalization-to-empty CHANGES
// MEANING. At product grain `{}` means "not recorded" and a permissive
// normalizer that drops junk is fine. At vintage grain `{}` under a set flag is
// an ASSERTION ("this vintage genuinely has none"), so silently coercing a
// malformed list into it would manufacture a claim the caller never made —
// measured before this existed: `vintageGrapes: [123]` stored as an
// authoritative empty. Reject instead; the caller gets a 400 and can retry.
function normalizeVintageGrapes(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new CatalogValidationError('vintage grapes must be an array')
  const out: string[] = []
  for (const g of raw) {
    if (typeof g !== 'string') throw new CatalogValidationError('each vintage grape must be a string')
    const s = optionalFact(g, 64)
    if (!s) throw new CatalogValidationError('vintage grape entries must not be blank')
    if (!out.includes(s)) out.push(s)
  }
  // ⚠️ Truncating an AUTHORITATIVE list would silently publish a shorter
  // composition than the caller asserted. Reject.
  if (out.length > 24) throw new CatalogValidationError('at most 24 vintage grapes')
  return out
}

function normalizeGrapes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const g of raw) {
    const s = optionalFact(g, 64)
    if (s && !out.includes(s)) out.push(s)
  }
  return out.slice(0, 24)
}

// The plausible-year rule for the lightweight vintage-add path (RFC § Vintage
// curation is lightweight). The DB CHECK is a wide 1800..2200 garbage fence;
// the tighter current-year+1 rule lives here, at the route boundary, because
// "plausible" moves with the calendar and a CHECK cannot.
//
// 🔒 `null` is the NON-VINTAGE row EXCLUSIVELY — never "year unknown". An
// unknown year links at PRODUCT grain instead (wines.vintageId null), which is
// what keeps NV rows clean. Callers must not pass null to mean "don't know".
//
// 🔒 THIS IS THE ONLY PLACE A VINTAGE YEAR IS RANGE-CHECKED. Do not "align" the
// input field to it, and do not relax it to match the input field.
//
// Two layers, deliberately asymmetric (settled during catalog review,
// 2026-07-26):
//
//   • The free-text ENCOUNTER string (`@verre/core` `normalizeVintageText`)
//     applies a STRUCTURAL grammar only — any four-digit value, or an NV token.
//     No plausibility range whatsoever.
//   • THIS function, at CATALOG PROMOTION, accepts only 1900..the current year, because
//     a promoted value becomes permanent shared identity that every later taster
//     inherits.
//
// Values outside the catalog range stay ENCOUNTER TEXT and default to
// product-grain handling at backfill; they are never auto-promoted to a vintage
// row.
//
// ⚠️ DO NOT ADD PLAUSIBILITY BOUNDS BACK TO THE SHARED WRITE NORMALIZER. That
// was tried and reverted: the normalizer runs on every edit RESEND, so a range
// there BLANKED a stored out-of-range value the moment the user touched any
// other field on the form — and the identity comparator then read ''-vs-'' as
// unchanged and KEPT the catalog link, leaving a blank vintage still linked at
// vintage grain. A write-boundary validator cannot retroactively invalidate
// stored data without an initial-value-aware edit path on every surface.
// The out-of-range round-trip pins in scripts/tests/vintage-text-units.ts fail
// if that range is reintroduced.
//
// The backfill's promotion rule (the handoff contract):
//   recognized NV token → the NV row (year = null)
//   1900..current year  → that dated vintage row
//   anything else (pre-1900, implausible future, legacy junk) → PRESERVE the
//                         encounter string, default to PRODUCT-grain linkage +
//                         manual disposition; never auto-mint a vintage
// 🔒 THE one year range (1900 to the current year, UTC; a vintage is the harvest
// year, so no bottle carries next year's: ruled 2026-11-22, was current + 1):
// the write boundary below AND the
// bottle search's year detection (lib/catalogSearch.ts: a typed word in this
// range is the year; plan 7b review r1 P1 found two definitions).
export const YEAR_MIN = 1900
export function yearMax(): number { return new Date().getUTCFullYear() }
export function isCatalogYear(n: number): boolean { return Number.isInteger(n) && n >= YEAR_MIN && n <= yearMax() }

export function validateYear(year: number | null): number | null {
  if (year === null) return null
  if (!Number.isInteger(year)) throw new CatalogValidationError('year must be an integer')
  const max = yearMax()
  if (year < YEAR_MIN || year > max) {
    throw new CatalogValidationError(`year must be between ${YEAR_MIN} and ${max}`)
  }
  return year
}

export type NewProducerInput = {
  name: string
  country?: unknown
  region?: unknown
  website?: unknown
}

// `style`, `colour` and `sparkling` are `unknown` on purpose: callers pass the
// RAW body value and `createProduct` is the one place that validates them.
export type NewProductInput = {
  name: string
  producerId: string
  category?: string
  style?: unknown
  colour?: unknown
  sparkling?: unknown
  abv?: number | null
  grapes?: unknown
  region?: unknown
  // The wine's ORIGIN (contract v3, `wine_products.country`): where the wine is
  // from, never the producer's home. ISO 3166-1 alpha-2 via the allow-list.
  country?: unknown
}

// ── Mint a producer ────────────────────────────────────────────────────────
export async function createProducer(
  input: NewProducerInput,
  addedBy: number | null,
  tx: Prisma.TransactionClient,
): Promise<{ id: string }> {
  const data = {
    id: nanoid(21),
    name: requiredName(input.name, 'producer name'),
    country: optionalCountry(input.country),
    region: optionalFact(input.region),
    // 🔒 `cleanUrl`, not `optionalFact` — the repo's http(s)-only sanitizer,
    // the same one `wines.purchaseUrl` uses (`docs/dev/wine-metadata.md`).
    // Generic text normalization stored `javascript:` / `data:` schemes
    // verbatim, which becomes a live stored-link hazard the moment a producer
    // page renders this as an anchor. cleanUrl also auto-prepends https:// to a
    // bare domain, so a pasted "example.com" saves and renders instead of
    // silently dropping. Empty result → NULL, matching every other optional
    // fact here.
    website: cleanUrl(input.website).slice(0, 512) || null,
    status: PROVISIONAL,
    addedBy,
  }
  const client = tx
  // 🔒 name_folded / region_folded are GENERATED ALWAYS columns and are NOT in
  // `data`. The Prisma client exposes them as optional inputs, but Postgres
  // rejects any supplied value with 428C9 — a loud runtime error rather than
  // silent drift (prisma/CLAUDE.md). Never add them here.
  await client.producer.create({ data, select: { id: true } })
  await recordUserMint(tx, 'producer', data.id, addedBy)
  await indexProducer(tx, data.id)
  return { id: data.id }
}

// ── Mint a product + its lead producer link ────────────────────────────────
//
// 🔒 THIS CANNOT BE A SINGLE STATEMENT, AND THAT IS THE INVARIANT WORKING.
// A bare `prisma.wineProduct.create()` ALWAYS raises `has no lead producer` at
// COMMIT: a deferred constraint trigger checks at commit time that every
// product has exactly one lead link (schema comment; prisma/CLAUDE.md). So the
// product row and its `product_producers` lead row must commit in ONE
// transaction. Phase-2 authors meet this as a confusing runtime error if they
// haven't read the schema — hence this function existing at all.
//
// Collaborators (RFC add-branch 5) are set HERE, at creation, alongside the
// lead. A collaboration is one product with 2+ links — NOT a merge, and not
// something to be bolted on afterwards.
export async function createProduct(
  input: NewProductInput,
  addedBy: number | null,
  collaboratorIds: string[],
  tx: Prisma.TransactionClient,
): Promise<{ id: string }> {
  const id = nanoid(21)
  const name = requiredName(input.name, 'product name')
  const category = input.category?.trim() || 'wine'
  const style = productStyle(input.style, category)
  const colour = productColour(input.colour)
  const sparkling = productSparkling(input.sparkling)
  const region = optionalFact(input.region)
  const country = optionalCountry(input.country)
  const grapes = normalizeGrapes(input.grapes)
  const abv = normalizeAbv(input.abv)
  if (!input.producerId) throw new CatalogValidationError('producerId is required')
  // A producer cannot be its own collaborator, and duplicates would fail the
  // composite PK mid-transaction. Filter before the write so the caller gets a
  // clear error path rather than a constraint violation.
  const collaborators = [...new Set(collaboratorIds)].filter(p => p && p !== input.producerId)

  const run = async (t: Prisma.TransactionClient) => {
    // The adder's user row FIRST (the key the product's `added_by` takes anyway,
    // FOR KEY SHARE): before the producer lock below, an account deletion of
    // the adder (users row, then its producers' `added_by` SET NULL) and this
    // mint could each hold what the other waits for (40P01; review 2026-11-21).
    if (addedBy !== null) await t.$queryRaw`SELECT 1 FROM users WHERE id = ${addedBy} FOR KEY SHARE`
    // The search doc's row rule (lockForSearchDoc): the lead's chain FOR SHARE
    // BEFORE the source rows, so a concurrent rename of the lead serialises with
    // this mint and the later of the two computes the doc from what the first
    // committed. The product row is new, so it needs no lock.
    await lockForSearchDoc(t, [input.producerId], [])
    await t.wineProduct.create({
      data: {
        id,
        name,
        category,
        style,
        colour,
        sparkling,
        abv,
        grapes,
        region,
        country,
        // 🔒 EXPLICIT, always — see SHARED_SCOPE.
        scope: SHARED_SCOPE,
        status: PROVISIONAL,
        addedBy,
      },
      select: { id: true },
    })
    await t.productProducer.create({
      data: { productId: id, producerId: input.producerId, role: 'lead' },
    })
    if (collaborators.length) {
      await t.productProducer.createMany({
        data: collaborators.map(producerId => ({ productId: id, producerId, role: 'collaborator' })),
      })
    }
    await recordUserMint(t, 'product', id, addedBy)
    // Findable the moment this mint commits (in its own transaction already).
    await indexProduct(t, id)
    return { id }
  }
  // An outer transaction is reused rather than nested: the lead link must
  // commit with the product, and a nested transaction would defeat that.
  return run(tx)
}

// ── Mint a vintage under an already-chosen product ─────────────────────────
//
// Lightweight by design (RFC § Vintage curation is lightweight): under an
// explicitly chosen product, a missing vintage is accepted directly when the
// year is plausible or null for the NV instance. The heavyweight duplicate
// queue is the producer/product grain; here the `(product_id, year)`
// UNIQUE NULLS NOT DISTINCT constraint is what prevents duplicates — including
// a second NV row, which a plain compound unique would allow.
export async function createVintage(
  productId: string,
  year: number | null,
  addedBy: number | null,
  abv: number | null,
  tx: Prisma.TransactionClient,
  // 🔒 Per-vintage GRAPE override. `grapes: undefined` (or omitting `opts`
  // entirely) means INHERIT the product's — the default and the overwhelmingly
  // common case. Supplying an array, INCLUDING an empty one, sets the override
  // flag: `[]` is the deliberate "this vintage genuinely has none listed".
  //
  // ⚠️ The flag exists because a nullable array cannot express this: Prisma
  // returns `[]` for both NULL and `{}` on a scalar list, so the distinction
  // would be invisible to every application read path. See the schema comment.
  //
  // A trailing options object rather than more positionals — six is already
  // past the point where call sites are readable, and the next vintage field
  // should go in here too rather than extending the signature again.
  opts?: { grapes?: string[] },
): Promise<{ id: string }> {
  if (!productId) throw new CatalogValidationError('productId is required')
  // 🔒 PRESENCE DETERMINES INTENT. An earlier version normalized an override
  // equal to the product's grapes back to inherit, as a belt against a client
  // posting the field unconditionally. That was WRONG twice over:
  //   • `[]` is truthy in JS, so an explicit "genuinely none" over a product
  //     whose grapes are ALSO `{}` was silently downgraded to inheritance —
  //     measured: {grapes:[], grapesOverride:false}. The exact assertion the
  //     flag exists to carry, discarded.
  //   • Even when correct, discarding an explicit override because it happens
  //     to equal TODAY's product value means a later product edit silently
  //     rewrites that vintage's composition.
  // A client that posts unconditionally is a client bug to fix or version, not
  // a reason to reinterpret an explicit write.
  const grapes = opts?.grapes === undefined ? null : normalizeVintageGrapes(opts.grapes)
  const data = {
    id: nanoid(21),
    productId,
    year: validateYear(year),
    abv: normalizeAbv(abv),
    grapes: grapes ?? [],
    grapesOverride: grapes !== null,
    status: PROVISIONAL,
    addedBy,
  }
  const client = tx
  await client.wineVintage.create({ data, select: { id: true } })
  await recordUserMint(tx, 'vintage', data.id, addedBy)
  return { id: data.id }
}

// ⚠️ Prisma Decimal serializes to a JSON STRING, and the column is
// DECIMAL(4,2) with a CHECK of 0..25 — note the type caps magnitude at 99.99
// first, so an out-of-range value raises "numeric field overflow" from the
// TYPE before the CHECK is ever reached. Bounding here gives a clean 400
// instead of a 500 from either.
// The abv rule on its own (the add flow validates a typed abv even when it is
// not written: an existing vintage keeps its own).
export function assertAbv(raw: unknown): void { normalizeAbv(raw) }

export function normalizeAbv(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 25) {
    throw new CatalogValidationError('abv must be between 0 and 25')
  }
  return Math.round(n * 100) / 100
}

// ── A reported alcohol (0.2.0 build 2) ─────────────────────────────────────
//
// 🔒 NEVER written into `wine_vintages.abv` (ruled 2026-11-27 with the
// catalogue-maintenance side): an alcohol typed on a listed year that has none
// is a review item (reason 'user-abv', the value, the vintage, the reporter)
// they pull and deliver back as a normal value. Until then every read shows it
// on that year (lib/catalogEntries.ts `vintageAbvSql`), with no marker.
// 🔒 The FIRST value wins: at most one open report per vintage (the partial
// unique `catalog_review_items_open_abv_key`), so a second report, or one on a
// year that already carries an alcohol, is ignored without an error. The year
// getting its own alcohol settles the open report in the database (the trigger
// `wine_vintages_abv_settles_report`, 20261128120000). Inside the
// bottle write's transaction (lib/catalogLink.ts `applyLink`), on the EFFECTIVE
// vintage the pick resolved to, before the entry is read for the snapshot: the
// reporter's bottle carries the value through the normal snapshot.
export async function reportVintageAbv(tx: Prisma.TransactionClient, vintageId: string, abv: number, userId: number): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO catalog_review_items (entity_type, entity_id, reason, abv, reported_by)
    SELECT 'vintage', v.id, 'user-abv', ${abv}::numeric, ${userId}
      FROM wine_vintages v WHERE v.id = ${vintageId} AND v.abv IS NULL
    ON CONFLICT (entity_id) WHERE reason = 'user-abv' AND resolved_at IS NULL DO NOTHING`
}

// The product kind, as three attributes (20261109120000). App-side mirrors of
// `wine_products_colour_check` / `wine_products_style_check`, so a bad value is
// a 400 rather than a constraint 500.
//
// 🔒 OMITTED IS NOT INVALID. `undefined` takes the column default (colour and
// style NULL, sparkling false); a PRESENT value of the wrong type or outside
// the vocabulary is rejected, never coerced. Coercing is how `style: 42` used
// to store NULL with a 200.
//
// ⚠️ The old style tokens (red, white, rose, spark, nonalc) are REJECTED, not
// mapped onto colour/sparkling: the endpoint has no client yet, so there is no
// old caller to keep working, and a mapping would be untested translation code.
const WINE_COLOURS = ['red', 'white', 'rose']
const WINE_STYLES = ['dessert', 'fortified']

function productColour(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string' || !WINE_COLOURS.includes(raw)) {
    throw new CatalogValidationError('colour must be red, white, rose or null')
  }
  return raw
}

function productSparkling(raw: unknown): boolean {
  if (raw === undefined) return false
  if (typeof raw !== 'boolean') throw new CatalogValidationError('sparkling must be true or false')
  return raw
}

// Wine-scoped, exactly like the CHECK: another category's styles are governed by
// the composite FK to category_styles alone, so adding a category stays an
// INSERT and never needs a code or schema change here.
function productStyle(raw: unknown, category: string): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new CatalogValidationError('style must be a string or null')
  if (category !== 'wine') return optionalFact(raw, 64)
  if (!WINE_STYLES.includes(raw)) {
    throw new CatalogValidationError('style must be dessert, fortified or null (colour and sparkling are separate fields)')
  }
  return raw
}

// ── Resolve a caller-supplied link to a real, linkable catalog target ──────
//
// 🔒 EVERY write boundary that accepts productId/vintageId from a request body
// MUST call this. It is the difference between "the client said this id" and
// "this id names a row that may legitimately be linked to". Four things it
// enforces, each of which is a way a raw body value goes wrong:
//
//   1. The product exists.
//   2. The vintage, if given, BELONGS TO that product. The database enforces
//      this structurally too (composite FK on (vintage_id, product_id)), but
//      failing here yields a 400 instead of a 500 from a constraint.
//   3. Neither is a tombstone or a junk verdict. Linking new tasting data to a
//      `linked` row points it at an entry already merged away; `rejected` has
//      left the public catalog. Both resolve badly forever after.
//   4. `vintageId` without `productId` is invalid — the DB CHECK says so, and
//      the composite FK alone would NOT catch it (MATCH SIMPLE skips whenever
//      any column is null).
//
// Returns the validated pair. Throws CatalogValidationError otherwise.
// `existing` is the wine's CURRENTLY-STORED link, and supplying it is what
// makes a PARTIAL link edit expressible. Without it, a caller sending only
// `{ vintageId: null }` — meaning "drop to product grain, keep the product" —
// had the PRODUCT link destroyed too, silently, with a 200: an omitted
// `productId` read as "no link" rather than "unchanged". With `existing`,
// omitted means KEEP and null means CLEAR, per field, matching the semantics
// `normalizeWine` (lib/session.ts) already implements one layer down. Callers that have no
// stored link (creates) simply omit it.
// `db`: the caller's transaction when it runs inside one (review r2: a pick is
// resolved under the writer's locks, and a second pool connection taken while
// the transaction holds its own could wait on a pool nobody releases).
export async function resolveCatalogLink(
  productId: unknown,
  vintageId: unknown,
  existing?: { productId?: string | null; vintageId?: string | null },
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ productId: string | null; vintageId: string | null }> {
  // 🔒 A PRESENT-BUT-MALFORMED id is a 400, NOT a silent clear.
  //
  // Coercing a non-string (a number, an object, `false`) to "no link" meant a
  // client bug silently DELETED a valid catalog link and returned 200 — the
  // one hole in an otherwise strict boundary, since every other bad input here
  // (unknown id, wrong product, tombstone, owned scope) rejects. It matters
  // beyond tidiness: a link nulled this way is indistinguishable from a legacy
  // never-linked row, so phase 5's exact-match backfill would re-derive it
  // from strings — string-derived linking on a wine that had an explicit user
  // choice. `null` remains a legitimate explicit clear; only wrong TYPES are
  // rejected.
  const check = (v: unknown, field: string, stored: string | null | undefined): string | null => {
    if (v === undefined) return stored ?? null   // omitted → keep what's stored
    if (v === null) return null                  // explicit null → clear
    if (typeof v !== 'string') throw new CatalogValidationError(`${field} must be a string or null`)
    return v || null
  }
  const p = check(productId, 'productId', existing?.productId)
  // 🔒 A STORED VINTAGE IS ONLY INHERITED WHILE ITS PARENT PRODUCT IS UNCHANGED.
  // The vintage is the child grain, so an inherited one is meaningless — and
  // provably wrong — the moment the product it belongs to is cleared or
  // swapped. Two request shapes made that concrete, both of which failed before
  // this guard:
  //   • `{productId: null}` alone — the natural spelling of "unlink this wine"
  //     — inherited the stored vintage, hit the `!p && v` shape check below and
  //     returned 400 "vintageId requires productId" for a perfectly valid
  //     request.
  //   • `{productId: <a different product>}` alone — a re-link — inherited a
  //     vintage belonging to the OLD product, which then failed the
  //     belongs-to-that-product check as a generic `invalid catalog link`. The
  //     request was well-formed; the error said nothing useful.
  // An EXPLICITLY sent vintageId still wins in both cases; only the inherited
  // value is dropped.
  const productChanged = p !== (existing?.productId ?? null)
  const v = vintageId === undefined && productChanged
    ? null
    : check(vintageId, 'vintageId', existing?.vintageId)
  if (!p && !v) return { productId: null, vintageId: null }
  // Shape errors describe the REQUEST, not the catalog's contents, so they are
  // safe to be specific about — they reveal nothing about which ids exist.
  if (!p && v) throw new CatalogValidationError('vintageId requires productId')

  const product = await db.wineProduct.findUnique({
    where: { id: p! },
    select: { id: true, status: true, scope: true },
  })
  // 🔒 ONE MESSAGE FOR EVERY "no, you may not link to that" OUTCOME.
  //
  // Distinguishing "no such id" / "it's owned" / "it's rejected" / "wrong
  // product" turns this into a four-way classifier over the catalog, and these
  // link paths are reachable from the ordinary session-wine and check-in
  // routes — i.e. from OUTSIDE the CATALOG_PUBLIC_ENABLED fence, by any caller
  // who can add a wine (including an anonymous host of their own session). A
  // caller with a valid link never sees these messages, so the specificity
  // bought nothing legitimate; it only made probing easier. Same
  // leak-prevention reasoning as the 404-not-403 rule in app/api/CLAUDE.md:
  // the response must not let an outsider distinguish "absent" from "present
  // but not for you". The specific reason is still available server-side for
  // debugging — see the console.warn below.
  const deny = denyCatalogRef
  if (!product) throw deny(`unknown productId ${p}`)
  if (!LINKABLE_STATUSES.includes(product.status)) throw deny(`product is ${product.status}`)
  // A future `owned` entry is not public catalog data; a session wine linking
  // to one would leak it through every surface that renders the link.
  if (product.scope !== SHARED_SCOPE) throw deny(`product scope is ${product.scope}`)
  if (!v) return { productId: product.id, vintageId: null }

  const vintage = await db.wineVintage.findUnique({
    where: { id: v },
    select: { id: true, productId: true, status: true },
  })
  if (!vintage) throw deny(`unknown vintageId ${v}`)
  if (vintage.productId !== product.id) throw deny('vintage belongs to a different product')
  if (!LINKABLE_STATUSES.includes(vintage.status)) throw deny(`vintage is ${vintage.status}`)
  return { productId: product.id, vintageId: vintage.id }
}

// `archived` is deliberately linkable: a discontinued entry keeps working for
// ratings and history (RFC § Lifecycle — "fully intact"), it is only excluded
// from add-time suggestions. `linked` and `rejected` are not.
const LINKABLE_STATUSES = ['provisional', 'confirmed', 'archived']

// ── The identity-changing-edit rule: RETIRED (catalogue model change step 4) ─
//
// A bottle's identity is its catalogue LINK: an edit that changes producer,
// name or year is a RE-LINK through the add flow (lib/catalogLink.ts), which
// writes the whole snapshot from the new entry. Typed identity text is ignored
// on every write, so there is no free-text change left to detect.

// ── The hard purge's reference clearing (catalogue model change § 5a) ───────
//
// 🔒 A purge clears or redirects catalogue references; it NEVER deletes an
// occurrence, a rating or a craving. The staff purge itself (`catalog.purge`,
// admin, audited) is phase 3's; these are the steps it runs inside its one
// transaction:
//   • a VINTAGE: the bottles and the cravings fall back to product grain; a
//     craving that then collides with the same person's "any year" craving of
//     that wine is merged (keep the row visible to its owner, else the earlier
//     saved_at, lib/cravings.ts); the row is deleted, then its review item
//     (that order: below).
//   • a PRODUCT: its vintages first, then the bottles and cravings unlinked
//     (each keeps its snapshot, so it still renders; an unlinked craving is
//     exempt from the one-per-wine unique; a blind save that already counts as
//     a craving becomes one first, Codex r1); its review item; the row (its
//     product_producers rows cascade, by ruling, prisma/CLAUDE.md).
// The moments whose bottles changed get a new line-up revision (their caches
// still carry the old link).
// 🔒 Lock order as every writer takes it (Codex r1: bottles first deadlocked
// against a moment's own contract): the moments' advisory locks and rows, in
// code order (`withSessionLocks`, as account deletion does), then the bottles,
// then the people's craving locks. The plan is read once, before the locks;
// only what was locked is written. A reference made meanwhile (a bottle linked
// in another moment, a craving by someone not locked) keeps its link, and so
// does a reference class these steps forget (an EAN, a merge pointing at the
// row): the delete FAILS on its NO ACTION key and the whole purge rolls back
// (the keys are the backstop; the caller retries).
// The plan also holds the moments a product purge's blind saves carry (an
// orphaned bottle's save keeps its moment, which the craving it becomes
// references, Codex r2) and every owner of a craving sourced from a locked
// bottle (an old instance's craving has no stored link). A save made after the
// plan in a moment it does not hold → `PurgeRaced` (rolled back, retry).
// (lib/cravings.ts, lib/occurrences.ts and lib/sessionMutation.ts read this
// module's neighbours, so they are loaded when a purge runs, never at import:
// no module cycle.)
export class PurgeRaced extends Error {}

export async function purgeVintage(tx: Prisma.TransactionClient, vintageId: string): Promise<void> {
  await purgeReferences(tx, null, [vintageId])
}

export async function purgeProduct(tx: Prisma.TransactionClient, productId: string): Promise<void> {
  const vintages = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM wine_vintages WHERE product_id = ${productId} ORDER BY id`
  await purgeReferences(tx, productId, vintages.map(v => v.id))
}

async function purgeReferences(tx: Prisma.TransactionClient, productId: string | null, vintageIds: string[]): Promise<void> {
  const { CRAVING_FROM, SAVE_MOMENT, cravingHiddenSql, lockCravings, maturedSavesToCravings } = await import('@/lib/cravings')
  const { bumpLineupRevision } = await import('@/lib/occurrences')
  const { withSessionLocks } = await import('@/lib/sessionMutation')
  const { Prisma: P } = await import('@prisma/client')
  const hit = (a: string) => (productId
    ? P.sql`${P.raw(a)}.product_id = ${productId}`
    : P.sql`${P.raw(a)}.vintage_id = ANY(${vintageIds}::text[])`)
  const codes = await tx.$queryRaw<{ code: string }[]>`
    SELECT s.code FROM wines w JOIN sessions s ON s.id = w.session_id WHERE ${hit('w')} AND s.code IS NOT NULL
    ${productId ? P.sql`UNION SELECT s.code FROM blind_saves bs JOIN wines w ON w.id = bs.wine_id JOIN sessions s ON s.id = ${SAVE_MOMENT}
     WHERE ${hit('w')} AND s.code IS NOT NULL` : P.empty}`
  const moments = [...(await withSessionLocks(tx, codes.map(c => c.code))).values()].flatMap(r => (r ? [r.id] : []))
  const bottles = await tx.$queryRaw<{ id: string; session_id: number | null }[]>`
    SELECT w.id, w.session_id FROM wines w
     WHERE ${hit('w')} AND (w.session_id IS NULL OR w.session_id = ANY(${moments}::int[])) ORDER BY w.id FOR UPDATE`
  const wineIds = bottles.map(b => b.id)
  const owners = (await tx.$queryRaw<{ u: number }[]>`
    SELECT user_id AS u FROM bookmarks b WHERE ${hit('b')}
    UNION SELECT user_id FROM bookmarks WHERE wine_id = ANY(${wineIds}::text[])
    UNION SELECT user_id FROM blind_saves WHERE wine_id = ANY(${wineIds}::text[])`).map(r => r.u)
  await lockCravings(tx, owners)
  if (productId && !(await maturedSavesToCravings(tx, wineIds, moments))) throw new PurgeRaced('a save was made in a moment this purge does not hold: retry')
  if (wineIds.length) {
    if (productId) await tx.$executeRaw`UPDATE wines SET vintage_id = NULL, product_id = NULL WHERE id = ANY(${wineIds}::text[])`
    else await tx.$executeRaw`UPDATE wines SET vintage_id = NULL WHERE id = ANY(${wineIds}::text[])`
  }
  for (const id of new Set(bottles.map(b => b.session_id).filter((x): x is number => x !== null))) await bumpLineupRevision(tx, id)
  for (const vintageId of vintageIds) {
    const pairs = await tx.$queryRaw<{ a: number; b: number }[]>`
      SELECT x.id AS a, y.id AS b FROM bookmarks x
        JOIN bookmarks y ON y.user_id = x.user_id AND y.product_id = x.product_id AND y.vintage_id IS NULL
       WHERE x.vintage_id = ${vintageId} AND x.user_id = ANY(${owners}::int[])`
    for (const { a, b } of pairs) {
      const rows = await tx.$queryRaw<{ id: number; saved_at: Date; hidden: boolean }[]>`
        SELECT b.id, b.saved_at, ${cravingHiddenSql(P.sql`b.user_id`)} AS hidden FROM ${CRAVING_FROM} WHERE b.id IN (${a}, ${b})`
      const [x, y] = [rows.find(r => r.id === a), rows.find(r => r.id === b)]
      if (!x || !y) continue
      const keepX = (x.hidden === false) !== (y.hidden === false) ? x.hidden === false : (+x.saved_at < +y.saved_at || (+x.saved_at === +y.saved_at && x.id < y.id))
      await tx.$executeRaw`DELETE FROM bookmarks WHERE id = ${keepX ? y.id : x.id}`
    }
    await tx.$executeRaw`UPDATE bookmarks SET vintage_id = NULL WHERE vintage_id = ${vintageId} AND user_id = ANY(${owners}::int[])`
  }
  if (productId) await tx.$executeRaw`UPDATE bookmarks SET product_id = NULL WHERE product_id = ${productId} AND user_id = ANY(${owners}::int[])`
  // The vintage row BEFORE its review items: the abv-settle trigger
  // (20261128120000) locks the vintage, then its open report, so the other
  // order deadlocks against a delivery filling that year (Codex 2026-11-28).
  // entity_id has no key, so the order is free otherwise.
  for (const vintageId of vintageIds) {
    await tx.$executeRaw`DELETE FROM wine_vintages WHERE id = ${vintageId}`
    await tx.$executeRaw`DELETE FROM catalog_review_items WHERE entity_type = 'vintage' AND entity_id = ${vintageId}`
  }
  if (productId) {
    await tx.$executeRaw`DELETE FROM catalog_review_items WHERE entity_type = 'product' AND entity_id = ${productId}`
    await tx.$executeRaw`DELETE FROM wine_products WHERE id = ${productId}`
    // Its search doc goes with it (the DELETE above holds the product row; a
    // purge writes no other doc). A rebuild racing this re-writes nothing it
    // keeps: its "source gone" delete runs after its upserts.
    await tx.$executeRaw`DELETE FROM catalog_search_docs WHERE product_id = ${productId}`
  }
}

// ── The search docs (catalogue model change step 7b) ───────────────────────
//
// 🔒 OUR writes keep `catalog_search_docs` / `catalog_search_producer_docs`
// current (migration 20261121180000_catalog_search; the read is
// lib/catalogSearch.ts `searchBottles` / `searchProducers`), inside the SAME
// transaction as the catalogue row they describe, so a wine is findable the
// moment its mint commits. Outside writers (a catalogue load, psql) are what the
// rebuild and its drift report are for (scripts/rebuild-catalog-search.mts). CI
// census: scripts/check-catalog-writes.mjs.
//
// 🔒 THE ROW RULE, every doc write, in ONE order taken BEFORE any source
// mutation (plan 7b, Codex r4 P1: a product edit holding its product and
// wanting its producer, against a producer rename holding the producer and
// wanting the product, deadlocked): (1) the producer rows involved (each lead
// and its effective chain), sorted by id; (2) the product rows involved, sorted
// by id; (3) the source mutations; (4) the doc computed in a NEW statement, so
// its snapshot is taken after any wait. A mint locks its lead's chain FOR SHARE
// (its product row is new); a purge locks its product row (its DELETE does) and
// writes no other doc. Phase 3's writers (rename, region, lead, merge, unmerge)
// follow it too, and also take the SHARED catalog-search advisory lock as the
// FIRST statement of their transaction (the rebuild takes the exclusive one):
// `CATALOG_SEARCH_LOCK`. Mints take no advisory lock: a mint only INSERTS a new
// key, which a rebuild either sees committed (the same doc) or not at all.
export const CATALOG_SEARCH_LOCK = 'verre:catalog-search'

// (1) + (2) of the row rule. `producers`: the leads (and any producer the
// writer changes); their effective chains (links_to followed like
// resolveEffectiveIds: at most 10 hops, MERGE_DEPTH_CAP, stop on a revisit) are
// read, then every row is locked in id order, then the chains are read again:
// a chain that moved meanwhile is locked again (a merge in phase 3). A producer
// the writer CHANGES (`changing`) FOR UPDATE, every other one FOR SHARE; the
// products FOR NO KEY UPDATE (a writer changing a product, or re-indexing it,
// passes it here: two re-index writers feeding one doc both lock its product,
// so they serialise).
// A merge chain moved under the lock (phase 3): locking a newly found row
// now could take it out of the id order every writer keeps, so the caller
// restarts its transaction (Codex 2026-11-21, r1 + r2). Unreachable before
// phase 3 (no writer merges); a mint that meets it fails once and its retry
// (the same client id) runs again.
export class SearchLockRetry extends Error {}

export async function lockForSearchDoc(
  tx: Prisma.TransactionClient,
  producers: string[], products: string[], changing: string[] = [],
): Promise<void> {
  const seeds = [...new Set([...producers, ...changing])]
  const chain = async () => (await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE walk(id, links_to, depth, path) AS (
      SELECT id, links_to, 0, ARRAY[id::text] FROM producers WHERE id = ANY(${seeds}::text[])
      UNION ALL
      SELECT p.id, p.links_to, w.depth + 1, w.path || p.id::text
        FROM walk w JOIN producers p ON p.id = w.links_to
       WHERE w.depth < 10 AND p.id::text <> ALL(w.path)
    ) SELECT DISTINCT id FROM walk ORDER BY id`).map(r => r.id)
  // ONE pass in the database's id order (the chain query's ORDER BY), then
  // the chain read again: a row it holds that is not locked yet (the chain
  // moved during a wait) could only be locked out of order now (a concurrent
  // writer may hold it and wait on one of ours: 40P01), so the transaction
  // restarts instead. A locked row that LEFT the chain is harmless.
  const locked = new Set<string>()
  for (const id of seeds.length ? await chain() : []) {
    if (changing.includes(id)) await tx.$queryRaw`SELECT id FROM producers WHERE id = ${id} FOR UPDATE`
    else await tx.$queryRaw`SELECT id FROM producers WHERE id = ${id} FOR SHARE`
    locked.add(id)
  }
  if (seeds.length && !(await chain()).every(id => locked.has(id))) {
    throw new SearchLockRetry('a merge chain moved while its rows were being locked: retry the transaction')
  }
  if (products.length) {
    await tx.$queryRaw`SELECT id FROM wine_products WHERE id = ANY(${[...new Set(products)].sort()}::text[]) ORDER BY id FOR NO KEY UPDATE`
  }
}

// The words a transaction's docs brought, published after its COMMIT
// (`publishSearchWords`). Keyed by the transaction client, so a rolled-back
// transaction's words are simply never published.
const pendingWords = new WeakMap<object, Set<string>>()
function noteWords(tx: Prisma.TransactionClient, words: string[]): void {
  if (!words.length) return
  const set = pendingWords.get(tx) ?? new Set<string>()
  for (const w of words) set.add(w)
  pendingWords.set(tx, set)
}

// (4) of the row rule: ONE statement each, computed from the rows as this
// transaction now sees them. Upserts, so a re-index (phase 3) is the same call.
export async function indexProducer(tx: Prisma.TransactionClient, producerId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ words: string[] }[]>`
    INSERT INTO catalog_search_producer_docs (producer_id, tsv)
    SELECT p.id, array_to_tsvector(public.catalog_search_words_v1(p.name_folded)) FROM producers p WHERE p.id = ${producerId}
    ON CONFLICT (producer_id) DO UPDATE SET tsv = EXCLUDED.tsv
    RETURNING tsvector_to_array(tsv) AS words`
  noteWords(tx, rows[0]?.words ?? [])
}

export async function indexProduct(tx: Prisma.TransactionClient, productId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ words: string[] }[]>`
    WITH RECURSIVE lead AS (
      SELECT pr.id, pr.name_folded, pr.links_to FROM product_producers pp JOIN producers pr ON pr.id = pp.producer_id
       WHERE pp.product_id = ${productId} AND pp.role = 'lead'
    ), walk(id, links_to, depth, path) AS (
      SELECT id, links_to, 0, ARRAY[id::text] FROM lead
      UNION ALL
      SELECT p.id, p.links_to, w.depth + 1, w.path || p.id::text
        FROM walk w JOIN producers p ON p.id = w.links_to
       WHERE w.depth < 10 AND p.id::text <> ALL(w.path)
    ), eff AS (SELECT id FROM walk ORDER BY depth DESC LIMIT 1),
    doc AS (
      SELECT wp.id AS product_id,
             public.catalog_search_words_v1(lead.name_folded) AS producer_words,
             CASE WHEN eff.id IS NULL OR eff.id = lead.id THEN ARRAY[]::text[]
                  ELSE public.catalog_search_words_v1(sv.name_folded) END AS survivor_words,
             public.catalog_search_words_v1(wp.name_folded) AS name_words,
             public.catalog_search_words_v1(wp.region_folded) AS region_words
        FROM wine_products wp CROSS JOIN lead LEFT JOIN eff ON true LEFT JOIN producers sv ON sv.id = eff.id
       WHERE wp.id = ${productId}
    )
    INSERT INTO catalog_search_docs (product_id, producer_words, survivor_words, name_words, region_words, tsv_name, tsv)
    SELECT product_id, producer_words, survivor_words, name_words, region_words,
           array_to_tsvector(producer_words || survivor_words || name_words),
           array_to_tsvector(producer_words || survivor_words || name_words || region_words)
      FROM doc
    ON CONFLICT (product_id) DO UPDATE SET
      producer_words = EXCLUDED.producer_words, survivor_words = EXCLUDED.survivor_words, name_words = EXCLUDED.name_words,
      region_words = EXCLUDED.region_words, tsv_name = EXCLUDED.tsv_name, tsv = EXCLUDED.tsv
    RETURNING tsvector_to_array(tsv) AS words`
  noteWords(tx, rows[0]?.words ?? [])
}

// 🔒 The word list is kept LOOSELY: it never decides whether a wine is found,
// only whether a typo lookup runs (lib/catalogSearch.ts: a typed word is always
// its own alternative). So a mint's words are added AFTER its COMMIT, best
// effort, in ONE statement: sorted in byte order (the rebuild inserts in the
// same order), ndoc 1, never updating an
// existing word (no hot row, no lock held through a bottle's transaction)
// EXCEPT one at 0 (no live doc held it: a purged or rejected entry's word),
// which is lifted to 1, or the typo lookup (it skips 0) would not offer the new
// wine's word until the next rebuild (found by the review's mutation run,
// 2026-11-21). A failure is logged and costs at most a typo lookup until the
// next rebuild.
// 🔒 It takes the SHARED catalog-search advisory lock (the rebuild holds the
// exclusive one), so a publication never runs inside a rebuild: one that did
// could have its new word zeroed by the rebuild's orphan step, or deadlock with
// the rebuild's two word passes (re-review 2026-11-21). Bounded by a 2 s
// `lock_timeout`: during a rebuild (about 10 s) it gives up, and the words wait
// for the next rebuild (the wine is found by its words meanwhile). Only words
// that are new or at 0 reach the INSERT's conflict path, so a common word's row
// is never locked by a mint.
export async function addWords(words: string[]): Promise<void> {
  if (!words.length) return
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL lock_timeout = '2s'`,
    prisma.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${CATALOG_SEARCH_LOCK}))`,
    prisma.$executeRaw`
      INSERT INTO catalog_search_words (word, ndoc)
      SELECT w, 1 FROM unnest(${[...new Set(words)]}::text[]) AS x(w)
       WHERE NOT EXISTS (SELECT 1 FROM catalog_search_words e WHERE e.word = x.w COLLATE "C" AND e.ndoc > 0)
       ORDER BY w COLLATE "C"
      ON CONFLICT (word) DO UPDATE SET ndoc = 1 WHERE catalog_search_words.ndoc = 0`,
  ])
}

// Called by every transaction that can mint, right after its COMMIT: the
// session mutation contract (bottle adds and edits), the check-in POST and
// PATCH, and `mintEntries` when it runs its own transaction. A transaction that
// rolled back never gets here, so its words are never published. 🔒 Not
// awaited by the request paths (`void`): it never fails a request, and inside
// the session contract it must not hold the lease before the projection.
export async function publishSearchWords(tx: Prisma.TransactionClient | null | undefined): Promise<void> {
  if (!tx) return
  const set = pendingWords.get(tx)
  if (!set) return
  pendingWords.delete(tx)
  await addWords([...set]).catch(err => console.error('[catalog-search] new words not published (a typo lookup until the next rebuild)', err))
}
