import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

// ── identityStore: the single chokepoint for credential + revocation writes ──
//
// 🔒 The ONLY code allowed to write `users.password_hash` and
// `user_sessions.revokedAt`. A CI gate (check-identity-writes.yml) fails the
// build on any such write elsewhere, so step 4's Better Auth dual-store fan-out
// (also writing auth_accounts / auth_sessions) has exactly one home and the two
// stores can't drift. See proposal §3 + root CLAUDE.md.
//
// STATUS (step 3): only the user_sessions / password_hash side is wired. The
// Better Auth fan-out is a marked TODO(step-4) no-op — no BA library exists yet,
// so writing it now would be untestable speculation.

// Write a user's bcrypt password hash. The ONE place `password_hash` is set.
// Callers (register, password-change) pass an already-bcrypt-hashed value —
// hashing stays at the call site so the cost factor + plaintext lifetime are
// the caller's concern; this owns the WRITE, not the hashing.
//
// Accepts an optional transaction client so register can write the credential
// inside its user-create + audit-log txn (keeps "a user always has a hash"
// atomic). Standalone (password-change) when omitted.
export async function syncCredential(
  userId: number,
  passwordHash: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  await tx.user.update({ where: { id: userId }, data: { passwordHash } })
  // TODO(step-4): upsert the Better Auth `auth_accounts` credential row
  // (providerId='credential', accountId=String(userId), password=passwordHash)
  // through Better Auth's API so native login sees the same password. Until the
  // BA library is wired (step 4) there is no second store to sync.
}

// Revoke all of a user's OTHER sessions (everything except `exceptSessionId`).
// The ONE place `user_sessions.revokedAt` is set in bulk. Returns how many
// user_sessions rows were revoked (preserves each caller's existing response).
//
// 🔒 The fan-out across the two session stores must be INDEPENDENT: if the
// Better Auth revoke throws, the user_sessions revoke must still have happened
// (and vice versa) — one store failing must not leave the other un-revoked.
// (No BA store to fan out to until step 4; the independence is set up here so
// step 4 only adds the second leg.)
export async function revokeAllSessions(
  userId: number,
  exceptSessionId: string,
  reason: 'password_change' | 'revoke_all',
): Promise<number> {
  const revoked = await prisma.userSession.updateMany({
    where: { userId, revokedAt: null, id: { not: exceptSessionId } },
    data: { revokedAt: new Date(), revocationReason: reason },
  })
  // TODO(step-4): independently revoke the user's Better Auth `auth_sessions`
  // rows (via Better Auth's revokeSessions). Run it in its own try/catch so a
  // BA failure can't skip the user_sessions revoke above and vice versa; a
  // partial-failure test must pin that both legs are attempted.
  return revoked.count
}

// Revoke a SINGLE user_sessions row (per-device sign-out + logout). The other
// place `user_sessions.revokedAt` is written — kept here so the chokepoint rule
// stays absolute (zero revokedAt writes outside identityStore), even though a
// single-device revoke does NOT fan out: revoking one user_sessions row has no
// Better Auth analog (a native device's logout is handled by Better Auth's own
// client, not user_sessions). Scoped by userId so a wrong-owner target matches
// zero rows → count 0 (the caller's 404-on-wrong-owner logic relies on this).
// Returns the rows-affected count.
export async function revokeOneSession(
  userId: number,
  sessionId: string,
  reason: 'manual' | 'logout',
): Promise<number> {
  const revoked = await prisma.userSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revocationReason: reason },
  })
  return revoked.count
}
