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
import { verifyMomentLinkToken } from '@/lib/momentLink'
import type { MomentDecision } from '@/lib/momentAudience'

// The look-in (docs/dev/proposals/moment-visibility.md § 7; step-1 plan § 4.1):
// what someone outside a moment sees of it. Read from the RECORD; the cache
// only for the guests without an account, and never opened or rebuilt (list
// reads never rebuild, lib/CLAUDE.md).
//
// 🔒 A NEW allow-list builder, never metaToWire / buildMetaView (they carry the
// code). No code, no wine id, no rating id, no username, no integer, no `a:` /
// `u:` / `d:` identity. `position` is the index in THIS output, a person's
// `key` a label of this response (`p0`…, guests `g0`…).
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
  created_at: Date | null; link_version: number | null; link_active: boolean | null; lineup_hidden: boolean
}

// A live row that can be looked into (`visibility` NULL reads as closed).
export async function readLookInRow(publicId: string): Promise<LookInRow | null> {
  const rows = await prisma.$queryRaw<LookInRow[]>`
    SELECT s.id, s.code, s.public_id, s.name, s.host_name, s.host_user_id, ${coverOutsideSql('s')} AS cover, s.category,
           s.date_from, s.date_to, s.timezone, s.address, s.description, s.link, s.blind, s.show_place, s.show_details,
           s.show_provenance, s.created_at, s.link_version, s.link_active, ${lineupHiddenNowSql('s')} AS lineup_hidden
      FROM sessions s
     WHERE s.public_id = ${publicId} AND s.deleted_at IS NULL AND s.visibility IS NOT NULL`
  return rows[0] ?? null
}

