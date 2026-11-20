// ── cravings: THE craving rules (catalogue model change § 5) ────────────────
//
// One craving per (user, wine, vintage) (`bookmarks_user_product_vintage_key`),
// remembering where it was first craved (its SOURCE bottle `wine_id`, its
// moment `source_session_id`, and the post it came from `source_item_id`).
// Every read of someone's cravings and every save write goes through here:
//
//   • A craving is HIDDEN while its source is hidden for its owner (the outside
//     rule, lib/outsideView.ts: the moment's line-up hidden, or the source bottle
//     redacted): left out of Cravings, Saved, their counts, the badges and every
//     wine-level `saved` flag, for the owner and for anyone looking at the
//     owner's list. A source bottle that is GONE was decided at its delete (only
//     cravings visible to their owner are kept, R1), so only the moment term
//     applies to it.
//   • A save on a bottle HIDDEN FOR THE CALLER (the moment's live rule, or the
//     outside rule on a post) is a save of THAT BOTTLE (ruled 2026-11-20, R2): a
//     `blind_saves` row, the bottle's own button state, and 🔒 NOTHING ELSE while
//     the bottle is hidden for its saver (review r1: storing a craving only when
//     the wine was not craved yet made the bookmarks id an oracle, and a craving
//     shared by two blind saves named one bottle at the other's reveal). The
//     answer is the same whatever the wine. Once its bottle is no longer hidden
//     for the saver, a blind save COUNTS AS A CRAVING of that bottle's wine
//     (`ownerCravingsSql`: every list reads both, one row per wine, a real
//     craving first, else the earliest such save).
//   • A crave from a place visible to the owner RE-POINTS a real craving whose
//     source is hidden for them: DELETE + INSERT (new id, saved_at now, a fresh
//     snapshot), so answer, count, position and date match a fresh craving.
//   • A bottle DELETE turns its blind saves that already count as cravings into
//     real cravings, detaches the cravings visible to their owner (the bottle
//     cleared, the moment KEPT, R1), and lets the still-hidden ones go with it
//     (the keys' CASCADE, unchanged, so an old instance behaves as before).
//   • A RE-LINK carries every real craving sourced from the bottle to the new
//     wine (R3); a blind save reads its bottle's wine live, so it follows too. A
//     collision keeps the visible row, else the earlier saved_at.
//   • Matching two links follows merges (lib/catalogEntries.ts).
//
// Writes for one user serialise on an advisory lock ('cravings:<user id>'),
// always taken AFTER any session lock and any bottle / moment row lock (never
// one of those under it).

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { cravingSessionIdSql, hiddenSql, redactedSql, type Viewer } from '@/lib/outsideView'
import {
  effectiveProductSql, effectiveVintageSql, entryKey, linkableLink, loadEntries, productAliasesSql, snapshotFromEntry, tombstoneMapSql,
} from '@/lib/catalogEntries'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

export const NOT_IN_CATALOGUE = "This bottle isn't in the catalogue yet"

// ONE budget for every save and unsave, in a moment and from a post (ruled
// 2026-11-20: a generous backstop; app/api/rate-limits.md). Charged after each
// route's gates, so a probe of a moment or post it may not see costs nothing.
export const SAVE_LIMIT = { key: (userId: number) => `rl:crave:user:${userId}:1h`, limit: 300, windowSec: 3600 }

// A bottle's moment: its own, else a session rating's (a banned adder's bottle
// in a running moment loses `wines.session_id`). Alias `w`.
const BOTTLE_MOMENT = (w: string) => Prisma.sql`COALESCE(${Prisma.raw(w)}.session_id, (
  SELECT bmr.session_id FROM ratings bmr WHERE bmr.wine_id = ${Prisma.raw(w)}.id AND bmr.session_id IS NOT NULL LIMIT 1))`

// A blind save's moment (alias bs, its bottle w): the one it stores first, as a
// craving does (an orphaned, unrated bottle keeps it).
export const SAVE_MOMENT = Prisma.sql`COALESCE(bs.session_id, ${BOTTLE_MOMENT('w')})`

// A craving's product / vintage as EVERY matcher reads it (review r4: one
// definition): its own link, else, for a craving with no link of a LINKED bottle
// (an old instance's save during the rolling deploy), its bottle's. Aliases b / w.
const CRAVING_PRODUCT = Prisma.sql`COALESCE(b.product_id, w.product_id)`
const CRAVING_VINTAGE = Prisma.sql`(CASE WHEN b.product_id IS NULL THEN w.vintage_id ELSE b.vintage_id END)`

