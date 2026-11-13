// The D4 state matrix (lists plan § Verification): the outside-a-moment SQL
// rule (lib/outsideView.ts) AND the tile photo rule SAFE_PHOTO
// (lib/profileTiles.ts) evaluated by Postgres over every combination of the
// record states they read, against an oracle written from the plan's prose.
// The oracle lives HERE only (a test oracle, never a runtime twin). Imported
// by scripts/tests/you-profile-integration.mts (§ 19) and run alone for the
// mutation checks; the caller owns the database (a THROWAWAY one) and the
// users (real rows: the sessions / members reference them).
//
// Dimensions: blind × revealed × deleted × over-by-dates (none / future / by
// date_to / by date_from + 48 h / by created_at + 48 h / started, not over) ×
// Blind for All × strict host (or hostless) × adder (u: / legacy NULL / a:),
// for viewers signed out / a stranger / the host / the adder; and Hide
// Line-up × start (none / +2 h / +10 min / past) × minutes (NULL / 0 / 30) ×
// deleted × host, for viewers signed out / a stranger / the strict host / a
// current cohost / a kicked cohost / a banned cohost / a taster.
import { Prisma, type PrismaClient } from '@prisma/client'

type Check = (label: string, ok: boolean, detail?: unknown) => void
export type MatrixUsers = { host: number; adder: number; stranger: number; cohost: number; kickedCohost: number; bannedCohost: number; taster: number }

const H = 3600_000
const SPAN = 48 * H

