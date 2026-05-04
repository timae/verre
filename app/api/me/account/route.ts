import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcrypt'
import { validateDisplayName } from '@/lib/displayName'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { executeAccountDelete } from '@/lib/accountDelete'

export async function PATCH(req: NextRequest) {
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

  const { name, email, currentPassword, newPassword } = await req.json()
  const updates: Record<string, unknown> = {}

  if (name !== undefined) {
    try { updates.name = validateDisplayName(name) }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }
  }

  if (email !== undefined) {
    const e = String(email).trim().toLowerCase()
    if (!e.includes('@')) return NextResponse.json({ error: 'invalid email' }, { status: 400 })
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
