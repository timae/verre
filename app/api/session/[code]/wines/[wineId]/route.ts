import { reclaimImages } from '@/lib/engagementCascade'
import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta, scanKeys } from '@/lib/redis'
import { isHostByIdentity, isProvider, mutateWines, isMutateReject, cleanBottleNotes, reassignProvenance } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved, authUnavailable, isTombstoneIdentityId } from '@/lib/identity'
import { parseWireIdentity, internalIdentity } from '@/lib/publicIds'
import { isSameOrigin } from '@/lib/csrf'
import { CatalogValidationError } from '@/lib/catalogWrite'
import { prepareLink, applyRelink, PICK_WHOLE, CREATE_HIDDEN } from '@/lib/catalogLink'
import { withSessionMutation, admitted, refuse, ContractCold, type MutationCtx } from '@/lib/sessionMutation'
import { readGrant, grantStatus, type AuthorizedIdentity } from '@/lib/sessionGrant'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openSessionFor } from '@/lib/sessionRoute'
import { beforeBottleDelete, afterRelink } from '@/lib/cravings'
import { reconcileLineup, lockOccurrence, relinkOccurrence, editOccurrenceNotes, withSnapshot, recordLineup, projectLineup, renumber, readOccurrence } from '@/lib/occurrences'
import type { WineMeta, SessionMeta } from '@/lib/session'
import { buildWineEcho } from '@/lib/sessionState'

// The target bottle under the contract's locks, and the caller's power over it
// (host / cohost: any bottle; provider: only its own). In a Postgres-backed
// moment both come from the RECORD (model change § 8a: the provider-ownership
// check and the "target concurrently deleted" reject come from rows, for every
// caller); in a Redis-only moment from the cached line-up, its authority.
async function lockedTarget(tx: Prisma.TransactionClient, ctx: MutationCtx, wineId: string): Promise<WineMeta | null> {
  if (ctx.row) {
    await reconcileLineup(tx, ctx)
    return lockOccurrence(tx, ctx.row.id, wineId)
  }
  const raw = await redis.get(k.wines(ctx.code))
  if (raw === null) throw new ContractCold(ctx.code)
  return (JSON.parse(raw) as WineMeta[]).find(w => w.id === wineId) ?? null
}
const mayEdit = (ctx: MutationCtx, caller: AuthorizedIdentity, wine: WineMeta) =>
  isHostByIdentity(ctx.meta!, caller) || (isProvider(ctx.meta!, caller) && wine.addedByIdentityId === caller.id)

type Ctx = { params: Promise<{ code: string; wineId: string }> }

