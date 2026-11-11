import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import { createHmac } from 'node:crypto'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'
import { validateDisplayName } from '@verre/core'
import { resolveGeoLabel } from '@/lib/geo'
import { parseNativeUserAgent, parseUserAgent } from '@/lib/userAgent'
import { backfillNativeCredential, revokeAllWebSessions, revokeNativeSessionsExcept, syncCredential } from '@/lib/identityStore'
import { checkRate, getClientIp, formatWait } from '@/lib/rateLimit'
import { bucketStart } from '@/lib/lastSeen'

// Deterministic synthetic user-id for the sign-up enumeration mitigation (see
// customSyntheticUser below). HMAC(lowercased email) → a positive integer string
// in a plausible serial-PK range, so the same email always yields the same id
// (no repeat-probe tell) and it's indistinguishable from a real id by FORMAT.
// Keyed on AUTH_SECRET so an attacker can't precompute the mapping. Range
// 1..1e6 — wide enough not to be an obvious constant low band; the absolute-
// range residual (vs the real serial sequence) is documented + accepted.
function syntheticUserId(email: string): string {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET || ''
  const digest = createHmac('sha256', secret).update(email.trim().toLowerCase()).digest()
  const n = digest.readUInt32BE(0) % 1_000_000
  return String(n + 1)
}

// ── Better Auth — native-app credential layer ─────────────────────────────────
//
// 🔒 NODE-RUNTIME ONLY. better-auth + bcrypt pull `node:*` imports. This module
// must NEVER be reached from proxy.ts / auth.config.ts / instrumentation.ts.
// Since Next 16 a leak no longer fails the build (the proxy runs on Node, and
// Turbopack only warns about Node modules in instrumentation's Edge entry); the
// import allowlists in eslint.config.mjs (CI: check-lint.yml) catch it instead. It is mounted only in the Node-runtime route
// handler at app/api/auth/native/[...all].
//
// SCOPE (step 5): email/password only. Social providers (Google/Apple) are a
// TODO(step-6) — they need real client credentials + the native nonce/Apple
// config (proposal §6.4–6.5). The resolveUser web/native read-split, the lazy
// auth_accounts credential backfill (hooks.before below), and the identityStore
// dual-store fan-out are live.
//
// Maps onto Verre's EXISTING tables (pinned in schema.prisma): user → `users`
// (Int autoincrement PK), plus `auth_accounts` / `auth_sessions` /
// `auth_verifications`. See docs/dev/proposals/mobile-app/01-identity-and-auth.md.

// Better Auth's secondaryStorage backed by Verre's existing Redis singleton
// (lib/redis). Used for the rate-limit store (§6.2 — the default in-memory
// limiter is per-instance + resets every deploy, useless on Deplo.io). `set`'s
// 3rd arg is a TTL IN SECONDS — honored via node-redis `EX` so sliding-session
// / rate-window expiry works. delete maps to node-redis `del`.
// 🔒 A MISSING auth_sessions ROW MEANS UNAUTHENTICATED, even when Redis holds a
// valid-looking copy — enforced HERE, the one boundary every Better Auth
// session lookup crosses (findSession reads Redis-first; BA's own endpoints,
// resolveUser via api.getSession, listSessions — all of them). Why: BA's
// sliding refresh is read-Redis → write-Redis → update-Postgres with nothing
// ordering it against a concurrent delete, so a heartbeat that read its copy
// just before a revoke completed writes it BACK afterwards (a year of TTL), its
// Postgres update then fails on the now-missing row, and the copy would keep
// authenticating with no row for any Postgres-driven revoke or prune to find
// (Codex pass 4; pinned deterministically with a barrier in
// scripts/tests/ba-session-lifetime.mjs § 7g). A session copy is therefore
// only returned if its row still exists; an orphan is deleted on sight and
// reads as absent. Cost: one indexed `token` lookup per native request — the
// same per-request DB read the never-cache-auth posture already pays for
// (lib/CLAUDE.md). Only session copies are checked: BA stores them as
// `{ session, user }`; the active-sessions list, verification values and
// rate-limit counters share this store and pass straight through.
// A PG outage here throws → fail-CLOSED (BA 500s / resolveUser falls through
// to the web branch, which has no cookie to honour).
const isSessionCopy = (value: string): boolean => {
  if (!value.startsWith('{')) return false
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && 'session' in parsed && 'user' in parsed
  } catch {
    return false
  }
}
const INCREMENT_SCRIPT = `
  local cur = redis.call('GET', KEYS[1])
  if cur and not tonumber(cur) then redis.call('DEL', KEYS[1]) end
  local n = redis.call('INCR', KEYS[1])
  if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return n
`
const secondaryStorage = {
  get: async (key: string) => {
    const value = (await redis.get(key)) ?? null
    if (value === null || !isSessionCopy(value)) return value
    const row = await prisma.authSession.findUnique({ where: { token: key }, select: { id: true } })
    if (row) return value
    await redis.del(key).catch((e) => console.error('secondaryStorage: orphan session copy delete failed', e))
    return null
  },
  set: async (key: string, value: string, ttlSeconds?: number) => {
    // Floor at 1: `EX: 0` throws in node-redis, and a falsy-check fallthrough
    // (`if (ttlSeconds)`) would turn a 0-TTL write into a PERMANENT key.
    if (ttlSeconds !== undefined) await redis.set(key, value, { EX: Math.max(1, Math.ceil(ttlSeconds)) })
    else await redis.set(key, value)
  },
  delete: async (key: string) => {
    await redis.del(key)
  },
  // Required since 1.7. BA calls it only to consume a `verification:` value on
  // the secondary-storage-ONLY path, which storeInDatabase below keeps off — so
  // it never sees a session copy and needs no row check.
  getAndDelete: async (key: string) => (await redis.getDel(key)) ?? null,
  // Required since 1.7: BA's limiter (rateLimit below) is now one atomic step
  // on this counter. Same INCR-then-EXPIRE-on-create shape as lib/rateLimit.ts
  // (fixed window from the first hit). 1.6.x kept a JSON object at the same
  // `<ip>|<path>` key, and INCR on it errors, which would 500 that path until
  // the old key's TTL ran out — so a non-numeric leftover counts as absent.
  increment: async (key: string, ttlSeconds: number) =>
    Number(await redis.eval(INCREMENT_SCRIPT, { keys: [key], arguments: [String(Math.max(1, Math.ceil(ttlSeconds)))] })),
}

