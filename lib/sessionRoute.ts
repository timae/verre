import { NextResponse, type NextRequest } from 'next/server'
import type { Session } from 'next-auth'
import { participantOrBanned, resolveIdentity, authInvalid, authRemoved, authUnavailable } from '@/lib/identity'
import type { Prisma } from '@prisma/client'
import { isHostByIdentity, mutateWines, isMutateReject, type SessionMeta, type WineMeta, type MutateReject } from '@/lib/session'
import { withSessionMutation, admitted, refuse } from '@/lib/sessionMutation'
import { openSession, unavailable, sessionRestoring, contractFailure, refreshLineup, type OpenedSession } from '@/lib/sessionRehydrate'
import { reconcileLineup, recordLineup, projectLineup, readLineupState } from '@/lib/occurrences'
import { readGateGrant, readGrant, grantStatus, cacheAdmission, authorized, type AuthorizedIdentity } from '@/lib/sessionGrant'
import { reserveMiss, settleMiss, chargeMissOnce, getClientIp, formatWait } from '@/lib/rateLimit'
import { prisma } from '@/lib/prisma'
import { redis, k } from '@/lib/redis'

// ── The entrance gate (leak-fixes F2) ────────────────────────────────────────
//
// A moment code is a join credential, and every moment route answers "no such
// moment" (404) differently from "not yours" (401 / 403), so each one is a code
// oracle. The model: a WRONG code costs budget that is never reset, a right
// code costs nothing. 🔒 Once a caller's budget is spent, only the moment's
// MEMBERS get past the entrance; everyone else gets the same 429 at once,
// before any route limiter, promotion, contract, rebuild or query-param branch
// runs, so the answer can't tell a right code from a wrong one (a check placed
// after a route's own decision re-creates the oracle through that decision:
// 401 vs 429, a 503 "restoring", a registration, a lock-wait).
//
// Budgets, per hour, never reset: 60 wrong codes per account (both code
// lengths), and per address 3,000 for 8-character codes and 300 for the old
// 4-character ones (65,536 hex codes), two separate budgets: a big event's
// shared Wi-Fi mistypes 8-character codes, only the small space needs the low
// cap. Exported so the suite can lower them.
export const CODE_MISS = { user: 60, ip8: 3000, ip4: 300, windowSeconds: 3600, seenSeconds: 3600 }

const userMissKey = (userId: number) => `rl:code-miss:u:${userId}:1h`
const ipMissKey = (code: string, ip: string) => code.length === 4 ? `rl:code-miss4:ip:${ip}:1h` : `rl:code-miss:ip:${ip}:1h`
// An identity that matches nothing in the cache admission (a caller with none).
const NO_IDENTITY = '-'

export type ChargedOpen =
  | { status: 'live'; meta: SessionMeta; wines: WineMeta[]; wrev: string | null }
  | { status: 'absent' | 'restoring' }
  | { status: 'limited'; retryAfter: number }

// The primitive: open a moment for a caller, charging a wrong code. The join
// page uses it directly (no Request there); routes go through openSessionFor.
// `identity` resolves the caller's identity id in this moment (cookie, app
// bearer, guest token), only called when the budget is spent.
export async function openSessionCharged(
  code: string,
  { userId, ip, identity }: { userId: number | null; ip: string; identity: () => Promise<string | null> },
): Promise<ChargedOpen> {
  const counters = [
    { key: ipMissKey(code, ip), max: code.length === 4 ? CODE_MISS.ip4 : CODE_MISS.ip8 },
    ...(userId !== null ? [{ key: userMissKey(userId), max: CODE_MISS.user }] : []),
  ]
  const seenKey = `rl:code-miss:seen:${userId !== null ? `u:${userId}` : `ip:${ip}`}:${code}`
  // 1. ONE atomic step BEFORE the open: a seen code is free (this caller
  // already paid to learn it is absent, so even on a spent budget it answers
  // 404 again, not 429: a deleted moment's open screen still reads "gone");
  // a spent budget goes to admission;
  // else a miss is RESERVED, so a parallel burst gets no more requests past
  // the entrance than the budget has room for. One round trip per request,
  // participants' polls included (plus the refund below): the price of a gate
  // that can't be routed around. A Redis error reserves nothing (fail open).
  const r = await reserveMiss(seenKey, counters, CODE_MISS)
  // 2. Spent: admission WITHOUT opening the moment, by the routes' own rule
  // (the record admits a member, a rating author, the strict host; the cache a
  // guest-only moment's roster, a meta-proven strict host, a kicked marker).
  // Kicked and banned count as admitted (their "removed" answer needs it).
  // 🔒 The same reads run for every caller and code, in parallel, whatever
  // the outcome: a read skipped on a miss would be a timing tell.
  if (r?.outcome === 'spent') {
    const id = await identity()
    const [grant, cache] = await Promise.all([
      readGateGrant(prisma, code, userId),
      cacheAdmission(code, id ?? NO_IDENTITY, undefined),
    ])
    const admitted = (grant !== null && grantStatus(grant) !== 'invalid') || cache === 'ok' || cache === 'host' || cache === 'banned' || cache === 'kicked'
    if (!admitted) return { status: 'limited', retryAfter: Math.max(1, Number(await redis.ttl(r.key).catch(() => 1))) }
    // Admitted: open as usual; a moment deleted meanwhile pays (or 429s) like a miss.
    const opened = await openSession(code)
    if (opened.status !== 'absent') return opened
    const charge = await chargeMissOnce(seenKey, counters, CODE_MISS)
    return charge.outcome === 'limited' ? { status: 'limited', retryAfter: charge.retryAfter } : { status: 'absent' }
  }
  // 3. Open, then settle the reservation: an absent code keeps its charge (one
  // per caller and code: a duplicate that lost the race is refunded), a live or
  // restoring one is refunded (a right code costs nothing).
  let opened: OpenedSession
  try {
    opened = await openSession(code)
  } catch (err) {
    // A failed open (a Postgres blip during a cold rebuild) charges nothing:
    // a member polling a cold moment must not leak a charge per poll.
    if (r?.outcome === 'reserved') await settleMiss(seenKey, counters, false, CODE_MISS)
    throw err
  }
  if (r?.outcome === 'reserved') await settleMiss(seenKey, counters, opened.status === 'absent', CODE_MISS)
  return opened
}

