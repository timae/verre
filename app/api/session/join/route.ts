import { prisma } from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { ensureMemberRow } from '@/lib/sessionMember'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { validateDisplayName } from '@verre/core'
import { disambiguateAgainst } from '@/lib/displayName.server'
import { checkRate, resetRate, getClientIp, formatWait } from '@/lib/rateLimit'
import { isSameOrigin } from '@/lib/csrf'
import { newAnonIdentityId, newAnonToken, userIdentityId, participantOrBanned, authRemoved } from '@/lib/identity'
import { withSessionMutation, refuse, ContractRefused, type MutationCtx } from '@/lib/sessionMutation'
import { openSession, unavailable, contractFailure } from '@/lib/sessionRehydrate'

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)

  // Rate limit invalid session-code attempts: 30 per minute per IP.
  // Counter is cleared on a successful join (real users with a typo
  // streak shouldn't slowly accumulate toward a block once they get
  // the right code). Counts everything until a successful match — so
  // both "session not found" and a malformed/empty code count.
  const ip = getClientIp(req)
  const rlKey = `rl:join:ip:${ip}:1m`
  const rl = await checkRate(rlKey, 30, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many join attempts. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  // Public field is `displayName` — see CLAUDE.md Auth section, names
  // are presentation-only and there is no concept of a username.
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { code, displayName: rawDisplayName } = body as Record<string, unknown>
  if (!code || typeof code !== 'string') return NextResponse.json({ error: 'code required' }, { status: 400 })

  let displayName: string
  try { displayName = validateDisplayName(rawDisplayName) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404 })
  // Opened first (a cold Postgres-backed moment is rebuilt): 404 only when the
  // session is really gone, 503 while restoring.
  const opened = await openSession(c)
  if (opened.status !== 'live') return unavailable(opened.status, 'session not found')

  // Logged-in users have a stable identity-id (`u:<userId>`): an existing
  // registration keeps its stored displayName (repeated joins don't stack emoji
  // suffixes). Anonymous joiners always get a fresh identity.
  //
  // Everything is decided inside the session mutation contract. Logged-in: a
  // ban (record, or the cache — it can deny) is rejected with the literal
  // 'banned' (client contract: components/session/JoinClient.tsx redirects to
  // the full RemovedView on it); otherwise the explicit /join RE-ADMITS a
  // kicked member (kick-ban.md) — the member row's removed_state is cleared in
  // the transaction (/join does not promote: a Redis-only session gets its
  // member rows at promotion), and the SREM kicked + roster HSET are the
  // grant-direction projection after COMMIT. In a Redis-only session, and for
  // anonymous joiners, Redis is the authority: the fenced writes inside the
  // transaction are the change.
  //
  // resetRate happens only on success — the ban path keeps consuming the
  // rate-limit budget so banned-id probing via response timing stays bounded.
  let anonToken: string | null = null
  let identityId: string
  try {
    if (session?.user?.id) {
      const uid = Number(session.user.id)
      identityId = userIdentityId(uid)
      const id = identityId
      // The explicit rejoin clears only a kick the caller is rejoining FROM —
      // one already in place when this request arrived. A kick that commits
      // while this join waits on the lock wins (A's R1 finding 2): the user's
      // intent predates it. This captures intent, not authorization (the ban
      // and kick state themselves are read fresh under the locks).
      // …and WHICH kick (r2/r3 N5): the member row's version — xmin (every
      // UPDATE changes it), 'absent' when there is no row (a kick-delete) —
      // read BEFORE the admission, so any change after it (another device
      // rejoined, the host kicked again) is a different version and wins. Any
      // other change to the row also refuses, which only costs a retry.
      const memberVersion = async (db: Pick<typeof prisma, '$queryRaw'>, lock: boolean) =>
        (lock
          ? await db.$queryRaw<{ v: string }[]>`SELECT xmin::text AS v FROM session_members WHERE session_code = ${c} AND user_id = ${uid} FOR UPDATE`
          : await db.$queryRaw<{ v: string }[]>`SELECT xmin::text AS v FROM session_members WHERE session_code = ${c} AND user_id = ${uid}`)[0]?.v ?? 'absent'
      const kickVersion = await memberVersion(prisma, false)
      // The Redis-only twin (r4 N5): the per-identity kick counter.
      const cacheKickVersion = (await redis.hGet(k.kickv(c), id)) ?? 'none'
      const kickedBefore = (await participantOrBanned(c, req, session, opened.meta)).status === 'kicked'
      displayName = await withSessionMutation(c, {
        label: 'join', redisLock: { waitMs: 3000 }, expectedCreatedAt: opened.meta.createdAt,
        caller: { id, displayName, kind: 'user' },
      }, async (tx, ctx) => {
        if (ctx.callerStatus === 'banned') throw refuse(403, 'banned')
        const kickedNow = ctx.row ? !!ctx.caller?.grant?.kicked : await redis.sIsMember(k.kicked(c), id)
        if (kickedNow && !kickedBefore) throw new ContractRefused(authRemoved('removed from session'))
        if (kickedNow && ctx.row && (await memberVersion(tx, true)) !== kickVersion) throw new ContractRefused(authRemoved('removed from session'))
        if (kickedNow && !ctx.row && ((await redis.hGet(k.kickv(c), id)) ?? 'none') !== cacheKickVersion) throw new ContractRefused(authRemoved('removed from session'))
        if (ctx.row) await ensureMemberRow(tx, ctx.row, uid, { clearKick: true })
        const identities = await redis.hGetAll(k.identities(c))
        const name = identities[id] ?? disambiguateAgainst(displayName, Object.values(identities))
        if (!ctx.row) await admit(ctx, id, name, identities[id] == null)
        return name
      }, async (ctx, name) => {
        if (ctx.row) await admit(ctx, id, name, true)
      })
    } else {
      identityId = newAnonIdentityId()
      anonToken = newAnonToken()
      const id = identityId
      const token = anonToken
      displayName = await withSessionMutation(c, { label: 'join-anon', redisLock: { waitMs: 3000 }, expectedCreatedAt: opened.meta.createdAt },
        async (_tx, ctx) => {
          const name = disambiguateAgainst(displayName, Object.values(await redis.hGetAll(k.identities(c))))
          const ttl = Number(await redis.pTTL(k.meta(c)))
          await ctx.fence!.exec(m => {
            m.hSet(k.identities(c), id, name)
            m.hSet(k.tokens(c), token, id)
            if (ttl > 0) { m.pExpire(k.identities(c), ttl); m.pExpire(k.tokens(c), ttl) }
          })
          return name
        })
    }
  } catch (err) {
    return contractFailure(err, c, { label: 'join' })
  }

  await touchWithMeta(c)
  // Reset the join rate-limit only on a successful join — a typo streak
  // doesn't accumulate against legitimate users, but ban-rejections
  // continue to count so banned-id probing is rate-limited.
  await resetRate(rlKey)

  return NextResponse.json({
    ...opened.meta,
    code: c,
    id: identityId,
    displayName,
    ...(anonToken ? { anonToken } : {}),
  })
}

// The re-admission writes (fenced): clear the kicked marker, register the
// roster entry (+ EXPIRE — the hash may have been evicted).
async function admit(ctx: MutationCtx, id: string, name: string, writeName: boolean): Promise<void> {
  const ttl = Number(await redis.pTTL(k.meta(ctx.code)))
  await ctx.fence!.exec(m => {
    m.sRem(k.kicked(ctx.code), id)
    if (writeName) m.hSet(k.identities(ctx.code), id, name)
    if (ttl > 0) m.pExpire(k.identities(ctx.code), ttl)
  })
}
