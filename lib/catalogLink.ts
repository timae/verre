import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { checkRate, getClientIp } from '@/lib/rateLimit'
import { canUseCatalog } from '@/lib/catalogGate'
import { resolveCatalogLink, catalogLinkRateKey, CatalogValidationError, denyCatalogRef, normalizeAbv, reportVintageAbv } from '@/lib/catalogWrite'
import { mintEntries } from '@/lib/catalogAddFlow'
import { loadEntries, entryKey, snapshotFromEntry, isReplayedCreate, type CatalogEntry, type EntrySnapshot } from '@/lib/catalogEntries'

// ── The catalogue on every bottle write (catalogue model change step 4) ─────
//
// 🔒 EVERY NEW BOTTLE LINKS (spec § 2): a session add and a check-in either
// PICK an existing entry (`productId` + optional `vintageId`, validated by
// `resolveCatalogLink`, generic denials, anyone admitted) or CREATE one through
// the add flow (`create`: the `/api/catalog/entries` body, signed in only,
// minted in the bottle's own transaction). The bottle's name, producer, year,
// kind and abv are then its SNAPSHOT of the entry, never the body's free text
// (`snapshotFromEntry`). Free-text identity fields in a body are ignored.
//
// Two halves: `prepareLink` runs before any lock (shape, the guest refusal, the
// kill switch, the budgets; it never reads the target bottle); `applyLink`
// runs inside the writer's transaction, AFTER the writer's own power decision
// (a pick's validation against the bottle as locked, a create's mint, the
// entry read for the snapshot).

export const LINK_REQUIRED = 'Choose a wine from the catalogue, or add a new one.'
// 🔒 ONE fixed refusal for a guest's create, answered before anything in the
// body is looked at: the same words whatever ids it names (no classifier,
// like denyCatalogRef).
export const GUEST_CREATE_REFUSED = 'Sign in to add a wine that isn’t in the catalogue yet.'
export const CREATE_CLOSED = 'Adding new wines is unavailable right now.'
export const CANNOT_UNLINK = 'A bottle stays linked to a wine. Choose the right one instead.'
// A partial pick (no productId) on a bottle hidden from the caller: refused
// with ONE answer before it is resolved (review r2: under Blind for Everyone a
// host is masked like a taster, and `{vintageId}` alone answered 400 or 200 by
// whether the guess was the hidden wine's, silently re-dating it on a hit).
export const PICK_WHOLE = 'Choose the wine and its year together.'
export const CREATE_HIDDEN = 'Reveal this bottle before you add a new wine for it.'
// The alcohol on a pick (0.2.0 build 2): a year the catalogue lists without
// one. Signed in, a year named, the catalogue open; refused on a bottle hidden
// from the caller (the wine PATCH).
export const GUEST_ABV_REFUSED = 'Sign in to add the alcohol.'
export const ABV_NEEDS_YEAR = 'Choose the year to add its alcohol.'
export const ABV_CLOSED = 'Adding the alcohol is unavailable right now.'
export const ABV_HIDDEN = 'Reveal this bottle before you add its alcohol.'
const ABV_INVALID = 'abv must be between 0 and 25'

// A pick carries the body's RAW ids: it is resolved under the writer's locks
// (`applyLink`), against the bottle's link as it stands there, after the
// writer decided the caller may edit it (security review r1: resolved before
// the locks against the target's stored link, a partial pick let a provider
// learn whether a guessed vintage belongs to someone else's blind bottle, 400
// vs 403; race review r1: a pick prepared before a concurrent re-link wrote
// the old product back, and an entry rejected meanwhile was still linked).
// `abv` on a pick: a year's alcohol to REPORT (lib/catalogWrite.ts
// `reportVintageAbv`), validated here, written in `applyLink`.
export type LinkRequest =
  | { kind: 'pick'; productId: unknown; vintageId: unknown; abv: number | null }
  | { kind: 'create'; body: Record<string, unknown> }
  | { kind: 'none' }

// LINK_REQUIRED also carries `code: 'link-required'`: a client that sent no
// link ("had a sip" of a source with nothing linkable left) shows its picker on
// that answer only.
const bad = (status: number, error: string) =>
  NextResponse.json(error === LINK_REQUIRED ? { error, code: 'link-required' } : { error }, { status, headers: { 'Cache-Control': 'private, no-store' } })
export const linkRequired = () => bad(400, LINK_REQUIRED)

