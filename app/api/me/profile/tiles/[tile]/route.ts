import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { MAX_IMAGE_DATA_URL_BYTES } from '@/lib/s3'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { isSameOrigin } from '@/lib/csrf'
import { replaceTilePhoto } from '@/lib/profileImage'
import { isTileKey } from '@/lib/profileTiles'

const noStore = { 'Cache-Control': 'private, no-store' }

// POST /api/me/profile/tiles/<impressions|moments|cravings> { imageData } —
// your own photo on a profile tile (ruled 2026-11-12; Take Photo / Choose from
// Library in the tile's cover sheet): uploaded through the avatar pipeline and
// pinned at once, the tile's previous own upload reclaimed. Back to a photo of
// your content, or the automatic one, is the profile PATCH (which reclaims it
// too). Its own counter: three tiles share it, the photo and cover keep theirs.
export async function POST(req: NextRequest, { params }: { params: Promise<{ tile: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: noStore })
  const userId = Number(session.user.id)
  const { tile } = await params
  if (!isTileKey(tile)) return NextResponse.json({ error: 'not found' }, { status: 404, headers: noStore })

  const rl = await checkRate(`rl:profile-tile:${userId}:1h`, 20, 3600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many uploads. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: noStore })
  const { imageData } = body as { imageData?: unknown }
  if (typeof imageData !== 'string' || imageData.length > MAX_IMAGE_DATA_URL_BYTES) {
    return NextResponse.json({ error: 'image too large' }, { status: 400, headers: noStore })
  }

  const r = await replaceTilePhoto(userId, tile, imageData)
  if (!r.ok) return r.reason === 'gone'
    ? NextResponse.json({ error: 'user not found' }, { status: 404, headers: noStore })
    : NextResponse.json({ error: 'upload failed' }, { status: 500, headers: noStore })
  // The same shape as the PATCH's `tiles`, so the app merges it the same way.
  return NextResponse.json({ tiles: { [tile]: { imageUrl: r.url, pinned: true } } }, { headers: noStore })
}
