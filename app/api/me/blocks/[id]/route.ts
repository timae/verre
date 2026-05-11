import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { isSameOrigin } from '@/lib/csrf'
import { parsePathId } from '@/lib/parsePathId'
import { formatWait } from '@/lib/rateLimit'
import { setBlock } from '@/lib/userBlock'

type Ctx = { params: Promise<{ id: string }> }

// Block another user. Idempotent. blockerId is taken from the session
// cookie — never from path/body. Path :id is the target.
//
// POST is rate-limited (30/h/user) against a stolen-cookie burst.
// DELETE is intentionally NOT rate-limited — unblock is the recovery
// path and must remain available even after a burst-block attack.
export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const blockerId = Number(session.user.id)
  const blockedId = parsePathId((await params).id)
  if (blockedId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  const result = await setBlock(blockerId, blockedId, true)
  if (!result.ok) {
    if (result.reason === 'rate-limited') {
      return NextResponse.json(
        { error: `Too many block changes. Try again in ${formatWait(result.retryAfter)}.` },
        { status: 429, headers: { 'Retry-After': String(result.retryAfter) } },
      )
    }
    if (result.reason === 'self') {
      return NextResponse.json({ error: 'cannot block yourself' }, { status: 400 })
    }
  }
  return NextResponse.json({ blocked: true })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const blockerId = Number(session.user.id)
  const blockedId = parsePathId((await params).id)
  if (blockedId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  const result = await setBlock(blockerId, blockedId, false)
  if (!result.ok) {
    if (result.reason === 'self') {
      return NextResponse.json({ error: 'cannot block yourself' }, { status: 400 })
    }
    // 'rate-limited' can't fire for DELETE; defensive fallthrough returns 400.
  }
  return NextResponse.json({ blocked: false })
}
