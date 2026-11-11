// Profile tile photos (the native You profile): one module for the automatic
// photo, the picker, the pin write and the pin read, so the four can never
// disagree about which photos a tile may show.
//
// Two pools per tile:
// - LIVE = the source still exists and still belongs to the profile. A chosen
//   tile cover (`users.tile_*_url`, a REFERENCE: no bytes owned) shows while it
//   is LIVE, whatever the blind / reveal state (ruling D3).
//   - impressions: a rating of the profile whose lead photo (first
//     rating_images row, else the wine's) has that URL. Tombstoned moments
//     included (D7: the moment's ratings and feed posts survive its deletion,
//     and D8 keeps a rated wine's photo, so the reference stays valid).
//   - moments: a live, non-kicked membership whose moment has that cover.
//   - cravings: a bookmark whose wine has that image.
// - PICK = what may be newly chosen, and what the automatic photo draws from:
//   impressions + cravings = LIVE + SAFE_PHOTO (never an unrevealed blind
//   wine); moments = LIVE (a cover is never blind-redacted,
//   prisma/schema.prisma sessions.cover_photo_url).
//
// 🔒 The tile COUNTS are not computed here and never depend on these pools
// (lib/profileHeader.ts): the pools only decide photos.
//
// The catalog model change moves per-event image columns onto occurrences;
// these pools and SAFE_PHOTO move with it.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export const TILE_KEYS = ['impressions', 'moments', 'cravings'] as const
export type TileKey = (typeof TILE_KEYS)[number]

export function isTileKey(v: unknown): v is TileKey {
  return typeof v === 'string' && (TILE_KEYS as readonly string[]).includes(v)
}

const COLUMN: Record<TileKey, Prisma.Sql> = {
  impressions: Prisma.raw('tile_impressions_url'),
  moments: Prisma.raw('tile_moments_url'),
  cravings: Prisma.raw('tile_cravings_url'),
}

// 🔒 A newly picked (or automatic) tile photo must never leak an unrevealed
// blind wine. The SAFE SUBSET of the feed's redaction rule
// (lib/sessionFeedWines.ts): standalone, not blind, revealed, or a tombstoned
// moment. It deliberately skips the feed's host / wine-adder bypasses and the
// over-by-its-dates auto-reveal: over-redacting a tile photo costs nothing, a
// leaked label costs the tasting. Aliases: `w` = wines, `s` = sessions (LEFT
// JOINed on the rating's or wine's session).
const SAFE_PHOTO = Prisma.sql`(s.id IS NULL OR s.deleted_at IS NOT NULL OR s.blind IS NOT TRUE OR w.revealed_at IS NOT NULL)`

// Every pool yields (url, at): the photo and the recency it sorts by.
function pool(tile: TileKey, profileId: number, pick: boolean): Prisma.Sql {
  if (tile === 'impressions') return Prisma.sql`
    SELECT COALESCE(ri.image_url, w.image_url) AS url, r.rated_at AS at
    FROM ratings r
    JOIN wines w ON w.id = r.wine_id
    LEFT JOIN sessions s ON s.id = r.session_id
    LEFT JOIN LATERAL (
      SELECT image_url FROM rating_images WHERE rating_id = r.id ORDER BY sort_order ASC LIMIT 1
    ) ri ON true
    WHERE r.user_id = ${profileId}
      AND COALESCE(ri.image_url, w.image_url) IS NOT NULL
      ${pick ? Prisma.sql`AND ${SAFE_PHOTO}` : Prisma.empty}`
  if (tile === 'moments') return Prisma.sql`
    SELECT s.cover_photo_url AS url, sm.joined_at AS at
    FROM session_members sm
    JOIN sessions s ON s.code = sm.session_code
    WHERE sm.user_id = ${profileId} AND s.deleted_at IS NULL
      AND sm.removed_state IS DISTINCT FROM 'kicked'
      AND s.cover_photo_url IS NOT NULL`
  return Prisma.sql`
    SELECT w.image_url AS url, b.saved_at AS at
    FROM bookmarks b
    JOIN wines w ON w.id = b.wine_id
    LEFT JOIN sessions s ON s.id = w.session_id
    WHERE b.user_id = ${profileId}
      AND w.image_url IS NOT NULL
      ${pick ? Prisma.sql`AND ${SAFE_PHOTO}` : Prisma.empty}`
}

