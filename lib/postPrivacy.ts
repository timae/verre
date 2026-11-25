// Who may see a person's POST, beyond the post gate (Moment Visibility step 3:
// Only Inside This Moment, and Hide from Feed). ONE module, SQL only: every
// reader selects these predicates in the statement that reads the rows, before
// paging (the lib/outsideView.ts lesson: a TypeScript twin drifts). The single
// post check is `viewerCanSeePost` (lib/profileVisibility.ts), built on
// `postShownSql` below.
//
//   only inside  = the person chose Incognito in that moment (R11;
//                  `moment_privacy.only_inside`; a missing row is "shown").
//   post hidden  = from viewer V, a post `fi` that is not V's own, and
//                  either a moment post its author hid from feeds there
//                  (`moment_privacy.hidden_from_feed`, R12: from EVERYONE,
//                  people in the moment included), or a moment post whose
//                  author is Incognito there while V is not in the moment
//                  (`insiderSql`, the grant rule; a deleted moment has no
//                  insiders, so its post shows to its author only), or a
//                  check-in its author hid from feeds (`feed_items.hidden_from_feed`).
//   stripped     = a list row of owner O from moment S, seen by V who is not
//                  O and not in S, where O is Only Inside in S: the row shows
//                  without its moment (no name, no wine id, no moment photo).
//
// 🔒 READERS ARE NEVER BEHIND A FLAG (T1): turning a flag off must not reopen
// a hidden post. Only the WRITES (and the `me` state, and the feed's own-post
// fields) sit behind `MOMENT_LOOKIN_ENABLED` / `HIDE_FROM_FEED_ENABLED`.
// 🔒 Aliases inside are private (`pp*`) so a caller's own aliases can't be
// shadowed; the caller's aliases are checked by ALIAS.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { redis, k } from '@/lib/redis'
import { insiderSql } from '@/lib/sessionGrant'
import { hiddenSql } from '@/lib/outsideView'
import type { Fence } from '@/lib/sessionMutation'

const ALIAS = /^[a-z_][a-z0-9_]*$/
function alias(name: string): Prisma.Sql {
  if (!ALIAS.test(name)) throw new Error(`postPrivacy: bad alias ${name}`)
  return Prisma.raw(name)
}

type Db = Prisma.TransactionClient | typeof prisma

// The stored choices of `userCol` (a column or a value) in `sessionCol`:
// Incognito (R11, `only_inside`) and Hide from Feed for that moment's post
// (R12, `hidden_from_feed`). A missing row is neither.
export function onlyInsideSql(userCol: Prisma.Sql, sessionCol: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM moment_privacy ppm WHERE ppm.session_id = ${sessionCol} AND ppm.user_id = ${userCol} AND ppm.only_inside)`
}
export function momentFeedHiddenSql(userCol: Prisma.Sql, sessionCol: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM moment_privacy ppf WHERE ppf.session_id = ${sessionCol} AND ppf.user_id = ${userCol} AND ppf.hidden_from_feed)`
}

// The post `fi` is hidden from the viewer (see the header). NULL-safe toward
// hidden: a NULL viewer is never the author and never an insider. A moment
// post hidden from feeds (R12) is hidden from EVERYONE but its author, people
// in the moment included; Incognito only from people outside it.
export function postHiddenSql(viewerId: number | null, fiName: string): Prisma.Sql {
  const fi = alias(fiName)
  const author = Prisma.sql`${fi}.user_id`, moment = Prisma.sql`${fi}.session_id`
  return Prisma.sql`(${fi}.user_id IS DISTINCT FROM ${viewerId}::integer AND (
    (${fi}.kind = 'session' AND (${momentFeedHiddenSql(author, moment)}
      OR (${onlyInsideSql(author, moment)} AND NOT ${insiderSql(viewerId, moment)})))
    OR (${fi}.kind = 'standalone' AND ${fi}.hidden_from_feed)))`
}

// "The post the feed would show you", minus the author's profile gate (the
// caller's, by author): not hidden, and a moment post whose line-up is not
// hidden from the viewer (the feed's hidden line-up rule, lib/outsideView.ts).
export function postShownSql(viewerId: number | null, fiName: string): Prisma.Sql {
  const fi = alias(fiName)
  return Prisma.sql`(NOT ${postHiddenSql(viewerId, fiName)} AND NOT EXISTS (
    SELECT 1 FROM sessions pls WHERE ${fi}.kind = 'session' AND pls.id = ${fi}.session_id AND ${hiddenSql(viewerId, 'pls')}))`
}

