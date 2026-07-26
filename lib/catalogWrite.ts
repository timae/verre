import { nanoid } from 'nanoid'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import { scrub, cleanUrl, cleanCountry } from '@/lib/textSafe'
import { normalizeVintageText } from '@verre/core'

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
// itself. An `a:<uuid>` anon identity is MINTED FRESH ON EVERY JOIN, and the
// join endpoint calls `resetRate` on every SUCCESSFUL join — so a caller who
// holds one valid session code (trivially, one they created themselves) can
// rejoin in a loop, collect unlimited identities, and get a fresh budget with
// each one. Keying those on identity bounded nothing: measured, 20 rotated
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
//   • THIS function, at CATALOG PROMOTION, accepts only 1900..current+1, because
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
//   1900..current+1     → that dated vintage row
//   anything else (pre-1900, implausible future, legacy junk) → PRESERVE the
//                         encounter string, default to PRODUCT-grain linkage +
//                         manual disposition; never auto-mint a vintage
export function validateYear(year: number | null): number | null {
  if (year === null) return null
  if (!Number.isInteger(year)) throw new CatalogValidationError('year must be an integer')
  const max = new Date().getUTCFullYear() + 1
  if (year < 1900 || year > max) {
    throw new CatalogValidationError(`year must be between 1900 and ${max}`)
  }
  return year
}

export type NewProducerInput = {
  name: string
  country?: unknown
  region?: unknown
  website?: unknown
}

