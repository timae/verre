import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'
import { scrub } from '@/lib/textSafe'

// ── Better Auth — native-app credential layer (step 4) ────────────────────────
//
// 🔒 NODE-RUNTIME ONLY. better-auth + bcrypt pull `node:*` imports. This module
// must NEVER be reached from middleware.ts / auth.config.ts / instrumentation.ts
// or `npm run build` fails with UnhandledSchemeError (Edge bundle). It is mounted
// only in the Node-runtime route handler at app/api/auth/native/[...all].
//
// SCOPE (step 4): email/password only. Social providers (Google/Apple) are a
// TODO(step-6) — they need real client credentials + the native nonce/Apple
// config (proposal §6.4–6.5). The resolveUser web/native read-split + the lazy
// auth_accounts credential backfill are step 5. Nothing reads these tables yet.
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
    if (ttlSeconds) await redis.set(key, value, { EX: ttlSeconds })
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
  // Shared with NextAuth's AUTH_URL convention; without it Better Auth can't
  // build callback/redirect URLs. Dev fallback keeps local boot warning-free.
  baseURL: process.env.AUTH_URL || process.env.BETTER_AUTH_URL || 'http://localhost:3000',
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
    // Better Auth's API, which deletes both stores. The identityStore fan-out
    // (step 5) must use betterAuthServer.api, never raw row deletes.
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

  // Verre invariant (lib/CLAUDE.md): scrub every free-text body field before a
  // DB write. BA's sign-up writes `name` straight to users.name with no scrub —
  // bidi overrides / zero-width chars would spoof display names in feeds.
  // create: cancel (BA maps a cancelled create to 400 FAILED_TO_CREATE_USER)
  // when the name scrubs to nothing; update: drop the field (undefined =
  // "not provided" to Prisma). Hook contract: return { data } to merge,
  // false to cancel (better-auth/dist/db/with-hooks.mjs).
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const name = scrub(user.name)
          if (name === null) return false
          return { data: { name } }
        },
      },
      update: {
        before: async (data) => {
          if (!('name' in data)) return
          return { data: { name: scrub(data.name) ?? undefined } }
        },
      },
    },
  },

  emailAndPassword: {
    enabled: true,
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

  // 🔒 Step-4 scope clamp: the catch-all mounts EVERY core BA endpoint, not just
  // the email/password + session set we use. Two are live-but-wrong for Verre
  // and must stay 404 (BA returns 404 on a disabledPaths match before rate
  // limiting or handlers run):
  //
  //  - /update-user — would write users.name + users.image_url (via the image →
  //    imageUrl mapping) directly, bypassing the avatar pipeline (MIME/magic-byte
  //    checks, EXIF strip, S3 reclaim accounting — docs/dev/avatars.md). Native
  //    profile edits must go through Verre's /api/me/* routes instead. Re-enable
  //    only if a native flow deliberately needs it — and then never for image.
  //
  //  - /change-password — writes auth_accounts.password ONLY: users.password_hash
  //    and user_sessions stay untouched, so the OLD password would still log in
  //    on web — exactly the cross-store credential drift the identityStore
  //    chokepoint exists to prevent (root CLAUDE.md). 🔓 Re-enable in step 5,
  //    when the credential + revocation fan-out routes through
  //    lib/identityStore.ts using betterAuthServer.api (proposal §8 step 5).
  //
  // The other risky endpoints are already inert by default (verified against
  // 1.6.15 dist): /delete-user + /change-email are config-gated off,
  // /set-password has no HTTP route (server-only), /request-password-reset
  // 400s with no sendResetPassword wired.
  disabledPaths: ['/update-user', '/change-password'],

  // TODO(step-6): socialProviders { google, apple } with the native id_token
  // path, nonce, and Apple appBundleIdentifier (proposal §6.4–6.5). Needs real
  // client credentials; not wired until then.
})
