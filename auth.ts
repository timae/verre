import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { authConfig } from '@/auth.config'
import { checkRate, peekRates, getClientIp } from '@/lib/rateLimit'
import { parseUserAgent } from '@/lib/userAgent'
import { resolveGeoLabel } from '@/lib/geo'

// Constant-time guard against email enumeration via login timing.
// Real bcrypt-12 hash that will never match any user's password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12)

// lastSeenAt is bumped at coarse 5-minute WALL-CLOCK buckets (00:00, 00:05, …),
// not a sliding window. The STORED value is the bucket START, not the precise
// request time — so every session's lastSeenAt snaps to the same edges. This
// is what collapses timeline-correlation signal across an exfiltrated DB: a
// stored value of 00:05:00 reveals only "active sometime in the 00:05–00:10
// window", never "request happened at 00:07:43". Applies ONLY to lastSeenAt;
// createdAt stays precise (one-shot value, useful for audit). See proposal §5.
const LAST_SEEN_BUCKET_MS = 5 * 60 * 1000

function bucketStart(ms: number): number {
  return Math.floor(ms / LAST_SEEN_BUCKET_MS) * LAST_SEEN_BUCKET_MS
}

// Bump lastSeenAt only when the current bucket differs from the stored one.
// Fire-and-forget from jwt(); the caller's .catch logs (never silences) errors
// so DB-pool exhaustion / outage signals reach ops. Because this is `async`, a
// synchronous throw in the prelude (e.g. a malformed Date) also surfaces as a
// rejected promise — so the caller's .catch covers it; it cannot throw INTO
// jwt(). Note: not strictly "one write per bucket" under concurrency — two
// requests observing the same boundary can both write — but both write the same
// bucket-start value, so the stored result is identical (idempotent).
async function bumpLastSeenIfNewBucket(sessionId: string, lastSeenAt: Date): Promise<void> {
  const nowBucket = bucketStart(Date.now())
  if (nowBucket === bucketStart(lastSeenAt.getTime())) return
  await prisma.userSession.update({
    where: { id: sessionId },
    data: { lastSeenAt: new Date(nowBucket) },
  })
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, request) {
        const parsed = z.object({
          email: z.string().email(),
          password: z.string().min(8),
        }).safeParse(credentials)
        if (!parsed.success) return null

        const email = parsed.data.email.toLowerCase()
        // Pull client IP from forwarded headers. The `request` param is the
        // raw NextAuth request; fall back to 'unknown' if no IP header set.
        const xff = request?.headers?.get?.('x-forwarded-for')
        const ip = xff ? xff.split(',')[0].trim() : (request?.headers?.get?.('x-real-ip') || 'unknown')

        // Rate limit FAILED login attempts. Successful logins don't count.
        // Three counters: 10 fails/min per email, 20 fails/hour per email,
        // 100 fails/10min per IP. We peek first (check without incrementing).
        // If already at the limit, refuse with a special error message the
        // login form surfaces. Otherwise run bcrypt; if THAT fails, we
        // increment.
        const rateChecks = [
          { key: `rl:login:email:${email}:1m`, max: 10, windowSeconds: 60 },
          { key: `rl:login:email:${email}:1h`, max: 20, windowSeconds: 3600 },
          { key: `rl:login:ip:${ip}:10m`,      max: 100, windowSeconds: 600 },
        ]
        const rate = await peekRates(rateChecks)
        if (!rate.allowed) {
          // NextAuth surfaces this Error message via res.error. The login
          // form parses RATE_LIMITED:<seconds> into a friendly message.
          throw new Error(`RATE_LIMITED:${rate.retryAfter}`)
        }

        const user = await prisma.user.findUnique({ where: { email } })
        const valid = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH)
        if (!user || !valid) {
          // Failed attempt — increment all three counters.
          for (const c of rateChecks) await checkRate(c.key, c.max, c.windowSeconds)
          return null
        }

        // Per-device session row. The signed JWT carries its uuid; the jwt()
        // revalidation gate below looks up revokedAt on every authenticated
        // request. deviceLabel + geoLabel are derived at write time — the raw
        // User-Agent and raw IP are NEVER persisted (proposal §4).
        // Geo is best-effort and NEVER blocks login: resolveGeoLabel is an
        // in-process disk lookup (no network — the IP never leaves the server)
        // that returns null on any miss/error, and we still wrap in catch.
        // The create() itself, by contrast, is a HARD dependency: if it throws,
        // the login fails (NextAuth turns it into a credentials error). This is
        // deliberate fail-closed — a login with no session row would be an
        // untracked, unrevocable session, which is worse than a transient login
        // failure the user can retry. Do NOT swallow this in a catch.
        const userAgent = request?.headers?.get?.('user-agent') ?? null
        const geoLabel = request ? await resolveGeoLabel(getClientIp(request)).catch(() => null) : null
        const userSession = await prisma.userSession.create({
          data: {
            userId: user.id,
            deviceLabel: parseUserAgent(userAgent),
            geoLabel,
          },
          select: { id: true },
        })

        return {
          id: String(user.id),
          name: user.name,
          email: user.email,
          userSessionId: userSession.id,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Initial sign-in: persist id + userSessionId from authorize(). token.id
      // MUST be set here so the immediately-following session() callback can
      // resolve the user; the revalidation branch below re-derives it too
      // (intentional belt-and-suspenders, not a contradiction).
      if (user) {
        token.id = user.id
        token.userSessionId = (user as { userSessionId?: string }).userSessionId
        return token
      }
      // Revalidation: gate on user_sessions.revokedAt. NEVER cache this lookup
      // (no unstable_cache / React cache / revalidate-tagged fetch) — the gap
      // between cache TTL and an actual revoke IS the security hole. Must hit
      // Postgres on every authenticated request, same cost as the old gate.
      //
      // A token with no userSessionId is a pre-feature ("legacy") token. We
      // treat it as invalid → strip identity → the holder is logged out on the
      // next request and re-logs in to get a tracked session. At two users a
      // one-time re-login is a non-issue, and it keeps the gate single-path: a
      // valid session ALWAYS has a live user_sessions row, no exceptions.
      if (!token.userSessionId) return {} as typeof token
      const sess = await prisma.userSession.findUnique({
        where: { id: token.userSessionId as string },
        select: { revokedAt: true, userId: true, lastSeenAt: true },
      })
      // Missing row (deleted / never existed) or revoked → strip identity.
      // We return {} rather than null because Server Components can't set
      // Set-Cookie; a null return would leave the cookie and cause a
      // transient bad state on the next render. session() sees no id → no user.
      if (!sess || sess.revokedAt) return {} as typeof token
      // Re-derive userId from the session row — never trust a pre-existing
      // token.id on revalidation. A tampered claim already fails signature
      // verification; this is defence-in-depth.
      token.id = String(sess.userId)
      bumpLastSeenIfNewBucket(token.userSessionId as string, sess.lastSeenAt).catch((err) =>
        console.warn('[user-session] lastSeenAt bump failed', err),
      )
      return token
    },
    async session({ session, token }) {
      // Token was stripped (revoked / user deleted) — return session with no user
      if (!token.id) return { ...session, user: undefined as never }
      // Fetch role/pro fresh on every session() call so changes (e.g. pro
      // upgrade) take effect immediately without requiring re-login.
      const dbUser = await prisma.user.findUnique({
        where: { id: Number(token.id) },
        select: { id: true, name: true, role: true, pro: true },
      })
      if (!dbUser) return { ...session, user: undefined as never }
      if (session.user) {
        session.user.id   = String(dbUser.id)
        session.user.name = dbUser.name
        session.user.role = dbUser.role
        session.user.pro  = dbUser.pro
        // Surface the current per-device session id so callers (password-change
        // handler, /api/me/devices) read it from auth() rather than re-parsing
        // the JWT. Always set here — a token reaching this callback already
        // passed the jwt() gate, which strips any token lacking a userSessionId.
        session.user.userSessionId = token.userSessionId as string | undefined
      }
      return session
    },
  },
  events: {
    // Logout chokepoint: when a user signs out, revoke their session row so it
    // stops showing as "active" in the Connected devices list. NextAuth's
    // signOut only clears the cookie; without this, the row would linger with
    // revokedAt NULL until cleanup, and the devices list would lie. Covers all
    // signOut() call sites at once (no per-button wiring). Best-effort: logout
    // must always succeed even if the DB write fails, so we catch + log.
    // Idempotent via the revokedAt IS NULL guard.
    async signOut(message) {
      const sessionId = 'token' in message ? (message.token?.userSessionId as string | undefined) : undefined
      if (!sessionId) return
      try {
        await prisma.userSession.updateMany({
          where: { id: sessionId, revokedAt: null },
          data: { revokedAt: new Date(), revocationReason: 'logout' },
        })
      } catch (err) {
        console.warn('[user-session] signOut revoke failed', err)
      }
    },
  },
  session: { strategy: 'jwt' },
  logger: {
    error(error) {
      // Collapse expected auth-failure noise so the real errors stand out.
      if (error.name === 'CredentialsSignin') {
        console.warn('[auth] failed login (wrong credentials)')
        return
      }
      if (error.name === 'CallbackRouteError') {
        const causeMsg = (error.cause as { err?: Error } | undefined)?.err?.message
          ?? (error.cause as Error | undefined)?.message
        const rl = causeMsg?.match(/^RATE_LIMITED:(\d+)$/)
        if (rl) {
          console.warn(`[auth] login rate-limited (retry in ${rl[1]}s)`)
          return
        }
      }
      console.error(error)
    },
  },
})
