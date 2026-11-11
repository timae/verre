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
// atomic). When omitted (password-change), it opens its OWN $transaction —
// either way both legs ride one client, so a rollback rolls back both and the
// stores can't split mid-write. That atomicity is load-bearing beyond this
// function: backfillNativeCredential's drift reconcile below infers "crashed
// BA mirror" from a hash mismatch, which is only a safe inference because
// syncCredential can never leave the two stores half-written.
export async function syncCredential(
  userId: number,
  passwordHash: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (c: Prisma.TransactionClient) => {
    await c.user.update({ where: { id: userId }, data: { passwordHash } })
    await c.authAccount.updateMany({
      where: { userId, providerId: 'credential' },
      data: { password: passwordHash },
    })
  }
  if (tx) return run(tx)
  await prisma.$transaction(run)
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
//
// Doubles as the drift RECONCILER, since it runs before every native credential
// sign-in. Two distinguishable crashed-mirror states, each with an unambiguous
// direction (every healthy writer is atomic across both stores — syncCredential
// is transactional; register runs it inside its txn):
//  - users.password_hash NULL + credential row WITH a hash → a native sign-up
//    whose post-commit account.create.after mirror (betterAuth.ts) crashed.
//    Complete it: auth_accounts → users. No revoke — a NULL-hash user could
//    never log in on web, so no credential web session can exist. Without this
//    branch the user is PERMANENTLY web-less: the create-mirror never re-fires
//    and the update-mirror engages only on a password change.
//  - row hash ≠ users.password_hash (both non-NULL) → a /change-password whose
//    account.update.after mirror crashed: BA committed the new hash to
//    auth_accounts, users.password_hash kept the OLD one. Complete the crashed
//    mirror: auth_accounts → users, plus the web-session revoke the hook owed.
//    Reconciling the other way would silently revert the user's password change.
//
// ORDER: revoke-before-hash. The web revoke runs FIRST, then the hash sync. If
// the revoke throws, the hash is still stale, so this same branch
// (existing.password !== users.password_hash) fires again on the next native
// sign-in and retries the whole reconcile — self-healing. The reverse order
// (hash then revoke) would, on a transient revoke failure, leave the hashes
// EQUAL, so the next sign-in skips this branch entirely and the owed revoke is
// never retried — silently degrading the guarantee to "hash done, revoke
// dropped." (Residual window the reconcile can't see is unchanged: the crashed
// /change-password hook itself completed its hash mirror but not its web revoke
// → hashes equal, stale web sessions survive — that's the after-hook's own
// double-failure case, now logged in betterAuth.ts, not this reconcile's.)
export async function backfillNativeCredential(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, passwordHash: true },
  })
  if (!user) return
  if (!user.passwordHash) {
    // NULL-heal branch (see header): complete a crashed create-mirror. A user
    // with no hash in EITHER store (social-only, once step 6 ships) has no
    // credential row with a password → no-op.
    const orphan = await prisma.authAccount.findFirst({
      where: { userId: user.id, providerId: 'credential', password: { not: null } },
      select: { password: true },
    })
    if (orphan?.password) await syncCredential(user.id, orphan.password)
    return
  }
  const existing = await prisma.authAccount.findFirst({
    where: { userId: user.id, providerId: 'credential' },
    select: { password: true },
  })
  if (existing) {
    if (!existing.password) {
      // A credential row should always carry a hash; heal a null one from web.
      await prisma.authAccount.updateMany({
        where: { userId: user.id, providerId: 'credential' },
        data: { password: user.passwordHash },
      })
    } else if (existing.password !== user.passwordHash) {
      // revoke-before-hash (see header): a revoke failure leaves hashes unequal
      // so the next sign-in retries, instead of stranding the owed revoke.
      await revokeAllWebSessions(user.id, 'password_change')
      await syncCredential(user.id, existing.password)
    }
    return
  }
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
  // Stale-create race: a web password change can land between the user read
  // above and the create, leaving the new row with the pre-change hash (the
  // change's own mirror no-ops when it runs before the row exists). Re-read and
  // copy the fresh hash over; with this, "row exists with a different hash"
  // above can't be a leftover of this race.
  const fresh = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  })
  if (fresh?.passwordHash && fresh.passwordHash !== user.passwordHash) {
    await prisma.authAccount.updateMany({
      where: { userId: user.id, providerId: 'credential' },
      data: { password: fresh.passwordHash },
    })
  }
}

