// The Prisma session time zone is pinned to UTC (lib/pgSession.mjs).
//
// @prisma/adapter-pg 7.x assumes a UTC session: it rewrites the offset of a
// timestamptz it reads to +00:00 and sends Date parameters without an offset.
// Production Postgres defaults to Europe/Zurich, so without the pin app-written
// timestamps were stored 1–2 h early and database-stamped ones read 1–2 h late
// (measured on prod 2026-11-08). Every other suite runs against a UTC database
// and could never see it — this one runs against a database whose DEFAULT zone
// is Europe/Zurich and refuses to run otherwise.
//
//   DATABASE_URL=postgres://…/<db with ALTER DATABASE … SET timezone TO 'Europe/Zurich'> \
//     npx tsx scripts/tests/pg-timezone-integration.mjs
//
// Both connection builders are checked: the app client (lib/prisma.ts) and the
// script factory (scripts/lib/prismaClient.mjs). For each: the session zone,
// the READ path (a server-side literal), the WRITE path (a Date parameter, read
// back as server-side UTC text), a typed write + read on a real table, and
// now() against the process clock — summer and winter dates both, because the
// Zurich offset differs between them. Then the precedence cases: a URL that
// carries `options` (which pg lets win over config) or a NUL-injected startup
// parameter is refused, TLS-dependent pg validation is not tripped, and
// PGOPTIONS is kept without displacing the pin.
import { prisma as appClient } from '../../lib/prisma.ts'
import { createPrismaClient } from '../lib/prismaClient.mjs'

let pass = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${JSON.stringify(detail)}` : ''}`) }
}

const scriptClient = createPrismaClient()
const utcText = (col) => `to_char((${col}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`

// Not vacuous: the DATABASE default must be a non-UTC zone.
const [dflt] = await scriptClient.$queryRawUnsafe(`
  SELECT array_to_string(s.setconfig, ',') AS cfg
    FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
   WHERE d.datname = current_database() AND s.setrole = 0`)
const cfg = dflt?.cfg ?? ''
if (!/TimeZone=Europe\/Zurich/i.test(cfg)) {
  console.error(`refusing to run: this database's default zone must be Europe/Zurich (ALTER DATABASE … SET timezone TO 'Europe/Zurich'); found ${JSON.stringify(cfg)}`)
  process.exit(2)
}

for (const [name, db] of [['app client (lib/prisma.ts)', appClient], ['script factory (scripts/lib/prismaClient.mjs)', scriptClient]]) {
  console.log(`\n${name}`)
  const [tz] = await db.$queryRawUnsafe('SHOW TimeZone')
  check('session TimeZone is UTC on a Europe/Zurich database', tz?.TimeZone === 'UTC', tz)
  for (const iso of ['2026-07-01T12:00:00.000Z', '2026-01-15T12:00:00.000Z']) {
    const d = new Date(iso)
    const [lit] = await db.$queryRawUnsafe(`SELECT '${iso}'::timestamptz AS t`)
    check(`READ: a server-side ${iso.slice(5, 7) === '07' ? 'summer' : 'winter'} instant reads back unchanged`, lit.t.toISOString() === iso, lit.t.toISOString())
    const [w] = await db.$queryRaw`SELECT to_char((${d}::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS s`
    check(`WRITE: a Date parameter is stored as the same instant (${iso.slice(0, 10)})`, w.s === iso.replace('.000Z', 'Z'), w.s)
    const row = await db.session.create({ data: { code: `TZ${Date.now().toString(36).slice(-6).toUpperCase()}`, hostName: 'tz', createdAt: d }, select: { id: true } })
    const [stored] = await db.$queryRawUnsafe(`SELECT ${utcText('created_at')} AS s FROM sessions WHERE id = ${row.id}`)
    const typed = await db.session.findUnique({ where: { id: row.id }, select: { createdAt: true } })
    check(`TYPED: create stores the instant and findUnique returns it (${iso.slice(0, 10)})`,
      stored.s === iso.replace('.000Z', 'Z') && typed.createdAt.toISOString() === iso, { stored: stored.s, typed: typed.createdAt.toISOString() })
    // Soft-delete scrub (a trigger blocks DELETE FROM sessions).
    await db.$executeRaw`UPDATE sessions SET deleted_at = now(), code = NULL WHERE id = ${row.id}`
  }
  const t0 = Date.now()
  const [n] = await db.$queryRawUnsafe('SELECT now() AS now')
  const drift = Math.abs(n.now.getTime() - (t0 + Date.now()) / 2)
  check('now() reads within 60 s of the process clock', drift < 60_000, { driftMs: drift })
}