// The link rule (the HMAC is computed for an unknown id too, so a wrong id and
// a wrong token cost the same): active, the version matches, a signed-in host,
// the secret usable (verify fails closed without it).
export function lookInLinkValid(publicId: string, row: LookInRow | null, token: string): boolean {
  const version = row?.link_version ?? 0
  const ok = verifyMomentLinkToken(publicId, Math.max(1, version), token)
  return ok && row !== null && version >= 1 && row.link_active === true && row.host_user_id !== null
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

// ── The body ───────────────────────────────────────────────────────────────

type Aroma = { a: string; m: string | null; p?: true }
type Taste = { score: number | null; notes: string | null; flavors: Record<string, number>; aromas: Aroma[] }
export type LookInPerson = { key: string; id?: string; name: string; imageUrl: string | null; guest?: true }
export type LookInRating = { person: string; position: number } & Taste & { imageUrl?: string }
export type LookInBottle =
  | { position: number; blind: true; colour: string | null; sparkling: boolean; avg: number | null; count: number }
  | {
      position: number; name: string; producer: string | null; vintage: string | null; grape: string | null
      colour: string | null; sparkling: boolean; abv: number | null; imageUrl: string | null; region: string | null
      country: string | null; vinification: string | null; description: string | null; purchaseUrl: string | null
      broughtBy: { id: string; name: string } | null; avg: number | null; count: number
    }
export type LookIn = {
  member: false
  moment: {
    id: string; name: string | null; coverPhotoUrl: string | null; category: string | null
    dateFrom: string | null; dateTo: string | null; blind: boolean
    timezone?: string | null; address?: string | null; description?: string | null; link?: string | null
    host: { id: string; name: string; imageUrl: string | null } | null
  }
  lineupHidden: boolean
  lineup: LookInBottle[]
  people: { total: number; named: LookInPerson[]; more: number }
  ratings: LookInRating[]
}

type Bottle = {
  id: string; name: string; producer: string | null; vintage: string | null; grape: string | null
  colour: string | null; sparkling: boolean; abv: Prisma.Decimal | null; image_url: string | null; region: string | null
  country: string | null; vinification: string | null; description: string | null; purchase_url: string | null
  added_by_identity_id: string | null; product_id: string | null; vintage_id: string | null; redacted: boolean; hidden: boolean
}
type RecordScore = { wine_id: string; user_id: number | null; tombstone_key: string | null; score: Prisma.Decimal | null }
type RecordRating = { wine_id: string; user_id: number; score: Prisma.Decimal | null; notes: string | null; flavors: unknown; aromas: unknown; image_url: string | null }

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
const iso = (d: Date | null) => d?.toISOString() ?? null

// null = the moment went (or its code moved to another moment) while it was
// read: the caller answers the one 404.
export async function buildLookIn(row: LookInRow, d: MomentDecision): Promise<LookIn | null> {
  const hidden = row.lineup_hidden
  const { redacted, hidden: rowHidden } = outsideViewSql(null, { s: 's', w: 'w' })
  const bottles = hidden ? [] : (await prisma.$queryRaw<Bottle[]>`
    SELECT w.id, w.name, w.producer, w.vintage, w.grape, w.colour, w.sparkling, w.abv, w.image_url, w.region, w.country,
           w.vinification, w.description, w.purchase_url, w.added_by_identity_id, w.product_id, w.vintage_id,
           ${redacted} AS redacted, ${rowHidden} AS hidden
      FROM wines w JOIN sessions s ON s.id = w.session_id
     WHERE w.session_id = ${row.id} AND s.deleted_at IS NULL
     ORDER BY w.position NULLS LAST, w.created_at, w.id`).filter(b => b.hidden === false)
  const roster = await eligibleRoster(prisma, { id: row.id, code: row.code, hostUserId: row.host_user_id === null ? null : Number(row.host_user_id), createdAt: row.created_at })
  const counted = new Set(roster.eligible.map(p => p.userId))
  const namedIds = roster.eligible.map(p => p.userId).filter(id => d.named.has(id))
  const host = row.host_user_id === null ? null : Number(row.host_user_id)
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set([...namedIds, ...(host !== null && d.hostNamed ? [host] : [])])] } },
    select: { id: true, publicId: true, name: true, imageUrl: true },
  })
  const userOf = new Map(users.map(u => [u.id, u]))
  // Every rater's SCORE (the averages), and the whole rating only for the
  // named (measured: decoding every rating's notes and JSON was most of a
  // big moment's read, .local/moment-visibility/step1-plan.md § 12).
  const bottleIds = bottles.map(b => b.id)
  const [entries, scoreRows, ratings, guests] = await Promise.all([
    loadEntriesSoft(bottles.filter(b => !b.redacted).map(b => ({ productId: b.product_id, vintageId: b.vintage_id }))),
    bottles.length === 0 ? Promise.resolve([] as RecordScore[]) : prisma.$queryRaw<RecordScore[]>`
      SELECT r.wine_id, r.user_id, r.tombstone_key, r.score FROM ratings r
       WHERE r.session_id = ${row.id} AND r.wine_id = ANY(${bottleIds}::text[])
         AND (r.user_id IS NOT NULL OR r.tombstone_key IS NOT NULL)
       ORDER BY r.rated_at ASC NULLS FIRST, r.mirror_at ASC NULLS FIRST, r.id ASC`,
    bottles.length === 0 || namedIds.length === 0 ? Promise.resolve([] as RecordRating[]) : prisma.$queryRaw<RecordRating[]>`
      SELECT r.wine_id, r.user_id, r.score, r.notes, r.flavors, r.aromas,
             (SELECT ri.image_url FROM rating_images ri WHERE ri.rating_id = r.id ORDER BY ri.sort_order ASC LIMIT 1) AS image_url
        FROM ratings r
       WHERE r.session_id = ${row.id} AND r.wine_id = ANY(${bottleIds}::text[]) AND r.user_id = ANY(${namedIds}::int[])
       ORDER BY r.wine_id, r.user_id`,
    readGuests(row.code, row.created_at),
  ])
  const guestPlan = guests ? planGuestRead(row.code, guests, bottleIds) : null
  const guestValues = guestPlan && guestPlan.keys.length > 0
    ? await redis.mGet(guestPlan.keys).catch((err: unknown) => { console.error('[look-in] guest ratings unavailable:', err); return null })
    : null

  // Keys of this response: named registered people in the room's order, then named guests.
  const people: LookInPerson[] = []
  const keyOfUser = new Map<number, string>()
  for (const id of namedIds) {
    const u = userOf.get(id)
    if (!u) continue
    keyOfUser.set(id, `p${keyOfUser.size}`)
    people.push({ key: keyOfUser.get(id)!, id: u.publicId, name: u.name, imageUrl: u.imageUrl })
  }
  const keyOfGuest = new Map<string, string>()
  for (const g of guestPlan?.named ?? []) {
    keyOfGuest.set(g.id, `g${keyOfGuest.size}`)
    people.push({ key: keyOfGuest.get(g.id)!, name: g.name, imageUrl: null, guest: true })
  }

  // Every counted score per bottle (users once, a tombstone key once: its latest).
  const position = new Map(bottles.map((b, i) => [b.id, i]))
  const scores = new Map<string, Map<string, number | null>>(bottles.map(b => [b.id, new Map()]))
  const out: LookInRating[] = []
  const blind = new Map(bottles.map(b => [b.id, b.redacted]))
  const taste = (t: Taste, person: string, wineId: string, imageUrl: string | null) => {
    const r: LookInRating = { person, position: position.get(wineId)!, ...t }
    if (!blind.get(wineId) && imageUrl) r.imageUrl = imageUrl
    out.push(r)
  }
  for (const r of scoreRows) {
    const who = r.user_id !== null ? (counted.has(Number(r.user_id)) ? `u${r.user_id}` : null) : `d${r.tombstone_key}`
    if (who) scores.get(r.wine_id)?.set(who, decimalToNumber(r.score))
  }
  for (const r of ratings) {
    const key = keyOfUser.get(Number(r.user_id))
    if (key) taste({ score: decimalToNumber(r.score), notes: r.notes, flavors: asFlavors(r.flavors), aromas: asAromas(r.aromas) }, key, r.wine_id, r.image_url)
  }
  if (guestPlan && guestValues) {
    guestPlan.pairs.forEach(({ guestId, wineId }, i) => {
      const raw = guestValues[i]
      if (!raw) return
      let v: Record<string, unknown>
      try { v = JSON.parse(raw) } catch { return }
      if (!v || typeof v !== 'object') return
      const score = typeof v.score === 'number' && Number.isFinite(v.score) ? v.score : null
      scores.get(wineId)?.set(`g${guestId}`, score)
      const gk = keyOfGuest.get(guestId)
      if (gk) taste({ score, notes: typeof v.notes === 'string' && v.notes ? v.notes : null, flavors: asFlavors(v.flavors), aromas: asAromas(v.aromas) }, gk, wineId, null)
    })
  }
  const order = new Map(people.map((p, i) => [p.key, i]))
  out.sort((a, b) => a.position - b.position || order.get(a.person)! - order.get(b.person)!)
  const tally = (wineId: string) => {
    const s = [...(scores.get(wineId)?.values() ?? [])].filter((x): x is number => x !== null && x > 0)
    return { avg: s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) / 100 : null, count: s.length }
  }

  const provenance = row.show_provenance !== false
  const lineup = bottles.map((b, i): LookInBottle => {
    if (b.redacted) return { position: i, blind: true, colour: b.colour, sparkling: b.sparkling, ...tally(b.id) }
    const e = b.product_id ? entries.get(entryKey(b.product_id, b.vintage_id)) : undefined
    const bringer = provenance && b.added_by_identity_id?.startsWith('u:') ? Number(b.added_by_identity_id.slice(2)) : null
    const by = bringer !== null && d.named.has(bringer) ? userOf.get(bringer) : undefined
    return {
      position: i,
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
      ...tally(b.id),
    }
  })

  const hostUser = host !== null && d.hostNamed ? userOf.get(host) : undefined
  // 🔒 The room was read by CODE (members, bans): codes recycle, so the row
  // must still be this incarnation's after those reads (review r1).
  const still = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM sessions WHERE id = ${row.id} AND code = ${row.code} AND deleted_at IS NULL) AS ok`
  if (!still[0]?.ok) return null
  const total = roster.eligible.length + roster.tombstones.length + (guestPlan?.counted ?? 0)
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
    },
    lineupHidden: hidden,
    lineup,
    people: { total, named: people, more: Math.max(0, total - people.length) },
    ratings: out,
  }
}
