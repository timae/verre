# app/api/auth/ — Auth routes

Local rules for `app/api/auth/*`. Root CLAUDE.md still applies; this is overlay context for register/login flows.

## Bot defenses on `/api/auth/register`

- **Honeypot field**: an offscreen `<input name="website">` rendered by the register form. Real users never see it; bots scraping the DOM tend to fill plausibly-named text inputs. Non-empty submissions reject with a generic 400.
- **Signed-timestamp form token**: `lib/registerToken.ts` mints a `<timestamp>.<hmac>` token at page render (server component, `force-dynamic`). The form posts it back with the body. Server verifies the HMAC, accepts only `>= 800ms` and `<= 30min` old. Rejects forged signatures, too-fast submits, and stale tokens with the same generic 400.
- Both checks run **before** the bcrypt hash + DB write, so a tripped honeypot or bad token costs the server effectively nothing.

HMAC secret is pulled from `AUTH_SECRET` (falls back to `NEXTAUTH_SECRET` / `JWT_SECRET` for compatibility). See `lib/registerToken.ts`.

## Login precheck

`/api/auth/login-precheck` exists to surface rate-limit errors that NextAuth v5 strips from `signIn()`. Uses `peekRate` (no increment); only the actual `authorize()` call increments on bcrypt failure. See `app/api/CLAUDE.md` for the broader rate-limit pattern.

## Trust anchor mechanisms

Trust-anchor principle (identity-ids only, display names presentation-only): see root CLAUDE.md "Trust model". Resolver API (`resolveIdentity`, `participantOrBanned`): see `lib/CLAUDE.md`.

This file documents the **mechanisms** that produce each trust anchor on `app/api/auth/*` routes:

- **Logged-in users** carry a NextAuth session cookie (`__Secure-authjs.session-token`, JWE-encrypted, 30 day lifetime). Resolved server-side via `auth()`. The cookie's JWT carries an opaque `userSessionId`; the `auth.ts` `jwt()` callback gates **every** authenticated request on `user_sessions.revokedAt` (this replaced the never-written `users.tokenVersion`). A token with no `userSessionId` (pre-feature/"legacy") is treated as invalid → forced re-login. **Never cache `auth()`** — any cache TTL is a revocation gap (see `lib/CLAUDE.md`). Per-device sign-out / password-change-revoke / logout-revoke all set `revokedAt` (+ a `revocationReason` that drives the tailored login-page notice via `lib/revocationNotice.ts`). Full design: `docs/dev/proposals/auth-sessions.md`; cross-cutting invariants: `lib/CLAUDE.md`.
- **Anonymous users** carry a per-session anon token (`crypto.randomUUID()`, stored in browser `localStorage` as `vr_anon_<CODE>`). Sent on every request as the `x-vr-anon-token` header. Maps to `s:{CODE}:tokens` → identity id. (Anon flow never touches `user_sessions` — the two trust models stay disjoint.)
- **Native (mobile) users** carry a Better Auth session cookie (signed opaque token, validated against the dual `auth_sessions`/Redis store on **every** request — `cookieCache` off, CI-pinned). Resolved server-side via `lib/resolveUser.ts`, the single seam every API handler uses: BA branch first, fall through to `auth()`; both branches return the same NextAuth `Session` shape, so downstream code is blind to which credential authenticated. Claims are never merged across branches. Revocation goes through `lib/identityStore.ts` (never raw `auth_sessions` row deletes — root CLAUDE.md "Redis-first"). Mounted at `/api/auth/native/[...all]`; full design: `docs/dev/proposals/mobile-app/01-identity-and-auth.md` §5a.
