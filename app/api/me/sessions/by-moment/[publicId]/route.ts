import { NextRequest, NextResponse } from 'next/server'
import { normalizePublicUserId } from '@verre/core'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { checkRates, getClientIp } from '@/lib/rateLimit'
import { momentLookInEnabled } from '@/lib/momentGate'
import { grantStatus, readGrantByPublicId } from '@/lib/sessionGrant'
import { lookInJson, lookInNotFound, NO_STORE } from '@/lib/momentLookIn'

// GET /api/me/sessions/by-moment/:publicId — a member's way from a moment's
// public id (a feed post, a look-in that answered `member: true`) to its code
// (Moment Visibility, step-1 plan § 4.3). 🔒 The ONLY route of the feature that
// returns a code: 200 `{ id, code }` for a caller the RECORD admits (the strict
// host, or a member or rating author, not kicked, not banned: `grantStatus`,
// the moment's own rule and the look-in's `member: true`). Everyone else, a
// kick-keep included, the look-in's one 404. Flag off: 404.
export async function GET(req: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  if (!momentLookInEnabled()) return lookInNotFound()
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: NO_STORE })
  const userId = Number(session.user.id)
  const rl = await checkRates([
    { key: `rl:by-moment:u:${userId}:1m`, max: 60, windowSeconds: 60 },
    { key: `rl:by-moment:ip:${getClientIp(req)}:1m`, max: 300, windowSeconds: 60 },
  ])
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests', retryAfter: rl.retryAfter }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfter) } })
  }
  const publicId = normalizePublicUserId((await params).publicId)
  if (!publicId) return lookInNotFound()
  const found = await readGrantByPublicId(prisma, publicId, userId)
  if (!found || grantStatus(found.grant) !== 'ok') return lookInNotFound()
  return lookInJson({ id: found.grant.sessionId, code: found.code })
}
