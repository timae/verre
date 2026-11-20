import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { redis, k, touchWithMeta } from '@/lib/redis'
import type { Prisma } from '@prisma/client'
import { isHostByIdentity, isProvider, mutateWines, ensurePromoted, isMutateReject, wineToWire, buildAdderLookup, cleanBottleNotes, type WineMeta } from '@/lib/session'
import { buildWinesView } from '@/lib/sessionState'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved, authUnavailable } from '@/lib/identity'
import { withSessionMutation, admitted, refuse, ContractCold } from '@/lib/sessionMutation'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openSessionFor, servedLineup } from '@/lib/sessionRoute'
import { isClientOccurrenceId, reconcileLineup, insertOccurrence, recordLineup, projectLineup, withSnapshot } from '@/lib/occurrences'
import { isSameOrigin } from '@/lib/csrf'
import { CatalogValidationError } from '@/lib/catalogWrite'
import { prepareLink, applyLink, linkRequired, type AppliedLink } from '@/lib/catalogLink'
import { entryKey } from '@/lib/catalogEntries'

type Ctx = { params: Promise<{ code: string }> }

export async function GET(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // The entrance gate first: 404 only when it is really gone (the client goes
  // home), 503 while a cold moment is restored, distinct from 401 ("session
  // exists but you're not a participant" → /join/<code>).
  const session = await resolveUser(req)
  const opened = await openSessionFor(c, req, session)
  if (opened instanceof NextResponse) return opened
  const { meta } = opened

  const p = await participantOrBanned(c, req, session, opened.meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid('not a participant')
  const identity = p.identity

  // Wire-shape assembly (hideLineup gate, blind redaction branch,
  // wineToWire) lives in lib/sessionState.ts buildWinesView — shared with
  // /api/session/:code/state.
  // The cached line-up when it is stamped with the record's revision, else the
  // record's (model change § 8a).
  const served = await servedLineup(c, opened, identity)
  if (served instanceof NextResponse) return served
  const identities = await redis.hGetAll(k.identities(c))
  const wines = await buildWinesView(c, served.meta, served.identity, identities, served.wines)
  return NextResponse.json(
    wines,
    // Response varies per viewer (blind redaction, the isMine flag). Force
    // private, no-store so no intermediary cache can serve one viewer's
    // payload to another.
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const session = await resolveUser(req)
  const opened = await openSessionFor(c, req, session, { notFound: 'session not found' })
  if (opened instanceof NextResponse) return opened
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { meta } = opened
  // Banned cohosts must not be able to write wines until they next poll
  // and bounce. participantOrBanned does the same check that GET uses.
  const pp = await participantOrBanned(c, req, session, opened.meta)
  if (pp.status === 'unavailable') return authUnavailable()
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity
  // Hosts, cohosts, and providers can all add wines (providers then edit/delete
  // only their own — the [wineId] route). Early reject only: re-decided under
  // the locks from the fresh grant.
  if (!isHostByIdentity(meta, identity) && !isProvider(meta, identity)) {
    return NextResponse.json({ error: 'only the host or a provider can add wines' }, { status: 403 })
  }

  // 🔒 The client mints the occurrence id (model change § 8a "Occurrence ids are
  // client-generated"): a retry after a lost response finds its own bottle
  // instead of adding a second one. A photo is never part of a create: it has
  // its own call (PUT …/wines/<id>/image) against the known id.
  if (!isClientOccurrenceId(body.id)) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (body.image !== undefined && body.image !== null && body.image !== '') {
    return NextResponse.json({ error: 'add the photo with its own call, after the bottle' }, { status: 400 })
  }

  // 🔒 Every new bottle links (catalogue model change step 4, lib/catalogLink.ts):
  // a PICK (`productId` + optional `vintageId`, validated against real rows,
  // generic denials, `rl:catalog-link` when present, keyed by IP for a guest)
  // or a CREATE (`create`: the add-flow body, signed in only, minted below in
  // this bottle's own transaction). The bottle's name, producer, year, kind
  // and abv are its snapshot of the entry; typed identity text is ignored.
  const userId = session?.user ? Number(session.user.id) : null
  // A retry of an add that already landed is answered FIRST (race review r1:
  // after the budgets and the kill switch it could answer 429 / 403 instead of
  // the acknowledgement). Bound to THIS moment and this adder: the record's row
  // when the moment has one, else the cached line-up (a Redis-only moment's
  // authority). The contract's own check below stays the authority.
  const live = await prisma.session.findFirst({ where: { code: c, deletedAt: null }, select: { id: true } })
  const landed = live
    ? (await prisma.$queryRaw<{ x: number }[]>`
        SELECT 1 AS x FROM wines WHERE id = ${String(body.id)} AND session_id = ${live.id} AND added_by_identity_id = ${identity.id}`)[0]
    : opened.wines.find(w => w.id === body.id && w.addedByIdentityId === identity.id)
  if (landed) return NextResponse.json({ id: body.id, alreadyAdded: true })
  const linkReq = await prepareLink(req, body, { userId, identityId: identity.id, pickRate: true, required: true })
  if (linkReq instanceof NextResponse) return linkReq
  if (linkReq.kind === 'none') return linkRequired()
  const notes = cleanBottleNotes(body)

  // The adder's provenance + a frozen snapshot of their display name (survives
  // a later kick / ban).
  const identities = await redis.hGetAll(k.identities(c))
  const adderDisplayName = identities[identity.id] || identity.displayName
  const id = body.id as string
  const bottle = (applied: AppliedLink): WineMeta => withSnapshot({
    id, name: '', producer: '', vintage: '', grape: '', type: '', image: '', imageUrl: '', revealedAt: null,
    description: notes.description || undefined, vinification: notes.vinification || undefined, purchaseUrl: notes.purchaseUrl || undefined,
    addedByIdentityId: identity.id, addedByDisplayName: adderDisplayName,
  }, applied, applied.snapshot)
  // Inside the contract: a CatalogValidationError from the mint is the 400.
  const link = async (tx: Prisma.TransactionClient) => {
    try { return await applyLink(tx, linkReq, userId) }
    catch (err) { if (err instanceof CatalogValidationError) throw refuse(400, err.message); throw err }
  }

  // Promotion stays a logged-in act (an anonymous-only session is never
  // promoted) and runs BEFORE this route's own contract (the locks are not
  // re-entrant). Best-effort here: a failed promotion leaves the session
  // Redis-only and the add proceeds; the next logged-in act retries it.
  if (session?.user) {
    try { await ensurePromoted(c, meta) }
    catch (err) { console.error('[wines] promotion failed', { code: c, err }) }
  }

  // The add, inside the session mutation contract; the power re-decided from
  // the caller's FRESH grant. Mode is decided by the row under the locks
  // (ctx.row), never by the caller's login:
  //   Postgres-backed → RECORD-FIRST (model change § 8a): INSERT … ON CONFLICT
  //     DO NOTHING (never an upsert: a provider must not overwrite another's
  //     bottle by its id); the existing row of this moment and this adder is a
  //     retry, anything else 409; the revision bumped by the row lock; the
  //     line-up projected from the record after COMMIT. A failed write fails
  //     the request (no best-effort mirror).
  //   Redis-only → the fenced `mutateWines` transform, with the same id rule.
  // 🔒 A retry is decided BEFORE the link is applied, so a retried create
  // mints nothing (the entry is permanent identity); a create that then fails
  // (a taken id) rolls its mint and review items back with it.
  // Optional one-shot insert position (1-indexed), host-only (providers cannot
  // reorder); out of range falls through to "append".
  const pos = Number(body.position)
  let added: { added: 'inserted' | 'mine'; wine: WineMeta | null; applied: AppliedLink | null }
  try {
    added = await withSessionMutation(c, { label: 'wine-add', redisLock: { waitMs: 3000 }, caller: identity, bumpLineup: true }, async (tx, ctx) => {
      const caller = admitted(ctx)
      if (!isHostByIdentity(ctx.meta!, caller) && !isProvider(ctx.meta!, caller)) {
        throw refuse(403, 'only the host or a provider can add wines')
      }
      const callerIsHost = isHostByIdentity(ctx.meta!, caller)
      const heldBy = async () => (await tx.$queryRaw<{ session_id: number | null; added_by_identity_id: string | null }[]>`
        SELECT session_id, added_by_identity_id FROM wines WHERE id = ${id}`)[0]
      if (ctx.row) {
        const revision = (await reconcileLineup(tx, ctx))!
        // After the reconciliation (it may copy this very id in from the cache).
        const held = await heldBy()
        if (held) {
          if (held.session_id === ctx.row.id && held.added_by_identity_id === caller.id) return { added: 'mine' as const, wine: null, applied: null, lineup: null, revision: null }
          throw refuse(409, 'that id belongs to another bottle')
        }
        const applied = await link(tx)
        const w = bottle(applied)
        const count = (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM wines WHERE session_id = ${ctx.row.id}`)[0].n
        const at = callerIsHost && Number.isInteger(pos) && pos >= 1 && pos < Number(count) + 1 ? pos - 1 : null
        const r = await insertOccurrence(tx, ctx.row.id, w, at, applied.snapshot)
        if (r !== 'inserted') throw refuse(409, 'that id belongs to another bottle')
        return { added: 'inserted' as const, wine: w, applied, lineup: await recordLineup(tx, ctx.row.id), revision }
      }
      // A guest may not take an id the record already holds (another moment's
      // bottle): it would be dropped at promotion.
      if (await heldBy()) throw refuse(409, 'that id belongs to another bottle')
      // A new wine is minted only into the record (race review r1: this branch
      // writes the cache before COMMIT, so a rolled-back mint could stay linked
      // in it). A signed-in caller lands here only when its promotion failed:
      // retry. Picks are fine.
      if (linkReq.kind === 'create') throw refuse(503, 'Try again in a moment.', { 'Retry-After': '1' })
      // The cached line-up is this moment's authority, and this contract holds
      // its lock: a retry is read here, before anything is minted.
      const cached = await redis.get(k.wines(c))
      if (cached === null) throw new ContractCold(c)
      const prior = (JSON.parse(cached) as WineMeta[]).find(w => w.id === id)
      if (prior) {
        if (prior.addedByIdentityId === caller.id) return { added: 'mine' as const, wine: null, applied: null, lineup: null, revision: null }
        throw refuse(409, 'that id belongs to another bottle')
      }
      const applied = await link(tx)
      const w = bottle(applied)
      const next = await mutateWines(ctx.fence!, (current) => {
        if (current.some(x => x.id === id)) return { reject: 'conflict' }
        const out = current.slice()
        if (callerIsHost && Number.isInteger(pos) && pos >= 1 && pos < out.length + 1) out.splice(pos - 1, 0, w)
        else out.push(w)
        return out
      })
      // Rolls back a mint with it (the lock makes this a re-check only).
      if (isMutateReject(next)) throw refuse(409, 'that id belongs to another bottle')
      return { added: 'inserted' as const, wine: w, applied, lineup: null, revision: null }
    }, async (ctx, r) => { if (r.lineup && r.revision !== null) await projectLineup(ctx.fence!, r.lineup, r.revision) })
  } catch (err) {
    return contractFailure(err, c, { label: 'wine-add' })
  }
  // 🔒 A retry that found its own bottle answers an identity-free
  // acknowledgement (model change § 8a, Codex r1/r2): what is stored may be
  // what a host changed since (a re-link under Blind for Everyone, a hidden
  // line-up), so the client re-reads through the GET, which applies every rule.
  if (added.added === 'mine' || !added.wine || !added.applied) return NextResponse.json({ id, alreadyAdded: true })
  await touchWithMeta(c)

  // Same wire shape as GET — clients that store POST responses back
  // into their wines list shouldn't see a different shape than the
  // polling GET. The caller is the wine's adder, so isMine is always
  // true here (wineToWire computes it from the just-written provenance).
  // Pass identities so `addedByDisplayName` resolves to the live name; the
  // adder lookup carries the caller's public id (`addedByUserId`).
  // showProvenance honours the "Show who brought each impression" setting so
  // this echo can't leak attribution the polling GET (buildWinesView) strips.
  // The entry is the one just linked (the adder chose it).
  const { wine, applied } = added
  const lookup = await buildAdderLookup([wine], identities)
  const entries = new Map([[entryKey(applied.productId, applied.vintageId), applied.entry]])
  const snapshots = new Map([[wine.id, { colour: applied.snapshot.colour, sparkling: applied.snapshot.sparkling, abv: applied.snapshot.abv, productId: applied.productId, vintageId: applied.vintageId, revealedAt: wine.revealedAt ?? null }]])
  return NextResponse.json(wineToWire(wine, identity.id, identities, lookup, meta.showProvenance !== false, entries, snapshots))
}