// Revoke all of a user's OTHER sessions (everything except `exceptSessionId`,
// the caller's own user_sessions row) across BOTH session stores. The ONE place
// `user_sessions.revokedAt` is set in bulk. Returns how many user_sessions rows
// were revoked (preserves each caller's existing response shape).
//
// The BA leg deletes ALL of the user's native sessions — no "except" on that
// side, because every caller is a web session (password change, devices
// revoke-all): the session being spared is always a user_sessions row, never a
// native one. It goes through revokeNativeSessionsExcept(userId, null) (below):
// token-driven from a Postgres snapshot, both stores per token, a failed token
// keeps its row as a retry target and the error rethrows. NOT BA's
// deleteUserSessions — that one is list-driven (`active-sessions-<id>`) and
// deletes the auth_sessions rows before the Redis copies, so an evicted list
// plus any failure left a Redis ghost with no row to retry from (Codex pass 3).
//
// 🔒 The two legs are INDEPENDENT: each runs in its own try/catch, both are
// always attempted, and the first error rethrows after both ran — one store
// failing must not leave the other un-revoked (§3; the partial-failure test
// pins this).
export type BulkRevokeReason = 'password_change' | 'revoke_all'
export async function revokeAllSessions(
  userId: number,
  exceptSessionId: string,
  reason: BulkRevokeReason,
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
    await revokeNativeSessionsExcept(userId, null)
  } catch (e) {
    baErr = e
  }
  if (webErr && baErr) console.error('revokeAllSessions: BA leg also failed (rethrowing web error)', baErr)
  if (webErr) throw webErr
  if (baErr) throw baErr
  return count
}

// Delete ALL of a user's native sessions across both BA stores — the account-
// deletion leg. lib/accountDelete.ts calls this BEFORE its Postgres txn: after
// the users-row cascade no auth_sessions rows remain to sweep from, so the
// Redis token copies (whose JSON carries the user's name + email) would outlive
// the account for up to the session TTL and keep authenticating on BA-native
// endpoints (resolveUser fails closed via its fresh users SELECT, but BA's own
// routes serve the cached user straight from Redis). A throw aborts the
// deletion — safe and retryable, nothing has been deleted yet. Goes through
// revokeNativeSessionsExcept (snapshot Postgres tokens → both-store delete per
// token, rethrow on any failure) so an orphaned Redis copy can't outlive the
// deleted account — exactly the leak this leg exists to prevent (the Redis
// JSON carries name + email).
export async function deleteAllNativeSessions(userId: number): Promise<void> {
  await revokeNativeSessionsExcept(userId, null)
}

// Native-INITIATED revokes — BA's /revoke-sessions, /revoke-other-sessions and
// the revoke half of /change-password — are LIST-DRIVEN (1.6.15, still in 1.7.18):
// deleteUserSessions / listSessions enumerate the user's Redis copies from
// `active-sessions-<userId>`, a cold key written only on session create/update/
// delete and never read on the hot path, so under eviction it goes first — and
// with it the revoke's reach: the PG rows die (or, for revoke-other, nothing at
// all does) while the Redis token copies keep authenticating Redis-first until
// their own TTL, now up to the 1-year native window. BA's versions are
// therefore NOT used for native callers (lib/betterAuth.ts hooks take the two
// coarse endpoints over and switch /change-password's revokeOtherSessions OFF);
// this helper is the replacement for all three: snapshot the user's tokens from
// POSTGRES (the authoritative list) and deleteSession() each except `keepToken`.
// 🔒 Failure semantics are the point (Codex review, 2026-11-04):
//  - the snapshot throws → NOTHING has been deleted; the caller aborts before
//    any mutation, so a retry sees the same rows.
//  - deleteSession is token-driven and both-store PER TOKEN (Redis copy first,
//    then the PG row), so a token that fails keeps its PG row — a durable,
//    visible (Connected devices) retry target for the next revoke. Every token
//    is still attempted, then the first error rethrows so the caller surfaces
//    the partial failure instead of reporting success.
//  - deleteSession is a no-op for an already-gone token → idempotent.
// The kept session is named by its token (BA's own hooks have it) OR by its row
// id (`keepId`: the devices revoke-all, whose caller is known by id only —
// resolveUser never carries the token). Either match spares the row.
// Pinned in scripts/tests/ba-session-lifetime.mjs § 7 (incl. injected failures).
export async function revokeNativeSessionsExcept(userId: number, keepToken: string | null, keepId: number | null = null): Promise<number> {
  const rows = await prisma.authSession.findMany({ where: { userId }, select: { id: true, token: true } })
  const adapter = await baInternalAdapter()
  let revoked = 0
  let firstErr: unknown
  for (const { id, token } of rows) {
    if (token === keepToken || id === keepId) continue
    try {
      await adapter.deleteSession(token)
      revoked++
    } catch (e) {
      console.error('revokeNativeSessionsExcept: deleteSession failed (row kept as retry target)', e)
      firstErr ??= e
    }
  }
  if (firstErr) throw firstErr
  return revoked
}

