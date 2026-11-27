// The moments list filter (lists plan D14): date, role, host, friends,
// category, search. ONE definition shared by `GET /api/me/sessions` (your
// moments: subject = viewer = you) and `GET /api/users/:id/moments` (someone's:
// subject = them, whose ROLE the role facet reads; viewer = you, for "me" in
// hosts and the people intersect). Moved verbatim from /api/me/sessions.
//
// Aliases the caller's query must use: `s` = sessions, `sm` = the SUBJECT's
// session_members row.

import { Prisma } from '@prisma/client'
import { parseWireIdentity, userIdsForPublicIds } from '@/lib/publicIds'
import { prisma } from '@/lib/prisma'
import { scrub } from '@/lib/textSafe'

// Max members a multi-select facet accepts per request. `people` is the
// binding one (each becomes a correlated EXISTS — AND semantics); `hosts` OR
// into an ANY() (cheaper) but is capped the same way for symmetry. Bounds
// per-request SQL work the rate limiter can't.
export const FACET_MAX = 20
// Cap on a single anon-host name (`n:<name>`) — bounds the free-text bind.
const HOST_NAME_MAX = 64
// Trigram typo tolerance for search — tuned against the prod dump (real typos
// score 0.54–0.67; the stock 0.6 default missed them, 0.3 catches them with no
// false positives). Explicit threshold in the predicate, NOT the %> operator
// (which reads a pooled-connection-leaking session GUC). See the migration.
const SIMILARITY = 0.3

// Roles the caller can filter on. 'taster' means "no host/cohost/provider
// badge" — the sm.role fallback maps host|co_host|provider|taster and anything
// unknown to taster. Mirrors the client RoleKey union.
const ROLE_KEYS = new Set(['host', 'cohost', 'provider', 'taster'])
// Wire role key → the sm.role values it matches (Part A durable mirror stores
// 'co_host'; the wire vocab is 'cohost'). 'taster' is the complement, handled
// specially below (NOT ANY-of a value list).
const ROLE_TO_SM: Record<string, string[]> = {
  host: ['host'],
  cohost: ['co_host'],
  provider: ['provider'],
}

// Parse a comma-separated multi-select param into a de-duped string[] (empty
// when absent/blank). Values are validated by the caller per facet.
function csv(v: string | null): string[] {
  if (!v) return []
  return [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))]
}

export type MomentFacets = {
  q: string
  roles: string[]
  hosts: string[]
  people: string[]
  category: string | null
  from: Date | null
  to: Date | null
}

export function parseMomentFacets(sp: URLSearchParams): MomentFacets {
  // Free-text params are scrubbed (strip NUL/control/bidi — a NUL byte would
  // 500 the $queryRaw with P22021) and length-capped before touching Postgres,
  // even though this is a read (root CLAUDE.md's scrub rule is framed for
  // writes, but the NUL-byte 500 hits reads too). 128 chars is ample for a
  // moment/host name search.
  const Q_MAX = 128
  const q = (scrub(sp.get('q')) ?? '').trim().slice(0, Q_MAX)
  const roles = csv(sp.get('roles')).filter((r) => ROLE_KEYS.has(r))
  // Same per-facet cap as `people`: hosts OR into the query (each id/name is one
  // ANY() member, cheaper than an EXISTS, but still bound the input). 20 is far
  // beyond any real "moments hosted by one of N people" query.
  const hosts = csv(sp.get('hosts')).slice(0, FACET_MAX) // 'me' | 'u:<publicId>' | 'n:<name>'
  const people = csv(sp.get('people')).slice(0, FACET_MAX) // 'u:<publicId>' friend identity ids
  const category = (scrub(sp.get('category')) ?? '').trim().slice(0, 32) || null // 'wine' | null (any); 'any' == null
  // `from`/`to` are full ISO INSTANTS (…Z), not bare YYYY-MM-DD: the client
  // sends the picked LOCAL day's start/end converted to UTC (local-midnight →
  // local-next-midnight-minus-1ms), so the window means "this date in the
  // user's device timezone" — the SAME timezone the moment cards render in
  // (momentFormat.ts uses device-local toLocaleDateString). The server just
  // compares the stored instant against these; no UTC-midnight re-anchoring,
  // so no off-by-a-day for non-UTC users.
  const fromRaw = sp.get('from')
  const toRaw = sp.get('to')
  // Bounds on the EFFECTIVE date (set date, else created) — the same key the
  // client's Recent list sorts on, so the filter and order agree. Parsed
  // lenient: a bad value is ignored rather than 400 (a stale client shouldn't
  // hard-fail the whole list).
  const fromMs = fromRaw ? Date.parse(fromRaw) : NaN
  const toMs = toRaw ? Date.parse(toRaw) : NaN
  const from = Number.isFinite(fromMs) ? new Date(fromMs) : null
  const to = Number.isFinite(toMs) ? new Date(toMs) : null
  return { q, roles, hosts, people, category, from, to }
}

