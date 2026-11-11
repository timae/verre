import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcrypt'
import { validateDisplayName } from '@verre/core'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { executeAccountDelete, AccountDeleteRetryableError, AccountDeleteTooManyWipesError } from '@/lib/accountDelete'
import { isSameOrigin } from '@/lib/csrf'
import { syncCredential, revokeAllSessions, revokeAllForNativeCaller } from '@/lib/identityStore'
import { propagateRename } from '@/lib/displayName.server'

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
    // 🔒 From the app, the address must also pass Better Auth's own sign-in
    // check (z.email(), better-auth api/routes/sign-in): `alice@` would save
    // here and then lock the app out at the next sign-in. Web unchanged.
    if (session.authSource === 'native' && !z.email().safeParse(e).success) return NextResponse.json({ error: 'invalid email' }, { status: 400 })
    updates.email = e
  }

  // The new password hash is kept separate from `updates` (name/email) because
  // the credential write goes through syncCredential (the chokepoint — the only
  // code allowed to write password_hash; CI-enforced), not the batched
  // prisma.user.update below.
  // 🔒 An email change from the APP re-confirms the current password (ruled
  // 2026-11-11): the email is the sign-in name and there is no reset mail, so
  // a stolen phone must not be able to move it. Web callers stay as they were
  // (the web form sends no password for it; slated for redesign).
  const emailNeedsPassword = updates.email !== undefined && session.authSource === 'native'
  let newPasswordHash: string | undefined
  if (newPassword !== undefined || emailNeedsPassword) {
    if (!currentPassword) return NextResponse.json({ error: 'current password required' }, { status: 400 })
    if (newPassword !== undefined && String(newPassword).length < 8) return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 })
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 })
    // Re-auth runs against users.password_hash only (verifyPassword has the
    // auth_accounts fallback for the device revokes, this route deliberately does
    // not). A native sign-up MIRRORS its hash here (lib/betterAuth.ts
    // account.create.after, fill-NULL-only; a crashed mirror heals on the next
    // native sign-in via backfillNativeCredential), so NULL means a social-only
    // user (none yet) or a crashed, unhealed mirror. Reject rather than fall
    // through to allow. The app changes passwords through Better Auth's
    // /change-password, not this PATCH.
    if (!user.passwordHash) return NextResponse.json({ error: 'current password incorrect' }, { status: 400 })
    const valid = await bcrypt.compare(String(currentPassword), user.passwordHash)
    // (The app's Change Email maps this exact text, and 'invalid email' above.)
    if (!valid) return NextResponse.json({ error: 'current password incorrect' }, { status: 400 })
    if (newPassword !== undefined) newPasswordHash = await bcrypt.hash(String(newPassword), 12)
  }

  if (Object.keys(updates).length === 0 && newPasswordHash === undefined) return NextResponse.json({ ok: true })

  try {
    if (Object.keys(updates).length > 0) await prisma.user.update({ where: { id: userId }, data: updates })
    if (newPasswordHash !== undefined) await syncCredential(userId, newPasswordHash)
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'P2002') return NextResponse.json({ error: 'email already in use' }, { status: 409 })
    return NextResponse.json({ error: 'update failed' }, { status: 500 })
  }

  // After commit: the shared rename tail (host_name mirror + live session
  // snapshots, best-effort).
  if (updates.name !== undefined) await propagateRename(userId, updates.name as string)

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
  // The ONE account-deletion path for web AND the app (Settings → Account →
  // Delete Account); BA's /delete-user is config-gated off (not registered —
  // user.deleteUser.enabled is unset, distinct from the disabledPaths deny-
  // list). Same re-auth as the PATCH above: users.password_hash only, which a
  // native sign-up mirrors; NULL (social-only, or a crashed, unhealed mirror)
  // reads as "password incorrect". Reject, don't allow.
  // ⚠️ For a native caller, executeAccountDelete revokes its native sessions
  // BEFORE the step that can fail (409 / 503 / 500), so the app treats any
  // failure after this check as "signed out, account intact" (see
  // lib/accountDelete.ts; pinned in scripts/tests/you-profile-integration.mts).
  if (!user.passwordHash) return NextResponse.json({ error: 'password incorrect' }, { status: 400 })
  const valid = await bcrypt.compare(String(password), user.passwordHash)
  if (!valid) return NextResponse.json({ error: 'password incorrect' }, { status: 400 })

  try {
    const plan = await executeAccountDelete(userId)
    console.warn(`[account-delete] user=${userId} sessionsDeleted=${plan.toDelete.length} sessionsTombstoned=${plan.toPseudonymize.length} otherScrubs=${plan.scrubOnly.length}`)
  } catch (err) {
    console.error('[account-delete] failed', err)
    // Nothing durable happened (one transaction — lib/accountDelete.ts); the
    // size bound and transient conflicts / Redis outages are worth a retry.
    if (err instanceof AccountDeleteTooManyWipesError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    if (err instanceof AccountDeleteRetryableError) {
      return NextResponse.json({ error: 'deletion could not complete, please try again' }, { status: 503, headers: { 'Retry-After': '5' } })
    }
    return NextResponse.json({ error: 'deletion failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
