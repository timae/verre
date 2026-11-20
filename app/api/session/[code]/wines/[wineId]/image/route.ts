import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { isHostByIdentity, isProvider, mutateWines, isMutateReject, MAX_WINE_IMAGE_DATA_URL, type WineMeta, type SessionMeta } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { participantOrBanned, authInvalid, authRemoved, authUnavailable } from '@/lib/identity'
import { isSameOrigin } from '@/lib/csrf'
import { imageDataUrlValid } from '@/lib/s3'
import { imageKey } from '@/lib/imageKeys'
import { withSessionMutation, admitted, refuse, ContractCold, type MutationCtx } from '@/lib/sessionMutation'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openSessionFor } from '@/lib/sessionRoute'
import { reconcileLineup, lockOccurrence, recordLineup, projectLineup, readLineupState, readOccurrence } from '@/lib/occurrences'
import { occurrenceImageIO } from '@/lib/occurrenceImage'
import { buildWineEcho } from '@/lib/sessionState'
import type { AuthorizedIdentity } from '@/lib/sessionGrant'

// A bottle's photo in a moment, ITS OWN CALL (docs/dev/proposals/
// wine-catalog-model-change.md § 8a "Image attach is a separate operation from
// create"): the bottle exists first (its client id is known), the photo follows
// and may be retried alone; its failure never rolls back or duplicates the
// bottle. PUT attaches or replaces, DELETE removes.
//
// 🔒 Attaching in a Redis-only moment is refused (403): its TTL would orphan the
// bytes with no deletion path, the anonymous cover-photo rule
// (app/api/session/route.ts). REMOVING a photo is allowed there (a guest moment
// may still carry one from before this rule): the cached line-up is its
// authority, the bytes are reclaimed after.
// 🔒 Order (the S3→DB failure rule): validate (MIME, magic bytes, size) and
// check the bottle and the caller's power over it on the record → upload under
// a FRESH key (never the live object's) → write the URL + bump the revision in
// the contract (decided again on the locked row) → a failed write reclaims the
// new object BEFORE answering, unless a row references it (a COMMIT whose answer
// was lost) → the replaced object is reclaimed after COMMIT.

type Ctx = { params: Promise<{ code: string; wineId: string }> }

const SIGN_IN = 'Sign in to add photos to this moment.'
const FORBIDDEN = 'only the host or the provider who added this wine can change its photo'

type Prelude = { c: string; wineId: string; meta: SessionMeta; identity: AuthorizedIdentity; cached: WineMeta | undefined }

async function prelude(req: NextRequest, params: Ctx['params']): Promise<NextResponse | Prelude> {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code, wineId } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const opened = await openSessionFor(c, req, session)
  if (opened instanceof NextResponse) return opened
  const pp = await participantOrBanned(c, req, session, opened.meta)
  if (pp.status === 'unavailable') return authUnavailable()
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()
  if (!isHostByIdentity(opened.meta, pp.identity) && !isProvider(opened.meta, pp.identity)) {
    return NextResponse.json({ error: FORBIDDEN }, { status: 403 })
  }
  return { c, wineId, meta: opened.meta, identity: pp.identity, cached: opened.wines.find(w => w.id === wineId) }
}

const mayChange = (meta: SessionMeta, caller: AuthorizedIdentity, wine: WineMeta) =>
  isHostByIdentity(meta, caller) || (isProvider(meta, caller) && wine.addedByIdentityId === caller.id)

// The write in a Postgres-backed moment, under the locks: the power and the
// ownership from the locked row. Returns the replaced URL and the line-up.
async function writeImage(c: string, wineId: string, identity: AuthorizedIdentity, url: string | null) {
  return withSessionMutation(c, { label: 'wine-image', redisLock: { waitMs: 3000 }, caller: identity, bumpLineup: true }, async (tx: Prisma.TransactionClient, ctx: MutationCtx) => {
    const caller = admitted(ctx)
    if (!ctx.row) throw refuse(403, SIGN_IN)
    await reconcileLineup(tx, ctx)
    const wine = await lockOccurrence(tx, ctx.row.id, wineId)
    if (!wine) throw refuse(404, 'wine not found')
    if (!mayChange(ctx.meta!, caller, wine)) throw refuse(403, FORBIDDEN)
    await tx.$executeRaw`UPDATE wines SET image_url = ${url} WHERE id = ${wineId} AND session_id = ${ctx.row.id}`
    return { replaced: wine.imageUrl && wine.imageUrl !== url ? wine.imageUrl : null, lineup: await recordLineup(tx, ctx.row.id), revision: ctx.row.lineupRevision! }
  }, async (ctx, r) => { await projectLineup(ctx.fence!, r.lineup, r.revision) })
}