// Before the locks. `userId` from the authenticated context (null = a guest).
// `pickRate`: the session routes charge `rl:catalog-link` on a pick (the
// check-in routes ride `rl:checkin`). `required`: a create path (no link →
// 400); an edit passes false.
export async function prepareLink(
  req: Request,
  body: Record<string, unknown>,
  opts: { userId: number | null; identityId: string; pickRate: boolean; required: boolean },
): Promise<LinkRequest | NextResponse> {
  const picks = body.productId !== undefined || body.vintageId !== undefined
  if (body.create !== undefined) {
    if (picks) return bad(400, 'pick a wine or add a new one, not both')
    if (opts.userId === null) return bad(403, GUEST_CREATE_REFUSED)
    if (!body.create || typeof body.create !== 'object' || Array.isArray(body.create)) return bad(400, 'create must be an object')
    if (!(await canUseCatalog(opts.userId))) return bad(403, CREATE_CLOSED)
    // The /api/catalog/entries budget, shared: a junk entry is permanent and
    // only a curator can tidy it.
    const rl = await checkRate(`rl:catalog-create:u:${opts.userId}:1h`, 60, 3600)
    if (!rl.allowed) return bad(429, 'Too many requests')
    return { kind: 'create', body: body.create as Record<string, unknown> }
  }
  if (!picks) return opts.required ? bad(400, LINK_REQUIRED) : { kind: 'none' }
  if (body.productId === null) return bad(400, CANNOT_UNLINK)
  // 🔒 An alcohol on a pick is a catalogue contribution like a create: a guest
  // gets ONE fixed refusal before anything else in it is looked at, then the
  // year, the value, the kill switch and the create budget (shared: a report
  // reaches the data side like a mint does). Absent, null and '' are no value;
  // anything but a number or a numeric string is refused (review r1: `Number()`
  // read true as 1, [12] as 12 and ' ' as 0, and the first value wins for all).
  let abv: number | null = null
  if (body.abv !== undefined && body.abv !== null && body.abv !== '') {
    if (opts.userId === null) return bad(403, GUEST_ABV_REFUSED)
    if (typeof body.vintageId !== 'string' || !body.vintageId) return bad(400, ABV_NEEDS_YEAR)
    if (!(typeof body.abv === 'number' || (typeof body.abv === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(body.abv)))) return bad(400, ABV_INVALID)
    try { abv = normalizeAbv(body.abv) } catch (err) { if (err instanceof CatalogValidationError) return bad(400, err.message); throw err }
    if (!(await canUseCatalog(opts.userId))) return bad(403, ABV_CLOSED)
    const rl = await checkRate(`rl:catalog-create:u:${opts.userId}:1h`, 60, 3600)
    if (!rl.allowed) return bad(429, 'Too many requests')
  }
  if (opts.pickRate) {
    const rl = await checkRate(catalogLinkRateKey(opts.identityId, getClientIp(req)), 120, 3600)
    if (!rl.allowed) return bad(429, 'Too many requests')
  }
  return { kind: 'pick', productId: body.productId, vintageId: body.vintageId, abv }
}

export type AppliedLink = { productId: string; vintageId: string | null; entry: CatalogEntry; snapshot: EntrySnapshot }

// Inside the writer's transaction, after its own power decision. A pick is
// validated here (`resolveCatalogLink`, one generic denial); `existing` = the
// bottle's link AS LOCKED (an edit), so a partial pick keeps the untouched
// grain of the current row; a pick's alcohol is reported on the vintage it
// resolved to (ignored when that year shows one already). A create mints (its
// review items with it). Then the entry is read through the resolver for the
// snapshot, so a report just written is on it. Throws CatalogValidationError →
// the caller's 400.
export async function applyLink(
  tx: Prisma.TransactionClient, link: Exclude<LinkRequest, { kind: 'none' }>, userId: number | null,
  existing?: { productId?: string | null; vintageId?: string | null },
): Promise<AppliedLink> {
  let productId: string, vintageId: string | null
  if (link.kind === 'create') {
    if (userId === null) throw new CatalogValidationError(GUEST_CREATE_REFUSED)
    const minted = await mintEntries(link.body, userId, tx)
    productId = minted.productId
    vintageId = minted.vintageId
  } else {
    const r = await resolveCatalogLink(link.productId, link.vintageId, existing, tx)
    if (!r.productId) throw new CatalogValidationError(existing ? CANNOT_UNLINK : LINK_REQUIRED)
    productId = r.productId
    vintageId = r.vintageId
    // The resolved vintage equals the body's today (a pick of a tombstone is
    // refused); if picks ever follow merges (phase 3), this stays the effective one.
    if (link.abv !== null && vintageId !== null && userId !== null) await reportVintageAbv(tx, vintageId, link.abv, userId)
  }
  const entry = (await loadEntries([{ productId, vintageId }], tx)).get(entryKey(productId, vintageId))
  if (!entry) throw denyCatalogRef(`entry ${productId}/${vintageId} not readable`)
  return { productId, vintageId, entry, snapshot: snapshotFromEntry(entry) }
}

// An EDIT's link (a re-link), under the locks after the power decision. 🔒 A
// re-link that CREATES has no occurrence id to make it idempotent: a PATCH
// `create` retried after a lost answer would mint a second permanent entry
// (race review r1). So when the bottle is already linked to an entry THIS
// caller minted with exactly the fields this `create` names, it is that retry:
// null, nothing new is linked (`isReplayedCreate`, lib/catalogEntries.ts).
export async function applyRelink(
  tx: Prisma.TransactionClient, link: LinkRequest, userId: number | null,
  current: { productId?: string | null; vintageId?: string | null },
): Promise<AppliedLink | null> {
  if (link.kind === 'none') return null
  if (link.kind === 'create' && userId !== null && await isReplayedCreate(tx, current, link.body, userId)) return null
  return applyLink(tx, link, userId, current)
}
