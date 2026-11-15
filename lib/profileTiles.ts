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
//     🔒 Never a cover whose URL carries the moment's code (`sessions/<code>_…`,
//     the create path until 2026-11-08 and the settings path until 2026-11-11):
//     the tile is served outside the moment and a code joins. A pin on one
//     reads as dead and is cleared, like any removed source.
//   - cravings: a bookmark whose wine has that image.
// - PICK = what may be newly chosen, and what the automatic photo draws from:
//   impressions + cravings = LIVE + SAFE_PHOTO (never an unrevealed blind
//   wine); moments = LIVE (a cover is never blind-redacted,
//   prisma/schema.prisma sessions.cover_photo_url).
// - OWN = a photo you took or chose on the phone for this tile (ruled
//   2026-11-12): uploaded through `POST /api/me/profile/tiles/<tile>` and
//   OWNED by the tile, unlike every other pin. Always live; reclaimed when the
//   tile changes or the account goes (lib/profileImage.ts,
//   lib/accountDelete.ts). 🔒 Recognised by the ROW, never the key (D2,
//   public-user-ids § 8): own ⇔ `tile_*_url = tile_*_own_url`, both written in
//   the same update and read under the same `FOR UPDATE`. A pin is a REFERENCE
//   that can point at a photo you don't own; without the owner binding a pin of
//   someone else's public tile URL followed by a replace would reclaim their
//   bytes. A URL match, not a boolean, because the previous release (still
//   serving during the rolling deploy) ignores the column: it can only make
//   the two unequal (at worst an orphan, never someone else's bytes).
//
// 🔒 The tile COUNTS are not computed here and never depend on these pools
// (lib/profileHeader.ts): the pools only decide photos.
//
// The catalog model change moves per-event image columns onto occurrences;
// these pools and SAFE_PHOTO move with it.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { cravingSessionIdSql, lineupHiddenNowSql } from '@/lib/outsideView'

export const TILE_KEYS = ['impressions', 'moments', 'cravings'] as const
export type TileKey = (typeof TILE_KEYS)[number]

export function isTileKey(v: unknown): v is TileKey {
  return typeof v === 'string' && (TILE_KEYS as readonly string[]).includes(v)
}

// ⚠️ LEGACY (drop once `scripts/rekey-user-images.mts` has run in prod, § 8):
// the key prefix today's own uploads were stored under, `avatars/tile_<tile>_
// u_<id>_…`. Until the re-key, such a URL still counts as own (the rule before
// tile_*_own_url, which the migration backfilled with exactly this test).
// Matched on the key part only, so it holds whatever S3 endpoint the URL was
// stored under.
export const LEGACY_OWN_TILE_PREFIX = true
export function isLegacyOwnTileUpload(url: string | null | undefined, tile: TileKey, userId: number): url is string {
  if (!url) return false
  const prefix = `/avatars/tile_${tile}_u_${userId}_`
  const at = url.indexOf(prefix)
  return at >= 0 && !url.slice(at + prefix.length).includes('/')
}

// own ⇔ the pin IS the tile's own upload (url = own_url), or (until the
// re-key) a legacy own key of this user and tile.
export function isOwnTile(url: string | null | undefined, ownUrl: string | null | undefined, tile: TileKey, userId: number): url is string {
  if (!url) return false
  if (url === ownUrl) return true
  return LEGACY_OWN_TILE_PREFIX && isLegacyOwnTileUpload(url, tile, userId)
}

export const OWN_COLUMN: Record<TileKey, Prisma.Sql> = {
  impressions: Prisma.raw('tile_impressions_own_url'),
  moments: Prisma.raw('tile_moments_own_url'),
  cravings: Prisma.raw('tile_cravings_own_url'),
}

const COLUMN: Record<TileKey, Prisma.Sql> = {
  impressions: Prisma.raw('tile_impressions_url'),
  moments: Prisma.raw('tile_moments_url'),
  cravings: Prisma.raw('tile_cravings_url'),
}

