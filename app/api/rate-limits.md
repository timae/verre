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