export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const opened = await openSessionFor(c, req, session)
  if (opened instanceof NextResponse) return opened
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { meta, wines } = opened
  const pp = await participantOrBanned(c, req, session, opened.meta)
  if (pp.status === 'unavailable') return authUnavailable()
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity

  // The bottle as cached, else as recorded (a cache behind the record must not
  // 404 a bottle that exists); re-read under the locks below.
  const before = wines.find(w => w.id === wineId) ?? await readOccurrence(c, wineId)
  if (!before) return NextResponse.json({ error: 'wine not found' }, { status: 404 })

  // Hosts (including cohosts) can edit any wine. Providers can edit only the
  // wines they added. Early reject only: the power and the ownership are
  // re-decided under the locks (fresh grant, the locked row).
  const isHost = isHostByIdentity(meta, identity)
  const isOwnAsProvider = isProvider(meta, identity) && (!!identity.grant || before.addedByIdentityId === identity.id)
  if (!isHost && !isOwnAsProvider) {
    return NextResponse.json({ error: 'only the host or the provider who added this wine can edit it' }, { status: 403 })
  }

  // ── Reassign "Brought by" — bounded v1 (docs/dev/proposals/reassign-brought-by.md).
  // OWNERSHIP-ONLY: a PATCH carrying broughtByIdentityId may carry nothing else.
  if (body.broughtByIdentityId !== undefined) {
    return reassignBroughtBy({ c, wineId, body, identity, isHost, meta, showProvenance: meta.showProvenance !== false })
  }
  // A photo has its own call (PUT …/image, DELETE …/image): an edit carries
  // the bottle's fields only.
  if (body.image !== undefined) {
    return NextResponse.json({ error: 'change the photo with its own call' }, { status: 400 })
  }

  // ── What an edit may change (catalogue model change step 4) ──────────────
  //
  // 🔒 A bottle's identity is its catalogue link: an identity edit is a RE-LINK
  // (a pick, or a create through the add flow: signed in only), and it writes
  // the WHOLE snapshot from the new entry. Typed identity text (name, producer,
  // year, type, grape, region, country) is ignored: it never becomes the
  // snapshot. A cosmetic edit writes only the bottle's own fields it SENT
  // (About, vinification, the purchase link), decided against the row as it
  // stands under the locks: nothing prepared before the lock is written back
  // (the interleaved-PATCH rule, spec § 9: an edit queued behind a re-link
  // must not put the old wine's name on the new link). A linked bottle is
  // never unlinked (400). The link limiter (`rl:catalog-link`, shared with the
  // POST) is charged only when a link is sent.
  const userId = session?.user ? Number(session.user.id) : null
  const linkReq = await prepareLink(req, body, { userId, identityId: identity.id, pickRate: true, required: false })
  if (linkReq instanceof NextResponse) return linkReq
  const notes = cleanBottleNotes(body)
  // 🔒 Resolved under the locks, AFTER mayEdit, against the bottle as locked
  // (security review r1: before the locks a partial pick on someone else's
  // bottle answered 400 vs 403 by whether the guessed vintage was its wine's).
  const link = async (tx: Prisma.TransactionClient, current: WineMeta) => {
    try { return await applyRelink(tx, linkReq, userId, current) }
    catch (err) { if (err instanceof CatalogValidationError) throw refuse(400, err.message); throw err }
  }
  const withNotes = (w: WineMeta): WineMeta => ({
    ...w,
    ...(notes.description !== undefined ? { description: notes.description || undefined } : {}),
    ...(notes.vinification !== undefined ? { vinification: notes.vinification || undefined } : {}),
    ...(notes.purchaseUrl !== undefined ? { purchaseUrl: notes.purchaseUrl || undefined } : {}),
  })
  let lineup: WineMeta[]
  try {
    lineup = await withSessionMutation(c, { label: 'wine-edit', redisLock: { waitMs: 3000 }, caller: identity, bumpLineup: true }, async (tx, ctx) => {
      const caller = admitted(ctx)
      const wine = await lockedTarget(tx, ctx, wineId)
      if (!wine) throw refuse(404, 'wine not found')
      if (!mayEdit(ctx, caller, wine)) throw refuse(403, 'only the host or the provider who added this wine can edit it')
      // A new wine is minted only into the record (race review r1: a Redis-only
      // moment writes its cache before COMMIT, so a rolled-back mint could stay
      // linked there). A signed-in caller in a Redis-only moment means its
      // promotion failed: retry.
      if (!ctx.row && linkReq.kind === 'create') throw refuse(503, 'Try again in a moment.', { 'Retry-After': '1' })
      // 🔒 A bottle hidden from this caller (blind, unrevealed, Blind for
      // Everyone: the only way a caller who may edit it is masked) takes no
      // PARTIAL pick: a missing grain would be resolved against the hidden
      // wine (review r2: `{vintageId}` alone; r3: `{productId}` alone keeps the
      // stored vintage). Both keys, or the one fixed refusal.
      const blind = ctx.row ? !!ctx.row.blind : !!ctx.meta!.blind
      const forEveryone = ctx.row ? !!ctx.row.blindForEveryone : !!ctx.meta!.blindForEveryone
      const hidden = blind && forEveryone && !wine.revealedAt
      if (hidden && linkReq.kind === 'pick' && (linkReq.productId === undefined || linkReq.vintageId === undefined)) throw refuse(400, PICK_WHOLE)
      // …and no CREATE (Codex r1): its replay answer (no mint) against a miss
      // (the mint's own validation) would tell which hidden bottle is which of
      // the caller's wines. A whole pick still re-links it.
      if (hidden && linkReq.kind === 'create') throw refuse(400, CREATE_HIDDEN)
      const applied = await link(tx, wine)
      if (ctx.row) {
        // A re-link carries the bottle's cravings to the new wine (R3).
        if (applied) { await relinkOccurrence(tx, ctx.row.id, wineId, applied, applied.snapshot); await afterRelink(tx, wineId) }
        await editOccurrenceNotes(tx, ctx.row.id, wineId, notes)
        return { lineup: await recordLineup(tx, ctx.row.id), revision: ctx.row.lineupRevision }
      }
      const out = await mutateWines(ctx.fence!, (current) => {
        const i = current.findIndex(w => w.id === wineId)
        if (i === -1) return { reject: 'wine not found' }
        const next = current.slice()
        next[i] = withNotes(applied ? withSnapshot(current[i], applied, applied.snapshot) : current[i])
        return next
      })
      if (isMutateReject(out)) throw refuse(404, out.reject)
      return { lineup: out, revision: null }
    }, async (ctx, r) => { if (r.revision !== null) await projectLineup(ctx.fence!, r.lineup, r.revision) }).then(r => r.lineup)
  } catch (err) {
    return contractFailure(err, c, { label: 'wine-edit' })
  }
  await touchWithMeta(c)

  // The same per-viewer view as the line-up read (lib/sessionState.ts
  // buildWineEcho), so a client storing this response back into its wines
  // cache sees what the next poll shows: the kicked-user fallback for the
  // adder name, and 🔒 Blind for All masking the host too (a no-op edit must
  // not unmask a bottle on demand; leak-fixes F6).
  return NextResponse.json(await buildWineEcho(c, meta, identity, lineup, wineId))
}

