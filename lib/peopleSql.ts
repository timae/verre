// Shared SQL fragments for the people surfaces (the app's People lists, in
// common, search, tasted-with). One home so every row set AND every
// viewer-relative count uses the SAME rules: a count that ran a looser rule
// than its rows could exceed them and name a blocker.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

type Id = number | Prisma.Sql
const id = (x: Id) => (typeof x === 'number' ? Prisma.sql`${x}::integer` : x)

// No block pair, either direction, between `col` and `a` OR `b` (the profile
// owner and the viewer; pass the viewer twice when there is no owner). Two PK
// probes per row (`user_blocks` (blocker_id, blocked_id)).
export const blockScrub = (a: Id, b: Id, col: Prisma.Sql) => Prisma.sql`NOT EXISTS (
  SELECT 1 FROM user_blocks b
  WHERE (b.blocker_id IN (${id(a)}, ${id(b)}) AND b.blocked_id = ${col})
     OR (b.blocked_id IN (${id(a)}, ${id(b)}) AND b.blocker_id = ${col}))`

// The together predicate (momentsTogether, tasted-with): one row per moment
// the viewer shares with `other_id`. Both member rows exist and neither is
// kicked (a ban or a moment deletion deletes the rows), the moment row is
// live, and it has started (`/api/me/sessions`' past / dateless rule);
// `at` = its recency key (the same COALESCE). 🔒 Never selects a code.
export const together = (viewerId: number) => Prisma.sql`(
  SELECT sm2.user_id AS other_id, s.id AS session_id, s.name AS name, COALESCE(s.date_from, s.created_at) AS at
  FROM session_members sm1
  JOIN session_members sm2 ON sm2.session_code = sm1.session_code AND sm2.user_id <> sm1.user_id
  JOIN sessions s ON s.code = sm1.session_code
  WHERE sm1.user_id = ${viewerId}
    AND sm1.removed_state IS DISTINCT FROM 'kicked'
    AND sm2.removed_state IS DISTINCT FROM 'kicked'
    AND s.deleted_at IS NULL
    AND (s.date_from IS NULL OR s.date_from <= now())
)`

// Moments the viewer shares with each of `ids` (absent = none).
export async function momentsTogether(viewerId: number, ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map()
  const rows = await prisma.$queryRaw<{ id: number; n: number }[]>`
    SELECT t.other_id AS id, COUNT(*)::int AS n
    FROM ${together(viewerId)} t
    WHERE t.other_id = ANY(${ids}::int[])
    GROUP BY t.other_id`
  return new Map(rows.map(r => [r.id, r.n]))
}

// "N friends in common" per listed person L: L's friends (mutual follows)
// the viewer follows, with no block pair between that friend and the viewer
// or L. The same set as L's profile header `inCommon` (lib/profileHeader.ts).
// Run it ONLY for ids the profile gate admits (social-graph data).
export async function friendsInCommon(viewerId: number, ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map()
  const rows = await prisma.$queryRaw<{ id: number; n: number }[]>`
    SELECT f1.follower_id AS id, COUNT(*)::int AS n
    FROM follows f1
    JOIN follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
    JOIN follows fv ON fv.follower_id = ${viewerId} AND fv.following_id = f1.following_id
    WHERE f1.follower_id = ANY(${ids}::int[])
      AND ${blockScrub(viewerId, Prisma.raw('f1.follower_id'), Prisma.raw('f1.following_id'))}
    GROUP BY f1.follower_id`
  return new Map(rows.map(r => [r.id, r.n]))
}
