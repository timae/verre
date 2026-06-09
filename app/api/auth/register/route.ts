import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { validateDisplayName } from '@verre/core'
import { checkRate, getClientIp, formatWait } from '@/lib/rateLimit'
import { verifyRegisterToken } from '@/lib/registerToken'
import { isSameOrigin } from '@/lib/csrf'
import { syncCredential } from '@/lib/identityStore'

const schema = z.object({
  name:       z.string(),
  email:      z.string().email(),
  password:   z.string().min(8),
  formToken:  z.string(),
  website:  z.string().optional(),
})

export async function POST(req: NextRequest) {
  // Origin guard — first thing on every state-changing route, per
  // app/api/CLAUDE.md. Register is unauthenticated so traditional cookie-CSRF
  // doesn't apply, and the honeypot + signed form-token already form a
  // complete anti-abuse defense. The origin check is defense-in-depth: it
  // catches some attack shapes (e.g. a future refactor that authenticates
  // the route) without depending on the bot-defense layer staying intact.
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Rate limit: 100 registrations per minute per IP. Generous enough for
  // a busy event where many people sign up at once; tight enough to make
  // sustained signup spam expensive.
  const ip = getClientIp(req)
  const rl = await checkRate(`rl:register:ip:${ip}:1m`, 100, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many registration attempts. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 })

  // Honeypot — only naive-bot trip; real users can't see the field.
  if (parsed.data.website && parsed.data.website.trim() !== '') {
    console.warn(`[register] honeypot triggered ip=${ip}`)
    return NextResponse.json({ error: 'registration failed' }, { status: 400 })
  }

  // Form token — proves the form was rendered server-side and gives us a
  // signed timestamp for the submit-timing check.
  const verdict = verifyRegisterToken(parsed.data.formToken)
  if (!verdict.ok) {
    console.warn(`[register] formToken rejected reason=${verdict.reason} ip=${ip}`)
    return NextResponse.json({ error: 'registration failed' }, { status: 400 })
  }

  let name: string
  try { name = validateDisplayName(parsed.data.name) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  const { email, password } = parsed.data
  try {
    const hash = await bcrypt.hash(password, 12)
    // User row + credential + initial visibility audit log row in one
    // transaction so a partial failure can't leave a user without a hash or
    // audit history. The credential write goes through syncCredential (the
    // chokepoint — the only code allowed to write password_hash; CI-enforced)
    // with the txn client so it stays atomic. The signup audit row uses
    // fromTier=NULL/fromFof=NULL — the convention distinguishing initial-state
    // from user-driven changes.
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { name, email: email.toLowerCase() },
        select: { id: true, name: true, email: true, role: true, pro: true, profileVisibility: true, visibilityFof: true },
      })
      await syncCredential(created.id, hash, tx)
      await tx.profileVisibilityLog.create({
        data: {
          userId: created.id,
          toTier: created.profileVisibility,
          toFof: created.visibilityFof,
        },
      })
      return created
    })
    return NextResponse.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, pro: user.pro } })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return NextResponse.json({ error: 'email already registered' }, { status: 409 })
    }
    return NextResponse.json({ error: 'registration failed' }, { status: 500 })
  }
}
