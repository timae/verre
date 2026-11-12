import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { prisma } from '@/lib/prisma'
import { validateDisplayName, normalizeBio } from '@verre/core'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { isSameOrigin } from '@/lib/csrf'
import { propagateRename } from '@/lib/displayName.server'
import { isTileKey, isPickable, resolveTilePhotos, type TileKey, type TilePhoto } from '@/lib/profileTiles'

const noStore = { 'Cache-Control': 'private, no-store' }

const TILE_FIELD = {
  impressions: 'tileImpressionsUrl',
  moments: 'tileMomentsUrl',
  cravings: 'tileCravingsUrl',
} as const

// PATCH /api/me/profile { name?, bio?, tiles?: { impressions? | moments? |
// cravings?: url | null } } — the native profile editor. NOT the account
// PATCH: that one charges the shared password-guess budget (`rl:account`
// 20/h) on every call, a rename included. Returns only the changed fields;
// the client merges them.
export async function PATCH(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore })
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: noStore })
  const userId = Number(session.user.id)

  const rl = await checkRate(`rl:profile-edit:${userId}:1h`, 60, 3600)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many profile changes. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: noStore })
  const { name, bio, tiles } = body as { name?: unknown; bio?: unknown; tiles?: unknown }
  const data: { name?: string; bio?: string | null; tileImpressionsUrl?: string | null; tileMomentsUrl?: string | null; tileCravingsUrl?: string | null } = {}

  if (name !== undefined) {
    try { data.name = validateDisplayName(name) }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400, headers: noStore }) }
  }
  if (bio !== undefined) {
    try { data.bio = normalizeBio(bio) }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400, headers: noStore }) }
  }
  const changedTiles: TileKey[] = []
  if (tiles !== undefined) {
    if (!tiles || typeof tiles !== 'object' || Array.isArray(tiles)) return NextResponse.json({ error: 'invalid tiles' }, { status: 400, headers: noStore })
    for (const [key, url] of Object.entries(tiles)) {
      if (!isTileKey(key)) return NextResponse.json({ error: 'invalid tiles' }, { status: 400, headers: noStore })
      if (url === undefined) continue
      // A pick must be in the FULL PICK pool (not the picker's 60-photo
      // window): the profile's own, blind-safe photo. One generic message.
      if (url !== null && (typeof url !== 'string' || !(await isPickable(key, userId, url)))) {
        return NextResponse.json({ error: 'That photo is not available.' }, { status: 400, headers: noStore })
      }
      data[TILE_FIELD[key]] = url
      changedTiles.push(key)
    }
  }
  if (Object.keys(data).length === 0) return NextResponse.json({}, { headers: noStore })

  // The pin is written unconditionally: a re-pick that waited on a dead-pin
  // clear's row lock (lib/profileTiles.ts) lands after it.
  try { await prisma.user.update({ where: { id: userId }, data }) }
  catch (e) {
    if ((e as { code?: string }).code === 'P2025') return NextResponse.json({ error: 'user not found' }, { status: 404, headers: noStore })
    return NextResponse.json({ error: 'update failed' }, { status: 500, headers: noStore })
  }
  if (data.name !== undefined) await propagateRename(userId, data.name)

  const out: { name?: string; bio?: string | null; tiles?: Partial<Record<TileKey, TilePhoto>> } = {}
  if (data.name !== undefined) out.name = data.name
  if (data.bio !== undefined) out.bio = data.bio
  if (changedTiles.length > 0) {
    out.tiles = await resolveTilePhotos(userId, changedTiles)
  }
  return NextResponse.json(out, { headers: noStore })
}
