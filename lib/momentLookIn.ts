import { createHmac } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { decimalToNumber } from '@verre/core'
import { prisma } from '@/lib/prisma'
import { redis, k } from '@/lib/redis'
import { lineupHiddenNowSql, outsideViewSql } from '@/lib/outsideView'
import { coverOutsideSql } from '@/lib/profileTiles'
import { eligibleRoster } from '@/lib/sessionRehydrate'
import { entryKey, loadEntriesSoft } from '@/lib/catalogEntries'
import { entryYear } from '@/lib/wineDisplay'
import { verifyMomentLinkCode } from '@/lib/momentLink'
import type { MomentDecision } from '@/lib/momentAudience'

// The look-in (docs/dev/proposals/moment-visibility.md § 7; step-1 plan § 4.1):
// what someone outside a moment sees of it. Read from the RECORD; the cache
// only for the guests without an account, and never opened or rebuilt (list
// reads never rebuild, lib/CLAUDE.md).
//
// 🔒 A NEW allow-list builder, never metaToWire / buildMetaView (they carry the
// code). No code, no wine id, no rating id, no username, no integer, no `a:` /
// `u:` / `d:` identity. `position` is the index in THIS output. Keys are
// STABLE and KEYED (step-2 plan T2, `lookInKeys`): a bottle's and a guest's
// from an HMAC under a key derived from the auth secret, a registered person's
// their public id, so the details read (`?bottles=`) can be merged into what
// the first read showed.
// Two reads (step-2 plan § 3, R3 + R15): the FIRST read carries everything a
// look-in shows except aromas (the line-up, averages, people, each named
// person's score and structure, `hasAromas`); the DETAILS read the asked
// bottles' aromas for the named only (an opened Compare card). 🔒 No note and
// no rating photo in either (R15: notes never leave the moment).
// 🔒 The line-up through the ONE outside rule with a NULL viewer (no bypass: an
// outsider who added a bottle still sees it blind): a blind bottle not yet
// revealed → a blind row (scores, notes, aromas and structure, no photo of any
// kind); a hidden line-up → `lineupHidden`, no bottle and no rating, and no
// rating key read.
// People: the total is the same for every viewer (the room's own roster,
// `eligibleRoster`: current members, raters without a member row, the strict
// host, minus kicked and banned; a deleted account's ratings once per
// tombstone key; the guests in the identities hash). Only the NAMED
// (lib/momentAudience.ts) carry a name, a photo and their ratings; the rest
// count in `more`. Averages use every counted rater's score above 0.

export const NO_STORE = { 'Cache-Control': 'private, no-store' }
// 🔒 THE one refusal of the look-in and the by-moment read: flag off, a
// malformed id or token, unknown, deleted, closed, not admitted, banned, an
// outsider's block pair with the host (a member is answered `member: true`
// first), a dead link. Same bytes and headers every time.
export const lookInNotFound = () => NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE })
export const lookInJson = (body: unknown) => NextResponse.json(body, { headers: NO_STORE })

export type LookInRow = {
  id: number; code: string; public_id: string; name: string | null; host_name: string | null; host_user_id: number | null
  cover: string | null; category: string | null; date_from: Date | null; date_to: Date | null; timezone: string | null
  address: string | null; description: string | null; link: string | null; blind: boolean | null
  show_place: boolean | null; show_details: boolean | null; show_provenance: boolean | null
  created_at: Date | null; link_active: boolean | null; link_code: string | null; lineup_hidden: boolean
  lineup_reveals_at: Date | null
}