// b = the craving, w = its source bottle (gone → NULL), s = its moment.
export const CRAVING_FROM = Prisma.sql`bookmarks b
  LEFT JOIN wines w ON w.id = b.wine_id
  LEFT JOIN sessions s ON s.id = ${cravingSessionIdSql('b', 'w')}`

// Hidden for this viewer (a user id, NULL, or a column such as b.user_id), on
// the row's source bottle `w` and moment `s`.
export function cravingHiddenSql(viewer: Viewer): Prisma.Sql {
  return Prisma.sql`(${hiddenSql(viewer, 's')} OR (w.id IS NOT NULL AND ${redactedSql(viewer, 's', 'w')}))`
}

// On someone else's view of the owner's list (aliases w / s of the row): never
// one hidden for the viewer, nor a legacy craving whose moment cannot be found
// (a session bottle with no moment: nothing could tell whether its label is
// hidden, D6). A source-less craving (its bottle deleted, R1: everyone) shows.
export function viewerSeesSql(viewerId: number | null): Prisma.Sql {
  return Prisma.sql`(NOT ${cravingHiddenSql(viewerId)}
    AND NOT (w.id IS NOT NULL AND w.origin IS DISTINCT FROM 'standalone' AND s.id IS NULL))`
}

// Was the OWNER in this row's moment: a save made IN the moment (`from_post`
// false: the save route admits participants only), or a member (not kicked) or
// a rater of it, or its source is their own check-in? A row they were not in (saved from someone
// else's post) shows its bottle's photo and id on their lists only to a viewer
// who may see that post (ruled 2026-11-20; the caller checks the post's author).
// `fromPost`: the row's own flag (a save made in the moment was a participant's,
// whatever later happened to the moment's member rows: a deleted moment drops
// them, review r3).
export function ownerWasThereSql(ownerId: number, fromPost: Prisma.Sql = Prisma.sql`oc.from_post`): Prisma.Sql {
  return Prisma.sql`(NOT COALESCE(${fromPost}, true) OR CASE WHEN s.id IS NOT NULL THEN (
      EXISTS (SELECT 1 FROM session_members owm WHERE owm.session_code = s.code AND owm.user_id = ${ownerId} AND owm.removed_state IS DISTINCT FROM 'kicked')
      OR EXISTS (SELECT 1 FROM ratings owr WHERE owr.session_id = s.id AND owr.user_id = ${ownerId}))
    ELSE (w.id IS NOT NULL AND EXISTS (SELECT 1 FROM ratings owr WHERE owr.wine_id = w.id AND owr.user_id = ${ownerId})) END)`
}

// ── The owner's cravings, as one set ────────────────────────────────────────
//
// A SELECT of the owner's cravings that are SHOWN to the owner: their real
// cravings not hidden for them, and their blind saves whose (linked) bottle is
// no longer hidden for them; ONE row per wine (effective product + vintage,
// merges followed by one tombstone walk), a real craving first, else the
// earliest save. Columns: kind ('c' craving | 'm' blind save), id, sk (the
// list's tiebreak: 2·id, 2·id+1 for a blind save), wine_id (its bottle, NULL for
// a craving whose bottle is gone), product_id / vintage_id (stored), ep / ev
// (effective), saved_at, name / producer / vintage (a craving's snapshot), sid
// (its moment), item_id (the post it came from). `products` narrows it to these
// effective products (an index-served alias set).
export function ownerCravingsSql(ownerId: number, opts: { products?: string[] } = {}): Prisma.Sql {
  const only = (col: string) => (opts.products
    ? Prisma.sql`AND ${Prisma.raw(col)} IN (${productAliasesSql(Prisma.sql`${opts.products}::text[]`)})`
    : Prisma.empty)
  return Prisma.sql`SELECT DISTINCT ON (COALESCE(k.ep, 'u' || k.id::text), k.ev) k.* FROM (
      WITH r0 AS MATERIALIZED (
          -- A craving with no link of a LINKED bottle (an old instance's save
          -- during the rolling deploy) reads as that bottle's wine (review r3).
          SELECT 'c'::text AS kind, b.id, (b.id::bigint * 2) AS sk, b.wine_id,
                 ${CRAVING_PRODUCT} AS product_id, ${CRAVING_VINTAGE} AS vintage_id, b.saved_at,
                 b.name, b.producer, b.vintage, s.id AS sid, b.source_item_id AS item_id, b.from_post
            FROM ${CRAVING_FROM}
           WHERE b.user_id = ${ownerId} AND NOT ${cravingHiddenSql(ownerId)} ${only('COALESCE(b.product_id, w.product_id)')}
          UNION ALL
          SELECT 'm', bs.id, (bs.id::bigint * 2 + 1), bs.wine_id, w.product_id, w.vintage_id, bs.saved_at,
                 NULL, NULL, NULL, s.id, bs.item_id, bs.from_post
            FROM blind_saves bs
            JOIN wines w ON w.id = bs.wine_id
            LEFT JOIN sessions s ON s.id = ${SAVE_MOMENT}
           WHERE bs.user_id = ${ownerId} AND w.product_id IS NOT NULL AND NOT ${cravingHiddenSql(ownerId)} ${only('w.product_id')}
      )
      SELECT r.*, COALESCE(ocp.eff, r.product_id) AS ep,
             CASE WHEN r.vintage_id IS NULL THEN NULL ELSE COALESCE(ocv.eff, r.vintage_id) END AS ev
        FROM r0 r
        -- the walk seeded by THESE rows' ids only (narrowed with the rows)
        LEFT JOIN (${tombstoneMapSql('wine_products', Prisma.sql`SELECT DISTINCT product_id FROM r0`)}) ocp
          ON ocp.id = r.product_id
        LEFT JOIN (${tombstoneMapSql('wine_vintages', Prisma.sql`SELECT DISTINCT vintage_id FROM r0 WHERE vintage_id IS NOT NULL`)}) ocv
          ON ocv.id = r.vintage_id
    ) k
    ORDER BY COALESCE(k.ep, 'u' || k.id::text), k.ev, (k.kind = 'c') DESC, k.saved_at, k.sk`
}

