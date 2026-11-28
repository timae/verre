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
//   - cravings: a craving whose source bottle has that image.
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
import { lineupHiddenNowSql, cravingSessionIdSql } from '@/lib/outsideView'
import { onlyInsideSql } from '@/lib/postPrivacy'
import { ownerCravingsSql, ownerWasThereSql, SAVE_MOMENT } from '@/lib/cravings'
import { sharedMomentSql } from '@/lib/momentAudience'
import { momentLookInEnabled } from '@/lib/momentGate'

export const TILE_KEYS = ['impressions', 'moments', 'cravings'] as const
export type TileKey = (typeof TILE_KEYS)[number]

export function isTileKey(v: unknown): v is TileKey {
  return typeof v === 'string' && (TILE_KEYS as readonly string[]).includes(v)
}

// own ⇔ the pin IS the tile's own upload: url = own_url (both written in the
// same update, read under the same lock), never the key.
export function isOwnTile(url: string | null | undefined, ownUrl: string | null | undefined): url is string {
  return !!url && url === ownUrl
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

// 🔒 A cover whose URL carries the moment's code (`sessions/<code>_…`, the
// create path until 2026-11-08 and the settings path until 2026-11-11): a code
// joins, so it is never served outside the moment. ONE predicate for the tile
// pools, the look-in and someone's Moments' open rows (step-1 plan C4). Alias
// `s` = a LIVE sessions row (its code is set).
export function legacyCoverSql(sName: 's'): Prisma.Sql {
  return Prisma.sql`strpos(${Prisma.raw(sName)}.cover_photo_url, 'sessions/' || ${Prisma.raw(sName)}.code || '_') > 0`
}
// The cover as it may be shown outside the moment: NULL for a code-bearing one,
// and NULL when the predicate can't be evaluated (fails closed).
export function coverOutsideSql(sName: 's'): Prisma.Sql {
  return Prisma.sql`CASE WHEN NOT (${legacyCoverSql(sName)}) THEN ${Prisma.raw(sName)}.cover_photo_url END`
}

// Every pool yields (url, at): the photo and the recency it sorts by. Three
// modes: PICK (the picker and the automatic photo: safe for every visitor),
// LIVE (a pin's reference still exists: only ever clears a pin), SHOWN (a live
// pin as anyone but the owner may see it).
// 🔒 Only Inside This Moment (Moment Visibility step 3, T7): a tile is shown
// to every visitor, so PICK and SHOWN leave out the photos of the owner's
// Only Inside moments (Impressions: the moment's wine photo, their own rating
// photos stay; Moments: the cover; Cravings: the bottle of a craving from
// one). LIVE keeps them: the pin stays stored and shows to its owner, and
// turning the switch off brings it back. Not behind the flag (T1).
// `sharedWith` (the moments PICK pool for someone else's automatic cover only,
// T12): only moments that viewer is in; null = nobody's.
type PoolMode = 'pick' | 'live' | 'shown'
function pool(tile: TileKey, profileId: number, mode: PoolMode, sharedWith?: number | null): Prisma.Sql {
  const owner = Prisma.sql`${profileId}::integer`
  if (tile === 'impressions') {
    const winePhoto = mode === 'live' ? Prisma.sql`w.image_url`
      : Prisma.sql`CASE WHEN NOT ${onlyInsideSql(owner, Prisma.sql`r.session_id`)} THEN w.image_url END`
    return Prisma.sql`
    SELECT COALESCE(ri.image_url, ${winePhoto}) AS url, r.rated_at AS at
    FROM ratings r
    JOIN wines w ON w.id = r.wine_id
    LEFT JOIN sessions s ON s.id = r.session_id
    LEFT JOIN LATERAL (
      SELECT image_url FROM rating_images WHERE rating_id = r.id ORDER BY sort_order ASC LIMIT 1
    ) ri ON true
    WHERE r.user_id = ${profileId}
      AND COALESCE(ri.image_url, ${winePhoto}) IS NOT NULL
      ${mode === 'pick' ? Prisma.sql`AND ${SAFE_PHOTO}` : Prisma.empty}`
  }
  if (tile === 'moments') return Prisma.sql`
    SELECT s.cover_photo_url AS url, sm.joined_at AS at
    FROM session_members sm
    JOIN sessions s ON s.code = sm.session_code
    WHERE sm.user_id = ${profileId} AND s.deleted_at IS NULL
      AND sm.removed_state IS DISTINCT FROM 'kicked'
      AND s.cover_photo_url IS NOT NULL
      AND NOT (${legacyCoverSql('s')})
      ${mode === 'live' ? Prisma.empty : Prisma.sql`AND NOT ${onlyInsideSql(owner, Prisma.sql`s.id`)}`}
      ${sharedWith === undefined ? Prisma.empty : sharedWith === null ? Prisma.sql`AND FALSE` : Prisma.sql`AND ${sharedMomentSql(sharedWith)}`}`
  // A craving's photo is its bottle's (lib/cravings.ts: the owner's shown set,
  // real cravings and the blind saves that count as one). A source-less craving
  // gives none. A picked photo (shown to every visitor) also needs a moment that
  // can be found, unless the bottle is a check-in's, and one the owner was IN:
  // a bottle saved from someone else's post shows only to people who may see
  // that post (ruled 2026-11-20), which a tile cannot tell.
  // LIVE (a pin's reference still exists): every real craving and every blind
  // save of that photo, whatever their state (review r2: a pin picked from a
  // matured blind save must not read as dead), as before: a pin is not cleared
  // because its craving is hidden for a while.
  // SHOWN: the same, minus a craving whose moment (lib/outsideView.ts
  // cravingSessionIdSql, a blind save's SAVE_MOMENT) is an Only Inside one.
  if (mode !== 'pick') return Prisma.sql`
    SELECT w.image_url AS url, b.saved_at AS at
    FROM bookmarks b JOIN wines w ON w.id = b.wine_id
    WHERE b.user_id = ${profileId} AND w.image_url IS NOT NULL
      ${mode === 'shown' ? Prisma.sql`AND NOT ${onlyInsideSql(owner, cravingSessionIdSql('b', 'w'))}` : Prisma.empty}
    UNION ALL
    SELECT w.image_url, bs.saved_at
    FROM blind_saves bs JOIN wines w ON w.id = bs.wine_id
    WHERE bs.user_id = ${profileId} AND w.image_url IS NOT NULL
      ${mode === 'shown' ? Prisma.sql`AND NOT ${onlyInsideSql(owner, SAVE_MOMENT)}` : Prisma.empty}`
  return Prisma.sql`
    SELECT w.image_url AS url, oc.saved_at AS at
    FROM (${ownerCravingsSql(profileId)}) oc
    JOIN wines w ON w.id = oc.wine_id
    LEFT JOIN sessions s ON s.id = oc.sid
    WHERE w.image_url IS NOT NULL
      AND (s.id IS NOT NULL OR w.origin = 'standalone') AND ${SAFE_PHOTO} AND ${ownerWasThereSql(profileId)}
      AND NOT ${onlyInsideSql(owner, Prisma.sql`oc.sid`)}`
}

type Db = Pick<typeof prisma, '$queryRaw'> | Prisma.TransactionClient

async function inPool(db: Db, tile: TileKey, profileId: number, url: string, mode: PoolMode): Promise<boolean> {
  const rows = await db.$queryRaw<{ hit: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM (${pool(tile, profileId, mode)}) p WHERE p.url = ${url}) AS hit`
  return rows[0]?.hit === true
}

// A pin's LIVE and SHOWN in ONE statement (a visitor's header read, every
// pinned tile; the owner needs only LIVE).
async function pinState(tile: TileKey, profileId: number, url: string): Promise<{ live: boolean; shown: boolean }> {
  const rows = await prisma.$queryRaw<{ live: boolean; shown: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM (${pool(tile, profileId, 'live')}) p WHERE p.url = ${url}) AS live,
           EXISTS (SELECT 1 FROM (${pool(tile, profileId, 'shown')}) p WHERE p.url = ${url}) AS shown`
  return { live: rows[0]?.live === true, shown: rows[0]?.shown === true }
}

export const isPickable = (tile: TileKey, profileId: number, url: string) => inPool(prisma, tile, profileId, url, 'pick')

// Step 1's automatic photo: the latest PICK photo. For someone else's Moments
// tile (Moment Visibility on, T12) only from the moments the viewer is in: an
// open moment's cover never feeds it (one cheap condition on a hot read).
async function autoLatest(tile: TileKey, profileId: number, sharedWith?: number | null): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ url: string }[]>`
    SELECT url FROM (${pool(tile, profileId, 'pick', tile === 'moments' ? sharedWith : undefined)}) p ORDER BY at DESC LIMIT 1`
  return rows[0]?.url ?? null
}