export const codesLimitedMessage = (retryAfter: number) => `Too many codes tried. Try again in ${formatWait(retryAfter)}.`

export function codesLimited(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: codesLimitedMessage(retryAfter), retryAfter },
    { status: 429, headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'private, no-store' } },
  )
}

export type OpenedLive = Extract<ChargedOpen, { status: 'live' }>

// THE first call of every moment route, after isSameOrigin, normalizeCode and
// resolving the caller (the resolved `session`: a second resolveUser would
// repeat the native last-seen bump). 404 carries the route's own body
// (`notFound`, or `absent()` for a route whose "gone" answer isn't a 404), 429
// the wait, 503 while restoring; 'live' continues exactly as before.
export async function openSessionFor(
  code: string, req: NextRequest, session: Session | null,
  { notFound = 'not found', absent }: { notFound?: string; absent?: () => NextResponse } = {},
): Promise<OpenedLive | NextResponse> {
  const r = await openSessionCharged(code, {
    userId: session?.user?.id ? Number(session.user.id) : null,
    ip: getClientIp(req),
    identity: async () => (await resolveIdentity(code, req, session))?.id ?? null,
  })
  if (r.status === 'live') return r
  if (r.status === 'limited') return codesLimited(r.retryAfter)
  if (r.status === 'restoring') return sessionRestoring()
  return absent ? absent() : unavailable('absent', notFound)
}

// The preamble of a participant-gated session route (redis-rehydration § 5.3):
// the entrance gate (a cold Postgres-backed moment is rebuilt; 404 only when it
// is really gone, 503 while restoring, 429 once the wrong-code budget is
// spent), then the admission (the record for a
// `u:` caller of a Postgres-backed session). Returns the response to send on
// any refusal.
export async function openAsParticipant(
  code: string, req: NextRequest, session: Session | null, invalid?: string,
): Promise<{ meta: SessionMeta; wines: WineMeta[]; identity: AuthorizedIdentity } | NextResponse> {
  const opened = await openSessionFor(code, req, session)
  if (opened instanceof NextResponse) return opened
  const p = await participantOrBanned(code, req, session, opened.meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status === 'banned' || p.status === 'kicked') return authRemoved('removed from session')
  if (p.status === 'invalid') return authInvalid(invalid)
  return { meta: opened.meta, wines: opened.wines, identity: p.identity }
}

// The line-up a READ serves (model change § 8a "the line-up read compares it
// with the record"): the cached one when it is stamped with the record's
// revision, else the record's, re-projected under the contract (a NULL revision
// reconciled first). The record's state comes from the caller's grant read (a
// signed-in caller of a Postgres-backed moment: no extra statement, and bound to
// the request's incarnation by participantOrBanned); a signed-in caller with NO
// grant is in a Redis-only moment (readGrant found no row); a guest pays one
// read, checked against the incarnation the request opened (Codex r1).
// 🔒 A KNOWN mismatch never falls back to the cache (Codex r1: a hide whose
// projection died would still show the bottle revealed): when the refresh
// cannot run (another holder has the lock, or it fails), the record's line-up
// is read directly and served without projecting; if that fails too, 503. The
// cache is the fallback only where nothing says it is behind: an unreconciled
// moment (NULL: today's cache is what was served before this release) or a
// failed state read (Postgres unreachable). Lists and enrichment never call this.
export type Served = { wines: WineMeta[]; meta: SessionMeta; identity: AuthorizedIdentity }
// A caller no longer admitted: the removed bounce (banned / kicked) or invalid.
const refused = (status: string): NextResponse =>
  status === 'banned' || status === 'kicked' ? authRemoved('removed from session') : authInvalid()