async function answer(c: string, meta: SessionMeta, identity: AuthorizedIdentity, lineup: WineMeta[], wineId: string) {
  await touchWithMeta(c)
  return NextResponse.json({ ok: true, wine: await buildWineEcho(c, meta, identity, lineup, wineId) }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const p = await prelude(req, params)
  if (p instanceof NextResponse) return p
  const { c, wineId, meta, identity, cached } = p
  const body = await req.json().catch(() => null)
  const image = body && typeof body === 'object' && !Array.isArray(body) ? (body as { image?: unknown }).image : undefined
  if (typeof image !== 'string' || image.length > MAX_WINE_IMAGE_DATA_URL || !imageDataUrlValid(image)) {
    return NextResponse.json({ error: 'The photo must be a JPEG, PNG, WebP or GIF of about 1 MB at most.' }, { status: 400 })
  }
  // Early refusals BEFORE any upload (decided again under the locks): a
  // Redis-only moment, a bottle the record does not have, a provider's
  // attempt on someone else's bottle. No upload for a request that cannot land.
  if ((await readLineupState(c)) === undefined) return NextResponse.json({ error: SIGN_IN }, { status: 403 })
  // The record's bottle, else the cached one (an unreconciled moment's
  // cache-only bottle: the contract reconciles it before writing).
  const target = (await readOccurrence(c, wineId)) ?? cached
  if (!target) return NextResponse.json({ error: 'wine not found' }, { status: 404 })
  if (!mayChange(meta, identity, target)) return NextResponse.json({ error: FORBIDDEN }, { status: 403 })
  const url = await occurrenceImageIO.upload(imageKey('occurrence'), image).catch(() => '')
  if (!url) return NextResponse.json({ error: 'the photo could not be stored, try again' }, { status: 502 })
  let r: Awaited<ReturnType<typeof writeImage>>
  try {
    r = await writeImage(c, wineId, identity, url)
  } catch (err) {
    // A COMMIT whose answer was lost leaves the URL on its row: keep those bytes.
    const referenced = await prisma.$queryRaw<{ x: number }[]>`SELECT 1 AS x FROM wines WHERE image_url = ${url} LIMIT 1`.catch(() => [{ x: 1 }])
    if (!referenced[0]) await occurrenceImageIO.reclaim([url])
    return contractFailure(err, c, { label: 'wine-image' })
  }
  if (r.replaced) void occurrenceImageIO.reclaim([r.replaced])
  return answer(c, meta, identity, r.lineup, wineId)
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const p = await prelude(req, params)
  if (p instanceof NextResponse) return p
  const { c, wineId, meta, identity } = p
  if ((await readLineupState(c)) === undefined) return removeCachedPhoto(c, wineId, meta, identity)
  let r: Awaited<ReturnType<typeof writeImage>>
  try {
    r = await writeImage(c, wineId, identity, null)
  } catch (err) {
    return contractFailure(err, c, { label: 'wine-image' })
  }
  if (r.replaced) void occurrenceImageIO.reclaim([r.replaced])
  return answer(c, meta, identity, r.lineup, wineId)
}

// A Redis-only moment: the cached line-up is the authority (mutateWines inside
// the contract); a moment promoted meanwhile takes the record path instead.
async function removeCachedPhoto(c: string, wineId: string, meta: SessionMeta, identity: AuthorizedIdentity): Promise<NextResponse> {
  let removed: string | null = null
  let lineup: WineMeta[]
  try {
    lineup = await withSessionMutation(c, { label: 'wine-image', redisLock: { waitMs: 3000 }, caller: identity }, async (_tx, ctx) => {
      removed = null
      const caller = admitted(ctx)
      if (ctx.row) throw refuse(409, 'try again')
      const raw = await redis.get(k.wines(c))
      if (raw === null) throw new ContractCold(c)
      const wine = (JSON.parse(raw) as WineMeta[]).find(w => w.id === wineId)
      if (!wine) throw refuse(404, 'wine not found')
      if (!mayChange(ctx.meta!, caller, wine)) throw refuse(403, FORBIDDEN)
      const out = await mutateWines(ctx.fence!, (current) => {
        const i = current.findIndex(w => w.id === wineId)
        if (i === -1) return { reject: 'wine not found' }
        const next = current.slice()
        removed = current[i].imageUrl || null
        next[i] = { ...current[i], imageUrl: '', image: '' }
        return next
      })
      if (isMutateReject(out)) throw refuse(404, out.reject)
      return out
    })
  } catch (err) {
    return contractFailure(err, c, { label: 'wine-image' })
  }
  if (removed) void occurrenceImageIO.reclaim([removed])
  return answer(c, meta, identity, lineup, wineId)
}
