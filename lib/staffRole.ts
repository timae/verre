import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

// ── staffRole: the account-level staff privilege resolver + grant lifecycle ──
//
// Staff privilege lives in its own table (`staff_roles`), NEVER as a column on
// `users`. A privilege bit there would sit on the hottest table in the app,
// reachable by every existing `prisma.user.update` and by Better Auth's own
// writes into `users` — whereas this table has no existing write path at all.
// Same safe-by-construction reasoning as the lib/identityStore.ts credential
// chokepoint. (`users.role` is a DEAD column: @default("taster"), read by
// nothing. The heavily-used `SessionMember.role` is the unrelated SESSION axis
// — host/cohost/provider/taster — and has nothing to do with staff powers.)
//
// 🔒 REVOCATION IS IMMEDIATE, WHICH MEANS EVERY CHECK IS A FRESH DB READ.
// Nothing here caches, and nothing may cache on top of it — not into a JWT, not
// into a session, not into a module-level Map. This mirrors the never-cache-
// auth() invariant in lib/CLAUDE.md: any TTL is a window in which a revoked
// privilege still resolves, and that window IS the security hole. If a hot path
// ever makes the read cost real, the fix is a request-scoped memo that cannot
// outlive the request, never a time-based cache.
//
// `admin` IMPLIES `curator`. The resolver answers a curator-level check
// affirmatively for an admin grant, so each person holds exactly ONE row and
// there is no "granted both" state that could drift. Do not "fix" this by
// inserting two rows.
//
// See docs/dev/proposals/wine-catalog.md § Open decisions — RESOLVED (ruling 1)
// and docs/dev/proposals/wine-catalog-implementation.md § Staff-role lifecycle.

export type StaffRole = 'admin' | 'curator'

// ── The permission map ─────────────────────────────────────────────────────
//
// Written down deliberately, because "who may do what" spread across route
// handlers is how a curator quietly ends up able to hard-purge. Purge is the
// most destructive operation in the system and does NOT belong to every
// curator.
//
// The values are the MINIMUM role. Because admin implies curator, an admin
// satisfies every curator-level entry too.
export const STAFF_PERMISSIONS = {
  // Catalog curation — the review queue's day-to-day work.
  'catalog.confirm': 'curator',
  'catalog.reject': 'curator',
  'catalog.archive': 'curator',
  'catalog.merge': 'curator',
  'catalog.unmerge': 'curator',
  'catalog.edit': 'curator',
  'catalog.lockField': 'curator',
  // Resolving an EAN that arrived already assigned to another product. A
  // re-point moves a strong identity key, so it is curator-level but audited.
  //
  // 🔒 THIS PERMISSION MUST NEVER AUTHORIZE ALL THREE RESOLUTION BRANCHES. The
  // documented resolutions are re-point, reject, AND PURGE (implementation plan
  // § EAN conflict → deferred). Re-point and reject are curator work; purge is
  // the most destructive operation in the system and is admin-only two lines
  // below. So the conflict handler MUST check `catalog.purge` INDEPENDENTLY on
  // the purge branch — this permission covers re-point and reject only.
  // Treating it as a blanket authorization for the whole screen would let a
  // curator purge through it, walking straight past the admin gate.
  'catalog.resolveEanConflict': 'curator',
  // 🔒 Hard purge — an exceptional, audited moderation deletion (abuse or
  // obscenity) that resolves every inbound reference by hand. Admin only. It is
  // the one catalog operation that destroys rather than tombstones, and it is
  // NOT reachable via import at all.
  'catalog.purge': 'admin',
  // 🔒 Granting privilege is admin-only, or curators could self-escalate.
  'staff.grantRole': 'admin',
  'staff.revokeRole': 'admin',
} as const satisfies Record<string, StaffRole>

export type StaffPermission = keyof typeof STAFF_PERMISSIONS

