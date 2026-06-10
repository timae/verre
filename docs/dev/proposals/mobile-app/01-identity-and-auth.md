# 01 — Identity & auth for native clients

**Status**: PROPOSED. Part of the [mobile-app meta-proposal](README.md). **The decision is settled:
adopt [Better Auth](https://better-auth.com) (a TypeScript auth *library*) for native clients (and the
future web redesign). NextAuth stays on the existing web app, untouched. The two coexist on a shared
`users` table as a deliberate, indefinite steady state.**

This replaces two earlier drafts: an attempt to extend NextAuth with hand-rolled native tokens, and a
self-hosted-OIDC-provider plan (Logto/Zitadel). Both were rejected after a long provider investigation
— see §1 and the full record in `.local/native-auth-investigation.md`. The conclusions here survived
three multi-angle review rounds and a spike against real production data.

## 1. The decision and why

**The deciding fact: social login (Google + Apple) is a launch requirement, not deferred.** Dev/test
builds on the founders' own phones can be email/password, but the **first App Store build ships with
Google + Apple sign-in**. (Apple Guideline 4.8 since Jan-2024 requires *a privacy-preserving login
option*, not specifically Sign in with Apple — Verre's own email/password may itself satisfy it — but
once we offer Google, shipping SIWA is the safe, low-friction choice that clears any reviewer. A product
choice, not a hard legal gate; we ship it.)
There is no public email/password-only phase.

**Why this picks Better Auth specifically** — the one capability that decides it:
- **NextAuth's Google/Apple providers are web-redirect-only** — there is no native `id_token` path
  (verified against the provider docs; the `next-auth/expo` PR has been stalled since 2022). So
  social-at-launch requires native-social glue from *any* option.
- **Better Auth accepts a device-obtained `id_token` natively**: `signIn.social({ provider, idToken })`,
  where the app gets the token from `expo-auth-session` (Google) / `expo-apple-authentication` (the
  native Apple sheet — no webview). First-party `@better-auth/expo` SDK.
- It is a **library that runs inside the existing Next.js backend** against the **existing managed
  Postgres** (standard privileges, no `CREATE ROLE`), so there is **zero new infrastructure** — no
  second service, no second database, no container.
- Its **default session model is an opaque, DB-backed session with immediate revocation**
  (`revokeSession`/`revokeOtherSessions`/`revokeSessions`) — which is *exactly* the per-device
  revocation Verre already hand-built on NextAuth via `user_sessions.revokedAt`. We adopt a system
  whose default already matches our hard-won invariant.
- MIT, actively maintained, post-1.0, all security advisories patched promptly.

**Why not the alternatives** (full evaluation in `.local/native-auth-investigation.md`):
- **Logto** — best native ergonomics, but its DB init *unconditionally* runs `CREATE ROLE` (per-tenant
  roles + RLS; source-verified, no opt-out). Nine's cheap "Economy" managed Postgres user has no
  `CREATEROLE` (reproduced `permission denied to create role`). Its only escapes are a 10×-pricier
  Business DB or a self-managed Postgres container to operate — net-new infra for the same outcome.
- **Zitadel** — runs on the cheap DB (verified), does native social via OIDC, but has **no first-party
  Expo SDK** (you'd hand-roll the native client — the very work we're trying to avoid), is
  event-sourced (unbounded DB growth, manual pruning), opaque-by-default with a per-app JWT toggle, and
  its backend "log out everywhere" needs a Session-v2 delete loop + a long-lived high-privilege M2M
  secret. A heavier service for less social convenience.
- **SuperTokens** — its OIDC-provider feature is paid/licensed (the free core is a proprietary session
  scheme, not standards).
