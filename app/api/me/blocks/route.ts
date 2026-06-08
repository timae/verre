import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { listBlockedUsers } from '@/lib/userBlock'

// List of users the calling user has blocked, newest first. Powers
// the BlockedUsersList in account settings — the only surface that
// surfaces the block-pair information back to the blocker. Always
// scoped to the calling user; the caller cannot list anyone else's
// blocks.
//
// Cache-Control: private, no-store — the response is per-user and
// must never be cached by a CDN/proxy between viewers.
export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const blockerId = Number(session.user.id)
  const rows = await listBlockedUsers(blockerId)
  return NextResponse.json(
    { blocks: rows },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
