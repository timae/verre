import { NextRequest, NextResponse } from 'next/server'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, scanKeys } from '@/lib/redis'
import { participantOrBanned, authInvalid, authRemoved, authUnavailable } from '@/lib/identity'
import { type SessionMeta, isHostByIdentity, isStrictHost, isHostless } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { buildMetaView, viewerUserIdFrom } from '@/lib/sessionState'
import { withSessionMutation, refuse } from '@/lib/sessionMutation'
import { readLiveRow, readRecordRoles, metaFromRecord } from '@/lib/sessionRecord'
import { openSession, unavailable, contractFailure } from '@/lib/sessionRehydrate'

// Inlined S3 reclaim — same pattern as app/api/checkins/[id]/route.ts and
// lib/session.ts. Adding a third named export to lib/s3.ts trips a Next 15.5 /
// webpack 5.98 bundling bug; keeping copies here until that's fixed upstream.
const _S3_ENDPOINT = process.env.S3_ENDPOINT
const _S3_BUCKET = process.env.S3_BUCKET
const _s3 = _S3_ENDPOINT
  ? new S3Client({
      endpoint: _S3_ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
      forcePathStyle: true,
    })
  : null
async function reclaimImage(url: string | null | undefined) {
  if (!_s3 || !_S3_BUCKET || !url || !_S3_ENDPOINT) return
  const prefix = `${_S3_ENDPOINT}/${_S3_BUCKET}/`
  if (!url.startsWith(prefix)) return
  const key = url.slice(prefix.length)
  if (!key) return
  try {
    await _s3.send(new DeleteObjectCommand({ Bucket: _S3_BUCKET, Key: key }))
  } catch (err) {
    console.warn('[s3] reclaimImage failed:', { key, err })
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status)

  const session = await resolveUser(req)
  const p = await participantOrBanned(c, req, session, opened.meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid('not a participant')
  const caller = p.identity

  // Body assembly (participants, ttl, host-gated banCount, the viewer's
  // session-scoped block-pair arrays, tier-gated avatar resolution) lives in
  // lib/sessionState.ts buildMetaView — shared with /api/session/:code/state.
  //
  // SECURITY: viewerBlocksOut/In carry the viewer's block-pair list. They
  // MUST NOT be logged or mirrored anywhere shared; the Cache-Control header
  // below forces private no-store on the whole response for this reason.
  const identities = await redis.hGetAll(k.identities(c))
  const body = await buildMetaView(c, opened.meta, caller, viewerUserIdFrom(session), identities)
  return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { targetId: targetIdFromBody, action, role: roleFromBody } = body as Record<string, unknown>

  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status)
  // Banned/kicked callers get the `removed` bounce header (same as the polled
  // GETs and wine routes) so their client reroutes to /join/<C>?removed=1.
  const pp = await participantOrBanned(c, req, session, opened.meta)
  if (pp.status === 'unavailable') return authUnavailable()
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()

  // set-role runs inside the session mutation contract (redis-rehydration § 4.7):
  // the caller's power comes from its FRESH grant and the target's current role
  // and host status are read fresh under the locks — cached arrays never decide.
  // RECORD-FIRST for a `u:` target of a Postgres-backed session: the member row
  // is the role, committed first; the meta rewrite from the record is the
  // projection (a refused one only lags presentation — the cache never grants).
  // For an anonymous target, or in a Redis-only session, meta IS the authority:
  // the fenced write inside the transaction is the change.
  try {
    const { meta } = await withSessionMutation(c, { label: 'set-role', redisLock: { waitMs: 3000 }, caller: pp.identity }, async (tx, ctx) => {
      const meta = ctx.meta!
      const caller = ctx.caller!
      const strictHostNow = isStrictHost(meta, caller)
      // Coarse moderator gate — closes the enumeration oracle that would let a
      // non-participant probe `targetId: u:<n>` (400 unknown-target vs 403).
      if (ctx.callerStatus !== 'ok' || !isHostByIdentity(meta, caller)) {
        throw refuse(403, 'only the host or a co-host can assign roles')
      }
      // Strict-host-only regardless of the target: answer 403 before target
      // resolution so a cohost cannot tell members from non-members.
      if (action === 'set-role' && roleFromBody === 'co_host' && !strictHostNow) {
        throw refuse(403, 'only the host can assign or remove the co-host role')
      }
      // The target must be part of this session — an identities-map entry, or
      // for a `u:` of a Postgres-backed session the record (member or rater).
      // Object.hasOwn guards prototype names (`__proto__`, `constructor`).
      if (typeof targetIdFromBody !== 'string' || !targetIdFromBody) throw refuse(400, 'targetId required')
      const targetId = targetIdFromBody
      const identities = await redis.hGetAll(k.identities(c))
      const targetUserId = /^u:\d{1,18}$/.test(targetId) ? Number(targetId.slice(2)) : null
      const member = ctx.row && targetUserId !== null
        ? (await tx.$queryRaw<{ role: string; removed_state: string | null }[]>`
            SELECT role, removed_state FROM session_members WHERE session_code = ${c} AND user_id = ${targetUserId} FOR UPDATE`)[0] ?? null
        : null
      const author = ctx.row && targetUserId !== null && !member
        ? !!(await tx.$queryRaw<{ x: number }[]>`SELECT 1 AS x FROM ratings WHERE session_id = ${ctx.row.id} AND user_id = ${targetUserId} LIMIT 1`)[0]
        : false
      if (!Object.hasOwn(identities, targetId) && !member && !author) throw refuse(400, 'targetId required')
      if (targetId === caller.id) throw refuse(400, 'cannot change your own role')
      // Only `set-role` is supported (`transfer-host` was removed).
      if (action !== 'set-role') throw refuse(400, 'unknown action')
      // The strict host cannot be re-roled — it would orphan the session.
      const recordBacked = !!ctx.row && targetUserId !== null
      const targetIsStrictHost = recordBacked
        ? ctx.row!.hostUserId === targetUserId
        : (!!meta.hostIdentityId && targetId === meta.hostIdentityId) || (!!meta.hostUserId && targetId === `u:${meta.hostUserId}`)
      if (targetIsStrictHost) throw refuse(400, 'cannot change the host\'s role')
      if (roleFromBody !== 'taster' && roleFromBody !== 'co_host' && roleFromBody !== 'provider') {
        throw refuse(400, 'role must be taster, co_host, or provider')
      }
      const newRole = roleFromBody as 'taster' | 'co_host' | 'provider'
      // A removed target gets no role (r2 N1): a kicked user holding co_host
      // would be one rejoin away from host powers — and a role on a removed
      // member is never what the host meant. Demotion stays allowed.
      if (newRole !== 'taster') {
        const removed = member?.removed_state === 'kicked'
          || await redis.sIsMember(k.kicked(c), targetId) || await redis.sIsMember(k.bans(c), targetId)
        if (removed) throw refuse(409, 'that person was removed from this moment')
      }
      const currentRole = recordBacked
        ? (member?.role === 'co_host' || member?.role === 'provider' ? member.role : 'taster')
        : meta.coHostIds?.includes(targetId) ? 'co_host' : meta.providerIds?.includes(targetId) ? 'provider' : 'taster'
      if (currentRole === newRole) return { meta, project: false }
      // Any transition that adds or removes the cohost designation needs the
      // strict host (residual: bad-target 400 vs real-cohost 403 — cohosts see
      // the identities map anyway).
      if ((newRole === 'co_host' || currentRole === 'co_host') && !strictHostNow) {
        throw refuse(403, 'only the host can assign or remove the co-host role')
      }
      if (recordBacked) {
        await tx.$executeRaw`
          INSERT INTO session_members (user_id, session_code, role)
          SELECT ${targetUserId}, ${c}, ${newRole} WHERE EXISTS (SELECT 1 FROM users WHERE id = ${targetUserId})
          ON CONFLICT (user_id, session_code) DO UPDATE SET role = EXCLUDED.role`
        const next = metaFromRecord((await readLiveRow(tx, c))!, await readRecordRoles(tx, c), meta)
        return { meta: next, project: true }
      }
      const next: SessionMeta = {
        ...meta,
        coHostIds: [...(meta.coHostIds ?? []).filter(id => id !== targetId), ...(newRole === 'co_host' ? [targetId] : [])],
        providerIds: [...(meta.providerIds ?? []).filter(id => id !== targetId), ...(newRole === 'provider' ? [targetId] : [])],
      }
      const written = ctx.row ? metaFromRecord(ctx.row, await readRecordRoles(tx, c), next) : next
      await ctx.fence!.exec(m => { m.set(k.meta(c), JSON.stringify(written), { XX: true, KEEPTTL: true }) })
      return { meta: written, project: false }
    }, async (ctx, r) => {
      if (r.project) await ctx.fence!.exec(m => { m.set(k.meta(c), JSON.stringify(r.meta), { XX: true, KEEPTTL: true }) })
    })
    // Carries coHostIds/providerIds — private, no-store like the GET.
    return NextResponse.json({ ok: true, meta }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (err) {
    return contractFailure(err, c, { busy: 429, label: 'set-role' })
  }
}

// DELETE soft-deletes a session per the §8 data-survival contract in
// docs/dev/proposals/rewire.md. Host-only (co-hosts cannot delete — same
// restriction as cohost role assignment).
//
// What survives on the sessions row: `id` and `deleted_at`. Every other
// column is scrubbed to NULL. The tombstone is genuinely empty: callers
// can tell the row exists and that it's deleted, nothing more.
//
// Ratings + feed_items survive untouched. Their `session_id` still points
// at the tombstoned row, providing the grouping signal for the user's
// own Tastes / Posts surfaces. Renderers JOIN sessions to read deletedAt
// and display "[deleted session]" labels.
//
// Wines: orphaned with `session_id = NULL` (today's behaviour preserved
// per the Q3 plan decision). The wishlist tombstone-label resolver reads
// session context via a wine's own ratings, not via `wines.session_id`.
//
// Pre-existing side effects still fire: HoF cleanup (legacy table is still
// load-bearing while Tim's HoF v2 hasn't shipped); S3 reclaim of orphan
// wine images; session_members wipe; Redis purge.
//
// Lifetime counters on users do NOT decrement — that's the whole point of
// the snapshot column design.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)

  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status)

  // Banned/kicked callers get the `removed` bounce header (same protocol as the
  // polled GETs and wine routes).
  const pp = await participantOrBanned(c, req, session, opened.meta)
  if (pp.status === 'unavailable') return authUnavailable()
  if (pp.status === 'banned' || pp.status === 'kicked') return authRemoved('removed from session')
  if (pp.status === 'invalid') return authInvalid()

  // The soft-delete protocol (redis-rehydration § 5.4), inside the mutation
  // contract: authorization from the caller's fresh grant; the scrub (or, for a
  // Redis-only session, the registry row alone) and the FENCED wipe of every
  // s:{CODE}:* key both inside the transaction — a refused wipe ('lost') rolls
  // the scrub back (503), and a crash after the wipe but before COMMIT leaves a
  // live row whose next open rebuilds: the delete did not happen, consistently.
  // The registry row (session_tombstones) is what makes a committed delete
  // visible to a promotion that comes later. Covers are reclaimed after COMMIT.
  //
  // Who may delete: the strict host; and a cohost when the moment has NO host
  // identity at all (§ 4.5, ruling 4 — an anonymous host after a rebuild, or a
  // tombstoned one). Never a display-name branch.
  let reclaimUrls: string[]
  try {
    reclaimUrls = await withSessionMutation(c, { label: 'delete', redisLock: { waitMs: 3000 }, caller: pp.identity, expectedCreatedAt: opened.meta.createdAt },
      async (tx, ctx): Promise<string[]> => {
        const meta = ctx.meta!
        const caller = ctx.caller!
        const cohost = isHostByIdentity(meta, caller) && !isStrictHost(meta, caller)
        if (ctx.callerStatus !== 'ok' || !(isStrictHost(meta, caller) || (cohost && isHostless(meta, caller)))) {
          throw refuse(403, 'only the host can delete this session')
        }
        const urls = new Set<string>(meta.coverPhotoUrl ? [meta.coverPhotoUrl] : [])
        const row = ctx.row
        if (!row) {
          await tx.$executeRaw`
            INSERT INTO session_tombstones (code, created_at) VALUES (${c}, ${new Date(meta.createdAt)}) ON CONFLICT DO NOTHING`
        } else {
          if (row.coverPhotoUrl) urls.add(row.coverPhotoUrl)
          // Images of wines nobody bookmarked: bookmarked wines stay reachable
          // from /me/saved, orphans lose their last reader with this session.
          const orphanImages = await tx.$queryRaw<{ image_url: string }[]>`
            SELECT image_url FROM wines
             WHERE session_id = ${row.id} AND image_url IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.wine_id = wines.id)`
          for (const r of orphanImages) if (r.image_url) urls.add(r.image_url)
          // Ratings + feed_items SURVIVE (rewire § 8): their session_id still
          // points at the tombstoned row. HoF (legacy, still load-bearing):
          // keep an entry if the rater also bookmarked the wine. The JOIN uses
          // wines.session_id, still set at this point.
          await tx.$executeRaw`
            DELETE FROM hall_of_fame h
             WHERE h.session_code = ${c} AND h.user_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM bookmarks b JOIN wines w ON w.id = b.wine_id
                  WHERE w.session_id = ${row.id} AND b.user_id = h.user_id AND w.name = h.wine_name)`
          // Wines orphan (session_id NULL); member + ban rows go — both are
          // keyed by code, and codes are recycled after the scrub.
          await tx.$executeRaw`UPDATE wines SET session_id = NULL WHERE session_id = ${row.id}`
          await tx.$executeRaw`DELETE FROM session_members WHERE session_code = ${c}`
          await tx.$executeRaw`DELETE FROM session_bans WHERE session_code = ${c}`
          await tx.$executeRaw`
            INSERT INTO session_tombstones (code, created_at) VALUES (${c}, ${row.createdAt ?? new Date(meta.createdAt)}) ON CONFLICT DO NOTHING`
          // Scrub to a tombstone: only `id` and `deleted_at` survive.
          await tx.$executeRaw`
            UPDATE sessions
              SET deleted_at = NOW(), code = NULL, host_user_id = NULL, host_name = NULL, blind = NULL,
                  blind_for_everyone = NULL, created_at = NULL, archived_at = NULL, name = NULL, address = NULL,
                  date_from = NULL, date_to = NULL, timezone = NULL, description = NULL, link = NULL,
                  cover_photo_url = NULL, category = NULL, lifespan = NULL, hide_lineup = NULL,
                  hide_lineup_minutes_before = NULL, show_provenance = NULL
             WHERE id = ${row.id}`
        }
        const keys = await scanKeys(`s:${c}:*`)
        for (let i = 0; i < keys.length; i += 500) {
          const batch = keys.slice(i, i + 500)
          await ctx.fence!.exec(m => { m.del(batch) })
        }
        return [...urls]
      })
  } catch (err) {
    return contractFailure(err, c, { label: 'session delete' })
  }

  // Reclaim S3 objects fire-and-forget after COMMIT: orphan bytes at worst,
  // never broken DB state.
  for (const url of reclaimUrls) reclaimImage(url)

  return NextResponse.json({ ok: true })
}