// A live row that can be looked into (`visibility` NULL reads as closed).
export async function readLookInRow(publicId: string): Promise<LookInRow | null> {
  const rows = await prisma.$queryRaw<LookInRow[]>`
    SELECT s.id, s.code, s.public_id, s.name, s.host_name, s.host_user_id, ${coverOutsideSql('s')} AS cover, s.category,
           s.date_from, s.date_to, s.timezone, s.address, s.description, s.link, s.blind, s.show_place, s.show_details,
           s.show_provenance, s.created_at, s.link_active, s.link_code, ${lineupHiddenNowSql('s')} AS lineup_hidden,
           -- The same expression as lineupHiddenNowSql's bound: what the date and the host's setting already imply.
           CASE WHEN COALESCE(s.hide_lineup, false) AND s.date_from IS NOT NULL
                THEN s.date_from - make_interval(mins => COALESCE(s.hide_lineup_minutes_before, 0)) END AS lineup_reveals_at
      FROM sessions s
     WHERE s.public_id = ${publicId} AND s.deleted_at IS NULL AND s.visibility IS NOT NULL`
  return rows[0] ?? null
}

// The link rule: the code stored on THIS moment (compared in constant time,
// for an unknown id or a moment without a code too, so each costs what a wrong
// code costs), the link active, a signed-in host.
export function lookInLinkValid(row: LookInRow | null, token: string): boolean {
  const ok = verifyMomentLinkCode(row?.link_code, token)
  return ok && row !== null && row.link_active === true && row.host_user_id !== null
}

// ── Guests without an account (the cache) ──────────────────────────────────

export const GUEST_ROSTER_MAX = 500
export const GUEST_NAMED_MAX = 100
export const GUEST_KEYS_MAX = 2000

