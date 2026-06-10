import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

// ── identityStore: the single chokepoint for credential + revocation writes ──
//
// 🔒 The ONLY code allowed to write `users.password_hash` and
// `user_sessions.revokedAt`. A CI gate (check-identity-writes.yml) fails the
// build on any such write elsewhere, so the Better Auth dual-store fan-out
// (auth_accounts / auth_sessions — live since step 5) has exactly one home and
// the two stores can't drift. See proposal §3 + root CLAUDE.md.
//
// Store split — what each fan-out leg may touch:
//  - auth_accounts (credential rows) are DB-ONLY: BA's secondaryStorage holds
//    sessions/verifications/rate-limit counters, never accounts. Raw Prisma
//    writes are therefore safe here — and necessary, since BA's setPassword API
//    wants a plaintext + a live BA session and we have a bcrypt hash + a web
//    caller. Raw writes also skip BA's databaseHooks, which is what lets
//    betterAuth.ts's account.update.after hook call back into syncCredential
//    without recursing.
//  - auth_sessions are DUAL-STORE (Postgres + Redis, reads Redis-first): a raw
//    prisma.authSession delete does NOT revoke. Session legs go through BA's
//    internalAdapter (deleteSession / deleteUserSessions — the same both-store
//    paths BA's own /delete-user uses). NOT betterAuthServer.api's revoke
//    endpoints: those sit behind sessionMiddleware and need a live BA cookie,
//    which a web-session caller never has.
//
// betterAuth.ts statically imports this module (databaseHooks / hooks.before),
// so imports in the other direction are dynamic, inside function bodies, to
// break the cycle.

async function baInternalAdapter() {
  const { betterAuthServer } = await import('@/lib/betterAuth')
  return (await betterAuthServer.$context).internalAdapter
}

// Write a user's bcrypt password hash to BOTH credential stores. The ONE place
// `users.password_hash` is set; the same call mirrors the hash into the Better
// Auth credential row (auth_accounts) when one exists, so the native password
// can never drift from the web password (§3).
//
// Update-only on the BA side (updateMany → no-op when no row): credential rows
// are CREATED exclusively by BA's own native sign-up and by
// backfillNativeCredential below. A user who never goes native never gets an
// auth_accounts row, and a web password change before the first native sign-in
// needs no mirror — the later backfill copies the then-current hash.
//
// Callers (register, password-change) pass an already-bcrypt-hashed value —
// hashing stays at the call site so the cost factor + plaintext lifetime are
// the caller's concern; this owns the WRITE, not the hashing.
//
// Accepts an optional transaction client so register can write the credential
// inside its user-create + audit-log txn (keeps "a user always has a hash"
// atomic). Standalone (password-change) when omitted. Both legs ride the same
// client, so a rollback rolls back both — the stores can't split mid-write.
export async function syncCredential(
  userId: number,
  passwordHash: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  await tx.user.update({ where: { id: userId }, data: { passwordHash } })
  await tx.authAccount.updateMany({
    where: { userId, providerId: 'credential' },
    data: { password: passwordHash },
  })
}

// Lazy credential backfill (§5): betterAuth.ts's before-hook calls this on
// /sign-in/email so an EXISTING web user can sign in natively the first time.
// BA's credential sign-in requires an auth_accounts row (fails closed without
// one) and never reads users.password_hash; copying the hash on first native
// contact keeps auth_accounts sparse — web-only users never get a row.
//
// Email is matched lowercased, mirroring BA's findUserByEmail AND the register
// route (which stores emails lowercased), so the two lookups can't disagree.
// Concurrent first sign-ins race on the create; @@unique([providerId,
// accountId]) makes the loser throw P2002 — swallowed, the row exists.
export async function backfillNativeCredential(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, passwordHash: true },
  })
  if (!user?.passwordHash) return
  const existing = await prisma.authAccount.findFirst({
    where: { userId: user.id, providerId: 'credential' },
    select: { id: true },
  })
  if (existing) return
  await prisma.authAccount
    .create({
      data: {
        userId: user.id,
        providerId: 'credential',
        // BA's own convention for credential rows: accountId = the user's id.
        accountId: String(user.id),
        password: user.passwordHash,
      },
    })
    .catch((e) => {
      if (e?.code !== 'P2002') throw e
    })
}

