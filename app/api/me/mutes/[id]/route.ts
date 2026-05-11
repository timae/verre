import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { isSameOrigin } from '@/lib/csrf'
import { parsePathId } from '@/lib/parsePathId'
import { formatWait } from '@/lib/rateLimit'
import { setMute } from '@/lib/userMute'

type Ctx = { params: Promise<{ id: string }> }

// Mute another user. Idempotent. Auth via session cookie; the muter is
// always the calling user (`session.user.id`), never read from the body
// or path — the path :id is the target.
export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const muterId = Number(session.user.id)
  const mutedId = parsePathId((await params).id)
  if (mutedId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  const result = await setMute(muterId, mutedId, true)
  if (!result.ok) {
    if (result.reason === 'rate-limited') {
      return NextResponse.json(
        { error: `Too many mute changes. Try again in ${formatWait(result.retryAfter)}.` },
        { status: 429, headers: { 'Retry-After': String(result.retryAfter) } },
      )
    }
    if (result.reason === 'self') {
      return NextResponse.json({ error: 'cannot mute yourself' }, { status: 400 })
    }
  }
  return NextResponse.json({ muted: true })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const muterId = Number(session.user.id)
  const mutedId = parsePathId((await params).id)
  if (mutedId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  const result = await setMute(muterId, mutedId, false)
  if (!result.ok) {
    if (result.reason === 'rate-limited') {
      return NextResponse.json(
        { error: `Too many mute changes. Try again in ${formatWait(result.retryAfter)}.` },
        { status: 429, headers: { 'Retry-After': String(result.retryAfter) } },
      )
    }
    if (result.reason === 'self') {
      return NextResponse.json({ error: 'cannot mute yourself' }, { status: 400 })
    }
  }
  return NextResponse.json({ muted: false })
}
