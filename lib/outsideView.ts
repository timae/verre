// What a moment's bottle may show OUTSIDE the moment (lists plan D4): the
// feed, the profile lists and tiles, /api/me/ratings + /api/me/bookmarks. ONE
// SQL definition on the DB clock, selected by every consumer; there is no
// TypeScript twin (two rules on two clocks drift). A CRAVING applies it to its
// source bottle for its owner and is LEFT OUT while hidden, never a blind row
// (lib/cravings.ts, catalogue model change § 5).
//
//   redacted = blind, the bottle not revealed, the moment not deleted, not
//              over by its dates (core MOMENT_DEFAULT_SPAN_MS, the
//              `momentIsOver` rule), and no bypass (the strict host, or the
//              viewer added the bottle; none under Blind for All) → a blind
//              row: no name / producer / vintage / grape / photo / catalog
//              fields / purchase link. Score, date and style stay.
//   hidden   = Hide Line-up, a start date, now before start − minutes, and
//              the viewer is not the moment's host (the strict host or a
//              current `co_host` member: the live rule's bypass,
//              `isHostByIdentity`) → LEFT OUT, on your own lists too (a host
//              can edit a bottle while the line-up is hidden).
//
// 🔒 NULL-safe: every TERM coalesces toward fail-closed (a NULL bypass or
// "over" term is false, so the row stays redacted / hidden; a NULL blind /
// hide_lineup is the documented default, off), and the OUTER flags are never
// wrapped in COALESCE(…, false): that would turn any NULL into "show in full".
// The viewer may be NULL (a signed-out web visitor): no bypass at all. It may
// also be a COLUMN (`Viewer` as Prisma.Sql, e.g. `b.user_id`): one statement
// then judges each row for its own owner (lib/cravings.ts: a re-link, a delete).
//
// Aliases name the caller's joins: `s` = sessions (LEFT JOINed on the row's
// moment), `w` = wines (the occurrence).

import { Prisma } from '@prisma/client'
import { MOMENT_DEFAULT_SPAN_MS } from '@verre/core'
import { prisma } from '@/lib/prisma'

const ALIAS = /^[a-z_][a-z0-9_]*$/
function alias(name: string): Prisma.Sql {
  if (!ALIAS.test(name)) throw new Error(`outsideView: bad alias ${name}`)
  return Prisma.raw(name)
}

const SPAN = Prisma.sql`make_interval(secs => ${MOMENT_DEFAULT_SPAN_MS / 1000}::double precision)`

// A user id, NULL (no viewer), or a column holding one.
export type Viewer = number | null | Prisma.Sql
// (Prisma.Sql is a type at runtime in Prisma 7: told apart by shape.)
const isSql = (v: Viewer): v is Prisma.Sql => typeof v === 'object' && v !== null && 'strings' in v && 'values' in v
const viewerSql = (v: Viewer): Prisma.Sql => (isSql(v) ? Prisma.sql`(${v})::integer` : Prisma.sql`${v}::integer`)

// The line-up is hidden right now, for anyone who isn't its host. Viewer-free:
// SAFE_PHOTO (lib/profileTiles.ts) uses it as is, with no bypass.
export function lineupHiddenNowSql(sName: string): Prisma.Sql {
  const s = alias(sName)
  return Prisma.sql`(COALESCE(${s}.hide_lineup, false) AND ${s}.date_from IS NOT NULL
    AND now() < ${s}.date_from - make_interval(mins => COALESCE(${s}.hide_lineup_minutes_before, 0)))`
}

