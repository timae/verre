import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { APIError } from 'better-auth/api'
import { createHmac } from 'node:crypto'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'
import { validateDisplayName } from '@verre/core'
import { resolveGeoLabel } from '@/lib/geo'
import { parseUserAgent } from '@/lib/userAgent'
import { backfillNativeCredential, revokeAllWebSessions, syncCredential } from '@/lib/identityStore'
import { checkRate, getClientIp, formatWait } from '@/lib/rateLimit'

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
// must NEVER be reached from middleware.ts / auth.config.ts / instrumentation.ts
// or `npm run build` fails with UnhandledSchemeError (Edge bundle). It is mounted
// only in the Node-runtime route handler at app/api/auth/native/[...all].
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
const secondaryStorage = {
  get: async (key: string) => (await redis.get(key)) ?? null,
  set: async (key: string, value: string, ttlSeconds?: number) => {
    // Floor at 1: `EX: 0` throws in node-redis, and a falsy-check fallthrough
    // (`if (ttlSeconds)`) would turn a 0-TTL write into a PERMANENT key.
    if (ttlSeconds !== undefined) await redis.set(key, value, { EX: Math.max(1, Math.ceil(ttlSeconds)) })
    else await redis.set(key, value)
  },
  delete: async (key: string) => {
    await redis.del(key)
  },
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
      // braces, and it closes two gaps BA's can't:
      //   (1) BA's getIp returns null when no client IP resolves and then SKIPS
      //       the limit entirely (rate-limiter/index.mjs — logs a one-time warning,
      //       then fail-OPEN; a hardcoded dist behaviour with no config flag).
      //       Here a missing IP buckets into a shared 'unknown' key (getClientIp),
      //       so the limit still applies — fail-closed.
      //   (2) BA's counter is a non-atomic read-modify-write (no Lua/INCR) →
      //       concurrent requests can under-count. Verre's checkRate is an atomic
      //       Lua INCR+EXPIRE, so the cap holds under concurrency.
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

      // Lazy credential backfill (§5): an existing WEB user's first native
      // sign-in needs an auth_accounts credential row (BA's credential sign-in
      // fails closed without one and never reads users.password_hash). Copy the
      // web hash on first contact. Throws fail the sign-in — fail-closed.
      if (ctx.path === '/sign-in/email') {
        const email = ctx.body?.email
        if (typeof email === 'string' && email) await backfillNativeCredential(email)
        return
      }
      // Force Verre's password-change posture: a password change revokes every
      // OTHER session (web does this via revokeAllSessions). Don't trust the
      // native client to pass revokeOtherSessions — inject it server-side.
      // The WEB-side revoke for this flow lives in the account.update.after
      // hook below; this flag covers the BA-side sessions.
      if (ctx.path === '/change-password') {
        return { context: { body: { ...ctx.body, revokeOtherSessions: true } } }
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
    // union GET reads these fields as ready-made labels). Hook-transformed data
    // feeds BOTH stores (with-hooks.mjs: the secondaryStorage fn receives the
    // created row).
    //
    // Create-only is sufficient because NO post-create path can write these
    // fields (verified vs 1.6.15 dist — not just "no path does", "no path CAN"):
    //   - sliding-refresh updateSession sends only { expiresAt, updatedAt }
    //     (routes/session.mjs) — never ipAddress/userAgent.
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
    // Precise createdAt stays (so does user_sessions'); updatedAt is BA-managed
    // sliding-refresh state, read only as a coarse "last seen".
    session: {
      create: {
        before: async (session) => ({
          data: {
            ipAddress: (await resolveGeoLabel(session.ipAddress).catch(() => null)) ?? '',
            userAgent: parseUserAgent(session.userAgent),
          },
        }),
      },
    },
    // 🔒 NATIVE→WEB credential mirror (§3): BA's /change-password writes
    // auth_accounts.password only. This after-hook (runs post-commit) fans the
    // new hash out to users.password_hash and kills every web session, so the
    // old password can't keep working on web — the exact drift /change-password
    // was disabledPaths'd to prevent until now.
    //
    // ⚠️ Covers /change-password ONLY — a future reset-password flow would NOT
    // hit this hook: BA's reset path goes through updatePassword → updateMany,
    // whose after-hook receives the adapter's COUNT, not the row, so the
    // providerId guard below silently skips. Inert today (no sendResetPassword
    // configured → no reset token can exist). When reset ships, wire
    // emailAndPassword.onPasswordReset + revokeSessionsOnPasswordReset and pin
    // a test — do not rely on this hook.
    //
    //  - Fires on ANY credential-account row update, so it self-discriminates:
    //    skip unless the row's hash actually differs from users.password_hash.
    //  - Skip when users.password_hash is NULL: a native-registered user has no
    //    web password and no web sessions — mirroring would silently grant web
    //    login. They stay native-only (the documented step-5 asymmetry).
    //  - No recursion: syncCredential writes auth_accounts via raw Prisma,
    //    which skips BA's databaseHooks.
    //  - Same independence rule as identityStore: the web-session revoke is
    //    attempted even if the hash mirror throws (revoking is the safety
    //    action), then the first error rethrows.
    account: {
      update: {
        after: async (account) => {
          // optional-chain: updateMany-shaped hook payloads are a count, not a row
          if (account?.providerId !== 'credential' || !account.password) return
          const userId = Number(account.userId)
          const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
          if (!user?.passwordHash || user.passwordHash === account.password) return
          // Independence rule (same as revokeAllSessions): both legs are
          // attempted, the revoke (the safety action) runs even if the hash
          // mirror throws, and the FIRST error rethrows after logging the second
          // — so a double failure can't silently swallow syncErr. A bare
          // unguarded `await revokeAllWebSessions` here would drop syncErr when
          // BOTH throw, hiding the crashed-mirror divergence the backfill
          // reconcile then has to detect blind.
          let syncErr: unknown
          let revokeErr: unknown
          try {
            await syncCredential(userId, account.password)
          } catch (e) {
            syncErr = e
          }
          try {
            await revokeAllWebSessions(userId, 'password_change')
          } catch (e) {
            revokeErr = e
          }
          if (syncErr && revokeErr) console.error('account.update.after mirror: revoke leg also failed (rethrowing sync error)', revokeErr)
          if (syncErr) throw syncErr
          if (revokeErr) throw revokeErr
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

  // Native sends no Origin; Better Auth validates Origin only when a cookie is
  // present. Lock trustedOrigins (§6.6 — BA has a history of trustedOrigins-bypass
  // ATOs). ⚠️ BA compares non-wildcard entries as FULL ORIGINS (scheme://host) —
  // SERVER_ACTIONS_ALLOWED_ORIGINS entries are scheme-less host:port (lib/csrf.ts
  // convention), so prepend https:// or every entry silently never matches (the
  // baseURL's own origin is auto-trusted, which is why this stayed invisible
  // locally). Apple's origin gets added in step 6 with the social config.
  trustedOrigins:
    process.env.SERVER_ACTIONS_ALLOWED_ORIGINS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((h) => (h.includes('://') ? h : `https://${h}`)) ?? [],

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
  //    drift-reconcile inference in backfillNativeCredential ("the only
  //    systematic divergence is a crashed change-password mirror, so accounts →
  //    users is unambiguously newer"): a post-reset native sign-in would copy
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
  //
  // /change-password was disabled in step 4 (it writes auth_accounts.password
  // ONLY — the old password would keep working on web). Re-enabled in step 5:
  // the account.update.after hook above mirrors the hash to users.password_hash
  // + revokes web sessions, and the before-hook forces revokeOtherSessions for
  // the BA side. Other risky endpoints inert by default (verified vs 1.6.15
  // dist): /delete-user config-gated off, /set-password has no HTTP route
  // (genuinely SERVER_ONLY — no path string).
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
  ],

  // TODO(step-6): socialProviders { google, apple } with the native id_token
  // path, nonce, and Apple appBundleIdentifier (proposal §6.4–6.5). Needs real
  // client credentials; not wired until then.
})
