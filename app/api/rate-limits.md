# Rate limit policy

| Endpoint | Limit |
|---|---|
| Login (`authorize()`) | 10/min/email + 20/h/email + 100/10min/IP |
| `/api/auth/register` | 100/min/IP |
| `/api/me/account` PATCH+DELETE | 20/h/user (shared) |
| `/api/me/avatar` POST | 10/h/user |
| `/api/me/visibility` GET | 60/min/user |
| `/api/me/visibility` PATCH (outer) | 60/min/user |
| `/api/me/visibility` PATCH (inner) | 30/h/user (on actual change) |
| `/api/me/mutes/:id` POST+DELETE | 60/h/user (shared) |
| `/api/me/blocks/:id` POST | 30/h/user |
| `/api/me/blocks/:id` DELETE | uncapped |
| `/api/session` POST | 10/10min/user-or-IP |
| `/api/session/join` POST | 30 invalid/min/IP |
| Bans POST+DELETE | 60/10min/caller (shared) |
| `/api/me/devices` GET | 60/min/user |
| `/api/me/devices/:id` DELETE | 30/h/user (revoke) + shares `rl:account` 20/h on the cross-device password check |
| `/api/me/devices` DELETE (revoke-all) | 10/h/user (revoke) + shares `rl:account` 20/h on the password check |
| `/api/auth/native/*` (Better Auth, global) | 100/min/IP (BA limiter, belt) |
| `/api/auth/native/sign-in/email` | 10/min/IP (atomic floor + BA) |
| `/api/auth/native/sign-up/email` | 10/min/IP (atomic floor + BA) |
| `/api/auth/native/change-password` | 20/h/IP (atomic floor + BA) + 20/h/user (shared `rl:account`) |
| `/api/auth/native/get-session` | BA 100/min/IP only (no atomic floor) |

**Per-endpoint rationale:**