export async function servedLineup(code: string, opened: OpenedLive, identity: AuthorizedIdentity): Promise<Served | NextResponse> {
  const cached: Served = { wines: opened.wines, meta: opened.meta, identity }
  let state: { sessionId: number; revision: number | null } | undefined
  try {
    if (identity.grant) state = { sessionId: identity.grant.sessionId, revision: identity.grant.lineupRevision }
    else if (identity.kind !== 'user') {
      const r = await readLineupState(code)
      if (r && r.createdAt !== opened.meta.createdAt) return unavailable('absent')
      state = r
    }
  } catch (err) {
    console.error('[lineup] the revision read failed, serving the cached line-up', { code, err })
    return cached
  }
  if (!state) return cached
  if (state.revision !== null && opened.wrev === String(state.revision)) return cached
  try {
    const r = await refreshLineup(code, opened.meta.createdAt, identity)
    if (r === 'absent') return unavailable('absent')
    // 🔒 The view of the newer line-up uses the settings and the caller read
    // with it under the locks (Codex r2), never the request's earlier ones, and
    // a caller no longer admitted gets the answer a fresh request would (r4).
    if (r !== 'busy') {
      if (r.callerStatus && r.callerStatus !== 'ok') return refused(r.callerStatus)
      return { wines: r.lineup, meta: r.meta, identity: r.caller ?? identity }
    }
  } catch (err) {
    console.error('[lineup] the refresh failed', { code, err })
  }
  if (state.revision === null) return cached
  try {
    // The line-up FIRST, then the settings and the caller's grant: a settings
    // tightening lands in the cache before its COMMIT, so settings read after
    // the bottles are never older than them.
    const wines = await recordLineup(prisma, state.sessionId)
    const raw = await redis.get(k.meta(code))
    const meta = raw ? JSON.parse(raw) as SessionMeta : null
    if (!meta || meta.createdAt !== opened.meta.createdAt) return sessionRestoring()
    // The fresh grant must be the SAME session (Codex r3: a code recycled
    // between the reads would attach its successor's grant), else 503.
    const fresh = identity.kind === 'user' ? await readGrant(prisma, code, Number(identity.id.slice(2))) : null
    if (identity.kind === 'user' && (!fresh || fresh.sessionId !== state.sessionId || fresh.createdAt !== opened.meta.createdAt)) return sessionRestoring()
    // Admission again, as the record and the cache say NOW (Codex r4): a Redis
    // ban first, then the grant (a signed-in caller) or the cache's roster (a
    // guest).
    if (await redis.sIsMember(k.bans(code), identity.id)) return refused('banned')
    const status = fresh ? grantStatus(fresh) : await cacheAdmission(code, identity.id, opened.meta.createdAt)
    if (status === 'mismatch') return sessionRestoring()
    // Exactly participantOrBanned's read rule: only 'ok' (a meta-proven host
    // missing from the roster is no participant for a read).
    if (status !== 'ok') return refused(status)
    return { wines, meta, identity: fresh ? authorized(identity, fresh, identity.incarnation, identity.denied) : identity }
  } catch (err) {
    console.error('[lineup] the record read failed', { code, err })
    return sessionRestoring()
  }
}

// A host-tier line-up write (reveal/hide, reveal-all/hide-all, reorder) inside
// the session mutation contract: the power re-decided from the caller's fresh
// grant. A Postgres-backed moment is RECORD-FIRST (model change § 8a): a NULL
// revision reconciled, `record(tx, sessionId)` decides and writes on the rows
// (the contract's row lock bumped the revision), the line-up read back and, after
// COMMIT, projected stamped. A Redis-only moment keeps the fenced `mutateWines`
// transform as its authority. A reject (either form) → `rejectStatus`.
export async function hostLineupWrite(
  code: string,
  caller: AuthorizedIdentity,
  { label, forbidden, rejectStatus = 404 }: { label: string; forbidden: string; rejectStatus?: number },
  ops: {
    redisOnly: (wines: WineMeta[]) => WineMeta[] | MutateReject
    record: (tx: Prisma.TransactionClient, sessionId: number) => Promise<void | MutateReject>
  },
): Promise<WineMeta[] | NextResponse> {
  try {
    const out = await withSessionMutation(code, { label, redisLock: { waitMs: 3000 }, caller, bumpLineup: true }, async (tx, ctx) => {
      if (!isHostByIdentity(ctx.meta!, admitted(ctx))) throw refuse(403, forbidden)
      if (!ctx.row) {
        const next = await mutateWines(ctx.fence!, ops.redisOnly)
        if (isMutateReject(next)) throw refuse(rejectStatus, next.reject)
        return { lineup: next, revision: null }
      }
      const revision = (await reconcileLineup(tx, ctx))!
      const r = await ops.record(tx, ctx.row.id)
      if (isMutateReject(r)) throw refuse(rejectStatus, r.reject)
      return { lineup: await recordLineup(tx, ctx.row.id), revision }
    }, async (ctx, r) => { if (r.revision !== null) await projectLineup(ctx.fence!, r.lineup, r.revision) })
    return out.lineup
  } catch (err) {
    return contractFailure(err, code, { label })
  }
}
