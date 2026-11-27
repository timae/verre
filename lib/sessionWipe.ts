import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { redis, k, scanKeys } from '@/lib/redis'
import { mutateWines, type SessionMeta, type WineMeta } from '@/lib/session'
import { reconcileLineup, bumpLineupRevision, renumber, recordLineup, projectLineup } from '@/lib/occurrences'
import { withSessionMutation, type MutationCtx } from '@/lib/sessionMutation'
import { bumpRaterVersions } from '@/lib/ratingVersions'
import { readLiveRow, readRecordRoles, metaFromRecord } from '@/lib/sessionRecord'
import type { Identity } from '@/lib/identity'
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'

// Local copy of reclaimImage to avoid coupling sessionWipe to accountDelete.
// Duplicated in three other places (accountDelete.ts, session.ts, me/avatar);
// captured in .local/future-work-rewire.md as a future extraction to
// lib/s3reclaim.ts. Trade-off accepted to keep phase 2 PR scope tight.
const _S3_ENDPOINT = process.env.S3_ENDPOINT
const _S3_BUCKET   = process.env.S3_BUCKET
const _s3 = _S3_ENDPOINT && _S3_BUCKET
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

// Single helper for all flavors of removing a participant from a session,
// invoked by the host-side ban/kick endpoint and the kicked user's self-service
// "delete my data" endpoint (/leave?cleanup=full).
//
// Scope semantics:
//   - 'kick-keep'   → strip from identities + role lists; the member row becomes
//                     (taster, removed_state 'kicked') — UPSERTed, so a
//                     historical rating author with no member row is recorded
//                     as kicked too (r1-4). Ratings stay for their own history.
//   - 'kick-delete' → kick + delete the user's session-scoped data (ratings,
//                     feed item, their cravings from this session (its
//                     stored moment, or its bottle's) + their blind saves,
//                     session_members).
//   - 'ban'         → kick-delete + the ban (session_bans row = the record for
//                     a Postgres-backed session; the Redis set is its cache).
//   Wines the target added are orphaned (session_id NULL, never hard-deleted —
//   other tasters' bookmarks survive) when the caller passes deleteAddedWines.
//   🔒 When the CALLER is the target (a removed person's own "Delete my
//   ratings", /leave?cleanup=full), the rating-action XP of the ratings it
//   deletes is taken back, once, floored at 0 (ruled 2026-11-26, the own-clear
//   rule of docs/dev/rating-saves.md). A host's kick or ban with delete takes
//   nothing back. Counters and badges never go down.
//
// 🔒 A mutation-contract participant (redis-rehydration § 5.4; release-B plan
// § 3): the caller's authorization and the TARGET's role/host status are
// decided under the locks from ctx (the caller's fresh grant, the target's
// fresh member row) — never from cached arrays. Order inside the transaction
// (plan § 1.4, D1): the deny-direction cache writes first (SADD bans/kicked,
// HDEL identities, fenced — a denial that survives a rollback fails closed),
// then the Postgres rows, then meta rewritten from the record (role lists
// stripped) and the fenced lineup filter + mirror. After COMMIT: the rating
// keys (content, removed only once the record no longer has the ratings) and
// the S3 reclaims.
//
// `d:<uuid>` targets (a deleted account's tombstoned ratings in this session,
// § 4.3) support scope 'kick-delete' ONLY: their ratings by tombstone_key (and
// keys) and the identities entry go; wine provenance is never touched.

export type WipeScope = 'kick-keep' | 'kick-delete' | 'ban'

export type WipeTarget = { strictHost: boolean; cohost: boolean }

export interface WipeOptions {
  code: string
  identityId: string
  scope: WipeScope
  // Host's toggle, for kick and ban alike. Ignored for d: targets.
  deleteAddedWines?: boolean
  caller: Identity
  // The incarnation the request opened (a raw caller carries none — r2 R1-2).
  expectedCreatedAt?: number
  label: string
  // The caller's authorization, decided UNDER the locks; throw refuse(…) to deny.
  authorize: (ctx: MutationCtx, target: WipeTarget) => void
  // Extra grant-direction projection after COMMIT (leave: SREM kicked).
  afterCommit?: (ctx: MutationCtx) => Promise<void>
}