- **Casdoor** — ticked every technical box but had a live **unpatched 9-CVE authentication-bypass
  batch** (CERT/CC VU#780781, vendor unreachable) plus a recurring auth-CVE pattern. Unfit for auth.
- **No-provider (native carries the NextAuth JWT as a bearer)** — was the leading plan *while social
  was deferred*; social-at-launch voids it, because NextAuth can't do native social and you'd hand-roll
  a per-provider bridge anyway.

**The honest cost we accept:** Better Auth is a young, fast-moving auth library — a HIGH advisory
landed the week of this investigation (patched fast). Running it is a **standing patch-tracking duty**
a 2-founder team takes on, lighter than running a separate auth *service* but real.

## 2. Sequencing — NEW CODE ONLY; NextAuth stays on web indefinitely

**Better Auth goes only where we write new code: the native app now, and the redesigned web later (as
greenfield). The working web auth (NextAuth) is NOT rewritten.** Web stays on NextAuth indefinitely —
**two auth systems are a deliberate permanent steady state**, not a temporary split awaiting a cutover.

- **There is no scheduled "cutover" moment** — but name a **consolidation trigger** so two-auth-systems
  is a *decision*, not a drift. The honest carrying cost is **two patch-tracking duties + two session
  models + two rate-limit configs, indefinitely**. Collapse onto Better Auth (retire NextAuth) when any
  of: the web redesign ships; NextAuth/Auth.js receives a HIGH advisory we'd have to chase; or the
  dual-store sync surface grows beyond the §3 chokepoint's reach. Absent a trigger, the realistic
  outcome is NextAuth living forever on a few legacy `/me` SSR routes — acceptable, but choose it.
- **Why not migrate web now ("single authority").** That means rewriting `auth.ts`, re-homing the
  `user_sessions.revokedAt` revocation gate, the ~46 API routes + the SSR pages that read NextAuth, and
  the Edge middleware — a multi-week rewrite of *working, security-reviewed* auth, with real regression
  risk to
  the one thing that currently works. Rejected as disproportionate.
- **Both systems share one identity.** Both key on the existing `users.id Int @autoincrement` (the trust
  anchor, ~15 FK relations). NextAuth reads `users.password_hash` + `user_sessions`; Better Auth gets
  its own `auth_accounts` (credentials) + `auth_sessions` tables, with its `user` model **mapped onto
  the existing `users` table** (verified — see §5).

## 3. The dual-store cost — measured, small, and bounded

The split means two credential stores (`users.password_hash` + Better Auth's `auth_accounts`) and two
session stores (`user_sessions` + `auth_sessions`) over one `users` table. The sync surface is tiny
because Verre's credential + revocation paths are few and already centralized:

- **Credential writes = 2 sites**: `app/api/auth/register/route.ts` + `app/api/me/account/route.ts`
  (password change). Each must also write the Better Auth `auth_accounts` row.
- **Revoke-all = 2 sites**: `app/api/me/account/route.ts` (password-change-revokes-others) +
  `app/api/me/devices/route.ts` (sign-out-all). Each must also call Better Auth's `revokeSessions`.
  (Per-device sign-out and logout are device-specific — each device knows its own store, no fanout.)

**Net build cost ≈ two helpers + four wirings + tests. The native *feature* (login/register UI,
Google/Apple native sheets, nonce wiring, SecureStore token storage, the `resolveUser` web/native
read-split) is the real multi-week work — unavoidable under any provider.**

🔒 **Safe-by-construction, not safe-by-discipline.** Put the credential write (`password_hash`) and
revocation (`revokedAt`) behind a single `lib/identityStore.ts` chokepoint that is the **only** code
allowed to touch those fields, enforced by a CI lint/grep rule that **fails the build** on any
assignment elsewhere. Drift (a future path forgetting the fanout) becomes impossible, not merely
test-caught. The revoke-all fanout must revoke **both** stores independently (one throwing must not skip
the other) — with a partial-failure test. **This is a cross-cutting invariant → it belongs in root
CLAUDE.md when implemented.**

**As-built constraint (step 4 discovery):** the BA leg of the fan-out must go through
Better Auth, **never raw `auth_sessions` row writes** — with `secondaryStorage` configured, BA
serves session reads Redis-first, so a raw `prisma.authSession` delete leaves the Redis copy
live until TTL.

**As built (step 5, 2026-06-10):** the BA leg uses `$context.internalAdapter`
(`deleteUserSessions` / `deleteSession` — the same both-store deletion path BA's own endpoints
use), not `api.revokeSessions` as sketched above: the `api.revoke*` endpoints sit behind
`sessionMiddleware` and need a live BA cookie, which a web-triggered revoke doesn't have.
`/change-password` is re-enabled WITH the fan-out: a `hooks.before` forces
`revokeOtherSessions: true` server-side, and a `databaseHooks.account.update.after` mirror routes
the new hash through `syncCredential` + revokes all web sessions (reason `password_change`) —
skipping users whose `password_hash` is NULL, so native-registered users stay native-only (no
silent web-login grant). `/update-user` stays `disabledPaths` (it would bypass the avatar
pipeline + name scrub).

**Worst drift failures, ranked:** (a) a web password change not propagated → native login uses the old
password (a visible bug, not a security hole); (b) "log out everywhere" missing the other store → a
revoked device stays alive (security-relevant, but visible in the Connected-devices panel). Both are
closed by the chokepoint + tests above.

## 4. Account model

Both systems resolve a caller to the same `users.id`. Credentials and sessions live where each system
expects them; the `users` row is the shared identity.

- **`users.id` (Int autoincrement) is the trust anchor** — unchanged, with all ~15 FK relations. Better
  Auth's `user` model maps onto it via **`advanced.database.generateId: "serial"`** — the literal
  string is the ONLY thing that flips the adapter's `useNumberId`, which keeps Int ids Int across the
  FK round-trip. ⚠️ **Corrected in step 4 (2026-06-09): the per-table `generateId` callback this
  section originally specified (return `false` for `user`, strings elsewhere) does NOT work on
  1.6.15** — without serial mode the adapter stringifies every id on output, so the FK write fails
  (`Argument userId: Expected Int, provided String`; GH #3450/#5081; the settable `useNumberId`
  option was removed, #2349). Serial is global → `auth_accounts`/`auth_sessions`/`auth_verifications`
  carry **Int autoincrement PKs** (migrated String→Int while empty,
  `20260609195038_native_auth_int_pks`). Verified e2e through `api.signUpEmail`: the Int FK
  round-trips, rows land in all three tables (`.local/test-env/scripts/_ba-e2e-signup.ts`).
- **Better Auth requires two additive columns on `users`** it doesn't have today: `email_verified`
  (boolean, `@default(false)`) and `updated_at` (timestamp, `@default(now())` — as built deliberately
  WITHOUT `@updatedAt`: BA manages the value in its own writes, and Prisma's auto-bump would race it
  on every existing `prisma.user.update`; see the schema comment). Both
  defaulted → additive-safe on the populated table. Authored by hand through Verre's gated Prisma
  migration pipeline (`prisma/CLAUDE.md`); **never** let the Better Auth CLI own or migrate `users`
  (its generated DDL would risk a `NOT NULL`-on-populated-rows violation, which `prisma/CLAUDE.md`
  flags as a confirm-gated destructive change).
- 🔴 **`users.password_hash` MUST become nullable — a social-only user has no password** (this is the
  launch-blocker the spike couldn't surface, since it only tested email/password against existing
  rows, never a fresh social-only INSERT). When a Google/Apple user signs up, Better Auth inserts a
  `users` row writing name/email/timestamps but **never `password_hash`** (passwords live in
  `auth_accounts`). With `password_hash NOT NULL` (today's schema, `String`, no default), that INSERT
  **500s on the first social sign-up.** Make it nullable. Safe web-side: `auth.ts:85` already feeds
  `?? DUMMY_HASH` on login. **BUT three other consumers do an unguarded `bcrypt.compare(pw,
  user.passwordHash)` and break on a null hash** — `app/api/me/account/route.ts:58` (password change)
  and `:113` (account delete), plus `lib/verifyPassword.ts:31` (guards a missing row via `user ?` but
  NOT a null hash). **In the same migration commit, guard all three**: `if (!user?.passwordHash)
  return <incorrect / no-password>` before the compare (never fall through to "allow"). Treat
  "nullable `password_hash` ⇒ audit every `.passwordHash` consumer" as a hard checklist item.
- **Credentials live in Better Auth's `auth_accounts` table** (provider `credential`), not on `users`.
  See §5 for the bcrypt bridge.
- **Social identities** (Google/Apple) become additional `auth_accounts` rows for the same `users.id`.

## 5. The credential bridge — bcrypt override + lazy backfill (SPIKE-VERIFIED)

Better Auth hashes with **scrypt** by default; Verre uses **bcrypt cost 12**. To verify existing
hashes, override **both** the hash and verify functions with Verre's bcrypt:

```ts
emailAndPassword: {
  enabled: true,
  password: {
    hash:   (pw) => bcrypt.hash(pw, 12),
    verify: ({ hash, password }) => bcrypt.compare(password, hash),
  },
},
```

🔒 **Override BOTH, not just `verify`.** Overriding only `verify` ships a mixed scrypt/bcrypt table
(new passwords scrypt, migrated bcrypt) and the built-in path errors on `$2a/$2b` hashes (GH #5016).

**No bulk credential migration. Lazy-create the `auth_accounts` row on a user's first native login** —
copy their existing `password_hash` into a `credential` account row at that moment. Per-user, naturally
tested, reversible — makes "new code only" true for *data*, not just control flow.

⚠️ **`signIn.email` does NOT auto-create the account row, AND Better Auth owns the credential-account
contract — a raw insert that misses a field produces a row that exists but never authenticates.** So
the lazy path is an explicit step *before* the verify, and it must replicate Better Auth's exact
`credential` account shape: **`providerId = 'credential'`, `accountId = String(users.id)`** (BA requires
accountId == userId for credential accounts), **`password = <the existing bcrypt $2b hash>`**, plus a
generated `id` and `created_at`/`updated_at`. Get any of these wrong and `signIn.email`'s lookup won't
match it. Do the insert through `identityStore` (§3) so it's the one chokepoint. **Validate this exact
shape in the build-first spike** (the prior spike inserted a hand-rolled row that *did* authenticate —
re-confirm the field set against the installed SDK version before relying on it). The documented
`setPassword` API doesn't fit (it takes *plaintext* + a logged-in session; we hold a pre-login hash).
*(Fallback if the contract proves fragile: drop lazy-backfill, write the BA credential going forward at
register/password-change via `identityStore`, and treat pre-existing users as a one-time
forgot-password-to-set-native-credential — uglier UX, zero raw-insert risk.)*

**Verified against real production data (2026-06-09 spike, dump deleted after):** Better Auth maps onto
the real prod `users` table; the bcrypt override signs in real users across **both cost factors present
in prod** (`$2b$12$` and a legacy `$2b$10$` — so the override must use plain `bcrypt.compare`, no
hardcoded cost); wrong passwords reject; the Int `user_id` FK round-trips; lazy-create works. 5/5.

## 5a. Session, revocation, and the never-cache invariant

- **Default session = opaque, DB-backed.** A session cookie maps to an `auth_sessions` row checked per
  request. `revokeSession`/`revokeOtherSessions`/`revokeSessions` delete rows → **immediate** revocation
  — the same model as Verre's `user_sessions.revokedAt` gate, native. **As built (step 4): sessions are
  dual-store.** Configuring `secondaryStorage` (required for rate limiting, §6.2) silently moves session
  storage to Redis-ONLY unless `session.storeSessionInDatabase: true` — which `lib/betterAuth.ts` sets.
  Reads are Redis-first with DB fallback; BA revocation deletes BOTH stores. ⚠️ A raw `auth_sessions`
  row delete therefore does NOT revoke (the Redis copy lives until TTL) — every revocation goes through
  Better Auth (as built: `lib/identityStore.ts` via `$context.internalAdapter` — the `api.revoke*`
  endpoints need a live BA cookie, which web-triggered revokes don't have; see §3 as-built note).
- **"Logged in forever" = sliding session.** `expiresIn` (7d default) + `updateAge` (1d default)
  auto-extends on activity → users stay logged in indefinitely while using the app. No hand-built
  re-issue endpoint.
- 🔒 **`cookieCache` MUST stay OFF — enforce with a CI test.** `cookieCache` is an opt-in cache of signed
  session data *in the device's cookie*; the server cannot invalidate another device's cookie, so a
  revoked session lingers up to `maxAge` on other devices — violating Verre's never-cache-`auth()`
  invariant (`lib/CLAUDE.md`). It was also the root cause of a HIGH 2FA-bypass (`GHSA-xg6x-h9c9-2m83`).
  Default is OFF (a DB read per request — Verre's posture; a sub-millisecond indexed lookup). **Never
  enable the JWT plugin** either (self-contained tokens the DB can't revoke). If session-read DB load
  ever matters (it won't at this scale), use Better Auth's `secondaryStorage` → Redis (server-side,
  mutable, preserves instant revocation) — **not** `cookieCache`. (As built, `secondaryStorage` is
  already on for rate limiting, so sessions already read Redis-first — see the dual-store note above.)
- 🔒 **The `resolveUser(req)` seam must be REWRITTEN, not just "add a branch" — both auth systems are now
  COOKIE-based, and the shipped precedence rule keys on the wrong signal.** The shipped seam (PR #37) was
  built for a Logto-era *bearer* native path: it routes on `if (Authorization header) → native, else →
  cookie`. But Better Auth's native client authenticates with an **opaque cookie**
  (`better-auth.session_token`, sent via `authClient.getCookie()`), NOT a bearer. So the live
  `Authorization`-present discriminator no longer distinguishes native from web. The seam selects between the two by
  **attempting Better Auth's `auth.api.getSession({ headers })` and falling through to `auth()`**. ⚠️
  **Do NOT string-match the cookie name** — in production Better Auth's cookie is
  `__Secure-better-auth.session_token` (the `__Secure-` prefix is added when secure cookies are on), so
  a literal name match silently fails in prod; let `getSession` parse it (it strips the prefix
  internally). 🔒 **Deterministic, fail-closed precedence**: if `getSession` returns a session, that's
  the caller (Better Auth wins); only on a null/absent Better Auth session do we consult the NextAuth
  cookie via `auth()`. Never merge claims from both; never let a caller carrying two cookies pick which
  identity runs. **NB — both cookies travel on every request** (Better Auth's cookie `path` defaults to
  `/`, independent of the basePath), so "both present" is the *routine* case for a native-then-web
  device, not a corner case — the precedence rule runs constantly.
- **Mapping the Better Auth session to Verre's `Session` shape is real adapter work, not a free
  pass-through.** Better Auth's `getSession` returns `{ user: { id, email, name, image, ... }, session }`
  — NOT NextAuth's `{ user: { id: string, role, pro, userSessionId } }`. The native branch must build
  the NextAuth-shaped value the API call sites expect: map `user.id` → `String(users.id)`, and do the
  **fresh, uncached `role`/`pro` SELECT** from `users` (the same read `auth()`'s `session()` does — do
  NOT cache it). `userSessionId` (a `user_sessions` concept) has no Better Auth analog — native callers
  don't have one; the few handlers that read it (password-change, devices) must tolerate its absence for
  a native caller (see the device-reauth note below). The call sites stay untouched *because the
  adapter produces the same shape* — but writing that adapter is the work; "pass-through" only describes
  the cookie branch. The native `getSession` path runs **uncached per request** (never-cache invariant).
- **Connected-devices must span both stores.** `GET /api/me/devices` reads `user_sessions` only; native
  sessions live in `auth_sessions`. So the existing panel won't show native devices (and the native app
  won't see web devices) unless the list read **unions both stores** (keyed on `users.id`). The §3
  revoke-fanout covers "log out everywhere"; this is the *display/list* side of the same feature and is
  easy to miss. **Decision: union the read** (`user_sessions` ∪ `auth_sessions`, keyed on `users.id`).
  This is load-bearing, not cosmetic: §3 downgrades a stale-revoke from "security hole" to "visible bug"
  *because the panel shows the un-revoked device* — if the list doesn't union both stores, that
  mitigation evaporates and the risk re-upgrades. So the union is required, not optional.
- **Device-management password re-auth has no native credential to check** — define it. The per-device
  `DELETE /api/me/devices/[id]` and revoke-all re-prompt for the password via `lib/verifyPassword.ts`,
  which does `bcrypt.compare(pw, users.password_hash)`. A **native** (Better Auth) user's credential is
  in `auth_accounts`, and with the §4 nullable change their `users.password_hash` may be NULL → the
  re-auth returns `false` (locks them out of device management). **For a native caller, verify the
  password against the Better Auth `credential` account** (or route the whole native device-management
  surface through Better Auth's own session/revocation APIs). Don't leave `verifyPassword` as the only
  gate — it's blind to native credentials.

## 6. Security must-dos — hard gates, not optional

From three review rounds. None of these are nice-to-haves.

1. 🔴 **nOAuth implicit-linking (`GHSA-g38m-r43w-p2q7`) — the #1 control.** With email/password + social
   + default linking (exactly our config), an attacker who pre-registers the victim's email gets the
   victim's later Google/Apple identity auto-bound → account takeover. The fix is the **version pin**
   (≥1.6.11 adds `requireLocalEmailVerified`, default true); residual vectors (link-while-authenticated,
   email-change-post-link) need more. **Do all of: pin `better-auth >= 1.6.13`; keep
   `requireLocalEmailVerified: true`; `account.accountLinking.disableImplicitLinking: true`;
   `allowDifferentEmails: false`; no `trustedProviders`.** `requireEmailVerification` alone does NOT fix it.
2. 🔴 **Rate limiting — the second-biggest gap, design before shipping.** Better Auth's native
   email/password + social endpoints are a fresh brute-force surface with no equivalent to Verre's
   `rl:login`. Its default limiter is **in-memory** (per-instance, useless on Deplo.io's multi-instance
   runtime, resets every deploy) and has two HIGH bypass advisories
   (`GHSA-p6v2-xcpg-h6xw` IPv6-prefix-rotation; `GHSA-x732-6j76-qmhm` double-slash path). **Set
   `rateLimit.storage: "secondary-storage"` → Redis + custom rules for `/sign-in/email` and social,
   matching Verre's posture; confirm the IP header isn't XFF-spoofable** (the same trusted-proxy caveat
   Verre already flagged for NextAuth).
3. 🔒 **`cookieCache` OFF, enforced by a CI test** (§5a). Never enable the JWT plugin.
4. **Nonce on native `id_token`.** Better Auth only checks the nonce *if provided*. The device must
   generate a nonce and pass it to **both** the native sheet and `signIn.social`, or a stolen `id_token`
   is replayable (~1h `maxTokenAge`).
5. **Apple config.** The native path needs `appBundleIdentifier` (the token `aud` is the iOS bundle id,
   **not** the Service ID — wrong value throws `JWTClaimValidationFailed`) + `trustedOrigins:
   ["https://appleid.apple.com"]`. Apple sends email/name **only on first authorization** → persist via
   `mapProfileToUser` or re-installs orphan the account.
6. **Native CSRF / `trustedOrigins`.** Native sends no Origin; Better Auth only validates Origin when a
   cookie is present. Lock `trustedOrigins` to Apple + Verre's own scheme (Better Auth has a history of
   trustedOrigins-bypass ATOs, `GHSA-vp58-j275-797x`).
7. 🔴 **Account-deletion FK cascade — the most dangerous regression touch-point.**
   `lib/accountDelete.ts` does a raw `DELETE FROM users` relying on Postgres `ON DELETE CASCADE`. If
   Better Auth's `auth_accounts`/`auth_sessions` `user_id` FK is **not** `onDelete: Cascade`, every web
   account deletion 500s the moment a user has Better Auth rows. **Hand-author both tables with
   `onDelete: Cascade` (matching `user_sessions`) + a test deleting a user who has Better Auth rows.**
   (Verified in the spike: tables created with the cascade.)
8. **Table-name collision.** Verre already has `@@map("sessions")` (wine-tasting sessions) **and**
   `user_sessions`. Better Auth's default `session` table collides → **pin** Better Auth's table names
   (`auth_sessions`/`auth_accounts`/`auth_verifications`). All Better Auth tables must live in
   `schema.prisma` or the schema-check CI fails every build.
9. **Keep Better Auth + bcrypt OUT of the Edge bundle.** `middleware.ts` makes the Edge runtime real,
   and `instrumentation.ts` is bundled for *both* runtimes. Better Auth (and bcrypt) pull `node:*`
   imports; if anything imported by `middleware.ts` / `auth.config.ts` / `instrumentation.ts` reaches
   the Better Auth config or `identityStore`, **`npm run build` fails with `UnhandledSchemeError`**
   (`tsc` won't catch it — see `app/CLAUDE.md`). Mount Better Auth only in Node-runtime route handlers.
   (The middleware `matcher` is `['/me/:path*']` — it does NOT cover `/api/auth/*`, so NextAuth's Edge
   config won't run on Better Auth's routes; keep it that way.)

🔒 **Crash/analytics SDK scrub** (Sentry, [06](06-ios-app.md) §6): a `beforeSend`/`beforeBreadcrumb`
denylist must strip the Better Auth session cookie/token, the password body fields
(`password`/`currentPassword`/`newPassword`), and the never-log viewer fields
(`viewerBlocksOut`/`viewerBlocksIn`/`viewerMutes`). Body-level redaction is insufficient — secrets leak
via breadcrumbs/network-spans/request-bodies too.

## 7. Trust model — unchanged

The native switch does not touch Verre's trust model (root CLAUDE.md). For completeness:
- **Identity ids remain the only trust anchor** — `u:<userId>` (logged-in), `a:<uuid>` (anon). Native
  callers resolve to `u:<userId>` via Better Auth's session → the same `users.id`. Anonymous stays
  browser-only (D1); native is registered-only.
- **Display names carry zero trust.** No change.
- 🔒 **Native sends no `Origin`**, so `isSameOrigin` passes and the session is the sole trust anchor.
  **Never relax the web cookie's `SameSite`/`httpOnly`** to accommodate native; a future social WebView
  flow uses a separate cookie, not a relaxation of this one.
- 🔒 **Never cache the per-request session/revocation lookup** (§5a) — the never-cache-`auth()` invariant
  applies equally to Better Auth (`cookieCache` OFF).

## 8. Sequencing & gate

What v1 needs, in order:

1. **`resolveUser(req)` seam — already shipped** (PR #37 on main, `69c8240`): `lib/resolveUser.ts` +
   all **46 API-route files / 63 call sites** swapped from `await auth()` → `await resolveUser(req)`.
   Cookie branch = pass-through to `auth()`; the native branch is rewritten in step 5. (SSR pages —
   `app/layout.tsx`, `app/me/*`, `app/u/[id]`, etc. — correctly keep `auth()` directly; they're not
   native-reachable. Its current comments/stub describe a *Logto bearer* branch — superseded by this
   decision; the code is harmless until step 5 rewrites it.) Delete the obsolete `logto/Dockerfile`
   (also on main from PR #37, now superseded).
2. **Schema (hand-authored, gated Prisma):** add `users.email_verified` (`@default(false)`) +
   `users.updated_at` (`@default(now())`); **make `users.password_hash` nullable + add the 3 bcrypt
   null-hash guards in the same commit** (§4 — without this the first social sign-up 500s); add
   `auth_accounts` / `auth_sessions` / `auth_verifications` (pinned names, Int `user_id` FK,
   `onDelete: Cascade`). All in `schema.prisma`.
3. **`lib/identityStore.ts` chokepoint** + the CI lint rule (§3): the only place `password_hash` /
   `revokedAt` may be written; `syncCredential` + `revokeAllSessions` fan-out across both stores.
4. **Better Auth config** with all §6 guardrails: bcrypt hash+verify override, `generateId: "serial"`
   (NOT the callback — see §4 correction), Prisma-delegate model mapping, `cookieCache` off,
   `storeSessionInDatabase: true` (without it, configuring `secondaryStorage` silently moves sessions
   to Redis-only — found in step 4; with it BA writes both stores and BA-side revocation deletes
   both, so revocation must always go through Better Auth — as built, `lib/identityStore.ts` via
   `$context.internalAdapter` (§3 as-built note) — never raw row deletes),
   `disableImplicitLinking` + the linking flags, `rateLimit` → Redis, exact-pinned `1.6.15`
   (floor `>=1.6.13` CI-asserted). Mount on a distinct basePath (`/api/auth/native`) so its
   catch-all doesn't collide with `[...nextauth]`. The catch-all mounts EVERY core BA endpoint —
   `disabledPaths` 404s the ones that are live-but-wrong (step 4: `/update-user` + `/change-password`;
   `/change-password` re-enabled in step 5; the step-5 post-ship pass added `/verify-password`,
   `/reset-password`, `/request-password-reset` — see the as-built note below; full rationale in
   `lib/betterAuth.ts`).
5. **`resolveUser` seam rewrite** (§5a) — select on which cookie is present (Better Auth session →
   `auth.api.getSession`, uncached; NextAuth cookie → unchanged `auth()`), with the deterministic
   fail-closed precedence; replace the live `Authorization`-bearer discriminator. Lazy-create the
   `auth_accounts` credential row (via `identityStore`) before the first native verify. Union the
   Connected-devices read across both stores (§5a). Wire the `identityStore` fan-out (BA leg
   through Better Auth, never raw row writes — §3) with the partial-failure test; **only then**
   drop `/change-password` from `disabledPaths` (a BA password change without the fan-out updates
   `auth_accounts` only — the old password keeps working on web).
   **Done (2026-06-10).** As-built deviations from this sketch: the BA revoke leg uses
   `$context.internalAdapter` (the `api.revoke*` endpoints need a live BA cookie — §3 as-built
   note); the backfill runs in a global `hooks.before` on `/sign-in/email` (behind BA's 10/min/IP
   limiter; idempotent; create-race-safe via the `[providerId, accountId]` unique);
   `verifyPassword` (device-revoke re-auth) falls back to the `auth_accounts` credential row only
   when `users.password_hash` is NULL; the devices GET lists native sessions as `ba:<int>` ids and
   the per-id DELETE routes those through `revokeOneNativeSession` (always password-gated — a
   `ba:` row is never the web caller's own current session); `/change-password` is rate-limited
   20/h/IP (BA `customRules`, `app/api/rate-limits.md`). Coverage:
   `.local/test-env/scripts/_ba-e2e-step5.ts` via `section-native-auth-step5.sh`.
   **Post-ship security pass (2026-06-10)** hardened the scope clamp once the catch-all's full
   mounted surface was audited (the prior `disabledPaths` was a deny-list of only the endpoints
   reasoned about, not an allow-list): (a) `/verify-password` — a `bcrypt.compare` password oracle
   that `metadata.scope: 'server'` does NOT keep off the HTTP router (the router skips only
   `metadata.SERVER_ONLY`), gated by BA's default 100/min and NOT the shared `rl:account` budget —
   added to `disabledPaths`; (b) `/reset-password` + `/request-password-reset` — reset writes
   `auth_accounts.password` only (the count-shaped `updatePassword` the `account.update.after`
   mirror can't see), which would diverge the two credential stores with no crashed-mirror cause
   and turn the drift-reconcile into an ATO primitive — added to `disabledPaths` (today inert
   anyway: no `sendResetPassword`); (c) native `/sign-up/email` accepted an `image` body field that
   mapped to `users.image_url`, bypassing the avatar pipeline — the `user.create.before` hook now
   force-undefines the LOGICAL `image` field (the rename to `imageUrl` happens later in
   `adapter.create`, so undefining `imageUrl` in the hook is a no-op — the bug the test caught).
   Pins in `_ba-e2e-signup.ts` §6/§8.
   **Second security + privacy pass (2026-06-10)** found three more: (d) **CRITICAL** — the WEB
   `PATCH /api/me/account` password change is reachable by a NATIVE (BA) cookie via `resolveUser`,
   which leaves `userSessionId` undefined; the old `if (… && session.user.userSessionId)` guard then
   SKIPPED all session revocation for native callers, so every other web + native session survived a
   password rotation (defeats the load-bearing "password change signs out other devices" invariant,
   for the exact dual-credential user native auth onboards). Fixed: a native caller (no
   `userSessionId`) revokes ALL web + ALL native sessions through `revokeAllForNativeCaller` (a
   chokepoint helper that fans out both legs with the same per-leg-catch-then-rethrow independence as
   `revokeAllSessions` — the first cut composed two unguarded sequential helper calls, which a later
   reviewer flagged as defeating that independence; corrected). Web callers unchanged. Pin:
   `_ba-e2e-step5.ts` §K. (e) `/verify-email` + `/send-verification-email` + `/change-email` added to
   `disabledPaths` — `/verify-email` is HTTP-reachable and on a token with `updateTo` writes
   `users.email` + `emailVerified` and mints a session; inert today (no verification-email flow wired)
   but `emailVerified` becomes load-bearing at step 6 (`requireLocalEmailVerified`), so deny now.
   (f) `/unlink-account` added to `disabledPaths` — `internalAdapter.deleteAccount` is a raw
   `auth_accounts` delete outside the chokepoint; blocked by the last-account guard today, arms at
   step 6 (social linking → ≥2 accounts). Also: the CI gate (`check-identity-writes.mjs`) now guards
   `auth_accounts` writes (the native credential store), not just the web columns. And (privacy) the
   devices union now buckets the native `lastSeenAt` (BA's precise `auth_sessions.updatedAt`) to the
   same 5-min edges as web `user_sessions.lastSeenAt` (`lib/lastSeen.ts`).
   **Third pass — six reviewers (3 security + general + privacy + regression + code-quality),
   2026-06-10.** No CRITICAL/HIGH live holes; regression + privacy + API-authz/IDOR reviewers came
   back clean. Acted on: (g) **HIGH** the `check-identity-writes.mjs` gate now also guards
   `auth_sessions` writes — previously the ONE native store it forgot, and the store where "a raw row
   delete does NOT revoke (Redis-first until TTL)" actually bites; a future `prisma.authSession.delete`
   believed to revoke would have passed a green build. (h) `check-better-auth-config.mjs` now asserts
   all required `disabledPaths` entries are present (eight at the time of this note; `/update-session`
   was added in pass four, making nine — the gate's `REQUIRED_DISABLED` list is the source of truth),
   so a future edit/merge dropping one re-arms a
   dangerous endpoint with a build failure instead of silently. (i) the `account.update.after` mirror
   and the backfill drift-reconcile both now apply the log-second-error / revoke-before-hash
   independence rule (a double-failure no longer swallows the first error; a transient reconcile
   revoke failure self-heals on the next sign-in rather than stranding the owed web revoke).
   Deferred (pre-existing, not introduced here): the `/api/me/account` PATCH email validator diverges
   from `register`'s `z.string().email()` (accepts any `@`-containing string) — a self-inflicted
   footgun today, but it should be unified before step 6 makes email load-bearing for
   `requireLocalEmailVerified`. Open BA-inherent accepted risk (documented in `identityStore.ts`): a
   corrupt/absent `active-sessions-<id>` Redis list can orphan token copies to TTL on a live-account
   revoke; mitigation (DB-driven sweep) is not wired — track at the step-7 gate.
   **Fourth pass — same six reviewers, 2026-06-10.** Five came back with no live holes (severity
   calibration tightened after the third pass over-graded a CI-gate gap as HIGH); the labels held this
   time. Only material outcome: `/update-session` added to `disabledPaths` (+ CI assertion + e2e pin).
   A privacy reviewer flagged it as a raw-IP/UA-injection path (a session-write that skips the
   create-only derivation hook); **verified against the 1.6.15 dist that this is a FALSE POSITIVE** —
   `parseSessionInput` → `getFields(.,"session","input")` returns an empty core schema in any
   non-output mode (`db/schema.mjs` line ~11), so `ipAddress`/`userAgent` aren't in the update schema
   at all; the endpoint 400s "No fields to update" and can't write anything (a second reviewer
   independently reached the same correct verdict). Denied anyway as defense-in-depth so it stops
   being re-litigated; the create-before hook comment now states the stronger "no path CAN write these
   fields" claim with the dist reasoning. Other findings were doc-only (gate KNOWN-LIMITS honesty
   about table-write aliasing; CI-gate guarantee-scope note; a "this fan-out duplication is deliberate"
   note) — no logic changes beyond the `/update-session` deny.
   **PR #39 review (Tim + agents), two rounds, 2026-06-10.** Round 1: name-validation parity
   (validateDisplayName on the native sign-up hook), deterministic synthetic id (HMAC, closes the
   repeat-probe tell), comment-accuracy fixes. Round 2 — two findings:
   (i) **HIGH** native `/change-password` was IP-keyed only → an attacker with a stolen native cookie
   could rotate IPs to bypass the 20/h current-password brute-force cap. Fixed: the before-hook now
   also charges the shared per-user `rl:account:user:<id>:1h` budget (the same key the web account
   routes + verifyPassword use), resolved via `getSessionFromCtx`. 5-reviewer-clean + e2e pin.
   (ii) **MEDIUM, re-scoped** native session-management endpoints. A reviewer flagged that a stolen
   native cookie could enumerate/revoke other native sessions with no password reauth (web gates device
   revoke behind verifyPassword), AND that `/list-sessions`+`/get-session` return the raw session token
   in the body. Investigation (probe-verified): the revoke-without-password is the LEGITIMATE "log out
   everywhere" feature and the victim's own panic button — web's password-gate is conservative, not
   load-bearing — so native staying password-free there is an INTENTIONAL, documented divergence. The
   token-in-body is the real (minor) issue: the leaked token is NOT replayable as a credential (a
   cookie is `token.<HMAC-sig>`; the bare token resolves no session — proven), so no hijack, but it
   diverges from web and would let a cookie-thief target a specific device. Fix: `/list-sessions`,
   `/get-session`, `/revoke-session` added to `disabledPaths` (closes the cross-device token leak +
   de-fangs targeted revoke; `resolveUser` uses the api.getSession METHOD which bypasses disabledPaths,
   so identity resolution is unaffected — verified). The COARSE `/revoke-sessions` +
   `/revoke-other-sessions` stay LIVE as the password-free native logout-all. BA's session `token`
   field can't be marked `returned:false` via config (verified), so disabling the leaking read
   endpoints is the fix, not a strip. CI gate now asserts 12 `disabledPaths` entries; e2e pins the 3
   new 404s + that `/revoke-other-sessions` stays live.
   **Final pre-merge sweep — 5 reviewers (3 security + privacy + regression/code-quality), 2026-06-10.**
   No CRITICAL/HIGH/MEDIUM across any angle; four angles fully clean, every load-bearing `betterAuth.ts`
   comment re-verified against the 1.6.15 dist. Two outcomes: (a) a note that `disabledPaths` is
   EXACT-match so `:token`/`:id`/`/callback` sub-paths (`/reset-password/:token`, `/delete-user/callback`,
   `/callback/:id`) aren't covered by their denied parents — inert today (no reset token mintable;
   delete-user + social config-gated off), but must be re-audited when reset/social ships (a literal
   `:token` entry can't match the concrete request path, so the note IS the mitigation). (b) the native
   `auth_sessions.updatedAt` (the "last seen") is now FLOORED to the 5-min bucket AT WRITE TIME via the
   session create/update hooks (`lib/lastSeen.ts`), not only coarsened on read — so the at-rest value
   (Postgres column + Redis copy) matches web `user_sessions.lastSeenAt`, closing a DB/Redis-exfil
   activity-timeline divergence. `createdAt` stays precise (one-shot). Pinned in `_ba-e2e-step5.ts` §J.
6. **Native social** — `signIn.social({ idToken })` for Google + Apple, with the nonce + Apple config
   (§6.4–6.5).
   **Deferred (2026-06-10, maintainer decision).** Can land even after the first throw of the mobile
   app — email/password native auth works without it, and it needs Google/Apple console credentials
   anyway. The step-7 gate below still blocks shipping native login; the §6.4–6.5 must-dos (nonce,
   `appBundleIdentifier`, social-only NULL-hash guards) move with this step, and the release-fence
   social items apply only once this lands.
7. **Rate-limiting design (§6.2) — gate: do not ship native login without it.** Scope at the gate
   (collected during step-5 review): XFF keying / trusted-proxy posture + the silent skip-when-no-IP;
   sign-up enumeration oracle + missing honeypot/signed-token parity with web register;
   `/change-password` IP-keying (BA can't key on userId); BA's non-atomic rate-limit counter
   (read-modify-write, no Lua/INCR); and BA's non-atomic `active-sessions-<userId>` list update —
   a concurrently-created session can be missing from the list, leaving a Redis token copy that
   authenticates but is invisible to the devices panel and to `deleteUserSessions` (BA-inherent;
   mitigation option: snapshot `auth_sessions` tokens pre-revoke and `deleteSession` each).
   **Done (2026-06-10).** As-built (research collapsed several items — see the per-item notes):
   - **XFF / trusted-proxy**: researched Deplo.io's proxy — it OVERWRITES `X-Forwarded-For` with the
     real client IP (client value → `X-Original-Forwarded-For`, never read). So keying on XFF[0] is
     NOT spoofable absent an untrusted front proxy. `getClientIp` hardened to treat a multi-entry XFF
     as untrusted; the invariant is documented in `docs/dev/deployment.md` (load-bearing: re-audit if
     a CDN is ever put in front). Not a code-keying rewrite as originally feared.
   - **Silent skip-when-no-IP + non-atomic counter**: closed together by an atomic, fail-CLOSED floor
     — a before-hook in `lib/betterAuth.ts` runs Verre's Lua `checkRate` (atomic INCR+EXPIRE) on
     `/sign-in/email` (10/min), `/sign-up/email` (10/min), `/change-password` (20/h), keyed on
     `getClientIp` (missing IP → shared `unknown` bucket, never a skip). BA's own limiter stays as a
     belt. Pinned `_ba-e2e-signup.ts` §10 + `getclientip-units.ts`.
   - **Enumeration oracle — format tell removed, residual remains (NOT fully closed)**: `autoSignIn:
     false` flips BA to a generic synthetic-success for an existing email (sign-up.mjs:161-205), but
     under our `generateId:'serial'` the synthetic id defaults to a random STRING vs a real integer id
     — an `^[0-9]+$` tell (confirmed by probe). `customSyntheticUser` overrides it to an integer string,
     closing the format tell; a sequence-correlation residual remains (synthetic id ≠ real next serial;
     `customSyntheticUser` is sync so can't read MAX(id)+1). Fully closed only by the deferred email-
     verification gate. Trade-off: native client signs in as a 2nd step. Pinned `_ba-e2e-signup.ts` §9
     (compares free-vs-taken id format — the check the first cut missed). Email-verification gating is
     the named follow-up at the release fence below.
   - **active-sessions orphan**: mitigated — `deleteUserSessionsSwept` in `lib/identityStore.ts`
     snapshots the user's `auth_sessions` tokens from Postgres BEFORE the revoke, then `deleteSession`
     each after, sweeping any Redis copy BA's lossy list missed. All three bulk-revoke call sites use
     it.
   - **Honeypot/signed-token parity — NOT ported (intentional).** They're web-form-specific (hidden
     DOM input; token minted on server-rendered form load); a JSON native endpoint has neither, and
     reimplementing them badly (a "sign-up intent" token) is security theater. The correct native
     equivalent is **App Attest (iOS) / Play Integrity (Android)** — a RELEASE-FENCE item for the
     app-build phase (`@expo/app-integrity`, rolled out monitor→warn→enforce), NOT a backend task.
     **Email-verification gating** (the strongest anti-spam lever) is blocked on the deferred email
     pipeline. Social sign-up is inherently bot-resistant. Both deferrals are named below at the fence.
   **Reset-password re-enable (if ever): hard prerequisite.** `/reset-password` +
   `/request-password-reset` are in `disabledPaths` (see step 5 post-ship note). Re-enabling reset
   MUST also (i) wire `sendResetPassword` + `onPasswordReset` + `revokeSessionsOnPasswordReset`, and
   (ii) teach `backfillNativeCredential`'s drift-reconcile about the reset path — its current
   "accounts → users is unambiguously newer" inference holds ONLY while a crashed `/change-password`
   mirror is the sole divergence cause; a reset breaks that and would let a post-reset native
   sign-in copy the reset hash into `users.password_hash` and revoke web sessions.

**Release fence** — before the first non-redeployable (TestFlight-external) install: the §6 🔒 must-dos
implemented and tested (nOAuth flags, rate limiting, `cookieCache`-off CI test, account-delete cascade
test, the dual-store fanout + partial-failure test, the **first social sign-up** creating a
password-less `users` row without a 500); web auth demonstrably unregressed (Simon + Tim still log in on
web, password change + account deletion still work); and a **real TestFlight (not dev-client) smoke test
of the Apple sign-in path** — Better Auth has documented issues (e.g. #7049, #8169, now closed) where
`signIn.social` with Apple worked in dev but hung/crashed in a production `.ipa`; the risk class is real
even if those specific ones are fixed (pin a known-good version + test the actual build).

**Carried to the app-build phase (named deferrals from the step-7 gate):**
- **App Attest / Play Integrity** on native email/password sign-up — `@expo/app-integrity`, server-side
  token verification, rolled out monitor→warn→enforce (never hard-enforce at launch: legit-user
  lockout risk — GrapheneOS, emulators, CI). Build-coupled (needs a registered App ID + custom
  dev-client), so it lands with the app, not the backend. Until then, native email/password sign-up
  rests on the atomic IP rate limiter alone; social sign-up is inherently bot-resistant.
- **Email-verification gating** — the strongest anti-spam lever (unverified rows inert + reaped), and
  it ALSO flips BA's `requireEmailVerification` path so the enumeration-oracle fix no longer depends on
  `autoSignIn: false`. Blocked on the (separate, deferred) email-pipeline feature — sequence it after
  that lands.

Everything visual ([05](05-design-system.md), [06](06-ios-app.md)) proceeds in parallel; no real authed
native call lands until step 5.