// Badges count the shown cravings (§ 5: a hidden one counts after its reveal).
export async function visibleCravingCount(userId: number, db: Db = prisma): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM (${ownerCravingsSql(userId)}) oc`
  return rows[0]?.n ?? 0
}

// Exported for the purge's reference clearing (lib/catalogWrite.ts), which
// rewrites many people's cravings: their locks, sorted, so a crave racing the
// purge waits instead of tripping the one-per-wine unique.
export async function lockCravings(tx: Tx, userIds: number[]): Promise<void> {
  for (const u of [...new Set(userIds)].sort((a, b) => a - b)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cravings:${u}`}))`
  }
}

type Bottle = { id: string; productId: string | null; vintageId: string | null; sessionId: number | null }
async function bottleOf(tx: Tx, wineId: string): Promise<Bottle | null> {
  const r = (await tx.$queryRaw<{ id: string; product_id: string | null; vintage_id: string | null; session_id: number | null }[]>`
    SELECT w.id, w.product_id, w.vintage_id, ${BOTTLE_MOMENT('w')} AS session_id FROM wines w WHERE w.id = ${wineId}`)[0]
  return r ? { id: r.id, productId: r.product_id, vintageId: r.vintage_id, sessionId: r.session_id } : null
}
const linkOf = (b: Bottle) => (b.productId ? { productId: b.productId, vintageId: b.vintageId } : null)

// The bottle's effective (product, vintage): one statement.
async function effectiveOf(tx: Tx, link: { productId: string; vintageId: string | null }): Promise<{ p: string; v: string | null }> {
  const r = (await tx.$queryRaw<{ p: string; v: string | null }[]>`
    SELECT ${effectiveProductSql(Prisma.sql`${link.productId}::text`)} AS p, ${effectiveVintageSql(Prisma.sql`${link.vintageId}::text`)} AS v`)[0]
  return { p: r?.p ?? link.productId, v: r?.v ?? null }
}

// The rows of the owner's SHOWN set that are this wine (real cravings and
// blind saves that count as one).
async function shownOfWine(tx: Tx, userId: number, link: { productId: string; vintageId: string | null }) {
  const e = await effectiveOf(tx, link)
  return tx.$queryRaw<{ kind: string; id: number }[]>`
    SELECT oc.kind, oc.id FROM (${ownerCravingsSql(userId, { products: [e.p] })}) oc
     WHERE oc.ep = ${e.p} AND oc.ev IS NOT DISTINCT FROM ${e.v}::text`
}
// EVERY shown row of this wine, not only the one the list shows (a real
// craving AND the blind saves that count as one): an unsave removes them all.
async function allShownOfWine(tx: Tx, userId: number, link: { productId: string; vintageId: string | null }) {
  const e = await effectiveOf(tx, link)
  return tx.$queryRaw<{ kind: string; id: number }[]>`
    SELECT 'c' AS kind, b.id FROM ${CRAVING_FROM}
     WHERE b.user_id = ${userId} AND NOT ${cravingHiddenSql(userId)}
       AND ${CRAVING_PRODUCT} IN (${productAliasesSql(Prisma.sql`ARRAY[${e.p}]::text[]`)})
       AND ${effectiveProductSql(CRAVING_PRODUCT)} = ${e.p} AND ${effectiveVintageSql(CRAVING_VINTAGE)} IS NOT DISTINCT FROM ${e.v}::text
    UNION ALL
    SELECT 'm', bs.id FROM blind_saves bs JOIN wines w ON w.id = bs.wine_id LEFT JOIN sessions s ON s.id = ${SAVE_MOMENT}
     WHERE bs.user_id = ${userId} AND NOT ${cravingHiddenSql(userId)}
       AND w.product_id IN (${productAliasesSql(Prisma.sql`ARRAY[${e.p}]::text[]`)})
       AND ${effectiveProductSql(Prisma.sql`w.product_id`)} = ${e.p} AND ${effectiveVintageSql(Prisma.sql`w.vintage_id`)} IS NOT DISTINCT FROM ${e.v}::text`
}
// The user's REAL cravings of this wine, each with its hidden flag for them.
type Real = { id: number; wine_id: string | null; saved_at: Date; hidden: boolean }
async function realOfWine(tx: Tx, userId: number, link: { productId: string; vintageId: string | null }): Promise<Real[]> {
  const e = await effectiveOf(tx, link)
  return tx.$queryRaw<Real[]>`
    SELECT b.id, b.wine_id, b.saved_at, ${cravingHiddenSql(userId)} AS hidden
      FROM ${CRAVING_FROM}
     WHERE b.user_id = ${userId}
       AND ${CRAVING_PRODUCT} IN (${productAliasesSql(Prisma.sql`ARRAY[${e.p}]::text[]`)})
       AND ${effectiveVintageSql(CRAVING_VINTAGE)} IS NOT DISTINCT FROM ${e.v}::text
     ORDER BY b.saved_at, b.id`
}

// The pair a craving of this bottle stores: the LINKABLE one (merges followed:
// the survivor; lib/catalogEntries.ts) when it is still the bottle's own wine,
// else the bottle's own pair (Codex r1: after a product merge, a year that
// exists only under the merged-away product gave the survivor's product grain,
// another wine than the bottle, so the bottle never matched its own save).
// Every matcher resolves the stored pair, so both read as the bottle. null =
// not a wine anyone may crave.
async function cravingLink(tx: Tx, link: { productId: string; vintageId: string | null }): Promise<{ productId: string; vintageId: string | null } | null> {
  const l = await linkableLink(link, tx)
  if (!l) return null
  const e = await effectiveOf(tx, link)
  return l.productId === e.p && l.vintageId === e.v ? l : link
}

// A fresh craving of this bottle's wine. The stored link is `cravingLink`'s,
// the snapshot the entry's (§ 5a: a purged craving still renders). `source` =
// its bottle (null when the bottle is being deleted: R1 keeps the moment), `at`
// its date.
async function insertCraving(tx: Tx, userId: number, b: Bottle, o: { source: string | null; itemId: number | null; fromPost: boolean; at?: Date }): Promise<number | null> {
  const link = b.productId ? await cravingLink(tx, { productId: b.productId, vintageId: b.vintageId }) : null
  if (!link) return null
  const e = (await loadEntries([link], tx)).get(entryKey(link.productId, link.vintageId))
  const snap = e ? snapshotFromEntry(e) : null
  const rows = await tx.$queryRaw<{ id: number }[]>`
    INSERT INTO bookmarks (user_id, wine_id, product_id, vintage_id, name, producer, vintage, source_session_id, source_item_id, from_post, saved_at)
    VALUES (${userId}, ${o.source}, ${link.productId}, ${link.vintageId}, ${snap ? snap.name.slice(0, 255) : null},
            ${snap ? snap.producer.slice(0, 255) : null}, ${snap?.vintage ? snap.vintage.slice(0, 4) : null}, ${b.sessionId}, ${o.itemId},
            ${o.fromPost}, ${o.at ?? new Date()})
    ON CONFLICT DO NOTHING RETURNING id`
  return rows[0]?.id ?? null
}

// Is this bottle visible to this user OUTSIDE its moment (the place a re-point
// would move a craving to)? A check-in's bottle has no moment: visible.
async function placeVisibleFor(tx: Tx, userId: number, wineId: string): Promise<boolean> {
  const r = (await tx.$queryRaw<{ v: boolean | null }[]>`
    SELECT NOT (${hiddenSql(userId, 's')} OR ${redactedSql(userId, 's', 'w')}) AS v
      FROM wines w LEFT JOIN sessions s ON s.id = ${BOTTLE_MOMENT('w')}
     WHERE w.id = ${wineId}`)[0]
  return r?.v === true
}

export type SaveOutcome = 'saved' | 'unsaved' | 'not-in-catalogue' | 'gone'

// A save of one bottle. `hidden` = the bottle is hidden for this caller on the
// surface the save came from (decided by the caller, under its locks, BEFORE
// any other refusal). `itemId` = the post it came from (none in the moment).
export async function saveBottle(tx: Tx, userId: number, wineId: string, hidden: boolean, itemId: number | null = null): Promise<SaveOutcome> {
  await lockCravings(tx, [userId])
  const b = await bottleOf(tx, wineId)
  if (!b) return 'gone'
  if (hidden) {
    // 🔒 The same work whatever the wine: one row, nothing read about the link.
    await tx.$executeRaw`INSERT INTO blind_saves (user_id, wine_id, session_id, item_id, from_post) VALUES (${userId}, ${wineId}, ${b.sessionId}, ${itemId}, ${itemId !== null}) ON CONFLICT (user_id, wine_id) DO NOTHING`
    return 'saved'
  }
  // A craving with no catalogue link of this very bottle (legacy, or an old
  // instance's save) is already a save (idempotent), linked bottle or not.
  if ((await tx.$queryRaw<{ id: number }[]>`SELECT id FROM bookmarks WHERE user_id = ${userId} AND wine_id = ${wineId} AND product_id IS NULL`).length) return 'saved'
  const link = linkOf(b)
  if (!link || !(await linkableLink(link, tx))) return 'not-in-catalogue'
  if ((await shownOfWine(tx, userId, link)).length) return 'saved'
  const hiddenReal = await realOfWine(tx, userId, link)
  if (hiddenReal.length) {
    // Only hidden ones: re-point, if this place shows outside (the cohost
    // residual: a place hidden outside too would only churn ids).
    if (!(await placeVisibleFor(tx, userId, wineId))) return 'saved'
    await tx.$executeRaw`DELETE FROM bookmarks WHERE id = ANY(${hiddenReal.map(f => f.id)}::int[])`
  }
  await insertCraving(tx, userId, b, { source: wineId, itemId, fromPost: itemId !== null })
  return 'saved'
}

// An unsave of one bottle. Hidden: only this bottle's save. Visible: the wine
// as the button shows it (every shown row of it, and this bottle's own save);
// an unlinked bottle: its legacy craving.
export async function unsaveBottle(tx: Tx, userId: number, wineId: string, hidden: boolean): Promise<SaveOutcome> {
  await lockCravings(tx, [userId])
  await tx.$executeRaw`DELETE FROM blind_saves WHERE user_id = ${userId} AND wine_id = ${wineId}`
  if (hidden) return 'unsaved'
  await tx.$executeRaw`
    DELETE FROM bookmarks WHERE id IN (SELECT b.id FROM ${CRAVING_FROM}
      WHERE b.user_id = ${userId} AND b.wine_id = ${wineId} AND b.product_id IS NULL AND NOT ${cravingHiddenSql(userId)})`
  const b = await bottleOf(tx, wineId)
  const link = b ? linkOf(b) : null
  if (!link) return 'unsaved'
  await dropShown(tx, await allShownOfWine(tx, userId, link))
  return 'unsaved'
}
async function dropShown(tx: Tx, rows: { kind: string; id: number }[]): Promise<void> {
  const c = rows.filter(r => r.kind === 'c').map(r => r.id)
  const m = rows.filter(r => r.kind === 'm').map(r => r.id)
  if (c.length) await tx.$executeRaw`DELETE FROM bookmarks WHERE id = ANY(${c}::int[])`
  if (m.length) await tx.$executeRaw`DELETE FROM blind_saves WHERE id = ANY(${m}::int[])`
}

// A list row's remove key: a craving's id, or 'm' + a blind save's id.
export type CravingKey = { kind: 'c' | 'm'; id: number }
export const cravingKey = (kind: string, id: number): string => (kind === 'm' ? `m${id}` : String(id))
export function parseCravingKey(raw: string | undefined | null): CravingKey | null {
  if (!raw) return null
  const m = /^(m?)([1-9][0-9]{0,9})$/.exec(raw)
  if (!m) return null
  const id = Number(m[2])
  return id <= 2_147_483_647 ? { kind: m[1] ? 'm' : 'c', id } : null
}

// DELETE /api/me/bookmarks/[key]: one of the owner's SHOWN cravings, and with
// it the rest of that wine as the list shows it (a real craving and the blind
// saves that count as one), so the wine leaves the list. A hidden one is not on
// any list: the same 404 as a missing key.
export async function removeCraving(userId: number, key: CravingKey): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockCravings(tx, [userId])
    const row = key.kind === 'c'
      ? (await tx.$queryRaw<{ product_id: string | null; vintage_id: string | null }[]>`
          SELECT ${CRAVING_PRODUCT} AS product_id, ${CRAVING_VINTAGE} AS vintage_id FROM ${CRAVING_FROM}
           WHERE b.id = ${key.id} AND b.user_id = ${userId} AND NOT ${cravingHiddenSql(userId)}`)[0]
      : (await tx.$queryRaw<{ product_id: string | null; vintage_id: string | null }[]>`
          SELECT w.product_id, w.vintage_id FROM blind_saves bs JOIN wines w ON w.id = bs.wine_id LEFT JOIN sessions s ON s.id = ${SAVE_MOMENT}
           WHERE bs.id = ${key.id} AND bs.user_id = ${userId} AND w.product_id IS NOT NULL AND NOT ${cravingHiddenSql(userId)}`)[0]
    if (!row) return false
    if (!row.product_id) { await tx.$executeRaw`DELETE FROM bookmarks WHERE id = ${key.id}`; return true }
    await dropShown(tx, await allShownOfWine(tx, userId, { productId: row.product_id, vintageId: row.vintage_id }))
    return true
  })
}

async function ownersOf(tx: Tx, wineId: string): Promise<number[]> {
  return (await tx.$queryRaw<{ u: number }[]>`
    SELECT user_id AS u FROM bookmarks WHERE wine_id = ${wineId}
    UNION SELECT user_id FROM blind_saves WHERE wine_id = ${wineId}`).map(r => r.u)
}

// Before a bottle row is deleted (in its transaction): a blind save of it that
// already counts as a craving becomes a real one (no bottle, its moment kept,
// its date), unless its saver has a shown craving of that wine already; the
// cravings visible to their owner lose the bottle and KEEP their moment (R1);
// the rest go with the row (the keys' CASCADE, as an old instance's DELETE).
export async function beforeBottleDelete(tx: Tx, wineId: string): Promise<void> {
  const owners = await ownersOf(tx, wineId)
  if (!owners.length) return
  await lockCravings(tx, owners)
  const b = await bottleOf(tx, wineId)
  const link = b ? linkOf(b) : null
  if (b && link) {
    const matured = await tx.$queryRaw<{ user_id: number; saved_at: Date; item_id: number | null; session_id: number | null; from_post: boolean }[]>`
      SELECT bs.user_id, bs.saved_at, bs.item_id, bs.session_id, bs.from_post FROM blind_saves bs JOIN wines w ON w.id = bs.wine_id LEFT JOIN sessions s ON s.id = ${SAVE_MOMENT}
       WHERE bs.wine_id = ${wineId} AND NOT ${cravingHiddenSql(Prisma.sql`bs.user_id`)}`
    for (const m of matured) {
      const others = (await allShownOfWine(tx, m.user_id, link)).filter(r => r.kind === 'c')
      if (others.length) continue
      // A hidden real craving of the same wine is superseded (the re-point rule).
      const hiddenReal = (await realOfWine(tx, m.user_id, link)).filter(r => r.hidden !== false)
      if (hiddenReal.length) await tx.$executeRaw`DELETE FROM bookmarks WHERE id = ANY(${hiddenReal.map(f => f.id)}::int[])`
      await insertCraving(tx, m.user_id, { ...b, sessionId: m.session_id ?? b.sessionId }, { source: null, itemId: m.item_id, fromPost: m.from_post, at: m.saved_at })
    }
  }
  await tx.$executeRaw`
    UPDATE bookmarks SET wine_id = NULL, source_session_id = COALESCE(bookmarks.source_session_id, ${b?.sessionId ?? null}::integer)
     WHERE id IN (SELECT b.id FROM ${CRAVING_FROM} WHERE b.wine_id = ${wineId} AND NOT ${cravingHiddenSql(Prisma.sql`b.user_id`)})`
}

// A PRODUCT purge (lib/catalogWrite.ts, its locks held, BEFORE the bottles
// lose their link; Codex r1): a blind save of one of these bottles that already
// counts as a craving becomes a real one (a save of an unlinked bottle counts
// as none), unlinked, with the entry's snapshot, its bottle, moment, post and
// date; one per saver and wine (the earliest, the row the list shows), none
// where the saver's list shows a real craving of that wine (that row stays the
// wine's). A still-hidden save stays a save of its bottle (named: after its
// reveal it counts as none, as on any unlinked bottle). 🔒 The craving carries
// the save's moment (an orphaned bottle's too: its FK takes that moment's row,
// Codex r2), so `moments` = the live moments the purge holds: a save whose live
// moment is not among them answers false and writes nothing (the caller
// refuses: a save made after its plan).
export async function maturedSavesToCravings(tx: Tx, wineIds: string[], moments: number[]): Promise<boolean> {
  if (!wineIds.length) return true
  const matured = await tx.$queryRaw<{ id: number; user_id: number; wine_id: string; saved_at: Date; item_id: number | null; sid: number | null; live: boolean | null; from_post: boolean; product_id: string; vintage_id: string | null }[]>`
    SELECT bs.id, bs.user_id, bs.wine_id, bs.saved_at, bs.item_id, s.id AS sid, s.deleted_at IS NULL AS live, bs.from_post, w.product_id, w.vintage_id
      FROM blind_saves bs JOIN wines w ON w.id = bs.wine_id LEFT JOIN sessions s ON s.id = ${SAVE_MOMENT}
     WHERE bs.wine_id = ANY(${wineIds}::text[]) AND w.product_id IS NOT NULL AND NOT ${cravingHiddenSql(Prisma.sql`bs.user_id`)}
     ORDER BY bs.saved_at, bs.id`
  if (matured.some(m => m.sid !== null && m.live === true && !moments.includes(m.sid))) return false
  const done = new Set<string>()
  const entries = await loadEntries(matured.map(m => ({ productId: m.product_id, vintageId: m.vintage_id })), tx)
  for (const m of matured) {
    const link = { productId: m.product_id, vintageId: m.vintage_id }
    const e = await effectiveOf(tx, link)
    const key = `${m.user_id}:${entryKey(e.p, e.v)}`
    if (done.has(key)) continue
    done.add(key)
    if ((await allShownOfWine(tx, m.user_id, link)).some(r => r.kind === 'c')) continue
    const en = entries.get(entryKey(link.productId, link.vintageId))
    const snap = en ? snapshotFromEntry(en) : null
    await tx.$executeRaw`
      INSERT INTO bookmarks (user_id, wine_id, product_id, vintage_id, name, producer, vintage, source_session_id, source_item_id, from_post, saved_at)
      VALUES (${m.user_id}, ${m.wine_id}, NULL, NULL, ${snap ? snap.name.slice(0, 255) : null}, ${snap ? snap.producer.slice(0, 255) : null},
              ${snap?.vintage ? snap.vintage.slice(0, 4) : null}, ${m.sid}, ${m.item_id}, ${m.from_post}, ${m.saved_at})`
    await tx.$executeRaw`DELETE FROM blind_saves WHERE id = ${m.id}`
  }
  return true
}

// After a bottle is RE-LINKED (in its transaction, the row already carrying
// its new link): every real craving sourced from it follows it to the new wine
// (R3), keeping its bottle and moment; a collision with an existing craving of
// the new wine keeps the visible row, else the earlier saved_at. (A blind save
// reads its bottle's wine live: it follows on its own.)
export async function afterRelink(tx: Tx, wineId: string): Promise<void> {
  const owners = (await tx.$queryRaw<{ u: number }[]>`SELECT user_id AS u FROM bookmarks WHERE wine_id = ${wineId}`).map(r => r.u)
  if (!owners.length) return
  await lockCravings(tx, owners)
  const b = await bottleOf(tx, wineId)
  const link = b?.productId ? await cravingLink(tx, { productId: b.productId, vintageId: b.vintageId }) : null
  if (!link) return
  const e = (await loadEntries([link], tx)).get(entryKey(link.productId, link.vintageId))
  const snap = e ? snapshotFromEntry(e) : null
  const moving = await tx.$queryRaw<{ id: number; user_id: number; saved_at: Date; hidden: boolean }[]>`
    SELECT b.id, b.user_id, b.saved_at, ${cravingHiddenSql(Prisma.sql`b.user_id`)} AS hidden
      FROM ${CRAVING_FROM} WHERE b.wine_id = ${wineId} ORDER BY b.id`
  for (const m of moving) {
    const others = (await realOfWine(tx, m.user_id, link)).filter(f => f.id !== m.id)
    const keepOther = others.find(o => (o.hidden === false && m.hidden !== false)
      || ((o.hidden === false) === (m.hidden === false) && (o.saved_at < m.saved_at || (+o.saved_at === +m.saved_at && o.id < m.id))))
    if (keepOther) { await tx.$executeRaw`DELETE FROM bookmarks WHERE id = ${m.id}`; continue }
    if (others.length) await tx.$executeRaw`DELETE FROM bookmarks WHERE id = ANY(${others.map(o => o.id)}::int[])`
    await tx.$executeRaw`
      UPDATE bookmarks SET product_id = ${link.productId}, vintage_id = ${link.vintageId},
             name = ${snap ? snap.name.slice(0, 255) : null}, producer = ${snap ? snap.producer.slice(0, 255) : null},
             vintage = ${snap?.vintage ? snap.vintage.slice(0, 4) : null}
       WHERE id = ${m.id}`
  }
}

// The per-viewer `saved` flag of a line-up or a feed page (§ 5): a row hidden
// for the viewer reads its OWN blind save only (never the wine's state); a
// visible linked row reads whether the wine is in the viewer's shown set; a
// visible unlinked row, whether they hold a legacy craving of that bottle.
// `effective` = the visible rows' effective (product, vintage) from
// loadEntries (merges followed). ONE statement.
export type SavedRow = { id: string; hidden: boolean; effective: { productId: string; vintageId: string | null } | null }
export async function savedFlags(viewerId: number, rows: SavedRow[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>(rows.map(r => [r.id, false]))
  const hiddenIds = rows.filter(r => r.hidden).map(r => r.id)
  const linked = rows.filter(r => !r.hidden && r.effective)
  // A craving with no catalogue link of THIS bottle (legacy, or an old
  // instance's save during the rolling deploy) is a save of it, linked or not.
  const visibleIds = rows.filter(r => !r.hidden).map(r => r.id)
  if (!hiddenIds.length && !visibleIds.length) return out
  const products = [...new Set(linked.map(r => r.effective!.productId))]
  // Membership only (is the wine in the viewer's shown set?), so no per-wine
  // reduction: the shown real cravings and the blind saves that count as one,
  // narrowed to the line-up's products. A smaller statement than
  // ownerCravingsSql on purpose: it runs on every poll, and the planning of the
  // full one cost more than its execution (measured).
  const al = Prisma.sql`SELECT id FROM al`
  const hits = await prisma.$queryRaw<{ k: string; a: string | null; b: string | null }[]>`
    WITH al AS MATERIALIZED (${productAliasesSql(Prisma.sql`${products}::text[]`)})
    SELECT 'm' AS k, bs.wine_id AS a, NULL::text AS b FROM blind_saves bs
     WHERE bs.user_id = ${viewerId} AND bs.wine_id = ANY(${hiddenIds}::text[])
    UNION ALL
    SELECT 'c', ${effectiveProductSql(CRAVING_PRODUCT)}, ${effectiveVintageSql(CRAVING_VINTAGE)} FROM ${CRAVING_FROM}
     WHERE b.user_id = ${viewerId} AND ${CRAVING_PRODUCT} IN (${al}) AND NOT ${cravingHiddenSql(viewerId)}
    UNION ALL
    SELECT 'c', ${effectiveProductSql(Prisma.sql`w.product_id`)}, ${effectiveVintageSql(Prisma.sql`w.vintage_id`)}
      FROM blind_saves bs JOIN wines w ON w.id = bs.wine_id LEFT JOIN sessions s ON s.id = ${SAVE_MOMENT}
     WHERE bs.user_id = ${viewerId} AND w.product_id IN (${al}) AND NOT ${cravingHiddenSql(viewerId)}
    UNION ALL
    SELECT 'u', b.wine_id, NULL FROM ${CRAVING_FROM}
     WHERE b.user_id = ${viewerId} AND b.product_id IS NULL AND b.wine_id = ANY(${visibleIds}::text[]) AND NOT ${cravingHiddenSql(viewerId)}`
  const marked = new Set(hits.filter(h => h.k === 'm').map(h => h.a))
  const craved = new Set(hits.filter(h => h.k === 'c').map(h => entryKey(h.a!, h.b)))
  const legacy = new Set(hits.filter(h => h.k === 'u').map(h => h.a))
  for (const r of rows) {
    if (r.hidden) out.set(r.id, marked.has(r.id))
    else out.set(r.id, legacy.has(r.id) || (!!r.effective && craved.has(entryKey(r.effective.productId, r.effective.vintageId))))
  }
  return out
}