export async function sessionWipe(opts: WipeOptions): Promise<void> {
  const { code, identityId, scope } = opts
  const userId = identityId.startsWith('u:') ? Number(identityId.slice(2)) : null
  const isTombstone = identityId.startsWith('d:')
  if (isTombstone && scope !== 'kick-delete') throw new Error(`sessionWipe: ${scope} is not valid for a tombstone identity`)
  const deleteAddedWines = !isTombstone && (opts.deleteAddedWines ?? false)
  // The person's own choice (only /leave wipes its own caller).
  const ownChoice = userId !== null && opts.caller.id === identityId
  const reclaim: string[] = []

  // bumpGen: the wipe deletes rating keys — an unleased writer's late SET with
  // an older generation must not recreate one (r2 R1-6).
  await withSessionMutation(code, { label: opts.label, redisLock: { waitMs: 3000 }, caller: opts.caller, expectedCreatedAt: opts.expectedCreatedAt, bumpGen: true }, async (tx, ctx) => {
    reclaim.length = 0   // per attempt: a rolled-back attempt's captures never reach the reclaim (r3 P1)
    const fence = ctx.fence!
    const meta = ctx.meta!
    const row = ctx.row
    opts.authorize(ctx, await readTarget(tx, ctx, identityId))
    const ttl = await redis.pTTL(k.meta(code))

    // ── Deny-direction cache writes first (fenced). The identities HDEL is a
    // removal; the token mapping is preserved on every scope (the removed
    // caller must still resolve to reach the bounce + /leave).
    await fence.exec((m) => {
      if (scope === 'ban') m.sAdd(k.bans(code), identityId)
      if (!isTombstone && scope !== 'ban') {
        m.sAdd(k.kicked(code), identityId)
        m.hSet(k.kickv(code), identityId, randomUUID())   // a fresh token per kick — a counter would restart after an eviction (r5 N5)
      }
      for (const key of [k.bans(code), k.kicked(code), k.kickv(code)]) if (Number(ttl) > 0) m.pExpire(key, Number(ttl))
      m.hDel(k.identities(code), identityId)
    })

    // ── The record.
    if (row) {
      if (scope === 'ban') {
        await tx.$executeRaw`INSERT INTO session_bans (session_code, identity_id) VALUES (${code}, ${identityId}) ON CONFLICT DO NOTHING`
      }
      if (isTombstone) {
        reclaim.push(...await ratingImages(tx, Prisma.sql`r.session_id = ${row.id} AND r.tombstone_key = ${identityId} AND r.user_id IS NULL`))
        // rating-write: EXEMPT
        await tx.$executeRaw`DELETE FROM ratings WHERE session_id = ${row.id} AND tombstone_key = ${identityId} AND user_id IS NULL`
      } else if (userId !== null && scope === 'kick-keep') {
        await tx.$executeRaw`
          INSERT INTO session_members (user_id, session_code, role, removed_state)
          SELECT ${userId}, ${code}, 'taster', 'kicked' WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId})
          ON CONFLICT (user_id, session_code) DO UPDATE SET role = 'taster', removed_state = 'kicked'`
      } else if (userId !== null) {
        // 🔒 Scoped by ratings.session_id, not through the wine's current
        // session (r5-1): a wine orphaned by an earlier deleteAddedWines keeps
        // its ratings' session_id, and a surviving rating would re-admit the
        // user as an author.
        reclaim.push(...await ratingImages(tx, Prisma.sql`r.user_id = ${userId} AND r.session_id = ${row.id}`))
        // The rater's versions move first (docs/dev/rating-saves.md): an entry
        // that waited offline through this kick and a rejoin must not re-create
        // a deleted rating on its old version.
        await bumpRaterVersions(tx, userId, row.id)
        // rating-write: BUMPS
        const gone = await tx.$queryRaw<{ xp: number }[]>`
          WITH d AS (DELETE FROM ratings WHERE user_id = ${userId} AND session_id = ${row.id} RETURNING rating_action_xp)
          SELECT COALESCE(SUM(rating_action_xp), 0)::int AS xp FROM d`
        // Their own choice: the action XP those ratings earned goes back, ONE
        // debit, floored at 0 (the session's advisory lock serialises this with
        // account deletion, whose touched set holds this moment).
        const refund = Number(gone[0]?.xp ?? 0)
        if (ownChoice && refund > 0) await tx.$executeRaw`UPDATE users SET xp = GREATEST(xp - ${refund}, 0) WHERE id = ${userId}`
        await tx.$executeRaw`DELETE FROM feed_items WHERE user_id = ${userId} AND session_id = ${row.id}`
        // Their cravings from this moment: by the moment the craving stores
        // (catalogue model change § 5: kept when its bottle is orphaned or
        // deleted), or by its bottle's; and their saves of its bottles.
        await tx.$executeRaw`
          DELETE FROM bookmarks b WHERE b.user_id = ${userId}
             AND (b.source_session_id = ${row.id} OR b.wine_id IN (SELECT w.id FROM wines w WHERE w.session_id = ${row.id}))`
        await tx.$executeRaw`
          DELETE FROM blind_saves bs WHERE bs.user_id = ${userId} AND (bs.session_id = ${row.id} OR bs.wine_id IN (
            SELECT w.id FROM wines w WHERE w.session_id = ${row.id}
            UNION SELECT r.wine_id FROM ratings r WHERE r.session_id = ${row.id}))`
        await tx.$executeRaw`DELETE FROM session_members WHERE user_id = ${userId} AND session_code = ${code}`
      }
    }

    // ── Role lists. A Postgres-backed session's meta is written FROM the
    // record as this transaction now sees it (its committed state minus the
    // target's role — deny-direction relative to what is committed); a
    // Redis-only session's meta is the authority, edited directly.
    if (row) {
      const next = metaFromRecord((await readLiveRow(tx, code))!, await readRecordRoles(tx, code), stripRoles(meta, identityId))
      await fence.exec(m => { m.set(k.meta(code), JSON.stringify(next), { XX: true, KEEPTTL: true }) })
    } else if (meta.coHostIds?.includes(identityId) || meta.providerIds?.includes(identityId)) {
      await fence.exec(m => { m.set(k.meta(code), JSON.stringify(stripRoles(meta, identityId)), { XX: true, KEEPTTL: true }) })
    }

    // ── Wines the target brought. Postgres-backed: RECORD-FIRST (model change
    // § 8a) — a NULL revision reconciled, the ids from the record's orphan
    // UPDATE (r3-5: cached provenance can lag a committed reassign), positions
    // renumbered, the revision bumped, the line-up projected after COMMIT.
    // Redis-only: the cached provenance is the authority.
    let lineup: { wines: WineMeta[]; revision: number } | null = null
    if (deleteAddedWines) {
      if (row) {
        await reconcileLineup(tx, ctx)
        const ids = await tx.$queryRaw<{ id: string }[]>`
          UPDATE wines SET session_id = NULL WHERE session_id = ${row.id} AND added_by_identity_id = ${identityId} RETURNING id`
        if (ids.length) {
          await renumber(tx, row.id)
          const revision = await bumpLineupRevision(tx, row.id)
          if (revision !== null) lineup = { wines: await recordLineup(tx, row.id), revision }
        }
      } else if (ctx.meta) {
        const drop = new Set((JSON.parse((await redis.get(k.wines(code))) ?? '[]') as WineMeta[]).filter(w => w.addedByIdentityId === identityId).map(w => w.id))
        if (drop.size) await mutateWines(fence, wines => wines.filter(w => !drop.has(w.id)))
      }
    }
    return lineup
  }, async (ctx, lineup) => {
    if (lineup) await projectLineup(ctx.fence!, lineup.wines, lineup.revision)
    // ── After COMMIT: the rating keys of a removed rater (the record no longer
    // has those ratings). Kick-keep keeps them (the roster guard hides them).
    if (scope !== 'kick-keep') {
      // rating-write: BUMPS
      const keys = await scanKeys(`s:${code}:r:${identityId}:*`)
      if (keys.length) await ctx.fence!.exec(m => { m.del(keys) })
    }
    await opts.afterCommit?.(ctx)
  })
  for (const url of reclaim) reclaimImage(url)
}