export const betterAuthServer = betterAuth({
  // Share NextAuth's secret so both systems sign/verify with the same key.
  // Same three-name fallback chain as lib/registerToken.ts / .env.example —
  // a prod deploy that sets only NEXTAUTH_SECRET must not hand BA undefined.
  secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET,
  // Shared with NextAuth's URL convention; without it Better Auth can't build
  // callback/redirect URLs (or validate Origin against its own origin). Same
  // multi-name chain as the secret above: prod sets NEXTAUTH_URL (the NextAuth
  // v4 name Verre deploys with) — omitting it here would silently hand BA the
  // localhost fallback in prod. Dev fallback keeps local boot warning-free.
  baseURL:
    process.env.AUTH_URL ||
    process.env.BETTER_AUTH_URL ||
    process.env.NEXTAUTH_URL ||
    'http://localhost:3000',
  // Catch-all is mounted under /api/auth/native so it never collides with
  // NextAuth's [...nextauth] catch-all (Next.js forbids two at one path level).
  basePath: '/api/auth/native',

  database: prismaAdapter(prisma, { provider: 'postgresql' }),

  advanced: {
    database: {
      // 🔴 MUST be the literal string "serial" — it is the ONLY thing that flips
      // the adapter's useNumberId, which keeps Int ids Int across the FK
      // round-trip (users.id → auth_accounts.user_id). The per-table callback
      // (`false` for user, strings elsewhere) does NOT work on 1.6.15: without
      // serial the adapter stringifies every id on output, so the Int FK write
      // fails ("Expected Int, provided String", GH #3450; the settable
      // useNumberId option was removed in 1.6.x). Serial is global → all 3 BA
      // tables carry Int autoincrement PKs in schema.prisma (proposal §4).
      generateId: 'serial',
    },
  },

  // Map Better Auth's logical models onto Verre's Prisma models. `modelName` is
  // the PRISMA DELEGATE name (prisma.user, prisma.authAccount, …) — NOT the SQL
  // table name; the @@map in schema.prisma owns the SQL table/column names, which
  // Better Auth never sees. Likewise `fields` keys map a BA field to a PRISMA
  // FIELD name (camelCase), not a column — so the only remap needed is BA's
  // `image` → Verre's `imageUrl`; every other field already matches the Prisma
  // model (userId, emailVerified, expiresAt, …) and must NOT be listed.
  user: {
    modelName: 'user',
    fields: { image: 'imageUrl' },
  },
  account: {
    modelName: 'authAccount',
    // 🔴 nOAuth (GHSA-g38m-r43w-p2q7): email/password + social + default linking
    // lets an attacker who pre-registered the victim's email capture the victim's
    // later Google/Apple identity. Lock ALL of these (proposal §6.1); the version
    // pin (>=1.6.13) plus requireLocalEmailVerified is the actual fix.
    accountLinking: {
      enabled: true,
      requireLocalEmailVerified: true,
      allowDifferentEmails: false,
      trustedProviders: [],
      disableImplicitLinking: true,
    },
  },
  session: {
    modelName: 'authSession',
    // 🔒 cookieCache OFF (the default; pinned + CI-tested). On, it caches signed
    // session data IN the device cookie → the server can't push a revocation to
    // another device until maxAge, violating Verre's never-cache-auth invariant
    // (lib/CLAUDE.md) and was the root of a HIGH 2FA-bypass (GHSA-xg6x-h9c9-2m83).
    cookieCache: { enabled: false },
    // 🔒 REQUIRED with secondaryStorage. Without it, configuring secondaryStorage
    // (added for rate limiting, §6.2) silently moves session storage to Redis
    // ONLY — auth_sessions stays empty and the proposal's opaque-DB-sessions
    // posture is gone. With it, BA writes BOTH stores and serves reads Redis-
    // first. ⚠️ Consequence: a raw prisma.authSession.delete does NOT revoke
    // (the Redis copy stays live until TTL) — every revocation must go through
    // Better Auth, which deletes both stores. The identityStore fan-out uses
    // $context.internalAdapter (deleteUserSessions/deleteSession — the same
    // both-store path BA's own endpoints use) because the api.revoke* endpoints
    // sit behind sessionMiddleware and need a live BA cookie, which web-
    // triggered revokes don't have. Never raw row deletes.
    storeSessionInDatabase: true,
    // Native sessions slide: a get-session heartbeat ≥ updateAge after the last
    // refresh re-stamps expiresAt to now + expiresIn, so an active device never
    // signs out and expiresIn is the INACTIVITY window. Ruled 2026-11-04: one
    // year — the 7d BA default is a web posture; a phone is expected to stay
    // signed in across months of not opening the app. Native-only: web is
    // NextAuth (auth.ts) and shares no setting here. Why not "never": expiry is
    // the only thing that retires a session nobody will revoke (replaced phones;
    // the iOS Keychain survives uninstall), and the nightly prune in
    // prisma/maintenance/cleanup-revoked-sessions.sql keys on it.
    // 🔒 Only HTTP calls may slide. lib/resolveUser.ts — the one non-HTTP
    // caller — passes disableRefresh: a refresh there re-stamps the server copy
    // but its Set-Cookie dies with the throwaway context, and the Expo client
    // drops its stored cookie at the stamp of the LAST Set-Cookie it actually
    // saw, so a silent server slide could sign the device out early by nearly
    // the whole window. (The /change-password before-hook's getSessionFromCtx
    // also slides when due, but inside the HTTP request, so its cookie lands.)
    // Pinned in scripts/tests/ba-session-lifetime.mjs.
    expiresIn: 365 * 24 * 3600,
    updateAge: 24 * 3600,
  },
  verification: {
    modelName: 'authVerification',
    // 🔒 Same secondaryStorage trap as storeSessionInDatabase above: without
    // this flag verification values live in Redis ONLY and auth_verifications
    // stays permanently empty (internal-adapter.mjs gates the DB write on
    // verification.storeInDatabase, same executeMainFn mechanism as sessions).
    storeInDatabase: true,
  },

  // Global request hooks (run for HTTP AND auth.api.* calls, after disabledPaths
  // + the rate limiter on HTTP — so neither can be used pre-limit).
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // 🔒 Atomic, fail-CLOSED rate limit on the auth-critical native paths
      // (step-7 gate). BA's own limiter (rateLimit above) is belt; this is the
      // braces. It was added for two gaps BA 1.6 had:
      //   (1) BA's getIp returns null when no client IP resolves, and 1.6 then
      //       SKIPPED the limit entirely (fail-OPEN). Here a missing IP buckets
      //       into a shared 'unknown' key (getClientIp), so the limit still
      //       applies — fail-closed.
      //   (2) 1.6's counter was a non-atomic read-modify-write → concurrent
      //       requests could under-count. Verre's checkRate is an atomic Lua
      //       INCR+EXPIRE, so the cap holds under concurrency.
      // 1.7 closed both upstream (a missing IP shares one `no-trusted-ip|<path>`
      // bucket; the count is one secondaryStorage.increment). The floor stays
      // the authoritative limit: its keys, budgets and IP rules are Verre's,
      // and it does not depend on BA's limiter internals across upgrades.
      // Same per-path limits as the documented BA rules (app/api/rate-limits.md)
      // so behaviour is unchanged when an IP IS present — this only adds the
      // floor. Keyed on the trusted-proxy-set client IP (getClientIp; see its
      // header note). Throwing 429 here rejects before the handler runs.
      const ip = getClientIp(ctx.request ?? new Request(ctx.context.baseURL, { headers: ctx.headers ?? new Headers() }))
      const rlRule =
        ctx.path === '/sign-in/email' ? { key: `rl:ba-signin:ip:${ip}:1m`, max: 10, window: 60 } :
        ctx.path === '/sign-up/email' ? { key: `rl:ba-signup:ip:${ip}:1m`, max: 10, window: 60 } :
        ctx.path === '/change-password' ? { key: `rl:ba-chgpw:ip:${ip}:1h`, max: 20, window: 3600 } :
        null
      if (rlRule) {
        const rl = await checkRate(rlRule.key, rlRule.max, rlRule.window)
        if (!rl.allowed) {
          throw APIError.fromStatus('TOO_MANY_REQUESTS', {
            message: `Too many attempts. Try again in ${formatWait(rl.retryAfter)}.`,
          })
        }
      }

      // 🔒 /change-password is a CURRENT-PASSWORD reauth surface from an already-
      // stolen native session — the same threat as the web account PATCH/DELETE.
      // The IP counter above bounds spray from one IP, but an attacker with one
      // stolen cookie can ROTATE IPs to bypass it. So ALSO charge the PER-USER
      // budget — the SAME `rl:account:user:<id>:1h` key (20/h) the web account
      // routes + verifyPassword use — so the password-guess budget is shared
      // across web and native and a stolen native cookie can't get a fresh 20/h.
      // The user comes from the session cookie (getSessionFromCtx — the global
      // before-hook runs before sensitiveSessionMiddleware populates
      // ctx.context.session, so resolve it directly). The per-user charge is
      // skipped in exactly two cases, both safe: (a) NO session → the charge is
      // skipped here, and sensitiveSessionMiddleware 401s the request right after
      // this hook, so no password guess reaches bcrypt; (b) a present session
      // with a non-positive/NaN id → that branch is UNREACHABLE (Verre ids are
      // always positive Postgres serials), so it can't actually skip a charge for
      // a real session. So a skipped charge never lets a guess through.
      //
      // ⚠️ getSessionFromCtx caches its result on ctx.context.session. On 1.6
      // the endpoint's sensitiveSessionMiddleware reused that cache, which was
      // only safe because cookieCache.enabled is false (we resolve WITHOUT
      // disableCookieCache). Since 1.7 the middleware clears it and re-reads the
      // store (getAuthoritativeSessionFromCtx, stateful config), so the endpoint
      // never trusts this lookup. Keep cookieCache off anyway (session config
      // above + its CI gate): this hook's own lookup would then key the budget
      // off a cookie-cached copy.
      if (ctx.path === '/change-password') {
        const sess = await getSessionFromCtx(ctx).catch(() => null)
        // Number(...) to match the web routes' EXACT key shape — they do
        // `Number(session.user.id)` (account/route.ts, verifyPassword.ts), so the
        // budget is genuinely the SAME key, not a string-vs-number twin that would
        // silently split the budget. The guard skips a non-positive/NaN id — see
        // the two skip cases (both safe) in the block comment above.
        const uid = Number(sess?.user?.id)
        if (Number.isInteger(uid) && uid > 0) {
          const rl = await checkRate(`rl:account:user:${uid}:1h`, 20, 3600)
          if (!rl.allowed) {
            throw APIError.fromStatus('TOO_MANY_REQUESTS', {
              message: `Too many attempts. Try again in ${formatWait(rl.retryAfter)}.`,
            })
          }
        }
      }

      // 🔒 Native revokes are OURS, not Better Auth's (rationale + failure
      // semantics: revokeNativeSessionsExcept in identityStore — BA's are list-
      // driven and delete PG rows before Redis copies, which an evicted
      // `active-sessions-<uid>` list turns into unrevocable ghosts).
      //  - /revoke-sessions and /revoke-other-sessions are handled HERE in full:
      //    the caller is resolved from the cookie (getSessionFromCtx — the same
      //    full store validation sessionMiddleware would do; cookieCache is off),
      //    every token is deleted from a Postgres snapshot, and the endpoint is
      //    short-circuited with BA's own `{ status: true }` body (a before-hook
      //    returning a non-context value IS the response — dispatch.mjs). A
      //    throw anywhere (snapshot, any token) surfaces as a 500 with the
      //    remaining rows intact for the retry. No session → fall through to
      //    the endpoint, which 401s.
      //  - /change-password: the revoke must only happen once the current
      //    password has verified, so it lives in the account.update.after
      //    database hook below (it runs iff the credential row committed, even
      //    when the endpoint fails afterwards). BA's own revokeOtherSessions is
      //    switched OFF (its list-driven delete would race ours and rotate the
      //    caller's session); the caller KEEPS its current session, like web.
      //    The hook keeps the caller's token from ITS OWN request context (BA
      //    passes the originating endpoint ctx as the hook's 2nd argument) —
      //    never from shared state, which a concurrent attempt could overwrite.
      if (ctx.path === '/revoke-sessions' || ctx.path === '/revoke-other-sessions') {
        const sess = await getSessionFromCtx(ctx).catch(() => null)
        const uid = Number(sess?.user?.id)
        const current = sess?.session?.token
        if (!Number.isInteger(uid) || uid <= 0 || !current) return
        try {
          await revokeNativeSessionsExcept(uid, ctx.path === '/revoke-other-sessions' ? current : null)
        } catch (e) {
          console.error(`${ctx.path}: native revoke failed (rows kept for retry)`, e)
          throw APIError.from('INTERNAL_SERVER_ERROR', { message: 'Internal Server Error', code: 'INTERNAL_SERVER_ERROR' })
        }
        return ctx.json({ status: true })
      }

      // Lazy credential backfill (§5): an existing WEB user's first native
      // sign-in needs an auth_accounts credential row (BA's credential sign-in
      // fails closed without one and never reads users.password_hash). Copy the
      // web hash on first contact. Throws fail the sign-in — fail-closed.
      if (ctx.path === '/sign-in/email') {
        const email = ctx.body?.email
        if (typeof email === 'string' && email) await backfillNativeCredential(email)
        return
      }
      // Verre's password-change posture: a password change revokes every OTHER
      // session, web AND native, through the chokepoint — both legs live in the
      // account.update.after hook below. BA's own revokeOtherSessions is forced
      // OFF here (don't trust the client to pass it either way): see the native-
      // revoke comment above for why BA's list-driven version is not used.
      if (ctx.path === '/change-password') {
        return { context: { body: { ...ctx.body, revokeOtherSessions: false } } }
      }
    }),
  },

  // Name handling — PARITY with the web register (app/api/auth/register): both
  // run validateDisplayName (@verre/core), which NFKC-normalises, enforces the
  // 2..64-char length (so an over-64 name 400s here, not a VarChar(64) 500 at
  // Prisma), the allowed-character set (rejecting bidi/zero-width/control — these
  // aren't in \p{L}\p{N}), reserved names, and single-script. BA's sign-up would
  // otherwise write `name` straight to users.name with NO validation. On invalid
  // input validateDisplayName THROWS → we map that to `return false`, which BA
  // turns into a 400 FAILED_TO_CREATE_USER (the create-cancel contract). update:
  // drop the field when absent (undefined = "not provided" to Prisma). Hook
  // contract: return { data } to MERGE into the incoming body (with-hooks.mjs
  // spreads { ...actualData, ...result.data }), false to cancel.
  //
  // 🔒 image MUST be force-undefined on create. BA's /sign-up/email accepts an
  // `image` body field, and the `fields: { image: 'imageUrl' }` map above would
  // write it straight to users.image_url — bypassing the avatar pipeline
  // (MIME/magic-byte checks, EXIF strip, S3 reclaim accounting), exactly what
  // /update-user is 404'd to prevent. Because the hook MERGES, returning only
  // { data: { name } } leaves a caller-supplied value in actualData; the explicit
  // undefined drops it. ⚠️ The hook sees BA's LOGICAL model — the field is still
  // `image` here; the `image → imageUrl` rename happens later in adapter.create
  // (with-hooks.mjs runs the before-hook on actualData, THEN the adapter maps
  // field names). So undefine `image`, not `imageUrl` — setting `imageUrl` here
  // would add an unknown key and the real `image` would still map through.
  // Native avatars set via /api/me/avatar.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          let name: string
          try { name = validateDisplayName(user.name) }
          catch { return false } // invalid → BA 400 FAILED_TO_CREATE_USER
          return { data: { name, image: undefined } }
        },
      },
      update: {
        before: async (data) => {
          if (!('name' in data)) return
          try { return { data: { name: validateDisplayName(data.name) } } }
          catch { return false } // invalid name on update → reject the update
        },
      },
    },
    // 🔒 Privacy parity with user_sessions (lib/CLAUDE.md): raw IPs are NEVER
    // persisted — only the derived country label. BA's createSession would
    // store the raw XFF IP + UA in auth_sessions AND the Redis session copy;
    // this hook replaces both with the same write-time labels the web login
    // path stores (resolveGeoLabel is in-process and never throws; the devices
    // union GET reads these fields as ready-made labels), except that the app's
    // own User-Agent gets its model label first ("iPhone 15 Pro · Verre App",
    // parseNativeUserAgent: only this hook calls it, so a web login can't claim
    // it; only /sign-in/email creates native sessions). Hook-transformed data
    // feeds BOTH stores (with-hooks.mjs: the secondaryStorage fn receives the
    // created row).
    //
    // Create-only is sufficient because NO post-create path can write these
    // fields (verified vs 1.6.15 dist — not just "no path does", "no path CAN"):
    //   - sliding-refresh updateSession sends only { expiresAt, updatedAt }
    //     (routes/session.mjs) — never ipAddress/userAgent.
    //   - the last-seen bump in lib/resolveUser.ts sends only { updatedAt }.
    //   - the /update-session HTTP endpoint takes an arbitrary body but routes
    //     it through parseSessionInput → getFields(.,"session","input"), and in
    //     any NON-output mode getFields returns coreSchema = {} (db/schema.mjs
    //     line ~11) merged only with session.additionalFields + plugin fields —
    //     of which Verre configures NONE. So ipAddress/userAgent are not in the
    //     update schema at all; a caller-supplied value is dropped and the
    //     endpoint 400s "No fields to update". It's in disabledPaths anyway
    //     (defense-in-depth + to stop reviewers re-litigating it — a raw-IP-
    //     injection flag on it was a false positive: core fields never reach
    //     parseInputData's input:false gate, they're excluded a step earlier).
    // Precise createdAt stays (so does user_sessions' — it's a one-shot value).
    //
    // 🔒 updatedAt is FLOORED to the 5-min bucket at WRITE time (lib/lastSeen.ts
    // bucketStart) — at create here AND on every sliding-refresh and every
    // resolveUser last-seen bump via the update.before hook below. auth_sessions.updatedAt is the native "last seen"
    // (the devices union surfaces it as lastSeenAt), so this gives it the SAME
    // at-rest precision as web user_sessions.lastSeenAt, which auth.ts buckets at
    // write time. Without this the column + its Redis copy held a precise instant
    // (coarsened only on read), so a DB/Redis exfil could reconstruct a native
    // activity timeline the web side already suppresses. The devices GET still
    // buckets on read (belt) but the at-rest value is now coarse too (braces).
    session: {
      create: {
        before: async (session) => ({
          data: {
            ipAddress: (await resolveGeoLabel(session.ipAddress).catch(() => null)) ?? '',
            userAgent: parseNativeUserAgent(session.userAgent) ?? parseUserAgent(session.userAgent),
            updatedAt: new Date(bucketStart(new Date(session.updatedAt ?? Date.now()).getTime())),
          },
        }),
      },
      update: {
        // Two writers send updatedAt as an exact instant: the sliding refresh
        // ({ expiresAt, updatedAt: new Date() }, routes/session.mjs) and the
        // last-seen bump in lib/resolveUser.ts ({ updatedAt } only). Floor it
        // so the stored value stays on the 5-min edge; other updates pass
        // through unchanged.
        before: async (data) => {
          if (!('updatedAt' in data) || data.updatedAt == null) return
          return { data: { updatedAt: new Date(bucketStart(new Date(data.updatedAt).getTime())) } }
        },
      },
    },
    // 🔒 NATIVE→WEB credential mirror (§3), TWO hooks:
    //
    // create.after — a NATIVE SIGN-UP writes its bcrypt hash to
    // auth_accounts.password only; without this mirror the user has
    // users.password_hash = NULL and can't log in on web (the original "step-5
    // asymmetry", reversed by security review 2026-06-12: it was a front-door
    // distinction with no capability behind it — a BA session already reaches
    // every API route via resolveUser — and it broke the one-identity product
    // promise for every app-registered user). Fill-NULL-ONLY: an existing web
    // user can never reach this hook with a different hash (a taken email gets
    // the synthetic-success path and creates NO row — see autoSignIn below),
    // and backfillNativeCredential's row-create is raw Prisma (skips BA hooks),
    // so the only callers are genuine BA-created rows. Social rows (step 6)
    // are guarded out by providerId/password. No revoke leg: a NULL-hash user
    // can have no credential web sessions to kill.
    // ⚠️ Runs POST-COMMIT — a throw here strands the user web-less with
    // nothing else able to heal (the update-mirror needs a non-NULL hash to
    // engage). backfillNativeCredential's NULL-heal branch (identityStore)
    // exists exactly for that: it completes this crashed mirror on the next
    // native sign-in. Ship/modify the two together.
    //
    // update.after — BA's /change-password writes auth_accounts.password only.
    // This after-hook (runs post-commit) fans the new hash out to
    // users.password_hash and kills every web session, so the old password
    // can't keep working on web — the exact drift /change-password was
    // disabledPaths'd to prevent until now.
    //
    // ⚠️ update covers /change-password ONLY — a future reset-password flow
    // would NOT hit it: BA's reset path goes through updatePassword →
    // updateMany, whose after-hook receives the adapter's COUNT, not the row,
    // so the providerId guard below silently skips. Inert today (no
    // sendResetPassword configured → no reset token can exist). When reset
    // ships, wire emailAndPassword.onPasswordReset +
    // revokeSessionsOnPasswordReset and pin a test — do not rely on this hook.
    //
    //  - update fires on ANY credential-account row update. The MIRROR leg
    //    self-discriminates (skip unless the row's hash differs from
    //    users.password_hash; a NULL users.password_hash means a crashed
    //    create-mirror, so mirroring here is a second heal point). The REVOKE
    //    legs do NOT depend on that comparison when the update originates from
    //    /change-password — see the hook body.
    //  - No recursion: syncCredential writes auth_accounts via raw Prisma,
    //    which skips BA's databaseHooks.
    //  - Same independence rule as identityStore: the web-session revoke is
    //    attempted even if the hash mirror throws (revoking is the safety
    //    action), then the first error rethrows.
    account: {
      create: {
        after: async (account) => {
          if (account?.providerId !== 'credential' || !account.password) return
          const userId = Number(account.userId)
          if (!Number.isInteger(userId) || userId <= 0) return
          const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
          if (!user || user.passwordHash) return // fill-NULL-only — never overwrite a web hash
          // syncCredential's auth_accounts leg re-writes the just-created row
          // with the same value — deliberately redundant: one chokepoint code
          // path for every credential write beats a special-cased variant.
          await syncCredential(userId, account.password)
        },
      },
      update: {
        // 🔒 (account, ctx): BA hands the ORIGINATING endpoint context as the 2nd
        // argument (with-hooks.mjs: `toRun(updated, context)` where context is
        // getCurrentAuthContext() — the per-request ctx dispatch.mjs runs the
        // handler under). That is what makes the keep decision request-scoped:
        // a shared per-user slot was overwritable by a concurrent wrong-password
        // attempt from a stolen session, which then became the session KEPT
        // (Codex pass 3). ctx is null for non-endpoint callers.
        after: async (account, ctx) => {
          // optional-chain: updateMany-shaped hook payloads are a count, not a row
          if (account?.providerId !== 'credential' || !account.password) return
          const userId = Number(account.userId)
          if (!Number.isInteger(userId) || userId <= 0) return
          const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
          if (!user) return
          // Two independent triggers, deliberately NOT one guard:
          //  - fromChangePassword: the ONLY BA path that updates a credential row
          //    today. A password change ALWAYS revokes the other sessions, web and
          //    native — regardless of whether the web hash still needs mirroring.
          //    Gating the revokes on the hash guard let a concurrent native sign-in
          //    (backfillNativeCredential mirroring the new hash between BA's
          //    commit and this read) make the hashes equal and SKIP revocation
          //    entirely, with BA's own revoke switched off (Codex pass 3).
          //  - mirrorNeeded: the hash self-discrimination the mirror leg still
          //    uses (a NULL users.password_hash is a crashed create-mirror → heal).
          const fromChangePassword = ctx?.path === '/change-password'
          const mirrorNeeded = user.passwordHash !== account.password
          if (!fromChangePassword && !mirrorNeeded) return
          const keep = fromChangePassword ? ctx?.context?.session?.session?.token ?? null : null
          // Independence rule (same as revokeAllSessions): every leg is
          // attempted, the revokes (the safety action) run even if the hash
          // mirror throws, and the FIRST error rethrows after logging the rest
          // — so a multi-failure can't silently swallow syncErr. A bare
          // unguarded `await revokeAllWebSessions` here would drop syncErr when
          // BOTH throw, hiding the crashed-mirror divergence the backfill
          // reconcile then has to detect blind.
          let syncErr: unknown
          let revokeErr: unknown
          let nativeErr: unknown
          if (mirrorNeeded) {
            try {
              await syncCredential(userId, account.password)
            } catch (e) {
              syncErr = e
            }
          }
          try {
            await revokeAllWebSessions(userId, 'password_change')
          } catch (e) {
            revokeErr = e
          }
          // Native leg, token-driven (revokeNativeSessionsExcept). Lives HERE, not
          // in an endpoint after-hook, because this fires iff the credential row
          // committed — including when BA's handler then fails (runWithAdapter
          // runs queued db after-hooks even on error), the exact partial-change
          // case an endpoint-level hook misses. No resolvable keep → keep nothing,
          // safety over a re-login.
          try {
            await revokeNativeSessionsExcept(userId, keep)
          } catch (e) {
            nativeErr = e
          }
          const errs = [syncErr, revokeErr, nativeErr].filter(Boolean)
          if (errs.length > 1) console.error('account.update.after mirror: multiple legs failed (rethrowing the first)', errs.slice(1))
          if (errs.length) throw errs[0]
        },
      },
    },
  },

  emailAndPassword: {
    enabled: true,
    // 🔒 Sign-up EMAIL-ENUMERATION mitigation (step-7 gate). BA's /sign-up/email
    // otherwise throws a distinct USER_ALREADY_EXISTS (422) for a taken email —
    // an attacker probes which emails have accounts. autoSignIn:false flips BA to
    // a GENERIC synthetic-success response for an existing email (token:null + a
    // synthetic user built from the REQUEST body, not the real row — no name leak;
    // BA hashes the password to blunt timing) — verified sign-up.mjs:161-205.
    //
    // ⚠️ NOT fully closed — DON'T claim it is. BA's enumeration protection was
    // designed for RANDOM-STRING ids: under our generateId:'serial' (integer PKs),
    // BA's id generator returns false → the synthetic path falls back to a 32-char
    // RANDOM string (sign-up.mjs:176), while a REAL new user gets an integer id
    // ("311"). Same 200/shape, but `^[0-9]+$` on user.id distinguishes them — the
    // oracle just moves from status code to id FORMAT. customSyntheticUser (below)
    // overrides the synthetic id to a small integer string, killing that format
    // tell. A RESIDUAL remains: ids are sequential, so an attacker interleaving
    // real signups can statistically spot a synthetic id that's out-of-sequence
    // (we can't read MAX(id)+1 — customSyntheticUser is called SYNCHRONOUSLY, no
    // await). Closing that fully needs the deferred email-verification gate (flips
    // requireEmailVerification, which also gates the real-row creation). The format
    // tell is the genuinely-exploitable, embarrassing-in-a-pentest part; the
    // sequence residual needs a deliberate interleaved-probe attack AND a free-
    // email probe self-poisons (it creates a real account, rate-limited 10/min).
    //
    // Trade-off: a signup no longer auto-creates a session, so the native client
    // calls /sign-in/email as a second step (standard two-step flow; the app
    // doesn't exist yet, so the contract is free to set). Social sign-up is
    // unaffected. (Web register has its own 409 oracle — out of scope here.)
    autoSignIn: false,
    // See the block above: return an integer-STRING id (matching a real serial PK)
    // so the synthetic-user response can't be told from a real new signup by id
    // FORMAT. The id is DETERMINISTIC per email — an HMAC of the lowercased email
    // (keyed on AUTH_SECRET) mapped into an integer range — so probing the SAME
    // email twice returns the SAME id (a real account's id is stable; a per-
    // request RANDOM id would itself be a tell). We can't read MAX(id)+1 here
    // (customSyntheticUser is sync), so the absolute-range residual survives until
    // the email-verification gate — but the cheap, exploitable tells (format +
    // repeat-probe) are both closed. coreFields is the request-supplied name/email.
    customSyntheticUser: ({ coreFields }: { coreFields: Record<string, unknown> }) => ({
      ...coreFields,
      id: syntheticUserId(String(coreFields.email ?? '')),
    }),
    // Override BOTH hash and verify with bcrypt (Better Auth defaults to scrypt).
    // Overriding only verify would ship a mixed scrypt/bcrypt table. verify uses
    // plain bcrypt.compare with NO hardcoded cost so it accepts every cost factor
    // in prod (both $2b$12$ and a legacy $2b$10$ user — proposal §5).
    password: {
      hash: (password: string) => bcrypt.hash(password, 12),
      verify: ({ hash, password }: { hash: string; password: string }) => bcrypt.compare(password, hash),
    },
  },

  // 🔴 Rate limiting (§6.2): the default limiter is in-memory (per-instance,
  // resets every deploy — useless on Deplo.io multi-instance). Route it through
  // Redis (secondaryStorage above) so limits are shared + durable. customRules
  // tighten the brute-force surfaces to match Verre's NextAuth posture (rl:login
  // is 10/min/email; here it's per-IP since BA keys on IP).
  rateLimit: {
    enabled: true,
    storage: 'secondary-storage',
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': { window: 60, max: 10 },
      '/sign-up/email': { window: 60, max: 10 },
      // Current-password brute-force surface, same threat as the web account
      // PATCH (rl:account 20/h/user) — mirrored here as 20/h, though per-IP
      // since BA keys on IP (step-7 gate revisits the keying).
      '/change-password': { window: 3600, max: 20 },
    },
  },

  secondaryStorage,

  // The server half of the Expo integration: maps the Expo client's
  // `expo-origin` header onto `origin` so the trustedOrigins check below
  // applies to native requests (only when no Origin header is present — a
  // browser's real Origin always wins), and auto-trusts `exp://` in
  // NODE_ENV=development ONLY (never in prod).
  //
  // ⚠️ VENDORED (verbatim behavior) from @better-auth/expo's expo() plugin
  // (dist/index.js; the onRequest origin mapping is unchanged from 1.6.15 to
  // 1.7.18), NOT imported. It was vendored because that package's zod-4 peer
  // tree could not resolve at the repo root next to the web app's zod 3; the
  // root is on zod 4 since the 1.7 upgrade, so that blocker is gone, and the
  // swap is left for social sign-in, which needs the rest of the plugin. The
  // pieces deliberately DROPPED are all social-OAuth machinery, dead until
  // step 6: the expoAuthorizationProxy endpoint, the OAuth-callback
  // cookie-in-redirect after-hooks, and the disableOriginOverride option.
  // TODO(step-6): when social lands, replace this bridge with the real
  // @better-auth/expo plugin.
  plugins: [
    {
      id: 'expo',
      init: () => ({
        options: { trustedOrigins: process.env.NODE_ENV === 'development' ? ['exp://'] : [] },
      }),
      onRequest: async (request) => {
        if (request.headers.get('origin')) return
        const expoOrigin = request.headers.get('expo-origin')
        if (!expoOrigin) return
        // Verbatim dist order — mutate-first is LOAD-BEARING here: Next's
        // NextRequest cannot be rebuilt via `new Request(request, …)` (undici
        // throws "Cannot read private member #state"); its headers ARE mutable
        // in route handlers, so the try path is the one that runs. The rebuild
        // fallback only serves runtimes with immutable headers.
        try {
          request.headers.set('origin', expoOrigin)
          return { request }
        } catch {
          const headers = new Headers(request.headers)
          headers.set('origin', expoOrigin)
          return { request: new Request(request, { headers }) }
        }
      },
    } satisfies BetterAuthPlugin,
  ],

  // Native sends no Origin; Better Auth validates Origin only when a cookie is
  // present. Lock trustedOrigins (§6.6 — BA has a history of trustedOrigins-bypass
  // ATOs). ⚠️ BA compares non-wildcard entries as FULL ORIGINS (scheme://host) —
  // SERVER_ACTIONS_ALLOWED_ORIGINS entries are scheme-less host:port (lib/csrf.ts
  // convention), so prepend https:// or every entry silently never matches (the
  // baseURL's own origin is auto-trusted, which is why this stayed invisible
  // locally). Apple's origin gets added in step 6 with the social config.
  //
  // 'io.verre.app://' is the native app's custom URL scheme (apps/mobile
  // app.json `scheme`). 1.6 matched custom schemes by string PREFIX
  // (url.startsWith(pattern)), which made the trailing :// load-bearing: a bare
  // 'io.verre.app' also prefix-matched 'io.verre.appevil://'. 1.7.18 parses
  // both sides and compares the scheme exactly (trusted-origins.mjs
  // matchesOriginPattern; with no authority/path in the entry, any
  // `io.verre.app:` URL matches and look-alike schemes do not). Keep the
  // trailing :// so the entry stays safe under either rule.
  trustedOrigins: [
    'io.verre.app://',
    ...(process.env.SERVER_ACTIONS_ALLOWED_ORIGINS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((h) => (h.includes('://') ? h : `https://${h}`)) ?? []),
  ],

  // 🔒 Scope clamp: the catch-all mounts EVERY core BA endpoint, not just the
  // email/password + session set we use. BA returns 404 on a disabledPaths match
  // BEFORE rate limiting or handlers run. The list is a DENY of every mounted
  // path that is live-but-wrong for Verre — NOT a relied-upon "everything else
  // is inert" assumption (a path that 404s/400s only because some config is
  // unwired becomes live the day that config lands; we disable those explicitly
  // so the re-enable is a deliberate decision, not a silent regression):
  //
  //  - /update-user — would write users.name + users.image_url (via the image →
  //    imageUrl mapping) directly, bypassing the avatar pipeline (MIME/magic-byte
  //    checks, EXIF strip, S3 reclaim accounting — docs/dev/avatars.md). Native
  //    profile edits must go through Verre's /api/me/* routes instead.
  //  - /verify-password — `metadata.scope: 'server'` does NOT keep it off the
  //    HTTP router (the router only skips metadata.SERVER_ONLY; scope is unused
  //    there — verified in better-call/router.mjs against 1.6.15). It's a
  //    bcrypt.compare password oracle behind sensitiveSessionMiddleware, gated
  //    ONLY by BA's default 100/min/IP — it does NOT charge Verre's shared
  //    rl:account 20/h/user budget, so leaving it live is a fresh brute-force
  //    surface against the current password from a stolen native session,
  //    defeating the reason rl:account is shared. Verre's own re-auth goes
  //    through lib/verifyPassword.ts; this endpoint is never needed.
  //  - /reset-password + /request-password-reset — reset writes
  //    auth_accounts.password ONLY (the count-shaped updatePassword path the
  //    account.update.after mirror can't see), so a reset would diverge the two
  //    credential stores with NO crashed-mirror cause. That breaks the
  //    drift-reconcile inference in backfillNativeCredential (each divergence
  //    state maps to exactly one known crashed mirror, so accounts → users is
  //    unambiguously the newer direction): a post-reset native sign-in would copy
  //    the reset hash into users.password_hash and revoke web sessions. Today
  //    request-reset already 400s (no sendResetPassword), but disabling both
  //    makes shipping reset a deliberate step that MUST also wire onPasswordReset
  //    + revokeSessionsOnPasswordReset AND teach the reconcile about reset
  //    (proposal §8 step-7). Don't re-enable without that.
  //  - /verify-email + /send-verification-email + /change-email — /verify-email
  //    is HTTP-reachable (GET, no SERVER_ONLY) and on a token carrying `updateTo`
  //    it writes users.email + emailVerified AND mints a session (email-change +
  //    session-mint primitive). The token is an HS256 JWT minted only by the
  //    (unwired) verification/change-email flows, so it's inert today — but
  //    `emailVerified` becomes load-bearing at step 6 (accountLinking's
  //    requireLocalEmailVerified is the nOAuth fix), so a verification flow wired
  //    later without re-auditing this would arm an ATO. Same deny-now posture as
  //    /update-user. Native email changes must go through Verre's own routes.
  //  - /unlink-account — calls internalAdapter.deleteAccount, a raw
  //    auth_accounts credential-row delete OUTSIDE the chokepoint. The
  //    last-account guard blocks it for a single-credential user today, so it's
  //    inert until social linking (step 6) gives a user ≥2 accounts — at which
  //    point unlinking `credential` would delete the native hash mirror while
  //    users.password_hash survives, the exact store divergence the chokepoint
  //    exists to prevent. Re-enable only with a deliberate native account-mgmt
  //    surface that routes the delete through identityStore.
  //  - /update-session — provably can't write anything (core session fields are
  //    excluded from the update input schema, so it 400s "No fields to update";
  //    full reasoning at the session.create.before hook above). Verre never
  //    calls it; denied purely so it isn't a recurring "why isn't this denied?"
  //    question for future reviewers.
  //  - /list-sessions — BA's parseSessionOutput does NOT strip the session
  //    `token` field (it has no returned:false flag, and that flag is not
  //    config-overridable — verified 1.6.15), so it returns the raw session
  //    token of the user's OTHER sessions — a cross-device token leak (web's
  //    GET /api/me/devices deliberately strips it). The leaked token is NOT
  //    directly replayable as a credential (a session cookie is
  //    token.<HMAC-sig>; the bare token resolves no session — empirically
  //    verified), so it's not a hijack — but it diverges from the web posture
  //    and would let a cookie-thief TARGET a specific device for
  //    /revoke-session. Stays denied.
  //    ⚠️ /get-session was denied "for parity" until the iOS app (PR #39 note);
  //    RE-ENABLED with the first native client: @better-auth/expo's useSession
  //    + sliding-refresh fetch `/get-session` over HTTP (session-atom.mjs /
  //    session-refresh.mjs — the client has no method-call path), so the deny
  //    broke the SDK's entire session lifecycle. Risk delta of re-enabling:
  //    none beyond posture — it returns only the CALLER'S OWN current token,
  //    which the caller already holds as its cookie. The cross-device leak
  //    (/list-sessions) is what mattered, and that stays denied.
  //  - /revoke-session — targeted single-session revoke; takes a token in the body.
  //    With /list-sessions gone there's no way for a native client to obtain
  //    another device's token, so it's de-fanged; disabled for cleanliness. The
  //    COARSE revokes (/revoke-sessions, /revoke-other-sessions) stay LIVE — they
  //    need no token and are the legitimate native "log out everywhere" feature
  //    (also the victim's own panic button). They are password-free by design: an
  //    INTENTIONAL divergence from web's password-gated device revoke. Web gates
  //    it conservatively; native treats "sign out other devices" as a safe
  //    defensive action (no password prompt for a frictionless logout-all). A
  //    stolen cookie can coarsely revoke-all, but that's marginal over the full
  //    account access the cookie already grants, and symmetric with the owner's
  //    own panic button. (PR #39 review round 2.) 🔒 BA's implementations are
  //    LIST-driven (active-sessions-<uid>) and are NOT what runs: the before-
  //    hook above answers both paths itself from a Postgres snapshot
  //    (revokeNativeSessionsExcept in identityStore) so an evicted list can't
  //    leave a live Redis copy. The paths stay live (not disabledPaths) because
  //    the hook IS the endpoint; disabling them would 404 before it runs.
  //
  // /change-password was disabled in step 4 (it writes auth_accounts.password
  // ONLY — the old password would keep working on web). Re-enabled in step 5:
  // the account.update.after hook above mirrors the hash to users.password_hash
  // + revokes web AND native sessions (the latter token-driven; BA's own
  // revokeOtherSessions is forced OFF by the before-hook). Other risky endpoints inert by default (verified vs 1.6.15
  // dist): /delete-user config-gated off, /set-password has no HTTP route
  // (genuinely SERVER_ONLY — no path string).
  //
  // ⚠️ disabledPaths is EXACT-match (BA's onRequest does `disabledPaths.includes
  // (normalizedPath)`, query/trailing-slash stripped but no prefix/param match).
  // So a denied parent does NOT cover its sub-paths: `/reset-password/:token`
  // (GET callback), `/delete-user/callback`, and `/callback/:id` route to their
  // handlers even though `/reset-password`, `/delete-user`, and the social paths
  // are denied/inert. A literal `/reset-password/:token` entry here would NOT
  // help — it'd never match the concrete `/reset-password/<actual-token>`. All
  // three are INERT today (no reset token can be minted; delete-user + social are
  // config-gated off). RE-AUDIT THESE SUB-PATHS the day reset-password or a
  // social provider is wired — that's when they arm, and no disabledPaths entry
  // will catch them (see proposal §8 step-6/step-7 re-audit obligations).
  disabledPaths: [
    '/update-user',
    '/verify-password',
    '/reset-password',
    '/request-password-reset',
    '/verify-email',
    '/send-verification-email',
    '/change-email',
    '/unlink-account',
    '/update-session',
    '/list-sessions',
    '/revoke-session',
  ],

  // TODO(step-6): socialProviders { google, apple } with the native id_token
  // path, nonce, and Apple appBundleIdentifier (proposal §6.4–6.5). Needs real
  // client credentials; not wired until then.
})
