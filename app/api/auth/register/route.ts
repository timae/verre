import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcrypt'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'
import { validateDisplayName, validateUsername } from '@verre/core'
import { checkRate, getClientIp, formatWait } from '@/lib/rateLimit'
import { verifyRegisterToken } from '@/lib/registerToken'
import { isSameOrigin } from '@/lib/csrf'
import { syncCredential } from '@/lib/identityStore'
import { AUDIT_SAME_AS_PROFILE } from '@/lib/profileVisibility'
import { usernameTaken } from '@/lib/username'

const schema = z.object({
  name:       z.string(),
  // Required since usernames (§ 9); a missing one is a 400 with its own message.
  username:   z.unknown().optional(),
  email:      z.email(),
  password:   z.string().min(8),
  formToken:  z.string(),
  website:  z.string().optional(),
})

// 409 { error, fields: { email?: 'taken', username?: 'taken' } }: both at once,
// honestly (the rate limit is the bound on probing, app/api/rate-limits.md).
// `error` keeps "email already registered" when only the email is taken. A
// HELD username answers like a taken one (`usernameTaken` includes holds).
async function conflicts(email: string, username: string): Promise<NextResponse | null> {
  const [emailRow, nameTaken] = await Promise.all([
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
    usernameTaken(username),
  ])
  if (!emailRow && !nameTaken) return null
  const fields: { email?: 'taken'; username?: 'taken' } = {
    ...(emailRow ? { email: 'taken' as const } : {}),
    ...(nameTaken ? { username: 'taken' as const } : {}),
  }
  const error = emailRow && nameTaken ? 'email and username already taken' : emailRow ? 'email already registered' : 'username already taken'
  return NextResponse.json({ error, fields }, { status: 409 })
}

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
  let username: string
  try { username = validateUsername(parsed.data.username) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  const { password } = parsed.data
  const email = parsed.data.email.toLowerCase()
  const taken = await conflicts(email, username)
  if (taken) return taken
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
      // The username rides the SAME insert (no user row without one). A model
      // call, so a taken or held name is P2002 (lib/username.ts).
      const created = await tx.user.create({
        data: { name, email, username },
        select: {
          id: true, name: true, email: true, role: true, pro: true, profileVisibility: true, visibilityFof: true,
          checkinVisibility: true, showCravings: true, showMoments: true, showLocations: true,
        },
      })
      await syncCredential(created.id, hash, tx)
      await tx.profileVisibilityLog.create({
        data: {
          userId: created.id,
          toTier: created.profileVisibility,
          toFof: created.visibilityFof,
          toCheckinTier: created.checkinVisibility ?? AUDIT_SAME_AS_PROFILE,
          toShowCravings: created.showCravings,
          toShowMoments: created.showMoments,
          toShowLocations: created.showLocations,
        },
      })
      return created
    })
    // No user id (public-user-ids § 5): the client signs in next and learns its
    // own (public) id from the session.
    return NextResponse.json({ user: { name: user.name, username, email: user.email, role: user.role, pro: user.pro } })
  } catch (err: unknown) {
    // A lost race after the pre-check: re-run it to name the field (Prisma's
    // error shape depends on the driver adapter, so it isn't parsed). If the
    // re-check names neither, the generic failure.
    if ((err as { code?: string }).code === 'P2002') {
      const lost = await conflicts(email, username).catch(() => null)
      if (lost) return lost
    }
    return NextResponse.json({ error: 'registration failed' }, { status: 500 })
  }
}