export const facetsActive = (f: MomentFacets) =>
  f.q !== '' || f.roles.length > 0 || f.hosts.length > 0 || f.people.length > 0 ||
  (f.category !== null && f.category !== 'any') || f.from !== null || f.to !== null

// The search / per-friend EXISTS: the params the `rl:moments-search` budget
// charges (the SAME key on every moments list).
export const facetsExpensive = (f: MomentFacets) => f.q !== '' || f.people.length > 0

// Friend ids the caller may filter `people` on. The picker only offers
// friends, but a request is untrusted — intersect the requested `people`
// ids with the caller's actual mutual-follow set so this can't become an
// attendance oracle for an arbitrary user. Blocked pairs are excluded too.
async function facetPeopleIds(f: MomentFacets, viewerId: number, blockedUserIds: Set<number>): Promise<number[]> {
  if (f.people.length === 0) return []
  // Wire identities (`u:<publicId>`); a malformed or unknown one is dropped
  // (and a request left with none matches nothing, below).
  const wantedPublic = f.people.flatMap((p) => {
    const w = parseWireIdentity(p)
    return w?.kind === 'user' ? [w.publicId] : []
  })
  const wanted = [...(await userIdsForPublicIds(wantedPublic)).values()]
    .filter((n) => !blockedUserIds.has(n))
    // Belt after the block-scrub filter (the raw `people` was already capped
    // at parse). Each accepted friend becomes one correlated EXISTS.
    .slice(0, FACET_MAX)
  if (wanted.length === 0) return []
  const mutuals = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT f1."following_id" AS id
    FROM follows f1
    JOIN follows f2 ON f2."follower_id" = f1."following_id" AND f2."following_id" = ${viewerId}
    WHERE f1."follower_id" = ${viewerId} AND f1."following_id" = ANY(${wanted})
  `
  return mutuals.map((m) => m.id)
}

// Someone's Moments' OPEN rows (Moment Visibility, lib/momentAudience.ts):
// moments the viewer is not in but may look into. 🔒 On them a filter never
// matches a hidden person: `people` only where that friend is named, `hosts`
// and the host-name half of `q` only where the host is named (otherwise
// "Alice was there" or a search for Alice's name is an attendance oracle).
export type OpenRowsNaming = { hostNamed: number[]; namedFor: (userId: number) => number[] }

// The `hosts=u:<publicId>` entries resolved: `unknown` = one of them is
// malformed or names nobody.
export type FacetHosts = { uids: number[]; unknown: boolean }
async function facetHostIds(f: MomentFacets): Promise<FacetHosts> {
  const entries = f.hosts.filter((h) => h.startsWith('u:'))
  const publicIds = entries.flatMap((h) => {
    const w = parseWireIdentity(h)
    return w?.kind === 'user' ? [w.publicId] : []
  })
  const uids = [...(await userIdsForPublicIds(publicIds)).values()]
  return { uids, unknown: entries.length > uids.length }
}

// The facets' id lookups, once per request: a caller that builds two WHEREs
// (someone's Moments: shared rows and open rows) passes them to both.
export type ResolvedFacets = { people: number[]; hosts: FacetHosts }
export async function resolveFacets(f: MomentFacets, viewerId: number, blockedUserIds: Set<number>): Promise<ResolvedFacets> {
  const [people, hosts] = await Promise.all([facetPeopleIds(f, viewerId, blockedUserIds), facetHostIds(f)])
  return { people, hosts }
}

export async function momentFacetWhere(
  f: MomentFacets,
  { subjectId, viewerId, blockedUserIds, resolved, open }: {
    subjectId: number; viewerId: number; blockedUserIds: Set<number>; resolved?: ResolvedFacets; open?: OpenRowsNaming
  },
): Promise<Prisma.Sql[]> {
  const where: Prisma.Sql[] = []
  const { people: peopleIds, hosts } = resolved ?? await resolveFacets(f, viewerId, blockedUserIds)
  const hostNamed = (clause: Prisma.Sql) => (open ? Prisma.sql`(s.id = ANY(${open.hostNamed}::int[]) AND ${clause})` : clause)

  // Date window on COALESCE(date_from, created_at), inclusive whole days.
  if (f.from) where.push(Prisma.sql`COALESCE(s.date_from, s.created_at) >= ${f.from}`)
  if (f.to) where.push(Prisma.sql`COALESCE(s.date_from, s.created_at) <= ${f.to}`)

  // Category: NULL rows predate the column → treat as 'wine' (the only thing
  // they could be), matching the client's fold.
  if (f.category && f.category !== 'any') {
    where.push(
      f.category === 'wine'
        ? Prisma.sql`COALESCE(s.category, 'wine') = 'wine'`
        : Prisma.sql`s.category = ${f.category}`,
    )
  }

  // Roles (the SUBJECT's): OR within the facet. Non-taster keys match sm.role
  // directly; 'taster' is the COMPLEMENT (no host/cohost/provider badge — role
  // IS NULL is impossible, so it's "not one of the badge values", incl. legacy/
  // unknown). host_user_id === subject is the belt for a host whose mirror row
  // predates the role snapshot (same last-resort as the enrichment fallback).
  if (f.roles.length > 0) {
    const clauses: Prisma.Sql[] = []
    const badgeValues = f.roles.flatMap((r) => ROLE_TO_SM[r] ?? [])
    if (badgeValues.length > 0) {
      clauses.push(Prisma.sql`sm.role = ANY(${badgeValues})`)
      if (f.roles.includes('host')) clauses.push(Prisma.sql`s.host_user_id = ${subjectId}`)
    }
    if (f.roles.includes('taster')) {
      clauses.push(
        Prisma.sql`(sm.role NOT IN ('host', 'co_host', 'provider') AND s.host_user_id IS DISTINCT FROM ${subjectId})`,
      )
    }
    where.push(Prisma.sql`(${Prisma.join(clauses, ' OR ')})`)
  }

  // Hosts: OR within the facet. 'me' = the VIEWER's own hosted moments;
  // 'u:<publicId>' matches host_user_id; 'n:<name>' matches the anon-host
  // name snapshot (accepting rename drift, per the proposal).
  // 🔒 A `u:` entry that is malformed (an old tab's `u:42`) or unknown adds a
  // FALSE clause, never nothing: dropping it could leave the facet empty and
  // widen the filter to every moment (public-user-ids § 4).
  if (f.hosts.length > 0) {
    const clauses: Prisma.Sql[] = []
    if (f.hosts.includes('me')) clauses.push(Prisma.sql`s.host_user_id = ${viewerId}`)
    if (hosts.uids.length > 0) clauses.push(Prisma.sql`s.host_user_id = ANY(${hosts.uids})`)
    if (hosts.unknown) clauses.push(Prisma.sql`FALSE`)
    // Scrub + length-cap the free-text anon-host names (NUL byte → P22021
    // 500; host_name is VarChar(64) so anything longer can't match anyway).
    const names = f.hosts
      .filter((h) => h.startsWith('n:'))
      .map((h) => (scrub(h.slice(2)) ?? '').slice(0, HOST_NAME_MAX))
      .filter(Boolean)
    if (names.length > 0) clauses.push(Prisma.sql`s.host_name = ANY(${names})`)
    if (clauses.length > 0) where.push(hostNamed(Prisma.sql`(${Prisma.join(clauses, ' OR ')})`))
  }

  // People: AND semantics — one EXISTS per selected friend ("the moments
  // Anna AND Tim were both at"). peopleIds is already intersected with the
  // caller's mutual-follow set + block scrub, so this can't probe an
  // arbitrary user's attendance. An empty peopleIds after that scrub (a
  // request for non-friends only) matches nothing — intentional.
  if (f.people.length > 0) {
    if (peopleIds.length === 0) {
      where.push(Prisma.sql`FALSE`)
    } else {
      for (const pid of peopleIds) {
        // `removed_state` excludes a friend who was KICKED from the session
        // — they aren't a participant there, so "moments Anna was at"
        // shouldn't match a moment Anna was kicked from (matches the live
        // identities hash, which strips kicked users, and the caller's own
        // kicked-drop). kick-delete/ban already dropped the sm2 row.
        const there = Prisma.sql`EXISTS (SELECT 1 FROM session_members sm2 WHERE sm2.session_code = s.code AND sm2.user_id = ${pid} AND sm2.removed_state IS DISTINCT FROM 'kicked')`
        where.push(open ? Prisma.sql`(s.id = ANY(${open.namedFor(pid)}::int[]) AND ${there})` : there)
      }
    }
  }

  // Search: accent-insensitive substring OR typo-tolerant trigram, over
  // name + host_name. See the migration for f_unaccent + the threshold.
  // `qLike` escapes the LIKE metacharacters (\ % _) so the substring branch
  // treats `q` as LITERAL text — otherwise a `%` in the query would match
  // everything and a `_` (real: session names like `tasting_with_…`) would
  // match any char. The `\` escape char is declared with ESCAPE (written
  // `'\\'`: inside this template literal `'\'` would reach Postgres as
  // `ESCAPE ''`, no escape at all, which silently disabled it until 2026-11-13). The
  // word_similarity branch is unaffected (it doesn't interpret wildcards), so
  // a metachar-containing query still fuzzy-matches on the raw `q`.
  if (f.q !== '') {
    const qLike = f.q.replace(/[\\%_]/g, (c) => `\\${c}`)
    where.push(
      Prisma.sql`(
        f_unaccent(s.name) ILIKE '%' || f_unaccent(${qLike}) || '%' ESCAPE '\\'
        OR word_similarity(f_unaccent(${f.q}), f_unaccent(s.name)) >= ${SIMILARITY}
        OR ${hostNamed(Prisma.sql`(f_unaccent(s.host_name) ILIKE '%' || f_unaccent(${qLike}) || '%' ESCAPE '\\'
          OR word_similarity(f_unaccent(${f.q}), f_unaccent(s.host_name)) >= ${SIMILARITY})`)}
      )`,
    )
  }
  return where
}