async function ratingImages(tx: Prisma.TransactionClient, where: Prisma.Sql): Promise<string[]> {
  const rows = await tx.$queryRaw<{ image_url: string | null }[]>`
    SELECT ri.image_url FROM rating_images ri JOIN ratings r ON r.id = ri.rating_id WHERE ${where}`
  return rows.map(r => r.image_url).filter((u): u is string => !!u)
}

function stripRoles(meta: SessionMeta, id: string): SessionMeta {
  return { ...meta, coHostIds: (meta.coHostIds ?? []).filter(x => x !== id), providerIds: (meta.providerIds ?? []).filter(x => x !== id) }
}

// The TARGET's role and host status, fresh under the locks (§ 4.7 audit: the
// strict-host-only "banning a cohost" check must not consult a cached array).
// `u:` target of a Postgres-backed session → its member row + the row's host;
// anyone else → Redis meta, their authority.
async function readTarget(tx: Prisma.TransactionClient, ctx: MutationCtx, id: string): Promise<WipeTarget> {
  if (id.startsWith('u:') && ctx.row) {
    const uid = Number(id.slice(2))
    const m = await tx.$queryRaw<{ role: string }[]>`
      SELECT role FROM session_members WHERE session_code = ${ctx.code} AND user_id = ${uid} FOR UPDATE`
    return { strictHost: ctx.row.hostUserId === uid, cohost: m[0]?.role === 'co_host' }
  }
  if (id.startsWith('d:')) return { strictHost: false, cohost: false }
  const meta = ctx.meta!
  return {
    strictHost: meta.hostIdentityId === id || (!!meta.hostUserId && `u:${meta.hostUserId}` === id),
    cohost: !!meta.coHostIds?.includes(id),
  }
}
