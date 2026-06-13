import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { hideCarousel, unhideCarousel } from '@/lib/redis'
import { checkRate, formatWait } from '@/lib/rateLimit'

type Ctx = { params: Promise<{ code: string }> }
const noStore = { 'Cache-Control': 'private, no-store' }

// POST = hide this session from the Moments-home highlight carousel,
// DELETE = un-hide. Purely a PERSONAL view preference on the caller's own
// list — it does NOT touch the session, other participants, or any rating;
// the moment stays in "All moments". No participant check needed: hiding a
// code you're not in is a harmless no-op (it just won't match a live row).
// Logged-in only (anon has no persistent home). Re-engaging with a hidden
// session (a /visit or rate) auto-un-hides it elsewhere.

async function gate(req: NextRequest, code: string) {
  if (!isSameOrigin(req)) return { error: NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore }) }
  const c = normalizeCode(code)
  if (!c) return { error: NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore }) }
  const session = await resolveUser(req)
  if (!session?.user) return { error: NextResponse.json({ error: 'auth required' }, { status: 401, headers: noStore }) }
  const userId = Number(session.user.id)
  // One counter for both verbs (hide+unhide) — a stolen cookie can't stack
  // budget by alternating. 30/10min is ample for normal manage-mode use.
  const rl = await checkRate(`rl:carousel-hidden:user:${userId}:10m`, 30, 600)
  if (!rl.allowed) {
    return { error: NextResponse.json(
      { error: `Too many changes. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    ) }
  }
  return { c, userId }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const g = await gate(req, code)
  if (g.error) return g.error
  await hideCarousel(g.userId, g.c)
  return NextResponse.json({ ok: true, hidden: true }, { headers: noStore })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const g = await gate(req, code)
  if (g.error) return g.error
  await unhideCarousel(g.userId, g.c)
  return NextResponse.json({ ok: true, hidden: false }, { headers: noStore })
}