// Reassign "Brought by" (bounded v1), RECORD-FIRST inside the session mutation
// contract (plan D2): every check is re-made under the locks (the caller's
// fresh grant; the target admitted in this moment — by the record for a `u:`
// target); the FORCED provenance commits in Postgres, the revision bumped; the
// cached line-up is the projection after COMMIT. Ownership decides provider edit
// rights, so the cache must never name an owner the record does not. v1 is
// limited to Postgres-backed moments (docs/dev/proposals/reassign-brought-by.md).
async function reassignBroughtBy({
  c, wineId, body, identity, isHost, meta, showProvenance,
}: {
  c: string
  meta: SessionMeta
  wineId: string
  body: Record<string, unknown>
  identity: AuthorizedIdentity
  isHost: boolean
  showProvenance: boolean
}): Promise<NextResponse> {
  if (Object.keys(body).some(key => key !== 'broughtByIdentityId')) {
    return NextResponse.json({ error: 'change who brought it on its own, then save other edits separately' }, { status: 400 })
  }
  if (!isHost) {
    return NextResponse.json({ error: 'only a host or co-host can change who brought an impression' }, { status: 403 })
  }
  if (!showProvenance) {
    return NextResponse.json({ error: 'turn on “show who brought each impression” to change it' }, { status: 400 })
  }
  // The WIRE identity (an old client's `u:<int>` is malformed). A tombstone
  // (d:) is never a valid new owner.
  const wireTarget = parseWireIdentity(body.broughtByIdentityId)
  if (!wireTarget || (wireTarget.kind === 'other' && isTombstoneIdentityId(wireTarget.id))) {
    return NextResponse.json({ error: 'invalid identity' }, { status: 400 })
  }
  try {
    const lineup = await withSessionMutation(c, { label: 'reassign', redisLock: { waitMs: 3000 }, caller: identity, bumpLineup: true }, async (tx, ctx) => {
      const caller = admitted(ctx)
      if (!isHostByIdentity(ctx.meta!, caller)) throw refuse(403, 'only a host or co-host can change who brought an impression')
      const provenanceShown = ctx.row ? ctx.row.showProvenance !== false : ctx.meta!.showProvenance !== false
      if (!provenanceShown) throw refuse(400, 'turn on “show who brought each impression” to change it')
      // 🔒 An unknown public id takes the not-a-participant answer (§ 4).
      const target = await internalIdentity(wireTarget, tx)
      if (!target) throw refuse(400, 'that person is not in this moment')
      // The new owner must be a current participant: live roster entry (its name
      // is the snapshot), not banned or kicked — and admitted by the record for
      // a `u:` target.
      const [targetName, inBans, inKicked] = await Promise.all([
        redis.hGet(k.identities(c), target), redis.sIsMember(k.bans(c), target), redis.sIsMember(k.kicked(c), target),
      ])
      const recordAdmits = /^u:\d{1,18}$/.test(target) && ctx.row
        ? await readGrant(tx, c, Number(target.slice(2))).then(g => !!g && grantStatus(g) === 'ok')
        : true
      if (!targetName || inBans || inKicked || !recordAdmits) throw refuse(400, 'that person is not in this moment')
      if (!ctx.row) {
        throw refuse(409, 'this moment isn’t saved yet: a signed-in guest needs to rate or join before you can change who brought it')
      }
      await reconcileLineup(tx, ctx)
      if (!(await lockOccurrence(tx, ctx.row.id, wineId))) throw refuse(404, 'wine not found')
      await reassignProvenance(tx, ctx.row.id, wineId, target, targetName)
      return { lineup: await recordLineup(tx, ctx.row.id), revision: ctx.row.lineupRevision! }
    }, async (ctx, r) => { await projectLineup(ctx.fence!, r.lineup, r.revision) }).then(r => r.lineup)
    await touchWithMeta(c)
    // The same per-viewer view as the line-up read (Blind for All masks a
    // hidden bottle in the host's echo too; leak-fixes F6). Reaching here
    // means showProvenance is on (gated above).
    return NextResponse.json(await buildWineEcho(c, { ...meta, showProvenance: true }, identity, lineup, wineId))
  } catch (err) {
    return contractFailure(err, c, { busy: 429, label: 'reassign' })
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const opened = await openSessionFor(c, req, session)
  if (opened instanceof NextResponse) return opened
  const { meta, wines } = opened
  const pp = await participantOrBanned(c, req, session, opened.meta)
  if (pp.status === 'unavailable') return authUnavailable()
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  const identity = pp.identity

  // Same provider/host rules as PATCH. Early reject only — re-decided under the
  // locks. An unknown bottle is decided there too (already gone → 200).
  const targetWine = wines.find(w => w.id === wineId)
  if (!isHostByIdentity(meta, identity) && !(isProvider(meta, identity) && (!!identity.grant || !targetWine || targetWine.addedByIdentityId === identity.id))) {
    return NextResponse.json({ error: 'only the host or the provider who added this wine can delete it' }, { status: 403 })
  }

  // Inside the session mutation contract (the power and the ownership fresh
  // under the locks). Postgres-backed: the row deleted (its ratings cascade),
  // positions renumbered, the revision bumped, the line-up projected after
  // COMMIT; Redis-only: the fenced line-up filter. The wine's rating keys go
  // with it (every rating-key-deleting path holds the lease, plan § 3, r3-3);
  // the S3 bytes after COMMIT. Idempotent: a bottle already gone answers 200.
  let deletedUrl: string | null = null
  try {
    await withSessionMutation(c, { label: 'wine-delete', redisLock: { waitMs: 3000 }, caller: identity, bumpGen: true, bumpLineup: true }, async (tx, ctx) => {
      deletedUrl = null   // per attempt (r3 P1)
      const caller = admitted(ctx)
      const wine = await lockedTarget(tx, ctx, wineId)
      if (!wine) {
        if (!isHostByIdentity(ctx.meta!, caller) && !isProvider(ctx.meta!, caller)) throw refuse(403, 'only the host or the provider who added this wine can delete it')
        return { lineup: ctx.row ? await recordLineup(tx, ctx.row.id) : null, revision: ctx.row?.lineupRevision ?? null }
      }
      if (!mayEdit(ctx, caller, wine)) throw refuse(403, 'only the host or the provider who added this wine can delete it')
      let lineup: WineMeta[] | null = null
      if (ctx.row) {
        // Its cravings first (lib/cravings.ts, catalogue model change § 5): the
        // ones visible to their owner lose the bottle and keep their moment;
        // the still-hidden ones go with the row (the key's CASCADE).
        await beforeBottleDelete(tx, wineId)
        await tx.$executeRaw`DELETE FROM wines WHERE id = ${wineId} AND session_id = ${ctx.row.id}`
        await renumber(tx, ctx.row.id)
        lineup = await recordLineup(tx, ctx.row.id)
      } else {
        const out = await mutateWines(ctx.fence!, (current) => current.some(w => w.id === wineId) ? current.filter(w => w.id !== wineId) : { reject: 'gone' })
        if (isMutateReject(out)) return { lineup: null, revision: null }
      }
      deletedUrl = wine.imageUrl || null
      // The bottle's rating keys: in a Postgres-backed moment AFTER COMMIT
      // (Codex r1: deleted before it, a failed COMMIT would keep the bottle and
      // lose guests' ratings, which exist only in Redis), by the contract,
      // fenced, before the projection; in a Redis-only moment now, with the
      // bottle (the cache is the data).
      const ratingKeys = await scanKeys(`s:${c}:r:*:${wineId}`)
      if (ctx.row) ctx.after.dropKeys.push(...ratingKeys)
      else if (ratingKeys.length > 0) await ctx.fence!.exec(m => { m.del(ratingKeys) })
      return { lineup, revision: ctx.row?.lineupRevision ?? null }
    }, async (ctx, r) => { if (r.lineup && r.revision !== null) await projectLineup(ctx.fence!, r.lineup, r.revision) })
  } catch (err) {
    return contractFailure(err, c, { busy: 429, label: 'wine-delete' })
  }
  // The wine's S3 image after COMMIT (the record row is gone with it).
  // Fire-and-forget.
  if (deletedUrl) reclaimImages([deletedUrl])
  await touchWithMeta(c)
  return NextResponse.json({ ok: true })
}