// pg lets the URL win: an `options` query parameter would REPLACE the pin (an
// empty one falls through to PGOPTIONS), and a NUL byte in a startup field
// injects a separate TimeZone parameter that Postgres applies after `options`.
// So a URL doing either, in ANY form pg recognises, is refused at construction.
console.log('\nURLs that would drop the pin are refused (script factory)')
const base = process.env.DATABASE_URL
const q = (tail) => `${base}${base.includes('?') ? '&' : '?'}${tail}`
const OPTIONS_ERR = /move it to PGOPTIONS/
for (const [label, url, expect] of [
  ['a URL options value', q('options=-c%20statement_timeout%3D4321'), OPTIONS_ERR],
  ['an EMPTY URL options', q('options='), OPTIONS_ERR],
  ['a bare URL options key', q('options'), OPTIONS_ERR],
  ['a percent-encoded options key', q('%6Fptions=-c%20TimeZone%3DEurope%2FZurich'), OPTIONS_ERR],
  ['a repeated options key', q('options=-c%20statement_timeout%3D0&options=-c%20statement_timeout%3D4321'), OPTIONS_ERR],
  ['a host-less URL (pg parses it, WHATWG URL does not)', 'postgres://someone@/somedb?options', OPTIONS_ERR],
  ['a NUL byte injecting a TimeZone startup parameter', q('application_name=review%00TimeZone%00Europe%2FZurich'), /NUL byte/],
]) {
  let err = null
  try { await createPrismaClient({ url }).$disconnect() } catch (e) { err = e }
  check(`refused: ${label}`, expect.test(err?.message ?? ''), err?.message ?? 'no error')
}
// The guard validates the COMPLETE config, TLS included: pg rejects
// sslnegotiation=direct without `ssl`, so a guard that left TLS out would
// refuse a valid setup. Construction only — nothing connects.
{
  const saved = { ca: process.env.DATABASE_CA_CERT, neg: process.env.PGSSLNEGOTIATION }
  process.env.DATABASE_CA_CERT = '-----BEGIN CERTIFICATE-----\nnot-used\n-----END CERTIFICATE-----'
  process.env.PGSSLNEGOTIATION = 'direct'
  let err = null
  try { createPrismaClient({ url: base }) } catch (e) { err = e }
  check('accepted: PGSSLNEGOTIATION=direct with a CA certificate (the guard sees TLS)', err === null, err?.message)
  for (const [k, v] of [['DATABASE_CA_CERT', saved.ca], ['PGSSLNEGOTIATION', saved.neg]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
}
console.log('\nPGOPTIONS is merged and the pin goes last (script factory)')
for (const [label, env, timeout] of [
  ['PGOPTIONS is kept and the pin holds', '-c statement_timeout=4322', '4322ms'],
  ['a PGOPTIONS -c TimeZone loses to the pin', '-c TimeZone=Europe/Zurich', null],
]) {
  const saved = process.env.PGOPTIONS
  process.env.PGOPTIONS = env
  try {
    const db = createPrismaClient({ url: base })
    try {
      const [tz] = await db.$queryRawUnsafe('SHOW TimeZone')
      const [st] = await db.$queryRawUnsafe('SHOW statement_timeout')
      check(label, tz?.TimeZone === 'UTC' && (timeout === null || st?.statement_timeout === timeout), { tz: tz?.TimeZone, statement_timeout: st?.statement_timeout })
    } finally { await db.$disconnect() }
  } finally {
    if (saved === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = saved
  }
}

console.log(`\n${pass} passed, ${failed} failed`)
await appClient.$disconnect()
await scriptClient.$disconnect()
process.exit(failed === 0 ? 0 : 1)
