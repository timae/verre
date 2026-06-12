import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcrypt'
import { validateDisplayName } from '@verre/core'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { executeAccountDelete } from '@/lib/accountDelete'
import { isSameOrigin } from '@/lib/csrf'
import { syncCredential, revokeAllSessions, revokeAllForNativeCaller } from '@/lib/identityStore'
import { propagateDisplayNameToSessions } from '@/lib/displayName.server'

// Minimal self profile for clients that can't read the web session shape —
// the native app uses `pro` to render pro-gated affordances (02a blind
// toggle) disabled instead of discovering the 403 on submit. resolveUser
// already runs a fresh users SELECT on both branches, so this is
// revocation/upgrade-correct on every request. No rate limit: cheap read,
// same class as /api/me/sessions.
export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const u = session.user as { name?: string | null; email?: string | null; pro?: boolean }
  return NextResponse.json(
    { name: u.name ?? null, email: u.email ?? null, pro: !!u.pro },
    // Viewer-dependent body — never shared-cacheable.
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

export async function PATCH(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  // Shared rl:account counter (also incremented by DELETE). 20/hour per user.
  // Threat model: an attacker with a stolen session cookie tries to
  // brute-force the current-password check used by both PATCH (password
  // change) and DELETE (account deletion). Sharing the counter caps total
  // attempts at 20/hour across both endpoints, not 20+20.
  const userId = Number(session.user.id)
  const rl = await checkRate(`rl:account:user:${userId}:1h`, 20, 3600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many account changes. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  const { name, email, currentPassword, newPassword } = body
  const updates: Record<string, unknown> = {}

  if (name !== undefined) {
    try { updates.name = validateDisplayName(name) }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }
  }

  if (email !== undefined) {
    const e = String(email).trim().toLowerCase()
    // Reject control chars (NULL byte trips Postgres P22021 → 500),
    // bidi/zero-width invisibles, and the obvious "no @" case. The
    // RFC 5322 grammar isn't enforced — bcrypt-grade strictness is
    // overkill for a write-side guard that only protects the column.
    if (!e || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/.test(e)) {
      return NextResponse.json({ error: 'invalid email' }, { status: 400 })
    }
    if (!e.includes('@')) return NextResponse.json({ error: 'invalid email' }, { status: 400 })
    if (e.length > 320) return NextResponse.json({ error: 'invalid email' }, { status: 400 })
    updates.email = e
  }

  // The new password hash is kept separate from `updates` (name/email) because
  // the credential write goes through syncCredential (the chokepoint — the only
  // code allowed to write password_hash; CI-enforced), not the batched
  // prisma.user.update below.
  let newPasswordHash: string | undefined
  if (newPassword !== undefined) {
    if (!currentPassword) return NextResponse.json({ error: 'current password required' }, { status: 400 })
    if (String(newPassword).length < 8) return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 })
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 })
    // A NATIVE-registered OR social-only (Better Auth) user has a NULL
    // users.password_hash — their credential (if any) lives in auth_accounts.
    // This web endpoint re-auths only against the WEB hash and rejects when it's
    // NULL: a shipped asymmetry (verifyPassword has the auth_accounts fallback
    // for device-revoke, this route deliberately does not). So a native-only user
    // can't change their password or delete their account via the WEB routes —
    // native account-management is a step-6+ surface (a deferred decision, not an
    // oversight; unifying would mean routing through verifyPassword + minding the
    // shared rl:account charge). Reject rather than fall through to allow.
    if (!user.passwordHash) return NextResponse.json({ error: 'current password incorrect' }, { status: 400 })
    const valid = await bcrypt.compare(String(currentPassword), user.passwordHash)
    if (!valid) return NextResponse.json({ error: 'current password incorrect' }, { status: 400 })
    newPasswordHash = await bcrypt.hash(String(newPassword), 12)
  }

  if (Object.keys(updates).length === 0 && newPasswordHash === undefined) return NextResponse.json({ ok: true })

  try {
    if (Object.keys(updates).length > 0) await prisma.user.update({ where: { id: userId }, data: updates })
    if (newPasswordHash !== undefined) await syncCredential(userId, newPasswordHash)
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'P2002') return NextResponse.json({ error: 'email already in use' }, { status: 409 })
    return NextResponse.json({ error: 'update failed' }, { status: 500 })
  }

  // After commit: push the new name into the session name snapshots — live
  // Redis (identities roster + meta.host) AND the Postgres sessions.host_name
  // mirror that feed/profile session cards read. Best-effort — a propagation
  // failure must not fail the rename itself.
  if (updates.name !== undefined) {
    const newName = updates.name as string
    try { await propagateDisplayNameToSessions(userId, newName) }
    catch (e) { console.error('rename propagation failed:', e) }
    try {
      await prisma.session.updateMany({
        where: { hostUserId: userId, deletedAt: null },
        data: { hostName: newName },
      })
    } catch (e) { console.error('rename host_name mirror failed:', e) }
  }

  // After a password change, revoke every OTHER device's session so a stolen
  // session can't outlive the rotation — the load-bearing invariant. This
  // endpoint is reachable by BOTH credential types (resolveUser), so the revoke
  // must cover both stores:
  //   - WEB caller (has a user_sessions row → userSessionId set): keep the
  //     caller's own session (no annoying self-logout; standard GitHub/Slack
  //     behaviour), revoke every OTHER web session, and fan out to ALL native
  //     sessions. revokeAllSessions does exactly this (chokepoint).
  //   - NATIVE caller (BA cookie → userSessionId UNDEFINED): the caller has no
  //     user_sessions row to preserve, so EVERY web + native session dies (incl.
  //     the caller's own native one — strictly safe, they just re-authed). Via
  //     revokeAllForNativeCaller, which fans out BOTH legs with the same per-leg-
  //     catch-then-rethrow independence as revokeAllSessions — NOT two unguarded
  //     sequential helper calls, which would let a web-leg throw skip the native
  //     revoke. The native /api/auth/native/change-password path instead keeps
  //     the current native session; this web endpoint is the cross-credential case.
  // userSessionId comes ONLY from the signed JWT, never the request body.
  const responseBody: { ok: true; otherDevicesSignedOut?: number } = { ok: true }
  if (newPasswordHash !== undefined) {
    responseBody.otherDevicesSignedOut = session.user.userSessionId
      ? await revokeAllSessions(userId, session.user.userSessionId, 'password_change')
      : await revokeAllForNativeCaller(userId)
  }

  return NextResponse.json(responseBody)
}