export async function outsideViewMatrix(prisma: PrismaClient, check: Check, u: MatrixUsers, tag: string) {
  const { redactedSql, hiddenSql } = await import('../../lib/outsideView.ts')
  const { SAFE_PHOTO } = await import('../../lib/profileTiles.ts')
  const now = Date.now()
  let seq = 0
  const code = () => `MX${tag.slice(-6)}${(seq++).toString(36)}`.slice(0, 16).toUpperCase()
  const wid = () => `mx${tag.slice(-6)}_${(seq++).toString(36)}`.slice(0, 21)
  const anon = 'a:0f0e0d0c-0b0a-4908-8706-050403020100'

  type S = {
    code: string; wine: string; host: number | null; blind: boolean | null; bfe: boolean | null; deleted: boolean
    createdAt: number | null; dateFrom: number | null; dateTo: number | null
    hide: boolean | null; minutes: number | null; revealed: boolean; adder: string | null
  }
  const rowsA: S[] = []
  const DATES: Record<string, Pick<S, 'createdAt' | 'dateFrom' | 'dateTo'>> = {
    none: { createdAt: null, dateFrom: null, dateTo: null },
    future: { createdAt: now - H, dateFrom: now + 5 * H, dateTo: null },
    overByTo: { createdAt: now - 100 * H, dateFrom: now - 10 * H, dateTo: now - H },
    overByFrom: { createdAt: now - 100 * H, dateFrom: now - SPAN - H, dateTo: null },
    overByCreated: { createdAt: now - SPAN - H, dateFrom: null, dateTo: null },
    started: { createdAt: now - 3 * H, dateFrom: now - 2 * H, dateTo: null },
  }
  for (const blind of [null, false, true])
    for (const revealed of [false, true])
      for (const deleted of [false, true])
        for (const d of Object.keys(DATES))
          for (const bfe of [null, false, true])
            for (const host of [u.host, null])
              for (const adder of [`u:${u.adder}`, null, anon])
                rowsA.push({ code: code(), wine: wid(), host, blind, bfe, deleted, ...DATES[d], hide: null, minutes: null, revealed, adder })

  const rowsB: S[] = []
  for (const hide of [null, false, true])
    for (const start of [null, now + 2 * H, now + 10 * 60_000, now - H])
      for (const minutes of [null, 0, 30])
        for (const deleted of [false, true])
          for (const host of [u.host, null])
            rowsB.push({ code: code(), wine: wid(), host, blind: null, bfe: null, deleted, createdAt: now - H, dateFrom: start, dateTo: null, hide, minutes, revealed: false, adder: null })

  const ts = (v: number | null) => (v === null ? null : new Date(v))
  const all = [...rowsA, ...rowsB]
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200)
    await prisma.$executeRaw`
      INSERT INTO sessions (code, host_user_id, blind, blind_for_everyone, created_at, date_from, date_to, deleted_at, hide_lineup, hide_lineup_minutes_before)
      VALUES ${Prisma.join(chunk.map(s => Prisma.sql`(${s.code}, ${s.host}::integer, ${s.blind}::boolean, ${s.bfe}::boolean, ${ts(s.createdAt)}::timestamptz,
        ${ts(s.dateFrom)}::timestamptz, ${ts(s.dateTo)}::timestamptz, ${s.deleted ? new Date(now - H) : null}::timestamptz, ${s.hide}::boolean, ${s.minutes}::integer)`))}`
    await prisma.$executeRaw`
      INSERT INTO wines (id, session_id, name, revealed_at, added_by_identity_id)
      SELECT v.id, s.id, 'Matrix Bottle', v.revealed_at, v.adder
        FROM (VALUES ${Prisma.join(chunk.map(s => Prisma.sql`(${s.wine}, ${s.code}, ${s.revealed ? new Date(now - H) : null}::timestamptz, ${s.adder}::varchar)`))}) AS v(id, code, revealed_at, adder)
        JOIN sessions s ON s.code = v.code`
  }
  // A standalone bottle (no moment): never redacted, never hidden, always safe.
  const lone = wid()
  await prisma.$executeRaw`INSERT INTO wines (id, name) VALUES (${lone}, 'Matrix Standalone')`
  // Members of every Hide Line-up moment: a current cohost, a kicked one (the
  // guard, though a kick also demotes), a banned one, a taster.
  await prisma.$executeRaw`
    INSERT INTO session_members (user_id, session_code, role, removed_state)
    SELECT m.uid, c.code, m.role, m.removed
      FROM unnest(${rowsB.map(s => s.code)}::varchar[]) AS c(code)
      CROSS JOIN (VALUES (${u.cohost}::integer, 'co_host', NULL::varchar), (${u.kickedCohost}::integer, 'co_host', 'kicked'),
                         (${u.bannedCohost}::integer, 'co_host', NULL), (${u.taster}::integer, 'taster', NULL)) AS m(uid, role, removed)`
  await prisma.$executeRaw`
    INSERT INTO session_bans (session_code, identity_id)
    SELECT c.code, ${`u:${u.bannedCohost}`} FROM unnest(${rowsB.map(s => s.code)}::varchar[]) AS c(code)`

  // ── the oracle (the plan's prose) ──
  const over = (s: S) => {
    const end = s.dateTo ?? (s.dateFrom !== null ? s.dateFrom + SPAN : s.createdAt !== null ? s.createdAt + SPAN : null)
    return end !== null && now > end
  }
  const redacted = (s: S | null, v: number | null) => {
    if (!s) return false
    const bypass = s.bfe !== true && ((s.host !== null && s.host === v) || (v !== null && s.adder === `u:${v}`))
    return s.blind === true && !s.revealed && !s.deleted && !over(s) && !bypass
  }
  const hiddenNow = (s: S | null) => !!s && s.hide === true && s.dateFrom !== null && now < s.dateFrom - (s.minutes ?? 0) * 60_000
  const hidden = (s: S | null, v: number | null) => {
    if (!hiddenNow(s)) return false
    const strict = s!.host !== null && s!.host === v
    const cohost = v === u.cohost && rowsB.includes(s!)
    return !(strict || cohost)
  }
  const safe = (s: S | null) => (!s || s.deleted || s.blind !== true || s.revealed) && !hiddenNow(s)

  const byWine = new Map<string, S | null>(all.map(s => [s.wine, s]))
  byWine.set(lone, null)
  const ids = [...byWine.keys()]
  const viewers: [string, number | null][] = [
    ['signed out', null], ['a stranger', u.stranger], ['the strict host', u.host], ['the adder', u.adder],
    ['a current cohost', u.cohost], ['a kicked cohost', u.kickedCohost], ['a banned cohost', u.bannedCohost], ['a taster', u.taster],
  ]
  for (const [label, v] of viewers) {
    const rows = await prisma.$queryRaw<{ id: string; redacted: boolean | null; hidden: boolean | null }[]>`
      SELECT w.id, ${redactedSql(v, 's', 'w')} AS redacted, ${hiddenSql(v, 's')} AS hidden
        FROM wines w LEFT JOIN sessions s ON s.id = w.session_id
       WHERE w.id = ANY(${ids}::varchar[])`
    const badR = rows.filter(r => r.redacted !== redacted(byWine.get(r.id) ?? null, v))
    const badH = rows.filter(r => r.hidden !== hidden(byWine.get(r.id) ?? null, v))
    check(`D4 matrix, ${label}: redacted matches the rule on all ${rows.length} bottles (never NULL)`, rows.length === ids.length && badR.length === 0,
      badR.slice(0, 3).map(r => ({ got: r.redacted, s: byWine.get(r.id) })))
    check(`D4 matrix, ${label}: hidden matches the rule on all ${rows.length} bottles (never NULL)`, rows.length === ids.length && badH.length === 0,
      badH.slice(0, 3).map(r => ({ got: r.hidden, s: byWine.get(r.id) })))
  }
  const photo = await prisma.$queryRaw<{ id: string; safe: boolean | null }[]>`
    SELECT w.id, ${SAFE_PHOTO} AS safe FROM wines w LEFT JOIN sessions s ON s.id = w.session_id WHERE w.id = ANY(${ids}::varchar[])`
  const badP = photo.filter(r => r.safe !== safe(byWine.get(r.id) ?? null))
  check(`SAFE_PHOTO matches its stricter rule on all ${photo.length} bottles (no bypass, hidden line-ups out)`, photo.length === ids.length && badP.length === 0,
    badP.slice(0, 3).map(r => ({ got: r.safe, s: byWine.get(r.id) })))
  // The subset relation, stated: a photo SAFE_PHOTO admits is never redacted
  // or hidden for ANY viewer.
  check('SAFE_PHOTO is a subset: no admitted photo is redacted or hidden for any viewer',
    photo.every(r => !r.safe || viewers.every(([, v]) => !redacted(byWine.get(r.id) ?? null, v) && !hidden(byWine.get(r.id) ?? null, v))))
  return { sessions: all.map(s => s.code), wines: ids }
}