// Fresh read of every grant this user holds. Returns [] for a null userId (an
// anonymous caller), so callers don't have to special-case it.
export async function getStaffRoles(userId: number | null | undefined): Promise<StaffRole[]> {
  if (!userId) return []
  const rows = await prisma.staffRole.findMany({
    where: { userId },
    select: { role: true },
  })
  return rows.map(r => r.role as StaffRole)
}

// Does this user satisfy `required`? admin satisfies 'curator' as well as
// 'admin'; curator satisfies only 'curator'.
export async function hasStaffRole(
  userId: number | null | undefined,
  required: StaffRole,
): Promise<boolean> {
  const roles = await getStaffRoles(userId)
  if (roles.includes('admin')) return true
  return roles.includes(required)
}

// Permission-keyed check — prefer this at call sites over hasStaffRole, so the
// required tier for an operation is declared once in STAFF_PERMISSIONS rather
// than restated (and eventually mis-stated) in each route.
export async function can(
  userId: number | null | undefined,
  permission: StaffPermission,
): Promise<boolean> {
  return hasStaffRole(userId, STAFF_PERMISSIONS[permission])
}

// ── Grant lifecycle ────────────────────────────────────────────────────────
//
// Every mutation appends to staff_role_audit IN THE SAME TRANSACTION. Deleting
// a staff_roles row otherwise destroys the history of who held what: the grant
// row is live state, the audit row is the durable record, and they are not the
// same thing. The audit row holds ID SNAPSHOTS, never FKs — see the schema
// comment on StaffRoleAudit for why "survives account deletion, never updated"
// and "plain FK to users" are incompatible.
//
// 🔒 ROLE CHANGES ARE TRANSITIONS. `staff_roles.user_id` is the PK, so a user
// holds exactly ONE live role row. Promotion replaces it; a downgrade is never
// implicit; revoking admin removes all staff access. See the three rules on the
// StaffRole model.
//
// 🔒 DEFENCE IN DEPTH, and the DB half is the load-bearing one. The app-layer
// guard alone was defeated twice: by `DELETE FROM users` (staff_roles cascades,
// so the sole admin deleting their own account left zero admins) and by
// `UPDATE staff_roles SET role='curator'` on the sole admin (a demotion deletes
// nothing). The database therefore carries:
//   • BEFORE DELETE OR UPDATE OF role ON staff_roles — refuses any change that
//     would leave zero admins, covering deletion AND demotion.
//   • BEFORE DELETE ON users — appends the account-deletion audit row. It hangs
//     off `users`, not `staff_roles`, so it fires ONLY for a real account
//     deletion; on staff_roles it stamped every deliberate revoke as an
//     'account deletion' too.
// The checks here produce typed errors instead of raw Postgres exceptions and
// serialize against those triggers on the SAME advisory-lock key — they are not
// sufficient on their own and are not meant to be.

// 🔒 The single lock key every admin-removal path takes, app-side and in the DB
// trigger alike. It must match `hashtext('verre:staff_roles:admin')` in
// migration § 12 EXACTLY, or the two paths serialize only against themselves
// and the delete-vs-revoke race reopens (it was 8/10 lockouts before this).
// Exported so tests can assert the app and the DB trigger genuinely share it. A
// test hardcoding the literal would stay green if THIS constant changed while the
// trigger's stayed put — catching only half the drift it exists to catch.
export const ADMIN_LOCK_KEY = 'verre:staff_roles:admin'