type Db = Pick<typeof prisma, '$queryRaw'> | Prisma.TransactionClient

async function inPool(db: Db, tile: TileKey, profileId: number, url: string, pick: boolean): Promise<boolean> {
  const rows = await db.$queryRaw<{ hit: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM (${pool(tile, profileId, pick)}) p WHERE p.url = ${url}) AS hit`
  return rows[0]?.hit === true
}

export const isPickable = (tile: TileKey, profileId: number, url: string) => inPool(prisma, tile, profileId, url, true)

// Step 1's automatic photo: the latest PICK photo.
async function autoLatest(tile: TileKey, profileId: number): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ url: string }[]>`
    SELECT url FROM (${pool(tile, profileId, true)}) p ORDER BY at DESC LIMIT 1`
  return rows[0]?.url ?? null
}

// The picker: the latest `limit` distinct PICK photos.
export async function listPickable(tile: TileKey, profileId: number, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ url: string }[]>`
    SELECT url FROM (${pool(tile, profileId, true)}) p
    GROUP BY url ORDER BY MAX(at) DESC LIMIT ${limit}`
  return rows.map(r => r.url)
}

export async function readPins(profileId: number): Promise<Record<TileKey, string | null>> {
  const rows = await prisma.$queryRaw<{ i: string | null; m: string | null; c: string | null }[]>`
    SELECT tile_impressions_url AS i, tile_moments_url AS m, tile_cravings_url AS c FROM users WHERE id = ${profileId}`
  const r = rows[0]
  return { impressions: r?.i ?? null, moments: r?.m ?? null, cravings: r?.c ?? null }
}

// A pin that read as dead: clear it under the users-row lock. The liveness
// re-check is a FRESH statement after the lock: under READ COMMITTED a single
// `UPDATE … AND NOT EXISTS (…)` re-checks only the users row after a lock wait
// and keeps its old snapshot of the other tables, so it could still erase a
// same-URL re-pick. Clears only if the pin is unchanged and still dead. The
// PATCH writes the pin unconditionally, so a re-pick that waited on this lock
// lands after the clear. Returns the pin to show when it turned out live.
async function clearDeadPin(tile: TileKey, profileId: number, dead: string): Promise<string | null> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ pin: string | null }[]>`
      SELECT ${COLUMN[tile]} AS pin FROM users WHERE id = ${profileId} FOR UPDATE`
    if (rows[0]?.pin !== dead) return null
    if (await inPool(tx, tile, profileId, dead, false)) return dead
    await tx.$executeRaw`UPDATE users SET ${COLUMN[tile]} = NULL WHERE id = ${profileId}`
    return null
  })
}

export type TilePhoto = { imageUrl: string | null; pinned: boolean }

// The pin read (every viewer): the pin while LIVE (no blind predicate, D3),
// else clear it and fall back to the automatic photo. Residual, accepted: a
// reversible removal (un-save, leave) undone before ANY profile read revives
// the pin; it leaks nothing beyond D3's re-hide rule, and a deleted source's
// URL never comes back (fresh keys per upload).
export async function resolveTilePhotos(profileId: number): Promise<Record<TileKey, TilePhoto>> {
  const pins = await readPins(profileId)
  const entries = await Promise.all(TILE_KEYS.map(async (tile): Promise<[TileKey, TilePhoto]> => {
    const pin = pins[tile]
    if (pin) {
      const live = (await inPool(prisma, tile, profileId, pin, false)) || (await clearDeadPin(tile, profileId, pin)) !== null
      if (live) return [tile, { imageUrl: pin, pinned: true }]
    }
    return [tile, { imageUrl: await autoLatest(tile, profileId), pinned: false }]
  }))
  return Object.fromEntries(entries) as Record<TileKey, TilePhoto>
}
