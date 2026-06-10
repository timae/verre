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
| `/api/auth/native/*` (Better Auth, global) | 100/min/IP |
| `/api/auth/native/sign-in/email` | 10/min/IP |
| `/api/auth/native/sign-up/email` | 10/min/IP |
| `/api/auth/native/change-password` | 20/h/IP |

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
- **Better Auth (`/api/auth/native/*`)**: enforced by BA's built-in limiter (`rateLimit` in `lib/betterAuth.ts`), stored in Redis via `secondaryStorage` (`<ip>|<path>` keys) — NOT `lib/rateLimit.ts`. ⚠️ Keyed on the first `X-Forwarded-For` entry (client-spoofable unless the edge proxy rewrites XFF — same trusted-proxy caveat as the web login throttle) and **silently skipped when no IP header is present**. Sign-up also lacks the web register's honeypot + signed-token defenses and errors distinctly on an existing email (enumeration oracle). Accepted for step 4 (no native clients exist); MUST be revisited at the step-7 rate-limit design gate (proposal §8) before native login ships.
- **Native change-password**: brute-forces the CURRENT password from a stolen native session (it's a re-auth surface, like account PATCH). 20/h matches the web `rl:account` budget posture, though it's a separate counter keyed on IP (BA's limiter can't key on userId) — the XFF caveat above applies, to be tightened at the same step-7 gate.
