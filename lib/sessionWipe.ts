import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { redis, k, scanKeys } from '@/lib/redis'
import { mutateWines, mirrorLineup, isMutateReject, type SessionMeta, type WineMeta } from '@/lib/session'
import { withSessionMutation, type MutationCtx } from '@/lib/sessionMutation'
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
//                     hof, feed item, bookmarks-of-wines-in-this-session,
//                     session_members).
//   - 'ban'         → kick-delete + the ban (session_bans row = the record for
//                     a Postgres-backed session; the Redis set is its cache).
//   Wines the target added are orphaned (session_id NULL, never hard-deleted —
//   other tasters' bookmarks survive) when the caller passes deleteAddedWines.
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
        await tx.$executeRaw`DELETE FROM ratings WHERE user_id = ${userId} AND session_id = ${row.id}`
        await tx.$executeRaw`DELETE FROM feed_items WHERE user_id = ${userId} AND session_id = ${row.id}`
        await tx.$executeRaw`DELETE FROM hall_of_fame WHERE user_id = ${userId} AND session_code = ${code}`
        await tx.$executeRaw`
          DELETE FROM bookmarks b USING wines w WHERE b.wine_id = w.id AND w.session_id = ${row.id} AND b.user_id = ${userId}`
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

    // ── Wines the target brought: the ids come from the RECORD's orphan UPDATE
    // (r3-5 — cached provenance can lag a committed reassign); in a Redis-only
    // session the cached provenance is the authority.
    if (deleteAddedWines) {
      const ids = row
        ? (await tx.$queryRaw<{ id: string }[]>`
            UPDATE wines SET session_id = NULL WHERE session_id = ${row.id} AND added_by_identity_id = ${identityId} RETURNING id`).map(r => r.id)
        : (ctx.meta ? (JSON.parse((await redis.get(k.wines(code))) ?? '[]') as WineMeta[]) : []).filter(w => w.addedByIdentityId === identityId).map(w => w.id)
      if (ids.length) {
        const drop = new Set(ids)
        const next = await mutateWines(fence, wines => wines.filter(w => !drop.has(w.id)))
        if (!isMutateReject(next)) await mirrorLineup(tx, row?.id ?? null, next)
      }
    }
  }, async (ctx) => {
    // ── After COMMIT: the rating keys of a removed rater (the record no longer
    // has those ratings). Kick-keep keeps them (the roster guard hides them).
    if (scope !== 'kick-keep') {
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