// Revoke all of a user's OTHER sessions (everything except `exceptSessionId`,
// the caller's own user_sessions row) across BOTH session stores. The ONE place
// `user_sessions.revokedAt` is set in bulk. Returns how many user_sessions rows
// were revoked (preserves each caller's existing response shape).
//
// The BA leg deletes ALL of the user's native sessions — no "except" on that
// side, because every caller is a web session (password change, devices
// revoke-all): the session being spared is always a user_sessions row, never a
// native one. internalAdapter.deleteUserSessions deletes each Redis token copy,
// the active-sessions list, and the auth_sessions rows in one call; the String
// cast satisfies BA's string-id types — the adapter re-coerces id-reference
// where-values to Number under generateId 'serial'.
//
// ⚠️ BA-inherent edges (deleteUserSessions never throws on either):
//  - active-sessions-<id> list CORRUPT (JSON.parse → null): silent early
//    return — DB rows AND Redis token copies all survive until TTL. Recovery:
//    DB-driven sweep (auth_sessions rows → deleteSession per token).
//  - list ABSENT (e.g. evicted): treated as empty — DB rows ARE deleted, but
//    any orphaned Redis token copies live (and authenticate, Redis-first)
//    until TTL, with no DB row left to sweep them from.
//
// 🔒 The two legs are INDEPENDENT: each runs in its own try/catch, both are
// always attempted, and the first error rethrows after both ran — one store
// failing must not leave the other un-revoked (§3; the partial-failure test
// pins this).
export async function revokeAllSessions(
  userId: number,
  exceptSessionId: string,
  reason: 'password_change' | 'revoke_all',
): Promise<number> {
  let count = 0
  let webErr: unknown
  let baErr: unknown
  try {
    const revoked = await prisma.userSession.updateMany({
      where: { userId, revokedAt: null, id: { not: exceptSessionId } },
      data: { revokedAt: new Date(), revocationReason: reason },
    })
    count = revoked.count
  } catch (e) {
    webErr = e
  }
  try {
    await (await baInternalAdapter()).deleteUserSessions(String(userId))
  } catch (e) {
    baErr = e
  }
  if (webErr) throw webErr
  if (baErr) throw baErr
  return count
}

// Revoke ALL of a user's web sessions (no except) — the web-side mirror for a
// NATIVE-initiated password change (betterAuth.ts account.update.after hook):
// there the caller's own session is a BA session, so every web session dies.
// The BA-side equivalent is BA's own revokeOtherSessions, forced on in the
// /change-password before-hook. Same revokedAt write, same chokepoint.
export async function revokeAllWebSessions(
  userId: number,
  reason: 'password_change',
): Promise<number> {
  const revoked = await prisma.userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revocationReason: reason },
  })
  return revoked.count
}

// Revoke a SINGLE user_sessions row (per-device sign-out + logout). The other
// place `user_sessions.revokedAt` is written — kept here so the chokepoint rule
// stays absolute (zero revokedAt writes outside identityStore). Web-only: one
// user_sessions row has no BA analog (native rows go through
// revokeOneNativeSession below). Scoped by userId so a wrong-owner target
// matches zero rows → count 0 (the caller's 404-on-wrong-owner logic relies on
// this). Returns the rows-affected count.
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

// Revoke a SINGLE Better Auth session — the `ba:<id>` rows in the Connected-
// devices list. Owner-scoped read first (wrong owner / unknown id → 0, feeding
// the caller's 404 path, same contract as revokeOneSession), then BA's
// deleteSession(token), which deletes the Redis copy + active-sessions list
// entry + the auth_sessions row. Reading authSession via Prisma is fine — only
// WRITES must go through BA.
export async function revokeOneNativeSession(
  userId: number,
  baSessionId: number,
): Promise<number> {
  const row = await prisma.authSession.findFirst({
    where: { id: baSessionId, userId },
    select: { token: true },
  })
  if (!row) return 0
  await (await baInternalAdapter()).deleteSession(row.token)
  return 1
}