// A list row of `ownerCol` from moment `sessionCol` shows without its moment.
export function strippedSql(viewerId: number | null, ownerCol: Prisma.Sql, sessionCol: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${viewerId}::integer IS DISTINCT FROM ${ownerCol} AND ${sessionCol} IS NOT NULL
    AND ${onlyInsideSql(ownerCol, sessionCol)} AND NOT ${insiderSql(viewerId, sessionCol)})`
}

// Is this ONE post shown to the viewer, by everything but the author's profile
// gate? One statement, read from the row (never the caller's copy of it).
export async function postShownTo(viewerId: number | null, postId: number, db: Db = prisma): Promise<boolean> {
  const rows = await db.$queryRaw<{ shown: boolean | null }[]>`
    SELECT ${postShownSql(viewerId, 'fi')} AS shown FROM feed_items fi WHERE fi.id = ${postId}`
  // A NULL (never by construction) reads as hidden.
  return rows[0]?.shown === true
}

// ── The page of posts (T4) ──────────────────────────────────────────────────
//
// 🔒 The feed's and the web profile's page of ids comes from ONE statement that
// applies every exclusion (a hidden line-up, Only Inside, Hide from Feed)
// BEFORE its LIMIT: dropped after the read, a page of hidden posts would end on
// one, and the cursor (the last raw row's time) would hand out its exact time.
// A `NOT EXISTS` per candidate row is bounded by the page; a pre-query of the
// hidden posts bound as parameters would not be (Postgres refuses past 65,535).
export type PageRow = { id: number; created_at: Date }
export async function pagePostIds(opts: {
  viewerId: number | null
  authors: number[]
  // The cursor (the feed's); absent = no upper bound (the web profile: the
  // app clock must not hide a post the DB stamped a moment later).
  before?: Date
  item?: number | null
  kind?: 'standalone' | 'session'
  hiddenSessions: number[]
  limit: number
}): Promise<PageRow[]> {
  if (opts.authors.length === 0) return []
  return prisma.$queryRaw<PageRow[]>`
    SELECT fi.id, fi.created_at
      FROM feed_items fi
     WHERE fi.user_id = ANY(${opts.authors}::int[]) ${opts.before ? Prisma.sql`AND fi.created_at < ${opts.before}` : Prisma.empty}
       ${opts.item != null ? Prisma.sql`AND fi.id = ${opts.item}` : Prisma.empty}
       ${opts.kind ? Prisma.sql`AND fi.kind = ${opts.kind}` : Prisma.empty}
       AND NOT (fi.kind = 'session' AND COALESCE(fi.session_id = ANY(${opts.hiddenSessions}::int[]), false))
       AND NOT ${postHiddenSql(opts.viewerId, 'fi')}
     ORDER BY fi.created_at DESC, fi.id DESC
     LIMIT ${opts.limit}`
}

// ── The state ───────────────────────────────────────────────────────────────

// A signed-in person's stored choices in one moment (no row = neither).
export type MomentChoice = 'onlyInside' | 'hiddenFromFeed'
export async function readMomentChoices(db: Db, sessionId: number, userId: number): Promise<Record<MomentChoice, boolean>> {
  const rows = await db.$queryRaw<{ only_inside: boolean; hidden_from_feed: boolean }[]>`
    SELECT only_inside, hidden_from_feed FROM moment_privacy WHERE session_id = ${sessionId} AND user_id = ${userId}`
  return { onlyInside: rows[0]?.only_inside === true, hiddenFromFeed: rows[0]?.hidden_from_feed === true }
}
export async function readOnlyInside(db: Db, sessionId: number, userId: number): Promise<boolean> {
  return (await readMomentChoices(db, sessionId, userId)).onlyInside
}

// 🔒 A guest's choice IS `s:{CODE}:shown`: missing from it (hid, an evicted key,
// a lost write) reads as Only Inside (fails closed). Only this switch re-adds.
export async function guestOnlyInside(code: string, identityId: string): Promise<boolean> {
  return !(await redis.sIsMember(k.shown(code), identityId))
}

// ── The writes ──────────────────────────────────────────────────────────────

// The budget of BOTH write routes (rate-limits.md): 🔒 R10 (ruled 2026-11-24)
// charges only SHOWING again, and only on a change; hiding is never refused (a
// protective path, like Unblock), so toggling stays bounded by its show half
// and a venue's guests can always hide. Signed in per user (shared by the two
// routes); a guest per moment and address (an `a:` id is re-minted per join).
export const postPrivacyKey = {
  user: (userId: string | number) => ({ key: `rl:post-privacy:u:${userId}:1h`, max: 30 }),
  guest: (code: string, ip: string) => ({ key: `rl:post-privacy:ip:${code}:${ip}:1h`, max: 120 }),
}

const COLUMN: Record<MomentChoice, Prisma.Sql> = { onlyInside: Prisma.raw('only_inside'), hiddenFromFeed: Prisma.raw('hidden_from_feed') }

// The caller's own post's current switch (the post route's show-direction
// check): null = not the caller's post of a kind that has that switch (the
// route's one 404). Hide from Feed: a check-in's own column, a moment post's
// per-moment choice (R12); Incognito: moment posts only.
export async function ownPostPrivacy(postId: number, userId: number, field: MomentChoice): Promise<boolean | null> {
  const rows = await prisma.$queryRaw<{ v: boolean }[]>`
    SELECT CASE WHEN fi.kind = 'standalone' THEN fi.hidden_from_feed ELSE COALESCE(ppo.${COLUMN[field]}, false) END AS v
      FROM feed_items fi
      LEFT JOIN moment_privacy ppo ON ppo.session_id = fi.session_id AND ppo.user_id = fi.user_id
     WHERE fi.id = ${postId} AND fi.user_id = ${userId}
       AND ${field === 'onlyInside' ? Prisma.sql`fi.kind = 'session' AND fi.session_id IS NOT NULL` : Prisma.sql`(fi.kind = 'standalone' OR (fi.kind = 'session' AND fi.session_id IS NOT NULL))`}`
  return rows[0] ? rows[0].v === true : null
}

// Signed in: one upsert of one choice (T9, T10: turning it off writes `false`,
// never a delete; the other choice keeps its value).
export async function setMomentChoice(tx: Prisma.TransactionClient, sessionId: number, userId: number, field: MomentChoice, on: boolean): Promise<void> {
  const col = COLUMN[field]
  await tx.$executeRaw`
    INSERT INTO moment_privacy (session_id, user_id, ${col}) VALUES (${sessionId}, ${userId}, ${on})
    ON CONFLICT (session_id, user_id) DO UPDATE SET ${col} = EXCLUDED.${col}`
}

// A guest (inside the contract holding the session lock): the fenced SREM to
// hide, SADD to show, with the roster's TTL. 🔒 The second writer of `shown`
// (lib/CLAUDE.md): the join mints a guest shown; only this switch changes it.
// Returns whether it CHANGED anything (R10's charge on a change): read under
// the contract's session lock, so two guest writes can't both see a change.
export async function setGuestShown(fence: Fence, code: string, identityId: string, onlyInside: boolean): Promise<boolean> {
  const ttl = Number(await fence.client.pTTL(k.identities(code)))
  const wasShown = (await fence.client.sIsMember(k.shown(code), identityId)) === true
  await fence.exec(m => {
    if (onlyInside) m.sRem(k.shown(code), identityId)
    else {
      m.sAdd(k.shown(code), identityId)
      if (ttl > 0) m.pExpire(k.shown(code), ttl)
    }
  })
  return onlyInside ? wasShown : !wasShown
}

// 🔒 SHOWING again (R10: counted only on an actual change; Codex 2026-11-25):
// each writes ONLY where the choice is still on and says whether it did, so of
// two concurrent "show" requests exactly one changes it and is charged
// (peek-then-check-on-change, root CLAUDE.md § Rate limits). A missing row is
// already shown: nothing to write.
export async function showMomentChoice(tx: Prisma.TransactionClient, sessionId: number, userId: number, field: MomentChoice): Promise<boolean> {
  const col = COLUMN[field]
  const n = await tx.$executeRaw`UPDATE moment_privacy SET ${col} = false WHERE session_id = ${sessionId} AND user_id = ${userId} AND ${col}`
  return n === 1
}
export async function showMomentChoiceByPost(postId: number, userId: number, field: MomentChoice): Promise<boolean> {
  const col = COLUMN[field]
  const n = await prisma.$executeRaw`
    UPDATE moment_privacy mp SET ${col} = false FROM feed_items fi
     WHERE fi.id = ${postId} AND fi.user_id = ${userId} AND fi.kind = 'session' AND fi.session_id IS NOT NULL
       AND mp.session_id = fi.session_id AND mp.user_id = fi.user_id AND mp.${col}`
  return n === 1
}
export async function showHiddenCheckin(postId: number, userId: number): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE feed_items SET hidden_from_feed = false WHERE id = ${postId} AND user_id = ${userId} AND kind = 'standalone' AND hidden_from_feed`
  return n === 1
}

// A ⋯ row on your own MOMENT post (Incognito, or Hide from Feed: R12): ONE
// statement, the post (the caller's, a moment post) is the write's source, so
// it works after the moment is deleted and for a kicked author. Returns false
// when nothing matched.
export async function setMomentChoiceByPost(postId: number, userId: number, field: MomentChoice, on: boolean): Promise<boolean> {
  const col = COLUMN[field]
  const n = await prisma.$executeRaw`
    INSERT INTO moment_privacy (session_id, user_id, ${col})
    SELECT fi.session_id, fi.user_id, ${on} FROM feed_items fi
     WHERE fi.id = ${postId} AND fi.user_id = ${userId} AND fi.kind = 'session' AND fi.session_id IS NOT NULL
    ON CONFLICT (session_id, user_id) DO UPDATE SET ${col} = EXCLUDED.${col}`
  return n === 1
}

// Hide from Feed on a CHECK-IN: its own column. Returns false when nothing
// matched (another author's post, not a check-in, gone).
export async function setHiddenFromFeed(postId: number, userId: number, on: boolean): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE feed_items SET hidden_from_feed = ${on} WHERE id = ${postId} AND user_id = ${userId} AND kind = 'standalone'`
  return n === 1
}
