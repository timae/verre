import { NextRequest, NextResponse } from 'next/server'
import { usernameFromPath } from '@verre/core'
import { PROFILE_NO_STORE, serveProfile } from '@/lib/profileRoute'
import { userForUsername } from '@/lib/username'

// GET /api/users/by-username/<username>: the profile GET by username
// (usernames § 5), for a scanned or pasted `/@name` link (`?view=header`, then
// the profile opens by the `id` in the answer). The SAME handler, limiter key
// and answers as `/api/users/[id]`. 🔒 The FORMAT only, never the reserved
// list (a rule for writes). Malformed → 400; unknown, held or renamed away →
// the same 404 as 'gone'.
export async function GET(req: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const username = usernameFromPath((await params).username)
  if (username === null) return NextResponse.json({ error: 'invalid username' }, { status: 400, headers: PROFILE_NO_STORE })
  return serveProfile(req, () => userForUsername(username))
}
