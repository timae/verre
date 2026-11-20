import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity, isProvider, mutateWines, normalizeWine, ensurePromoted, isMutateReject, wineToWire, buildAdderLookup } from '@/lib/session'
import { buildWinesView } from '@/lib/sessionState'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved, authUnavailable } from '@/lib/identity'
import { withSessionMutation, admitted, refuse } from '@/lib/sessionMutation'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openSessionFor, servedLineup } from '@/lib/sessionRoute'
import { isClientOccurrenceId, reconcileLineup, insertOccurrence, recordLineup, projectLineup } from '@/lib/occurrences'
import { isSameOrigin } from '@/lib/csrf'
import { checkRate, getClientIp } from '@/lib/rateLimit'
import { resolveCatalogLink, catalogLinkRateKey, CatalogValidationError } from '@/lib/catalogWrite'

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

  // 🔒 The catalog link is validated SERVER-SIDE against real rows before it is
  // stored — a raw body value is just a string the client sent. resolveCatalogLink
  // rejects an unknown id, a vintage that belongs to a DIFFERENT product, a
  // tombstone or rejected entry, and vintageId-without-productId.
  //
  // Charged only when a link is actually supplied, so ordinary wine-adding is
  // unaffected. The cap exists because this reaches the catalog from OUTSIDE
  // the CATALOG_PUBLIC_ENABLED fence. Same key on POST and PATCH (the
  // shared-counter pattern in app/api/CLAUDE.md) so add + edit can't stack N+N.
  // 🔒 The key comes from catalogLinkRateKey, which buckets ANONYMOUS callers by
  // IP rather than identity (an `a:<uuid>` is re-minted on every join).
  if (body.productId !== undefined || body.vintageId !== undefined) {
    const rl = await checkRate(catalogLinkRateKey(identity.id, getClientIp(req)), 120, 3600)
    if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  let link: { productId: string | null; vintageId: string | null }
  try {
    link = await resolveCatalogLink(body.productId, body.vintageId)
  } catch (err) {
    if (err instanceof CatalogValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }

  // The adder's provenance + a frozen snapshot of their display name (survives
  // a later kick / ban).
  const identities = await redis.hGetAll(k.identities(c))
  const adderDisplayName = identities[identity.id] || identity.displayName
  const result = normalizeWine({ ...body, ...link }, undefined, identity.id, adderDisplayName)
  if ('error' in result) return NextResponse.json(result, { status: 400 })

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
  // Optional one-shot insert position (1-indexed), host-only (providers cannot
  // reorder); out of range falls through to "append".
  const pos = Number(body.position)
  let added: 'inserted' | 'mine'
  try {
    added = await withSessionMutation(c, { label: 'wine-add', redisLock: { waitMs: 3000 }, caller: identity, bumpLineup: true }, async (tx, ctx) => {
      const caller = admitted(ctx)
      if (!isHostByIdentity(ctx.meta!, caller) && !isProvider(ctx.meta!, caller)) {
        throw refuse(403, 'only the host or a provider can add wines')
      }
      const callerIsHost = isHostByIdentity(ctx.meta!, caller)
      if (ctx.row) {
        const revision = (await reconcileLineup(tx, ctx))!
        const count = (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM wines WHERE session_id = ${ctx.row.id}`)[0].n
        const at = callerIsHost && Number.isInteger(pos) && pos >= 1 && pos < Number(count) + 1 ? pos - 1 : null
        const r = await insertOccurrence(tx, ctx.row.id, result, at)
        if (r === 'conflict') throw refuse(409, 'that id belongs to another bottle')
        return { added: r, lineup: await recordLineup(tx, ctx.row.id), revision }
      }
      // A guest may not take an id the record already holds (another moment's
      // bottle): it would be dropped at promotion.
      if ((await tx.$queryRaw<{ x: number }[]>`SELECT 1 AS x FROM wines WHERE id = ${result.id}`)[0]) throw refuse(409, 'that id belongs to another bottle')
      const next = await mutateWines(ctx.fence!, (current) => {
        const existing = current.find(w => w.id === result.id)
        if (existing) return { reject: existing.addedByIdentityId === caller.id ? 'mine' : 'conflict' }
        const out = current.slice()
        if (callerIsHost && Number.isInteger(pos) && pos >= 1 && pos < out.length + 1) out.splice(pos - 1, 0, result)
        else out.push(result)
        return out
      })
      if (isMutateReject(next)) {
        if (next.reject === 'mine') return { added: 'mine' as const, lineup: null, revision: null }
        throw refuse(409, 'that id belongs to another bottle')
      }
      return { added: 'inserted' as const, lineup: null, revision: null }
    }, async (ctx, r) => { if (r.lineup && r.revision !== null) await projectLineup(ctx.fence!, r.lineup, r.revision) }).then(r => r.added)
  } catch (err) {
    return contractFailure(err, c, { label: 'wine-add' })
  }
  // 🔒 A retry that found its own bottle answers an identity-free
  // acknowledgement (model change § 8a, Codex r1/r2): what is stored may be
  // what a host changed since (a re-link under Blind for Everyone, a hidden
  // line-up), so the client re-reads through the GET, which applies every rule.
  if (added === 'mine') return NextResponse.json({ id: result.id, alreadyAdded: true })
  await touchWithMeta(c)

  // Same wire shape as GET — clients that store POST responses back
  // into their wines list shouldn't see a different shape than the
  // polling GET. The caller is the wine's adder, so isMine is always
  // true here (wineToWire computes it from the just-written provenance).
  // Pass identities so `addedByDisplayName` resolves to the live name; the
  // adder lookup carries the caller's public id (`addedByUserId`).
  // showProvenance honours the "Show who brought each impression" setting so
  // this echo can't leak attribution the polling GET (buildWinesView) strips.
  const lookup = await buildAdderLookup([result], identities)
  return NextResponse.json(wineToWire(result, identity.id, identities, lookup, meta.showProvenance !== false))
}