- **Login**: brute-force on stolen email knowledge. Counters increment on bcrypt failure only — successful logins don't pollute.
- **Register**: mass-signup spam. IP-based; combined with bot defenses (honeypot, signed-token) gating before the bcrypt + DB write.
- **Account PATCH+DELETE**: brute-force the password re-auth check from a stolen session cookie. Shared so an attacker doesn't get 20+20.
- **Avatar POST**: storage abuse via a stolen session cookie. DELETE is currently uncapped (`app/api/me/avatar/route.ts` has no `checkRate` call on DELETE) — flag for review if abuse appears, but DELETE is idempotent and reclaims S3 rather than consuming it.
- **Visibility GET / PATCH (outer)**: read-side noise + general burst protection. Distinct counters per HTTP method.
- **Visibility PATCH (inner)**: stolen-cookie thrashing the audit log + flipping visibility. Enforced inside `setProfileVisibility` via peek-then-`checkRate`-on-change so no-op submits don't burn slots.
- **Mutes POST+DELETE**: stolen cookie thrashing the table or generating noise. Shared.
- **Blocks POST**: stolen-cookie burst-blocking. DELETE intentionally **uncapped** — recovery path from a burst-block attack must always stay open.
- **Session POST**: code-space exhaustion (8-char Crockford, but mass enumeration would crowd legitimate creates).
- **Session join POST**: code-guessing. Counter cleared on a valid code so legitimate joiners aren't penalized.
- **Bans POST+DELETE (kick/ban + unban)**: bounded moderation in both directions. DELETE shares the budget (unlike block DELETE, which is uncapped) — moderation actions are not a recovery path.
- **Devices GET**: read-side noise from a stolen cookie polling the list.
- **Devices :id DELETE**: per-id revoke is "one user clicking through their list." 30/h is ample for normal use; the cap bounds a stolen cookie thrashing revokes. **The cross-device password re-auth additionally consumes the shared `rl:account` counter** — otherwise this endpoint would be a fresh 30/h brute-force surface against the same password hash, defeating the whole reason `rl:account` is shared. Own-current-session revoke skips both the password and the `rl:account` charge (it's just a logout). `ba:<int>` targets (native sessions from the union GET) always take the password path — a `ba:` row is never the web caller's own current session.
- **Devices DELETE (revoke-all)**: separate, lower counter (10/h) because this is a single panic-event ("sign out everywhere"), not list-clicking. Distinct from per-id so an incident-response revoke-all isn't starved by prior per-id clicks, and vice versa. **Its password check also draws from the shared `rl:account` counter** for the same brute-force reason. Net: account PATCH/DELETE + both device password gates share one 20/h budget against the password hash; the device-specific 30/h and 10/h caps independently bound revoke-thrashing.
- **Better Auth (`/api/auth/native/*`)** — TWO layers (step-7 hardening, proposal §8):
  - **BA's built-in limiter** (`rateLimit` in `lib/betterAuth.ts`), Redis via `secondaryStorage` (`<ip>|<path>` keys). Belt. ⚠️ It is non-atomic (read-modify-write) and **silently skips when it can't resolve an IP** (`getIp` → null → fail-OPEN, a hardcoded dist behaviour) — so it is NOT relied on as the floor.
  - **Verre's atomic floor** (the braces): a before-hook in `lib/betterAuth.ts` runs `lib/rateLimit.ts` `checkRate` (atomic Lua INCR+EXPIRE) on the auth-critical paths — `rl:ba-signin:ip:<ip>:1m` (10/min), `rl:ba-signup:ip:<ip>:1m` (10/min), `rl:ba-chgpw:ip:<ip>:1h` (20/h). A missing IP buckets into a shared `unknown` key (`getClientIp`), so the cap **fails CLOSED** instead of skipping; the atomic counter holds under concurrency. Pinned in `_ba-e2e-signup.ts` §10.
  - **IP keying is trustworthy** on Deplo.io: its proxy overwrites `X-Forwarded-For` with the real client IP (`getClientIp` reads it; multi-entry XFF is treated as untrusted). The trusted-proxy invariant is documented in `docs/dev/deployment.md` — it holds only while no untrusted proxy sits in front of Deplo.io.
  - **Enumeration oracle — format tell removed, residual remains**: `autoSignIn: false` flips BA to a generic synthetic-success response for an already-registered email (token:null + a synthetic user) instead of a distinct 422. Under our serial integer PKs the synthetic id defaults to a random STRING (vs a real integer id) — an `^[0-9]+$` tell — so `customSyntheticUser` overrides it to an integer string. That closes the FORMAT tell; a sequence-correlation residual remains (the synthetic id isn't the real next serial), fully closed only by the deferred email-verification gate. Trade-off: the native client signs in as a second step after signup. Pinned in `_ba-e2e-signup.ts` §9 (compares free-vs-taken id format). See `lib/betterAuth.ts`.
  - **Native get-session** (live since iOS milestone 1 — removed from `disabledPaths` because @better-auth/expo's `useSession`/sliding-refresh fetch it over HTTP): the app's session heartbeat, hit on every launch/foreground. No Verre atomic floor — it's a cheap Redis read with no bcrypt/oracle surface, and the auth-critical paths (sign-in/up/change-password) keep theirs. BA's belt limiter is the only cap; add a floor if abuse appears.
  - **Residual (deferred, named)**: native sign-up has no honeypot/signed-token (web-form-specific — don't apply to a JSON API). The real native equivalent is **App Attest / Play Integrity**, a release-fence item for the app-build phase (`@expo/app-integrity`), rolled out monitor→warn→enforce. Email-verification gating (the strongest anti-spam lever) is blocked on the (separate, deferred) email pipeline. Social sign-up (Google/Apple) is inherently bot-resistant and needs none of this.
- **Native change-password**: brute-forces the CURRENT password from a stolen native session (a re-auth surface, like account PATCH). Charged on TWO counters: the IP floor (`rl:ba-chgpw:ip:<ip>:1h`, 20/h — bounds spray from one IP) AND the per-user budget (`rl:account:user:<id>:1h`, 20/h — the SAME key the web account PATCH/DELETE + `verifyPassword` use, resolved from the session cookie via `getSessionFromCtx` in the `lib/betterAuth.ts` before-hook). The per-user key is the load-bearing one: without it an attacker with one stolen native cookie could ROTATE IPs to bypass the IP cap and brute-force the current password. Sharing the web `rl:account` key means web+native can't stack N+N against the same password hash. (PR#39 review fix — supersedes the earlier "deferred to the step-7 gate, keyed on IP only" note.)