// 🔒 LOCK ORDERING INVARIANT: this advisory lock is taken FIRST, before any row
// lock and before any read the decision depends on. Two consequences, both
// learned from real defects:
//   • Reading first decides on STALE state (demote-vs-revoke left a user with no
//     role and a falsified audit trail).
//   • Locking a row first inverts the order and DEADLOCKS (two admins revoking
//     each other → Postgres 40P01).
// Re-taking it within one transaction is a no-op, so callers may take it defensively.
async function lockAdminSet(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ADMIN_LOCK_KEY}))`
}

export class LastAdminError extends Error {
  constructor() {
    super('Cannot revoke the final admin grant')
    this.name = 'LastAdminError'
  }
}

// Granting `curator` to an existing admin. Rejected — see grantStaffRoleAs.
export class ImplicitDowngradeError extends Error {
  constructor() {
    super('Refusing to downgrade admin to curator implicitly — use demoteToCuratorAs')
    this.name = 'ImplicitDowngradeError'
  }
}

// The subject did not hold the role the caller believed. Raised rather than
// returned-silently: a no-op that reports success is indistinguishable from the
// operation having happened, which is how a demote-vs-revoke race told BOTH
// callers their transition applied while only one did.
export class RoleStateChangedError extends Error {
  constructor(expected: string, actual: string) {
    super(`Subject no longer holds '${expected}' (now: ${actual}) — re-read and retry`)
    this.name = 'RoleStateChangedError'
  }
}

export class NotAuthorizedError extends Error {
  constructor(permission: StaffPermission) {
    super(`Caller lacks ${permission}`)
    this.name = 'NotAuthorizedError'
  }
}

// ── The mutation primitives — MODULE-PRIVATE, by design ────────────────────
//
// 🔒 These are NOT exported. They take a caller-supplied actorId and perform NO
// authorization, which is only safe if nothing outside this module can reach
// them. Exporting them was a fixed defect: `grantStaffRole(subject, 'admin',
// <any-non-staff-user-id>)` successfully granted admin, and any future route
// calling one directly would be a privilege-escalation hole AND could forge
// audit attribution by nominating someone else as the actor.
//
// The public API below is the ONLY way in, and every entry point resolves
// authorization INSIDE the same transaction as the write.
//
// Bootstrap is a direct-DB operation — not a script, not an endpoint, and NOT an
// exported function here (see the note at the bottom of this file, and the
// runbook in prisma/CLAUDE.md): the first admin is a hand-run INSERT, whose whole
// premise is that DB access IS the credential.

// Assert the caller currently holds `permission`, reading INSIDE the caller's
// transaction and LOCKING the actor's own grant row for the rest of it.
//
// 🔒 The lock is what makes this a real check rather than a stale one. Without
// it, an admin whose privilege is revoked concurrently could still complete a
// grant: check passes, revoke commits, write lands. FOR UPDATE on the actor's
// row forces a concurrent revoke of that actor to wait for this transaction, so
// the privilege that authorized the write is still held when the write commits.
async function assertCanTx(
  tx: Prisma.TransactionClient,
  callerId: number,
  permission: StaffPermission,
): Promise<void> {
  // 🔒 SHARED LOCK FIRST, ALWAYS. Taking the caller's ROW lock before the shared
  // advisory lock is INVERTED ORDERING and deadlocks: two admins revoking each
  // other each hold their own row and then wait for the other's, producing
  // Postgres 40P01. Ordering every path as (advisory, then rows) makes a cycle
  // impossible — the advisory lock is a single global gate, so whoever holds it
  // can always make progress.
  await lockAdminSet(tx)
  const rows = await tx.$queryRaw<{ role: string }[]>`
    SELECT role FROM staff_roles WHERE user_id = ${callerId} FOR UPDATE
  `
  const role = rows[0]?.role
  const required = STAFF_PERMISSIONS[permission]
  const satisfied = role === 'admin' || role === required
  if (!satisfied) throw new NotAuthorizedError(permission)
}

// Grant or promote, inside an existing transaction. One live row per user, so
// this is a transition:
//
//  - no existing role → insert
//  - same role        → no-op on the row, still audited (the attempt is
//                       history), no spurious revoke event
//  - curator → admin  → PROMOTION: replaces the row and writes BOTH
//                       revoke-curator and grant-admin, so the audit shows the
//                       privilege actually held at each point
//  - admin → curator  → 🔒 REJECTED. A grant must never silently strip admin;
//                       lowering privilege is the explicit demote operation.
async function applyGrant(
  tx: Prisma.TransactionClient,
  subjectId: number,
  role: StaffRole,
  actorId: number | null,
  reason?: string,
): Promise<void> {
  // 🔒 LOCK BEFORE READ. Reading the subject first and locking later decides the
  // transition on STALE state: a reviewer reproduced demote-vs-revoke where both
  // calls succeeded, the user ended with NO role, and the audit falsely recorded
  // a second admin revocation. The lock must precede every read whose value the
  // decision depends on — lockAdminSet is idempotent within a transaction, so
  // re-taking it costs nothing when the caller already holds it.
  await lockAdminSet(tx)
  const existing = await tx.staffRole.findUnique({ where: { userId: subjectId } })
  if (existing?.role === role) {
    await tx.staffRoleAudit.create({
      data: { subjectId, role, action: 'grant', actorId, reason: reason ?? null },
    })
    return
  }
  if (existing?.role === 'admin' && role === 'curator') throw new ImplicitDowngradeError()
  if (existing) {
    await tx.staffRole.update({
      where: { userId: subjectId },
      data: { role, grantedBy: actorId, grantedAt: new Date() },
    })
    await tx.staffRoleAudit.create({
      data: {
        subjectId, role: existing.role, action: 'revoke', actorId,
        reason: reason ?? `superseded by ${role}`,
      },
    })
  } else {
    await tx.staffRole.create({ data: { userId: subjectId, role, grantedBy: actorId } })
  }
  await tx.staffRoleAudit.create({
    data: { subjectId, role, action: 'grant', actorId, reason: reason ?? null },
  })
}

// Revoke all staff access, inside an existing transaction.
//
// 🔒 Revoking admin makes the person an ORDINARY USER, not an automatic curator
// (Simon, 2026-07-25) — auto-demotion would leave someone holding privileges the
// revoker may not have meant to leave them. Re-granting curator is a separate
// deliberate act.
//
// `role` is the role the caller BELIEVES the subject holds; a mismatch is a
// no-op that appends nothing, so a stale UI cannot revoke something else.
//
// The last-admin refusal also lives in the DB trigger; this check runs first
// only to raise a typed error instead of a raw Postgres exception. Both take the
// same advisory lock, so app-revoke and cascade-delete serialize against each
// other rather than only against themselves.
async function applyRevoke(
  tx: Prisma.TransactionClient,
  subjectId: number,
  role: StaffRole,
  actorId: number | null,
  reason?: string,
): Promise<void> {
  // 🔒 Lock before read — see applyGrant.
  await lockAdminSet(tx)
  const existing = await tx.staffRole.findUnique({ where: { userId: subjectId } })
  // 🔒 THROW, don't return — see applyDemote. A stale UI revoking a role the
  // subject no longer holds must learn that, not be told it succeeded.
  if (!existing || existing.role !== role) {
    throw new RoleStateChangedError(role, existing?.role ?? 'none')
  }
  if (role === 'admin') {
    const others = await tx.staffRole.count({
      where: { role: 'admin', userId: { not: subjectId } },
    })
    if (others === 0) throw new LastAdminError()
  }
  // This is the DELIBERATE-revoke audit row, with the real actor. The
  // account-deletion row is written by a separate BEFORE DELETE ON users
  // trigger, so the two cases never both fire for one removal.
  await tx.staffRoleAudit.create({
    data: { subjectId, role, action: 'revoke', actorId, reason: reason ?? null },
  })
  await tx.staffRole.delete({ where: { userId: subjectId } })
}

// Explicit demotion admin → curator, inside an existing transaction. The ONLY
// way privilege goes down without going to zero; applyGrant refuses to do it
// implicitly. The DB trigger covers this path too (it fires on UPDATE OF role,
// not only DELETE), so a sole admin cannot demote themselves to zero admins.
async function applyDemote(
  tx: Prisma.TransactionClient,
  subjectId: number,
  actorId: number | null,
  reason?: string,
): Promise<void> {
  // 🔒 Lock before read — see applyGrant. Demote-vs-revoke was the pair that
  // actually broke: both succeeded and the subject ended with no staff role.
  await lockAdminSet(tx)
  const existing = await tx.staffRole.findUnique({ where: { userId: subjectId } })
  // 🔒 THROW, don't return. A silent success here is a lie: under a concurrent
  // revoke the row is already gone, and returning void told the caller the
  // demotion applied when nothing happened. Verified with a gated race — both
  // calls reported success, the row was gone, and only the revoke was audited.
  if (!existing || existing.role !== 'admin') {
    throw new RoleStateChangedError('admin', existing?.role ?? 'none')
  }
  const others = await tx.staffRole.count({
    where: { role: 'admin', userId: { not: subjectId } },
  })
  if (others === 0) throw new LastAdminError()
  await tx.staffRole.update({
    where: { userId: subjectId },
    data: { role: 'curator', grantedBy: actorId, grantedAt: new Date() },
  })
  await tx.staffRoleAudit.create({
    data: { subjectId, role: 'admin', action: 'revoke', actorId, reason: reason ?? 'demoted to curator' },
  })
  await tx.staffRoleAudit.create({
    data: { subjectId, role: 'curator', action: 'grant', actorId, reason: reason ?? 'demoted from admin' },
  })
}

// ── The public API — authorization and mutation in ONE transaction ─────────
//
// 🔒 `callerId` MUST come from the authenticated server context (`auth()` /
// resolveIdentity) — NEVER from a request body, header, or query parameter (root
// CLAUDE.md § Trust model: identity ids are the only trust anchor and are never
// read from a request body). It is a parameter because this module is
// framework-neutral and must not import NextAuth; the route is responsible for
// passing a value it derived from the session, and passing anything else is the
// same class of bug as trusting a body-supplied user id anywhere else.
//
// The actor of the audit row is ALWAYS this same callerId — there is no
// parameter through which a caller can attribute the action to someone else.

export async function grantStaffRoleAs(
  callerId: number,
  subjectId: number,
  role: StaffRole,
  reason?: string,
): Promise<void> {
  await prisma.$transaction(async tx => {
    await assertCanTx(tx, callerId, 'staff.grantRole')
    await applyGrant(tx, subjectId, role, callerId, reason)
  })
}

export async function revokeStaffRoleAs(
  callerId: number,
  subjectId: number,
  role: StaffRole,
  reason?: string,
): Promise<void> {
  await prisma.$transaction(async tx => {
    await assertCanTx(tx, callerId, 'staff.revokeRole')
    await applyRevoke(tx, subjectId, role, callerId, reason)
  })
}

export async function demoteToCuratorAs(
  callerId: number,
  subjectId: number,
  reason?: string,
): Promise<void> {
  await prisma.$transaction(async tx => {
    await assertCanTx(tx, callerId, 'staff.revokeRole')
    await applyDemote(tx, subjectId, callerId, reason)
  })
}

// ── No unchecked grant function is exported, deliberately ──────────────────
//
// 🔒 There is NO exported way to mint a staff role without an authorization
// check. An earlier `bootstrapAdminGrant(subjectId)` existed for a bootstrap
// script; once both were replaced by a documented direct-DB INSERT
// (prisma/CLAUDE.md), that export was pure liability — confirmed reachable: any future route or server
// action could import it and promote an arbitrary user to admin, with no
// permission gate and no audit attribution.
//
// The first admin is created with SQL by someone who already holds database
// credentials. Everything after that goes through grantStaffRoleAs /
// revokeStaffRoleAs / demoteToCuratorAs, which resolve authorization inside the
// write transaction. If a server-side bootstrap path is ever genuinely needed,
// add it behind an explicit, non-HTTP-reachable entry point and re-argue it —
// do not re-export an unchecked mutator.