// The live rule's host bypass: the strict host, or a co_host member row that
// is not kicked and not banned (a removed cohost holds no power).
function hostBypassSql(viewerId: Viewer, s: Prisma.Sql): Prisma.Sql {
  const v = viewerSql(viewerId)
  return Prisma.sql`(COALESCE(${s}.host_user_id = ${v}, false) OR EXISTS (
    SELECT 1 FROM session_members ovm
     WHERE ovm.session_code = ${s}.code AND ovm.user_id = ${v} AND ovm.role = 'co_host' AND ovm.removed_state IS NULL
       AND NOT EXISTS (SELECT 1 FROM session_bans ovb WHERE ovb.session_code = ${s}.code AND ovb.identity_id = 'u:' || ${v}::text)))`
}

export function hiddenSql(viewerId: Viewer, sName: string): Prisma.Sql {
  return Prisma.sql`(${lineupHiddenNowSql(sName)} AND NOT ${hostBypassSql(viewerId, alias(sName))})`
}

export function redactedSql(viewerId: Viewer, sName: string, wName: string): Prisma.Sql {
  const s = alias(sName)
  const w = alias(wName)
  const v = viewerSql(viewerId)
  const over = Prisma.sql`COALESCE(now() > COALESCE(${s}.date_to, ${s}.date_from + ${SPAN}, ${s}.created_at + ${SPAN}), false)`
  const bypass = Prisma.sql`(NOT COALESCE(${s}.blind_for_everyone, false) AND (
    COALESCE(${s}.host_user_id = ${v}, false) OR COALESCE(${w}.added_by_identity_id = 'u:' || ${v}::text, false)))`
  return Prisma.sql`(COALESCE(${s}.blind, false) AND ${w}.revealed_at IS NULL AND ${s}.deleted_at IS NULL
    AND NOT ${over} AND NOT ${bypass})`
}

export function outsideViewSql(viewerId: Viewer, a: { s: string; w: string }): { redacted: Prisma.Sql; hidden: Prisma.Sql } {
  return { redacted: redactedSql(viewerId, a.s, a.w), hidden: hiddenSql(viewerId, a.s) }
}

// A craving's moment (catalogue model change § 5): the one it stores
// (`bookmarks.source_session_id`, written with its source and kept when the
// bottle is deleted, R1), else the bottle's own, else a session rating's of that
// bottle (legacy rows the backfill found no moment for). `wines.session_id` is
// NULL both for a deleted moment AND for a banned adder's bottles in a moment
// still running (lib/sessionWipe.ts), which is why the stored moment comes
// first. NULL = no moment found.
export function cravingSessionIdSql(bName: string, wName: string): Prisma.Sql {
  const b = alias(bName)
  const w = alias(wName)
  return Prisma.sql`COALESCE(${b}.source_session_id, ${w}.session_id, (
    SELECT ovr.session_id FROM ratings ovr WHERE ovr.wine_id = ${w}.id AND ovr.session_id IS NOT NULL LIMIT 1))`
}

// 🔒 A fully hidden moment post is left out IN the query, before paging: the
// feed's cursor is the last raw row's time, so a page of dropped hidden posts
// would hand out a hidden post's exact time (the page statement,
// lib/postPrivacy.ts `pagePostIds`, takes these ids). The moments among these authors'
// session posts whose line-up is hidden from this viewer. Starts from the
// moments still before their start with Hide Line-up on (a hidden line-up
// implies both), so the cost follows those, not the authors' post history.
// ⚠️ "Implies" holds only while `hide_lineup_minutes_before` is never negative
// (clamped at its one writer, lib/sessionFields.ts; no DB CHECK): a negative
// value would hide a line-up AFTER the start, outside this start set.
export async function hiddenSessionIds(viewerId: number | null, authorIds: number[]): Promise<number[]> {
  if (authorIds.length === 0) return []
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT s.id
      FROM sessions s
     WHERE s.hide_lineup IS TRUE AND s.date_from > now()
       AND ${hiddenSql(viewerId, 's')}
       AND EXISTS (SELECT 1 FROM feed_items fi
                    WHERE fi.session_id = s.id AND fi.kind = 'session' AND fi.user_id = ANY(${authorIds}::int[]))`
  return rows.map(r => r.id)
}