export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const userId = Number(session.user.id)

  // Shared rl:account counter (also incremented by PATCH). See PATCH for
  // threat model: brute-force of the password re-prompt by a holder of a
  // stolen session cookie. 20 total attempts/hour across both endpoints.
  const rl = await checkRate(`rl:account:user:${userId}:1h`, 20, 3600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many account changes. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const { password } = await req.json().catch(() => ({}))
  if (!password) return NextResponse.json({ error: 'password required' }, { status: 400 })

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 })
  // A NATIVE-registered OR social-only (Better Auth) user has a NULL
  // users.password_hash — no WEB password to confirm deletion against, so this
  // route rejects (same asymmetry as the PATCH above: it does NOT fall back to
  // the auth_accounts credential the way verifyPassword does). A native-only user
  // therefore has no web deletion path, and BA's /delete-user is config-gated off
  // (not registered — user.deleteUser.enabled is unset, distinct from the
  // disabledPaths deny-list) — account deletion for native-only users is a
  // step-6+ native surface (deferred, not wired today). Reject, don't allow.
  if (!user.passwordHash) return NextResponse.json({ error: 'password incorrect' }, { status: 400 })
  const valid = await bcrypt.compare(String(password), user.passwordHash)
  if (!valid) return NextResponse.json({ error: 'password incorrect' }, { status: 400 })

  try {
    const plan = await executeAccountDelete(userId)
    console.warn(`[account-delete] user=${userId} sessionsDeleted=${plan.toDelete.length} sessionsTombstoned=${plan.toPseudonymize.length} otherScrubs=${plan.scrubOnly.length}`)
  } catch (err) {
    console.error('[account-delete] failed', err)
    return NextResponse.json({ error: 'deletion failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
