import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

// ── identityStore: the single chokepoint for credential + revocation writes ──
//
// 🔒 The ONLY code allowed to write `users.password_hash` and
// `user_sessions.revokedAt`. A CI gate (check-identity-writes.yml) fails the
// build on any such write elsewhere, so step 5's Better Auth dual-store fan-out
// (also writing auth_accounts / auth_sessions) has exactly one home and the two
// stores can't drift. See proposal §3 + root CLAUDE.md.
//
// STATUS (post step 4): the user_sessions / password_hash side is wired, and
// the Better Auth library + config now exist (lib/betterAuth.ts) — but nothing
// here touches the BA tables yet. The fan-out is a marked TODO(step-5) no-op;
// BA's own /change-password endpoint is a disabledPath until it lands (a
// BA-side password change would otherwise skip this chokepoint entirely).
//
// 🔒 When the fan-out lands: BA sessions live in BOTH auth_sessions and Redis
// (secondaryStorage), reads are Redis-first — a raw prisma.authSession delete
// does NOT revoke. The BA leg must go through betterAuthServer.api, never raw
// row writes. See the session comment in lib/betterAuth.ts.

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
  // TODO(step-5): upsert the Better Auth `auth_accounts` credential row
  // (providerId='credential', accountId=String(userId), password=passwordHash)
  // through Better Auth's API so native login sees the same password. The BA
  // library is wired (step 4, lib/betterAuth.ts); the fan-out lands with the
  // resolveUser split in step 5 (proposal §8).
}

// Revoke all of a user's OTHER sessions (everything except `exceptSessionId`).
// The ONE place `user_sessions.revokedAt` is set in bulk. Returns how many
// user_sessions rows were revoked (preserves each caller's existing response).
//
// 🔒 The fan-out across the two session stores must be INDEPENDENT: if the
// Better Auth revoke throws, the user_sessions revoke must still have happened
// (and vice versa) — one store failing must not leave the other un-revoked.
// (The BA store exists since step 4 but nothing logs into it yet; step 5 adds
// the second leg here.)
export async function revokeAllSessions(
  userId: number,
  exceptSessionId: string,
  reason: 'password_change' | 'revoke_all',
): Promise<number> {
  const revoked = await prisma.userSession.updateMany({
    where: { userId, revokedAt: null, id: { not: exceptSessionId } },
    data: { revokedAt: new Date(), revocationReason: reason },
  })
  // TODO(step-5): independently revoke the user's Better Auth sessions — via
  // betterAuthServer.api (revokeSessions), NEVER a raw prisma.authSession
  // deleteMany: reads are Redis-first under secondaryStorage, so a raw row
  // delete leaves the Redis copy live until TTL (see lib/betterAuth.ts). Run it
  // in its own try/catch so a BA failure can't skip the user_sessions revoke
  // above and vice versa; a partial-failure test must pin that both legs are
  // attempted.
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
