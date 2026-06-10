import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { checkRate } from '@/lib/rateLimit'

type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'rate-limited'; retryAfter: number }
  | { ok: false; reason: 'incorrect' }

// Shared password re-auth + rate-limit charge for the device-session sign-out
// endpoints (cross-device DELETE + revoke-all DELETE). Both charge ONE shared
// counter (`rl:account:user:${userId}:1h`, 20/h) so a stolen cookie can't stack
// brute-force budget across endpoints. See app/api/CLAUDE.md "Shared-counter
// pairs". Charged on every attempt — these are already-authenticated deliberate
// actions, so a correct password isn't "free" the way a successful login is.
//
// NOTE: account PATCH/DELETE deliberately do NOT use this helper. They charge
// `rl:account` once at the top of the handler to rate-limit ALL account
// mutations (including name/email edits that involve no password), then do
// their own inline bcrypt. Routing them through here would either double-charge
// the counter or drop the non-password-edit rate limiting. They share the SAME
// key string, which is what makes the budget shared — the helper is just the
// device endpoints' path to that same key.
//
// Returns a structured result, NOT a Response — each caller maps it to its own
// status codes / error copy.
export async function verifyPassword(userId: number, password: string): Promise<VerifyResult> {
  const rl = await checkRate(`rl:account:user:${userId}:1h`, 20, 3600)
  if (!rl.allowed) return { ok: false, reason: 'rate-limited', retryAfter: rl.retryAfter }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
  // ONE hash is authoritative per user, tried at most once per attempt:
  // users.password_hash when present (web-credentialed; the §3 mirror keeps the
  // native copy equal, so checking both would just double the guesses a stolen
  // cookie gets per rate-limit slot). Only when it's NULL (native-registered
  // user, step-5 asymmetry) fall back to the auth_accounts credential row —
  // a READ, so the identity-writes gate is untouched. A user with neither
  // (social-only, step 6) never falls through to "allow".
  let hash = user?.passwordHash ?? null
  if (user && !hash) {
    const cred = await prisma.authAccount.findFirst({
      where: { userId, providerId: 'credential' },
      select: { password: true },
    })
    hash = cred?.password ?? null
  }
  const valid = hash ? await bcrypt.compare(password, hash) : false
  if (!valid) return { ok: false, reason: 'incorrect' }
  return { ok: true }
}