// The picker: the latest `limit` distinct PICK photos.
export async function listPickable(tile: TileKey, profileId: number, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ url: string }[]>`
    SELECT url FROM (${pool(tile, profileId, 'pick')}) p
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
  const pin = (url: string | null | undefined, own: string | null | undefined): Pin => ({ url: url ?? null, own: isOwnTile(url, own) })
  return { impressions: pin(r?.i, r?.io), moments: pin(r?.m, r?.mo), cravings: pin(r?.c, r?.co) }
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
    if (isOwnTile(dead, rows[0].own)) return dead
    // 🔒 LIVE, never SHOWN: an Only Inside switch never clears a pin.
    if (await inPool(tx, tile, profileId, dead, 'live')) return dead
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
// `viewerId` is who is looking (null = signed out). 🔒 It restricts the
// AUTOMATIC Moments cover only (T12, Moment Visibility on, someone else's
// profile): the pin's liveness and the owner's picker keep the full pool, or a
// stranger's view would read the owner's pin as dead and erase it for everyone.
export async function resolveTilePhotos(profileId: number, tiles: readonly TileKey[], viewerId: number | null): Promise<Partial<Record<TileKey, TilePhoto>>> {
  if (tiles.length === 0) return {}
  const sharedWith = viewerId === profileId || !momentLookInEnabled() ? undefined : viewerId
  const pins = await readPins(profileId)
  const entries = await Promise.all(tiles.map(async (tile): Promise<[TileKey, TilePhoto]> => {
    const { url: pin, own } = pins[tile]
    if (pin) {
      // 🔒 Anyone but the owner (signed out included) sees a pin only while
      // it is SHOWN (not a photo of the owner's Only Inside moments); the
      // automatic photo instead. Whatever the flag says (T1). A pin that
      // reads dead is cleared on LIVE only (clearDeadPin), never on SHOWN.
      if (own) return [tile, { imageUrl: pin, pinned: true }]
      const owner = viewerId === profileId
      const state = owner ? { live: await inPool(prisma, tile, profileId, pin, 'live'), shown: true } : await pinState(tile, profileId, pin)
      // A pin that read dead but is live under clearDeadPin's lock has no
      // SHOWN answer from this read: this one visitor read gets the automatic
      // photo (the safe side, transient; the next read decides; recheck
      // 2026-11-24, accepted).
      const live = state.live || (await clearDeadPin(tile, profileId, pin)) !== null
      if (live && state.shown) return [tile, { imageUrl: pin, pinned: true }]
    }
    return [tile, { imageUrl: await autoLatest(tile, profileId, sharedWith), pinned: false }]
  }))
  return Object.fromEntries(entries)
}