// Retire native sessions past expires_at. Better Auth never deletes an expired
// row on its own (only on access, and a device that is gone never accesses it),
// so with the 1-year window replaced phones would sit in auth_sessions forever.
// 🔒 Goes through deleteSession, NOT a raw SQL DELETE (the first cut was SQL —
// Codex showed why that is wrong): BA writes Redis BEFORE Postgres on a refresh,
// so a PG failure mid-heartbeat leaves a Redis copy a year AHEAD of its row.
// A raw prune of that row leaves the copy authenticating with no PG row to
// find it from (unrevocable), and its next heartbeat 500s on P2025 while
// extending the Redis TTL. deleteSession invalidates the Redis copy FIRST,
// whatever its TTL, then drops the row. Batched (small, bounded per run) and
// idempotent; the 1-day margin covers app/DB clock skew. Scheduled in-process
// by lib/nativeSessionPrune.ts (the Deploio cron image has no lib/).
export async function pruneExpiredNativeSessions(batch = 500, maxBatches = 20): Promise<number> {
  const adapter = await baInternalAdapter()
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000)
  let total = 0
  for (let i = 0; i < maxBatches; i++) {
    const rows = await prisma.authSession.findMany({ where: { expiresAt: { lt: cutoff } }, select: { token: true }, take: batch })
    for (const { token } of rows) await adapter.deleteSession(token)
    total += rows.length
    if (rows.length < batch) break
  }
  return total
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

// Revoke a NATIVE caller's sessions across both stores: every web session, and
// every native one except `keepNativeSessionId` when given. Two callers:
//  - account PATCH password change via resolveUser (no options): EVERY web AND
//    every native session dies, the caller's own native one included — they
//    just re-authed with their password, so a single native re-login is the
//    only cost, and it's strictly safer than leaving any session alive.
//  - devices revoke-all ("Sign Out of All Other Devices") from the app:
//    `keepNativeSessionId` = the caller's own row (resolveUser's
//    nativeSessionId), reason 'revoke_all'.
// Distinct from revokeAllSessions, which spares the WEB caller's own
// user_sessions row and has no native exception. The native leg is the one
// loop, revokeNativeSessionsExcept (keep by id), so its failure semantics stay
// a single implementation.
//
// 🔒 Same INDEPENDENCE rule as revokeAllSessions: each leg runs in its own
// try/catch, both are always attempted, the first error rethrows after logging
// the second. Composing the two single-store helpers sequentially+unguarded at a
// call site (revokeAllWebSessions then deleteAllNativeSessions) would let a web-
// leg throw skip the native leg — the exact "one store failing leaves the other
// un-revoked" hole the fan-out exists to close. Returns the web-session count.
//
// The per-leg try/catch + rethrow-first scaffold is INTENTIONALLY duplicated
// across revokeAllSessions, this function, and the betterAuth.ts account.update
// .after mirror — three sites, so the repo's 3+-extract rule technically fires,
// but extracting it means passing the web leg as a closure, which reads worse
// than the inline form and each site's surrounding comment is load-bearing.
// Deliberate, not yet-to-be-refactored.
export async function revokeAllForNativeCaller(
  userId: number,
  { keepNativeSessionId = null, reason = 'password_change' }: { keepNativeSessionId?: number | null; reason?: BulkRevokeReason } = {},
): Promise<number> {
  let count = 0
  let webErr: unknown
  let baErr: unknown
  try {
    const revoked = await prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revocationReason: reason },
    })
    count = revoked.count
  } catch (e) {
    webErr = e
  }
  try {
    await revokeNativeSessionsExcept(userId, null, keepNativeSessionId)
  } catch (e) {
    baErr = e
  }
  if (webErr && baErr) console.error('revokeAllForNativeCaller: BA leg also failed (rethrowing web error)', baErr)
  if (webErr) throw webErr
  if (baErr) throw baErr
  return count
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
