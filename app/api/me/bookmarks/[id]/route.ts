import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { isSameOrigin } from '@/lib/csrf'
import { parseCravingKey, removeCraving } from '@/lib/cravings'

type Ctx = { params: Promise<{ id: string }> }
const NO_STORE = { 'Cache-Control': 'private, no-store' }

// DELETE /api/me/bookmarks/<key>: remove one of your cravings by its key (the
// `key` of your own Cravings and Saved rows: a craving's id, or `m` + a blind
// save's id; catalogue model change § 5), with the rest of that wine as the list
// shows it. Owner-scoped: someone else's key, a missing one, a malformed one and
// a craving hidden for you (it is on no list until its reveal) are the same 404.
// The old by-wine route is gone: removal is by key, or per bottle in the moment
// (`/api/session/<code>/wines/<wineId>/bookmark`).
export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const key = parseCravingKey((await params).id)
  if (key === null || !(await removeCraving(Number(session.user.id), key))) return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