export type NewProductInput = {
  name: string
  producerId: string
  category?: string
  style?: string | null
  abv?: number | null
  grapes?: unknown
  region?: unknown
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
  const style = optionalFact(input.style, 64)
  const region = optionalFact(input.region)
  const grapes = normalizeGrapes(input.grapes)
  const abv = normalizeAbv(input.abv)
  if (!input.producerId) throw new CatalogValidationError('producerId is required')
  // A producer cannot be its own collaborator, and duplicates would fail the
  // composite PK mid-transaction. Filter before the write so the caller gets a
  // clear error path rather than a constraint violation.
  const collaborators = [...new Set(collaboratorIds)].filter(p => p && p !== input.producerId)

  const run = async (t: Prisma.TransactionClient) => {
    await t.wineProduct.create({
      data: {
        id,
        name,
        category,
        style,
        abv,
        grapes,
        region,
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
  return { id: data.id }
}

// ⚠️ Prisma Decimal serializes to a JSON STRING, and the column is
// DECIMAL(4,2) with a CHECK of 0..25 — note the type caps magnitude at 99.99
// first, so an out-of-range value raises "numeric field overflow" from the
// TYPE before the CHECK is ever reached. Bounding here gives a clean 400
// instead of a 500 from either.
function normalizeAbv(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 25) {
    throw new CatalogValidationError('abv must be between 0 and 25')
  }
  return Math.round(n * 100) / 100
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
// `addWineToSession` already implements one layer down. Callers that have no
// stored link (creates) simply omit it.
export async function resolveCatalogLink(
  productId: unknown,
  vintageId: unknown,
  existing?: { productId?: string | null; vintageId?: string | null },
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

  const product = await prisma.wineProduct.findUnique({
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

  const vintage = await prisma.wineVintage.findUnique({
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

// ── The identity-changing-edit rule ────────────────────────────────────────
//
// 🔒 A wine-instance edit that changes the instance's IDENTITY must not
// silently keep a now-incompatible catalog link (RFC § Identity-changing wine
// edits). Wine-instance fields are historical SNAPSHOTS — they do not derive
// from live catalog facts — so an edit that renames the wine, changes its
// producer, or changes its year has, as far as the catalog is concerned,
// pointed the instance at a different thing. Keeping the old link there would
// silently attribute one label's ratings to another.
//
// Cosmetic edits (photo, description, region, a typo-level fix confirmed
// against the SAME entry) keep the link. That is why this compares the three
// IDENTITY fields only — widening it to every field would clear links on a
// photo upload, and narrowing it to `name` alone would keep the link across a
// producer change, which is the worst case.
//
// The editor can always RE-LINK explicitly in the same request by sending
// productId/vintageId, which takes precedence — this only decides what happens
// when they DON'T.
//
// Returns the link the write should carry.
export function applyIdentityEditRule(
  existing: { name: string; producer: string; vintage: string; productId?: string | null; vintageId?: string | null },
  incoming: { name?: unknown; producer?: unknown; vintage?: unknown },
  explicitLink: { productId: string | null; vintageId: string | null } | null,
): { productId: string | null; vintageId: string | null } {
  // An explicit re-link (or an explicit clear) always wins — the editor said so.
  if (explicitLink) return explicitLink
  if (!existing.productId) return { productId: null, vintageId: null }
  // Only fields PRESENT in the body count. A PATCH that omits `producer`
  // entirely is not changing the producer, so it must not be read as a change
  // to the empty string.
  // 🔒 COMPARE WHAT WILL ACTUALLY BE STORED, not the raw body value.
  //
  // The write paths normalize before storing — `scrub()` strips control and
  // zero-width characters, and `vintage` goes through the shared canonicalizer
  // — so comparing the RAW incoming value against the STORED one reports a
  // change where the stored value would not actually move. Verified example: a
  // name carrying a zero-width character cleared the link, because scrub()
  // removes the character and leaves the stored value byte-identical.
  //
  // ⚠️ The vintage rule is NOT truncation. It is exactly-four-digits-or-NV,
  // else empty, so an overlong '2019-2020' becomes EMPTY rather than '2019' —
  // that genuinely moves the stored value and MUST clear the link. An earlier
  // version of this comment (and an integration expectation) described the
  // truncating write and became wrong when the contract tightened.
  //
  // Over-clearing fails SAFE but silently drops correct links on edits that
  // change nothing, which is the failure this rule exists to avoid.
  //
  // On top of the write's own normalization: trim, case-fold, and collapse
  // internal whitespace. Those three are typographic, not identity — "Grand
  // Vin" and "Grand  Vin" are the same wine.
  //
  // Deliberately NOT accent-folded. Accents can distinguish real labels, and
  // unlike the catalog's own matching path there is no generated column here to
  // keep a second fold honest — so this stays a conservative string compare.
  const norm = (v: unknown, field: 'name' | 'producer' | 'vintage') => {
    // Mirrors lib/session.ts `clean()` (scrub → '') and its vintage rule. If
    // those write-path rules change, this must change with them.
    //
    // 🔒 NO `String(v)` COERCION — the write path does `scrub(v)`, and `scrub`
    // returns null for any non-string. Stringifying here made the comparator
    // strictly more permissive than the write: a PATCH carrying NUMERIC 2019
    // compared equal to a stored '2019' (so the link was KEPT) while the write
    // stored '' — a blank vintage still linked to a vintage-grain catalog row.
    // Same defect class as the omitted-vs-empty edit bug, reached by a different
    // route. The comparator must model what the write ACTUALLY does, including
    // its type rejection.
    let s = scrub(v) ?? ''
    // 🔒 The SHARED normalizer, not `.slice(0, 4)`. The write path canonicalizes
    // NV tokens ('N.V.' → 'NV'), so a slice-based compare reported a change on
    // an edit that only canonicalized — silently CLEARING a correct catalog
    // link. Measured: stored 'N.V.' + incoming 'NV' → {productId: null,
    // vintageId: null}. Using the same function the write uses makes
    // "compare what will actually be stored" true rather than approximate.
    if (field === 'vintage') s = normalizeVintageText(s)
    return s.trim().toLowerCase().replace(/\s+/g, ' ')
  }
  const changed = (field: 'name' | 'producer' | 'vintage'): boolean => {
    const next = incoming[field]
    if (next === undefined) return false
    // 🔒 MODEL THE WRITE'S FALLBACK, not just its normalization. `name` is
    // REQUIRED, so both write paths do `scrub(name) || existing` — an invalid
    // (non-string) or blank name is IGNORED and the stored name is retained.
    // Nothing moves, so the link must survive. Without this the comparator
    // cleared a correct link on an edit the write discarded, which is the same
    // over-clearing class as the `.slice(0,4)` and `String(v)` defects.
    //
    // ⚠️ `vintage` is deliberately NOT symmetric: it is OPTIONAL, so the write
    // stores the normalized value even when that is empty — a blank or numeric
    // vintage really does move the stored value, and really must clear the link.
    // The asymmetry is the write paths', not this function's invention.
    if (field === 'name' && norm(next, field) === '') return false
    return norm(existing[field], field) !== norm(next, field)
  }
  if (changed('name') || changed('producer') || changed('vintage')) {
    return { productId: null, vintageId: null }
  }
  return { productId: existing.productId ?? null, vintageId: existing.vintageId ?? null }
}
