import { prisma } from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'
import { metaToWire } from '@/lib/sessionState'
import { wireIdentity } from '@/lib/publicIds'
import { resolveUser } from '@/lib/resolveUser'
import { ensureMemberRow } from '@/lib/sessionMember'
import { redis, k, touchWithMeta } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { validateDisplayName } from '@verre/core'
import { disambiguateAgainst } from '@/lib/displayName.server'
import { checkRate, peekRate, refundRate, getClientIp, formatWait } from '@/lib/rateLimit'
import { isSameOrigin } from '@/lib/csrf'
import { newAnonIdentityId, newAnonToken, userIdentityId, participantOrBanned, authRemoved } from '@/lib/identity'
import { withSessionMutation, refuse, ContractRefused, type MutationCtx } from '@/lib/sessionMutation'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openSessionFor } from '@/lib/sessionRoute'

const JOIN_FAILURES = 30
const GUEST_JOINS = 60

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)

  // Failed join attempts (a malformed body, a ban): 30 per minute per address,
  // charged on failures only, never reset, so a venue full of people joining
  // one moment is never throttled. A WRONG code is not a failure here: it pays
  // the wrong-code budget at the entrance gate (leak-fixes F2), shared with
  // every moment surface so they can't stack N+N.
  const ip = getClientIp(req)
  const failKey = `rl:join:ip:${ip}:1m`
  const tooMany = (retryAfter: number) => NextResponse.json(
    { error: `Too many join attempts. Try again in ${formatWait(retryAfter)}.`, retryAfter },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  )
  const pk = await peekRate(failKey, JOIN_FAILURES)
  if (!pk.allowed) return tooMany(pk.retryAfter)
  const failed = async (res: NextResponse) => { await checkRate(failKey, JOIN_FAILURES, 60); return res }

  // Public field is `displayName` — see CLAUDE.md Auth section, names
  // are presentation-only and there is no concept of a username.
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return failed(NextResponse.json({ error: 'invalid body' }, { status: 400 }))
  const { code, displayName: rawDisplayName } = body as Record<string, unknown>
  if (!code || typeof code !== 'string') return failed(NextResponse.json({ error: 'code required' }, { status: 400 }))

  let displayName: string
  try { displayName = validateDisplayName(rawDisplayName) }
  catch (e) { return failed(NextResponse.json({ error: (e as Error).message }, { status: 400 })) }

  const c = normalizeCode(code)
  if (!c) return failed(NextResponse.json({ error: 'session not found' }, { status: 404 }))
  // The entrance gate (a cold Postgres-backed moment is rebuilt): 404 only
  // when the session is really gone, 503 while restoring, 429 once the
  // wrong-code budget is spent.
  const opened = await openSessionFor(c, req, session, { notFound: 'session not found' })
  if (opened instanceof NextResponse) return opened

  // Guest joins mint a new guest each (a logged-in rejoin is idempotent):
  // capped per address per moment, sized for a venue's shared Wi-Fi. Charged
  // as a reservation BEFORE the join (a parallel burst can't read "room left"
  // on every request) and refunded when the join doesn't go through (a busy
  // retry costs nothing). No moment-wide cap: one person could spend it and
  // lock every real guest out.
  const guestKey = `rl:join:anon:${c}:ip:${ip}:10m`
  const guestJoin = !session?.user?.id
  if (guestJoin) {
    const g = await checkRate(guestKey, GUEST_JOINS, 600)
    if (!g.allowed) {
      await refundRate(guestKey)
      return NextResponse.json(
        { error: `Too many guests joined from here. Try again in ${formatWait(g.retryAfter)}.`, retryAfter: g.retryAfter },
        { status: 429, headers: { 'Retry-After': String(g.retryAfter) } },
      )
    }
  }

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
  // A ban is a failure: it charges the failed-attempts budget (below), so
  // banned-id probing via response timing stays bounded.
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
    if (guestJoin) await refundRate(guestKey)
    const res = await contractFailure(err, c, { label: 'join' })
    return res.status === 403 ? failed(res) : res
  }

  await touchWithMeta(c)

  // 🔒 Wire shapes only (public-user-ids § 4): meta through the allow-list,
  // the caller's own identity as `u:<publicId>`.
  return NextResponse.json({
    ...await metaToWire(opened.meta),
    code: c,
    id: await wireIdentity(identityId),
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
