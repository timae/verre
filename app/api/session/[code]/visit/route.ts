import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k, touchWithMeta, bumpLastSeen, unhideCarousel, lifespanTTL } from '@/lib/redis'
import { ensurePromoted } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { ensureMemberRow } from '@/lib/sessionMember'
import { userIdentityId, authRemoved } from '@/lib/identity'
import { disambiguateAgainst } from '@/lib/displayName.server'
import { isSameOrigin } from '@/lib/csrf'
import { withSessionMutation, ContractRefused, type MutationCtx } from '@/lib/sessionMutation'
import { openSession, unavailable, contractFailure } from '@/lib/sessionRehydrate'

// POST /api/session/<code>/visit — a logged-in participant opened the moment.
// Promotes the session (a logged-in act), writes the durable member row, and
// registers the user in the Redis participant set so every entry path (rejoin
// link, direct URL, /api/session/join) reflects participation.
//
// 🔒 Admission is the RECORD's for a Postgres-backed session (§ 4.7): a ban
// (record or cache — the cache can deny) or a kick bounces with the `removed`
// header and re-seeds the missing Redis entry (fenced; § 5.5 belt 1). /visit
// never clears a kick — only the explicit /join re-admits (kick-ban.md).
// Everything is decided inside the session mutation contract; the roster HSET
// is the projection after COMMIT (a Redis-only session: the fenced HSET is the
// change itself).
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ ok: true })

  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status, 'session not found')
  const userId = Number(session.user.id)
  const id = userIdentityId(userId)

  // Promotion runs BEFORE this route's own contract (the locks are not
  // re-entrant). Best-effort: a visit still registers in a Redis-only session.
  try { await ensurePromoted(c, opened.meta) }
  catch (err) { console.error('[visit] promotion failed', { code: c, err }) }

  let displayName: string
  try {
    displayName = await withSessionMutation(c, {
      label: 'visit', redisLock: { waitMs: 3000 }, expectedCreatedAt: opened.meta.createdAt,
      caller: { id, displayName: session.user.name || '', kind: 'user' },
    }, async (tx, ctx) => {
      await admitOrBounce(ctx, id)
      if (ctx.row) await ensureMemberRow(tx, ctx.row, userId)
      const identities = await redis.hGetAll(k.identities(c))
      if (identities[id] != null) return identities[id]
      const name = disambiguateAgainst(session.user!.name || '', Object.values(identities))
      if (!ctx.row) await register(ctx, id, name)
      return name
    }, async (ctx, name) => {
      if (ctx.row) await register(ctx, id, name)
    })
  } catch (err) {
    return contractFailure(err, c, { label: 'visit' })
  }
  await touchWithMeta(c)
  // Pin as "Just visited" on the Moments home and un-hide it from the carousel
  // (re-engagement brings the card back to the highlights).
  await bumpLastSeen(c, userId)
  await unhideCarousel(userId, c)
  return NextResponse.json({ ok: true, id, displayName })
}

// The bounce under the locks, with the deny-direction re-seed (fenced) when
// Redis lacks the entry the record answered from. A cached kicked marker also
// bounces (the cache may deny — e.g. a kick-deleted user has no record trace);
// reconciliation removes a stale one for a user the record admits.
async function admitOrBounce(ctx: MutationCtx, id: string): Promise<void> {
  const g = ctx.caller?.grant
  const banned = ctx.callerStatus === 'banned'
  const kicked = (!!ctx.row && !!g?.kicked && !g.strictHost) || await redis.sIsMember(k.kicked(ctx.code), id)
  if (!banned && !kicked) return
  const key = banned ? k.bans(ctx.code) : k.kicked(ctx.code)
  if (ctx.row && !(await redis.sIsMember(key, id))) {
    await ctx.fence!.exec(m => { m.sAdd(key, id); m.expire(key, lifespanTTL(ctx.row?.lifespan ?? undefined)) })
  }
  throw new ContractRefused(authRemoved('removed from session'))
}

// The fenced roster entry (+ EXPIRE: the hash may have been evicted).
async function register(ctx: MutationCtx, id: string, name: string): Promise<void> {
  const ttl = Number(await redis.pTTL(k.meta(ctx.code)))
  await ctx.fence!.exec(m => {
    m.hSet(k.identities(ctx.code), id, name)
    if (ttl > 0) m.pExpire(k.identities(ctx.code), ttl)
  })
}