// 🔒 A newly picked (or automatic) tile photo must never leak an unrevealed
// blind bottle or a hidden line-up. A deliberately STRICTER SUBSET of the
// outside-a-moment rule (lib/outsideView.ts, lists plan D4), pinned beside
// it: standalone, or not blind / revealed / a tombstoned moment, AND the
// line-up not hidden right now for ANYONE (no host bypass). It skips the
// rule's host / bottle-adder bypasses and the over-by-its-dates auto-reveal:
// over-redacting a tile photo costs nothing, a leaked label costs the
// tasting. Aliases: `w` = wines, `s` = sessions (LEFT JOINed on the rating's
// or craving's moment).
export const SAFE_PHOTO = Prisma.sql`((s.id IS NULL OR s.deleted_at IS NOT NULL OR s.blind IS NOT TRUE OR w.revealed_at IS NOT NULL)
  AND NOT ${lineupHiddenNowSql('s')})`

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
      AND s.cover_photo_url IS NOT NULL
      AND strpos(s.cover_photo_url, 'sessions/' || s.code || '_') = 0`
  // A craving's moment: the bottle's own, else a session rating's (a banned
  // adder's bottles in a running moment lose wines.session_id). One whose
  // moment can't be found never gives a picked photo.
  return Prisma.sql`
    SELECT w.image_url AS url, b.saved_at AS at
    FROM bookmarks b
    JOIN wines w ON w.id = b.wine_id
    LEFT JOIN sessions s ON s.id = ${cravingSessionIdSql('w')}
    WHERE b.user_id = ${profileId}
      AND w.image_url IS NOT NULL
      ${pick ? Prisma.sql`AND s.id IS NOT NULL AND ${SAFE_PHOTO}` : Prisma.empty}`
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

export type Pin = { url: string | null; own: boolean }

export async function readPins(profileId: number): Promise<Record<TileKey, Pin>> {
  const rows = await prisma.$queryRaw<{ i: string | null; m: string | null; c: string | null; io: string | null; mo: string | null; co: string | null }[]>`
    SELECT tile_impressions_url AS i, tile_moments_url AS m, tile_cravings_url AS c,
           tile_impressions_own_url AS io, tile_moments_own_url AS mo, tile_cravings_own_url AS co
    FROM users WHERE id = ${profileId}`
  const r = rows[0]
  const pin = (tile: TileKey, url: string | null | undefined, own: string | null | undefined): Pin =>
    ({ url: url ?? null, own: isOwnTile(url, own, tile, profileId) })
  return { impressions: pin('impressions', r?.i, r?.io), moments: pin('moments', r?.m, r?.mo), cravings: pin('cravings', r?.c, r?.co) }
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
    const rows = await tx.$queryRaw<{ pin: string | null; own: string | null }[]>`
      SELECT ${COLUMN[tile]} AS pin, ${OWN_COLUMN[tile]} AS own FROM users WHERE id = ${profileId} FOR UPDATE`
    if (rows[0]?.pin !== dead) return null
    // Own under the lock (an own upload landed since the read): live, keep it.
    if (isOwnTile(dead, rows[0].own, tile, profileId)) return dead
    if (await inPool(tx, tile, profileId, dead, false)) return dead
    await tx.$executeRaw`UPDATE users SET ${COLUMN[tile]} = NULL WHERE id = ${profileId}`
    return null
  })
}

export type TilePhoto = { imageUrl: string | null; pinned: boolean }

// The pin read (every viewer): your own upload, or the pin while LIVE (no
// blind predicate, D3), else clear it and fall back to the automatic photo. Residual, accepted: a
// reversible removal (un-save, leave) undone before ANY profile read revives
// the pin; it leaks nothing beyond D3's re-hide rule, and a deleted source's
// URL never comes back (fresh keys per upload).
//
// `tiles` is REQUIRED (no "all" default) and the result holds only those
// keys: a tile hidden from the viewer (lib/profileHeader.ts) is never
// requested, so its photo query never runs and its stored pin is kept.
export async function resolveTilePhotos(profileId: number, tiles: readonly TileKey[]): Promise<Partial<Record<TileKey, TilePhoto>>> {
  if (tiles.length === 0) return {}
  const pins = await readPins(profileId)
  const entries = await Promise.all(tiles.map(async (tile): Promise<[TileKey, TilePhoto]> => {
    const { url: pin, own } = pins[tile]
    if (pin) {
      const live = own || (await inPool(prisma, tile, profileId, pin, false)) || (await clearDeadPin(tile, profileId, pin)) !== null
      if (live) return [tile, { imageUrl: pin, pinned: true }]
    }
    return [tile, { imageUrl: await autoLatest(tile, profileId), pinned: false }]
  }))
  return Object.fromEntries(entries)
}