// ONE script, bound to the incarnation the look-in authorized (codes recycle):
// KEYS meta, identities, shown, bans, kicked; ARGV the row's created_at (ms) and
// the roster bound. A roster over the bound (a flooded roster, R8) reads
// nothing more. Returns 'ok' then (id, name, shown) per guest still in the
// room, or a single status.
const GUEST_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'absent'} end
local ok, m = pcall(cjson.decode, raw)
if not ok or type(m) ~= 'table' or string.format('%.0f', tonumber(m.createdAt) or -1) ~= ARGV[1] then return {'mismatch'} end
if redis.call('HLEN', KEYS[2]) > tonumber(ARGV[2]) then return {'flooded'} end
local all = redis.call('HGETALL', KEYS[2])
local out = {'ok'}
for i = 1, #all, 2 do
  local id = all[i]
  if string.sub(id, 1, 2) == 'a:' and redis.call('SISMEMBER', KEYS[4], id) == 0 and redis.call('SISMEMBER', KEYS[5], id) == 0 then
    out[#out + 1] = id
    out[#out + 1] = all[i + 1]
    out[#out + 1] = tostring(redis.call('SISMEMBER', KEYS[3], id))
  end
end
return out`

export type GuestEntry = { id: string; name: string; shown: boolean }

// What the look-in reads of its guests (pure; the suite calls it directly):
// guests in identity order; their rating keys over the SURVIVING bottles only
// (none with a hidden line-up), at most GUEST_KEYS_MAX keys, never a SCAN; a
// guest whose keys don't fit is counted, never named, and adds no score. Of the
// guests read, the shown ones are named, at most GUEST_NAMED_MAX.
export function planGuestRead(code: string, guests: GuestEntry[], bottleIds: string[]) {
  const sorted = [...guests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const read = bottleIds.length === 0 ? sorted : sorted.slice(0, Math.floor(GUEST_KEYS_MAX / bottleIds.length))
  const pairs = read.flatMap(g => bottleIds.map(wineId => ({ guestId: g.id, wineId })))
  return {
    counted: sorted.length,
    read,
    named: read.filter(g => g.shown).slice(0, GUEST_NAMED_MAX),
    pairs,
    // rating-write: EXEMPT
    keys: pairs.map(p => k.rating(code, p.guestId, p.wineId)),
  }
}

// null = no guests (no meta, another incarnation, a flooded roster, a Redis error).
export async function readGuests(code: string, createdAt: Date | null): Promise<GuestEntry[] | null> {
  if (!createdAt) return null
  try {
    const r = await redis.eval(GUEST_SCRIPT, {
      keys: [k.meta(code), k.identities(code), k.shown(code), k.bans(code), k.kicked(code)],
      arguments: [String(createdAt.getTime()), String(GUEST_ROSTER_MAX)],
    }) as string[]
    if (r[0] !== 'ok') return null
    const out: GuestEntry[] = []
    for (let i = 1; i + 2 < r.length; i += 3) out.push({ id: r[i], name: r[i + 1], shown: r[i + 2] === '1' })
    return out
  } catch (err) {
    console.error('[look-in] guests unavailable:', err)
    return null
  }
}

// ── Stable keys (step-2 plan T2) ───────────────────────────────────────────

// K = HMAC-SHA256(auth secret, "verre-lookin-keys-v1"); the auth secret chain
// lib/registerToken.ts reads, but 🔒 with NO fallback: none → null, and every
// look-in body is the one 404. Keyed, never a plain hash: a legacy bottle keeps
// its 13-digit Date.now() id, which an outsider could otherwise recover from an
// unkeyed hash by trying every millisecond around the moment's creation (and
// a legacy blind id is label identity). Rotating the secret only changes the
// keys (an open card closes on the next read).
const KEYS_CONTEXT = 'verre-lookin-keys-v1'
export type LookInKeys = { bottle: (publicId: string, wineId: string) => string; guest: (publicId: string, guestUuid: string) => string }
export function lookInKeys(): LookInKeys | null {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET
  if (!secret) return null
  const K = createHmac('sha256', secret).update(KEYS_CONTEXT).digest()
  const mac = (kind: string, publicId: string, id: string) => createHmac('sha256', K).update(`${kind}\0${publicId}\0${id}`).digest('hex')
  return {
    bottle: (publicId, wineId) => mac('bottle', publicId, wineId).slice(0, 16),
    guest: (publicId, guestUuid) => `g${mac('guest', publicId, guestUuid).slice(0, 15)}`,
  }
}

// `?bottles=<key>[,<key>…]`: undefined = the first read; null = malformed (the
// one 404, like a malformed token): not exactly one parameter, 0 or more than
// LOOKIN_DETAILS_MAX keys, a key that is not 16 hex, a duplicate. The app sends
// at most 10 (its scheduler); 30 is the server's bound.
export const LOOKIN_DETAILS_MAX = 30
const BOTTLE_KEY = /^[0-9a-f]{16}$/
export function parseBottleKeys(params: URLSearchParams): string[] | null | undefined {
  const all = params.getAll('bottles')
  if (all.length === 0) return undefined
  if (all.length > 1) return null
  const keys = all[0].split(',')
  if (keys.length > LOOKIN_DETAILS_MAX || keys.some(key => !BOTTLE_KEY.test(key)) || new Set(keys).size !== keys.length) return null
  return keys
}

// ── The bodies ─────────────────────────────────────────────────────────────

type Aroma = { a: string; m: string | null; p?: true }
export type LookInPerson = { key: string; id?: string; name: string; imageUrl: string | null; guest?: true }
// The first read's rating: what Compare's cards and a bottle's page show.
export type LookInLightRating = { person: string; bottle: string; score: number | null; flavors: Record<string, number>; hasAromas?: true }
// The details read's rating: an opened Compare card's aromas, for the named only.
export type LookInAromaRating = { person: string; aromas: Aroma[] }
export type LookInBottle = { key: string; position: number } & (
  | { blind: true; colour: string | null; sparkling: boolean; avg: number | null; count: number }
  | {
      name: string; producer: string | null; vintage: string | null; grape: string | null
      colour: string | null; sparkling: boolean; abv: number | null; imageUrl: string | null; region: string | null
      country: string | null; vinification: string | null; description: string | null; purchaseUrl: string | null
      broughtBy: { id: string; name: string } | null; avg: number | null; count: number
    })
export type LookIn = {
  member: false
  moment: {
    id: string; name: string | null; coverPhotoUrl: string | null; category: string | null
    dateFrom: string | null; dateTo: string | null; blind: boolean
    timezone?: string | null; address?: string | null; description?: string | null; link?: string | null
    host: { id: string; name: string; imageUrl: string | null } | null
    lineupRevealsAt?: string
  }
  lineupHidden: boolean
  lineup: LookInBottle[]
  people: { total: number; named: LookInPerson[]; more: number }
  ratings: LookInLightRating[]
}
export type LookInDetails = { member: false; bottles: { key: string; ratings: LookInAromaRating[] }[] }

type Bottle = {
  id: string; name: string; producer: string | null; vintage: string | null; grape: string | null
  colour: string | null; sparkling: boolean; abv: Prisma.Decimal | null; image_url: string | null; region: string | null
  country: string | null; vinification: string | null; description: string | null; purchase_url: string | null
  added_by_identity_id: string | null; product_id: string | null; vintage_id: string | null; redacted: boolean; hidden: boolean
}
type RecordScore = { wine_id: string; user_id: number | null; tombstone_key: string | null; score: Prisma.Decimal | null }
type LightRow = { wine_id: string; user_id: number; score: Prisma.Decimal | null; flavors: unknown; has_aromas: boolean }
type AromaRow = { wine_id: string; user_id: number; aromas: unknown }
// One rating as read, before it is shaped for either body.
type Taste = { person: string; wineId: string; score: number | null; flavors: Record<string, number>; hasAromas: boolean; aromas: Aroma[] }

// 🔒 Projected, never passed through (review r1): an aroma to `{a, m, p?}`,
// structure to its NUMBER values (its keys are the axes, checked where they
// are written: validateFlavors).
const asFlavors = (v: unknown): Record<string, number> => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'number' && Number.isFinite(x)))
  : {})
const asAromas = (v: unknown): Aroma[] => (Array.isArray(v) ? v : []).flatMap((x): Aroma[] => {
  if (!x || typeof x !== 'object' || typeof x.a !== 'string') return []
  const m = typeof x.m === 'string' ? x.m : null
  return [x.p === true ? { a: x.a, m, p: true } : { a: x.a, m }]
})
// `asAromas(…).length > 0` in SQL (an element that is an object with a string
// `a`), so the first read never decodes the aromas themselves.
const HAS_AROMAS = Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.aromas) = 'array' THEN r.aromas ELSE '[]'::jsonb END) e
  WHERE jsonb_typeof(e) = 'object' AND jsonb_typeof(e -> 'a') = 'string')`
const iso = (d: Date | null) => d?.toISOString() ?? null

// What both reads share: the line-up (every surviving bottle, for positions and
// keys), the room, and the named people's ratings on the TARGET bottles (all of
// them for the first read, the asked ones for details). 🔒 Neither read selects
// a note or a rating photo (R15: notes never leave the moment; a moment's
// rating has no photo of its own). The first read adds the counted scores (the
// averages) and the catalogue entries.
// null = no key secret, or the moment went (or its code moved to another
// moment) while it was read: the caller answers the one 404.
async function readRoom(row: LookInRow, d: MomentDecision, asked: string[] | null) {
  const keys = lookInKeys()
  if (!keys) return null
  const details = asked !== null
  const { redacted, hidden: rowHidden } = outsideViewSql(null, { s: 's', w: 'w' })
  const all = row.lineup_hidden ? [] : (await prisma.$queryRaw<Bottle[]>`
    SELECT w.id, w.name, w.producer, w.vintage, w.grape, w.colour, w.sparkling, w.abv, w.image_url, w.region, w.country,
           w.vinification, w.description, w.purchase_url, w.added_by_identity_id, w.product_id, w.vintage_id,
           ${redacted} AS redacted, ${rowHidden} AS hidden
      FROM wines w JOIN sessions s ON s.id = w.session_id
     WHERE w.session_id = ${row.id} AND s.deleted_at IS NULL
     ORDER BY w.position NULLS LAST, w.created_at, w.id`).filter(b => b.hidden === false)
  const keyOf = new Map(all.map(b => [b.id, keys.bottle(row.public_id, b.id)]))
  const positionOf = new Map(all.map((b, i) => [b.id, i]))
  const askedSet = new Set(asked ?? [])
  // A key not in the line-up now is dropped, like a bottle that left.
  const bottles = details ? all.filter(b => askedSet.has(keyOf.get(b.id)!)) : all
  const roster = details && bottles.length === 0 ? null
    : await eligibleRoster(prisma, { id: row.id, code: row.code, hostUserId: row.host_user_id === null ? null : Number(row.host_user_id), createdAt: row.created_at })
  const counted = new Set(roster?.eligible.map(p => p.userId) ?? [])
  const namedIds = (roster?.eligible ?? []).map(p => p.userId).filter(id => d.named.has(id))
  const host = row.host_user_id === null ? null : Number(row.host_user_id)
  const users = roster === null ? [] : await prisma.user.findMany({
    where: { id: { in: [...new Set([...namedIds, ...(!details && host !== null && d.hostNamed ? [host] : [])])] } },
    select: { id: true, publicId: true, name: true, imageUrl: true },
  })
  const userOf = new Map(users.map(u => [u.id, u]))
  // Every rater's SCORE (the averages), and the named people's ratings: light
  // on the first read (score, structure, a flag for aromas), the aromas on the
  // details read (measured: decoding every rating's JSON was most of a big
  // moment's read, .local/moment-visibility/step1-plan.md § 12).
  const ids = bottles.map(b => b.id)
  const none = <T,>() => Promise.resolve([] as T[])
  const [entries, scoreRows, light, aromaRows, guests] = await Promise.all([
    details ? Promise.resolve(new Map() as Awaited<ReturnType<typeof loadEntriesSoft>>)
      : loadEntriesSoft(bottles.filter(b => !b.redacted).map(b => ({ productId: b.product_id, vintageId: b.vintage_id }))),
    details || ids.length === 0 ? none<RecordScore>() : prisma.$queryRaw<RecordScore[]>`
      SELECT r.wine_id, r.user_id, r.tombstone_key, r.score FROM ratings r
       WHERE r.session_id = ${row.id} AND r.wine_id = ANY(${ids}::text[])
         AND (r.user_id IS NOT NULL OR r.tombstone_key IS NOT NULL)
       ORDER BY r.rated_at ASC NULLS FIRST, r.mirror_at ASC NULLS FIRST, r.id ASC`,
    details || ids.length === 0 || namedIds.length === 0 ? none<LightRow>() : prisma.$queryRaw<LightRow[]>`
      SELECT r.wine_id, r.user_id, r.score, r.flavors, ${HAS_AROMAS} AS has_aromas
        FROM ratings r
       WHERE r.session_id = ${row.id} AND r.wine_id = ANY(${ids}::text[]) AND r.user_id = ANY(${namedIds}::int[])
       ORDER BY r.wine_id, r.user_id`,
    !details || ids.length === 0 || namedIds.length === 0 ? none<AromaRow>() : prisma.$queryRaw<AromaRow[]>`
      SELECT r.wine_id, r.user_id, r.aromas
        FROM ratings r
       WHERE r.session_id = ${row.id} AND r.wine_id = ANY(${ids}::text[]) AND r.user_id = ANY(${namedIds}::int[]) AND ${HAS_AROMAS}
       ORDER BY r.wine_id, r.user_id`,
    roster === null ? Promise.resolve(null) : readGuests(row.code, row.created_at),
  ])
  // 🔒 The guest SET (who is counted, who is named) is planned over the WHOLE
  // line-up, exactly as the first read plans it, whatever was asked (review
  // r1: planned over the asked bottles alone it would name and count more
  // guests); only the asked bottles' keys are then read.
  const guestPlan = guests ? planGuestRead(row.code, guests, all.map(b => b.id)) : null
  const idSet = new Set(ids)
  const pairs = (guestPlan?.pairs ?? []).map((p, i) => ({ ...p, key: guestPlan!.keys[i] })).filter(p => idSet.has(p.wineId))
  const guestValues = pairs.length > 0
    ? await redis.mGet(pairs.map(p => p.key)).catch((err: unknown) => { console.error('[look-in] guest ratings unavailable:', err); return null })
    : null

  // Named registered people in the room's order (key = public id), then named guests.
  const people: LookInPerson[] = []
  const keyOfUser = new Map<number, string>()
  for (const id of namedIds) {
    const u = userOf.get(id)
    if (!u) continue
    keyOfUser.set(id, u.publicId)
    people.push({ key: u.publicId, id: u.publicId, name: u.name, imageUrl: u.imageUrl })
  }
  const keyOfGuest = new Map<string, string>()
  for (const g of guestPlan?.named ?? []) {
    const gk = keys.guest(row.public_id, g.id.slice(2))
    keyOfGuest.set(g.id, gk)
    people.push({ key: gk, name: g.name, imageUrl: null, guest: true })
  }

  // Every counted score per bottle (users once, a tombstone key once: its latest).
  const scores = new Map<string, Map<string, number | null>>(bottles.map(b => [b.id, new Map()]))
  for (const r of scoreRows) {
    const who = r.user_id !== null ? (counted.has(Number(r.user_id)) ? `u${r.user_id}` : null) : `d${r.tombstone_key}`
    if (who) scores.get(r.wine_id)?.set(who, decimalToNumber(r.score))
  }
  const tastes: Taste[] = []
  for (const r of light) {
    const person = keyOfUser.get(Number(r.user_id))
    if (person) tastes.push({ person, wineId: r.wine_id, score: decimalToNumber(r.score), flavors: asFlavors(r.flavors), hasAromas: r.has_aromas === true, aromas: [] })
  }
  for (const r of aromaRows) {
    const person = keyOfUser.get(Number(r.user_id))
    const aromas = asAromas(r.aromas)
    if (person && aromas.length > 0) tastes.push({ person, wineId: r.wine_id, score: null, flavors: {}, hasAromas: true, aromas })
  }
  if (guestValues) {
    pairs.forEach(({ guestId, wineId }, i) => {
      const raw = guestValues[i]
      if (!raw) return
      let v: Record<string, unknown>
      try { v = JSON.parse(raw) } catch { return }
      if (!v || typeof v !== 'object') return
      const score = typeof v.score === 'number' && Number.isFinite(v.score) ? v.score : null
      scores.get(wineId)?.set(`g${guestId}`, score)
      const person = keyOfGuest.get(guestId)
      if (!person) return
      const aromas = asAromas(v.aromas)
      if (!details) tastes.push({ person, wineId, score, flavors: asFlavors(v.flavors), hasAromas: aromas.length > 0, aromas: [] })
      else if (aromas.length > 0) tastes.push({ person, wineId, score: null, flavors: {}, hasAromas: true, aromas })
    })
  }
  const order = new Map(people.map((p, i) => [p.key, i]))
  tastes.sort((a, b) => positionOf.get(a.wineId)! - positionOf.get(b.wineId)! || order.get(a.person)! - order.get(b.person)!)
  const tally = (wineId: string) => {
    const s = [...(scores.get(wineId)?.values() ?? [])].filter((x): x is number => x !== null && x > 0)
    return { avg: s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) / 100 : null, count: s.length }
  }
  // 🔒 The room was read by CODE (members, bans, guests): codes recycle, so the
  // row must still be this incarnation's after those reads (review r1). (An
  // empty details answer read nothing by code.)
  if (roster !== null) {
    const still = await prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM sessions WHERE id = ${row.id} AND code = ${row.code} AND deleted_at IS NULL) AS ok`
    if (!still[0]?.ok) return null
  }
  const total = roster ? roster.eligible.length + roster.tombstones.length + (guestPlan?.counted ?? 0) : 0
  return { bottles, keyOf, positionOf, people, tastes, tally, entries, userOf, total }
}

type Room = NonNullable<Awaited<ReturnType<typeof readRoom>>>

function bottleRow(row: LookInRow, d: MomentDecision, room: Room, b: Bottle): LookInBottle {
  const head = { key: room.keyOf.get(b.id)!, position: room.positionOf.get(b.id)! }
  if (b.redacted) return { ...head, blind: true, colour: b.colour, sparkling: b.sparkling, ...room.tally(b.id) }
  const e = b.product_id ? room.entries.get(entryKey(b.product_id, b.vintage_id)) : undefined
  const bringer = row.show_provenance !== false && b.added_by_identity_id?.startsWith('u:') ? Number(b.added_by_identity_id.slice(2)) : null
  const by = bringer !== null && d.named.has(bringer) ? room.userOf.get(bringer) : undefined
  return {
    ...head,
    name: e?.name ?? b.name,
    producer: e?.producer ?? b.producer,
    vintage: e ? (entryYear(e) || null) : b.vintage,
    grape: e ? (e.grapes.join(', ') || null) : b.grape,
    colour: b.colour,
    sparkling: b.sparkling,
    abv: b.abv === null ? null : Number(b.abv),
    imageUrl: b.image_url,
    region: e?.region ?? b.region,
    country: e?.country ?? b.country,
    vinification: b.vinification,
    description: b.description,
    purchaseUrl: b.purchase_url,
    broughtBy: by ? { id: by.publicId, name: by.name } : null,
    ...room.tally(b.id),
  }
}

// The first read (step-2 plan § 3.1).
export async function buildLookIn(row: LookInRow, d: MomentDecision): Promise<LookIn | null> {
  const room = await readRoom(row, d, null)
  if (!room) return null
  const host = row.host_user_id === null ? null : Number(row.host_user_id)
  const hostUser = host !== null && d.hostNamed ? room.userOf.get(host) : undefined
  const hidden = row.lineup_hidden
  return {
    member: false,
    moment: {
      id: row.public_id,
      // A nameless old moment reads as its host's name only while the host is named.
      name: row.name || (hostUser ? row.host_name : null) || null,
      coverPhotoUrl: row.cover,
      category: row.category,
      dateFrom: iso(row.date_from),
      dateTo: iso(row.date_to),
      blind: row.blind === true,
      ...(row.show_place === true ? { timezone: row.timezone, address: row.address } : {}),
      ...(row.show_details === true ? { description: row.description, link: row.link } : {}),
      host: hostUser ? { id: hostUser.publicId, name: hostUser.name, imageUrl: hostUser.imageUrl } : null,
      ...(hidden && row.lineup_reveals_at ? { lineupRevealsAt: row.lineup_reveals_at.toISOString() } : {}),
    },
    lineupHidden: hidden,
    lineup: room.bottles.map(b => bottleRow(row, d, room, b)),
    people: { total: room.total, named: room.people, more: Math.max(0, room.total - room.people.length) },
    ratings: room.tastes.map(t => ({
      person: t.person, bottle: room.keyOf.get(t.wineId)!, score: t.score, flavors: t.flavors, ...(t.hasAromas ? { hasAromas: true as const } : {}),
    })),
  }
}

// The details read (step-2 plan § 3.2, R15): the asked bottles still in the
// line-up, in its order, each with the named people's AROMAS (only those who
// have any). Every asked bottle that is still there is answered, with or without
// aromas, so the app knows it was read.
export async function buildLookInDetails(row: LookInRow, d: MomentDecision, asked: string[]): Promise<LookInDetails | null> {
  const room = await readRoom(row, d, asked)
  if (!room) return null
  return {
    member: false,
    bottles: room.bottles.map(b => ({
      key: room.keyOf.get(b.id)!,
      ratings: room.tastes.filter(t => t.wineId === b.id).map(t => ({ person: t.person, aromas: t.aromas })),
    })),
  }
}
