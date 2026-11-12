import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { isOwnTileUpload, isTileKey, isPickable, listPickable, readPins } from '@/lib/profileTiles'

const noStore = { 'Cache-Control': 'private, no-store' }
const LIMIT = 60

// GET /api/me/profile/photos?pool=impressions|moments|cravings — the tile
// cover picker: the latest ≤ 60 distinct pickable photos (own, blind-safe),
// the current pin first while it is still pickable or is the tile's own
// upload. `pin` = that pin, or null (none set, or a re-hidden pin the picker
// can't offer).
export async function GET(req: NextRequest) {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: noStore })
  const userId = Number(session.user.id)
  const pool = req.nextUrl.searchParams.get('pool')
  if (!isTileKey(pool)) return NextResponse.json({ error: 'invalid pool' }, { status: 400, headers: noStore })

  const rl = await checkRate(`rl:profile-photos:${userId}:1m`, 60, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const [photos, pins] = await Promise.all([listPickable(pool, userId, LIMIT), readPins(userId)])
  const pinned = pins[pool]
  const pin = pinned && (isOwnTileUpload(pinned, pool, userId) || photos.includes(pinned) || (await isPickable(pool, userId, pinned))) ? pinned : null
  const ordered = pin ? [pin, ...photos.filter(u => u !== pin)].slice(0, LIMIT) : photos
  return NextResponse.json({ photos: ordered, pin }, { headers: noStore })
}
