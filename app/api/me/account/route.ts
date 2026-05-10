import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcrypt'
import { validateDisplayName } from '@/lib/displayName'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { executeAccountDelete } from '@/lib/accountDelete'
import { isSameOrigin } from '@/lib/csrf'

export async function PATCH(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
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

  if (newPassword !== undefined) {
    if (!currentPassword) return NextResponse.json({ error: 'current password required' }, { status: 400 })
    if (String(newPassword).length < 8) return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 })
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 })
    const valid = await bcrypt.compare(String(currentPassword), user.passwordHash)
    if (!valid) return NextResponse.json({ error: 'current password incorrect' }, { status: 400 })
    updates.passwordHash = await bcrypt.hash(String(newPassword), 12)
  }

  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true })

  try {
    await prisma.user.update({ where: { id: userId }, data: updates })
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'P2002') return NextResponse.json({ error: 'email already in use' }, { status: 409 })
    return NextResponse.json({ error: 'update failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
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
