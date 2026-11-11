import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { listMutedUsers } from '@/lib/userMute'

// The caller's own mute list, newest first (Settings → Privacy → Muted). Always
// scoped to the caller. A muted user who blocked the caller is left out
// (listMutedUsers). Viewer-dependent: private, no-store on every path.
const NO_STORE = { 'Cache-Control': 'private, no-store' }
export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: NO_STORE })
  const muterId = Number(session.user.id)
  const rl = await checkRate(`rl:mutes-read:user:${muterId}:1m`, 60, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfter) } },
    )
  }
  return NextResponse.json({ mutes: await listMutedUsers(muterId) }, { headers: NO_STORE })
}
