// The Redis half of the catalogue replacement's zero-reference check (spec
// wine-catalog-model-change.md § "Catalogue flush"; build plan step 1b). The
// catalogue-maintenance side's report counts the links Postgres holds; a guest
// moment lives only in Redis, and its cached line-up (`s:{CODE}:wines`) can
// carry a `productId` / `vintageId` that no foreign key sees. Run it right
// before the replacement, after their report.
//
//   REDIS_URL=… npx tsx scripts/scan-redis-catalogue-links.mts [--removed <file>] [--merged <file>]
//
// 🔒 READ-ONLY: SCAN, TYPE and GET, nothing else. REDIS_URL must be set in the
// environment (no default, no .env: lib/redis.ts falls back to localhost, which
// would scan the wrong instance and report a clean zero).
//
// Reports every cached bottle that carries a catalogue id (expected: none, the
// same rule as the Postgres side) and flags the ones whose id is in the removed
// or merged lists: those would point at nothing after the replacement. The
// lists are the catalogue-maintenance side's (confirmed 2026-11-20): CSV with a
// header, read BY HEADER NAME: `removed.csv` is `entity,id`, `merged.csv` is
// `entity,loser_id,survivor_id` (the loser is the id that goes; the survivor
// stays and is not flagged); `entity` is producer, product or vintage. Any id
// of any entity is matched against both fields (fail-safe: a mislabelled row
// still flags). 🔒 A malformed list REFUSES (exit 2, the line named): a
// skipped line could hide a link that dangles after the replacement.
// Every line-up key is read, Redis-only and record-backed moments alike (a
// record-backed moment's links are in Postgres too, where the report counts
// them). Moment codes are printed, as in warm-lineups.mts, so the operator can
// act on them; bottle and people names are not.
//
// Exit 0: no cached bottle links to the catalogue. 1: at least one does (in
// the report). 2: usage or setup.
import { readFileSync } from 'node:fs'
import { createClient } from 'redis'

const ID = /^[A-Za-z0-9_-]{1,21}$/
const KEY = /^s:([^:]+):wines$/
const args = process.argv.slice(2)
const flagValue = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const files = { removed: flagValue('--removed'), merged: flagValue('--merged') }
const known = new Set(['--removed', '--merged', files.removed, files.merged])
if (args.some(a => !known.has(a)) || (args.includes('--removed') && !files.removed) || (args.includes('--merged') && !files.merged)) {
  console.error('usage: scan-redis-catalogue-links.mts [--removed <file>] [--merged <file>]')
  process.exit(2)
}
const url = process.env.REDIS_URL
if (!url) {
  console.error('scan-redis-catalogue-links: REDIS_URL is not set in the environment (no default, no .env)')
  process.exit(2)
}
let where: string
try { const u = new URL(url); where = `${u.protocol}//${u.host}${u.pathname}` }
catch { console.error('scan-redis-catalogue-links: REDIS_URL does not parse'); process.exit(2) }

const ENTITIES = new Set(['producer', 'product', 'vintage'])
const COLUMN = { removed: 'id', merged: 'loser_id' } as const
type List = { file: string; rows: number; byEntity: Record<string, number> }
const listed = new Map<string, Set<string>>()   // id → "removed product", "merged vintage", …
const lists: Record<string, List> = {}
const refuse = (msg: string): never => { console.error(`scan-redis-catalogue-links: ${msg}`); process.exit(2) }
const fields = (line: string) => line.split(',').map(f => f.trim().replace(/^"(.*)"$/, '$1'))
for (const kind of ['removed', 'merged'] as const) {
  const file = files[kind]
  if (!file) continue
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch (e) { refuse(`cannot read ${file} (${(e as Error).message})`) }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const header = fields(lines[0] ?? '')
  const ei = header.indexOf('entity'), ii = header.indexOf(COLUMN[kind])
  if (ei < 0 || ii < 0) refuse(`${file}: the header must name \`entity\` and \`${COLUMN[kind]}\` (found: ${header.join(',') || 'nothing'})`)
  const entry: List = { file, rows: 0, byEntity: {} }
  lines.slice(1).forEach((line, n) => {
    if (!line.trim()) return
    const f = fields(line), entity = f[ei], id = f[ii]
    if (f.length !== header.length || !ENTITIES.has(entity) || !ID.test(id ?? '')) refuse(`${file} line ${n + 2}: not \`${header.join(',')}\` with entity producer / product / vintage and an id`)
    entry.rows++
    entry.byEntity[entity] = (entry.byEntity[entity] ?? 0) + 1
    if (!listed.has(id)) listed.set(id, new Set())
    listed.get(id)!.add(`${kind} ${entity}`)
  })
  lists[kind] = entry
}

const client = createClient({ url, socket: { tls: url.startsWith('rediss://'), connectTimeout: 5000, reconnectStrategy: false } })
client.on('error', () => { /* surfaced by the awaited call */ })
try { await client.connect() } catch (e) { console.error(`scan-redis-catalogue-links: cannot connect to ${where} (${(e as Error).message})`); process.exit(2) }

const counts = { lineups: 0, bottles: 0, linked: 0, linkedListed: 0, unreadable: 0, notString: 0 }
const links: { code: string; wineId: string; productId: string | null; vintageId: string | null; listed: string[] }[] = []
const unreadable: string[] = []
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
let cursor = 0
do {
  const res = await client.scan(cursor, { MATCH: 's:*:wines', COUNT: 500 })
  cursor = res.cursor
  for (const key of res.keys) {
    const m = KEY.exec(key)
    if (!m) continue
    if (await client.type(key) !== 'string') { counts.notString++; unreadable.push(m[1]); continue }
    const raw = await client.get(key)
    if (raw === null) continue   // expired between SCAN and GET
    let list: unknown
    try { list = JSON.parse(raw) } catch { list = null }
    if (!Array.isArray(list)) { counts.unreadable++; unreadable.push(m[1]); continue }
    counts.lineups++
    for (const w of list as Record<string, unknown>[]) {
      if (!w || typeof w !== 'object') continue
      counts.bottles++
      const productId = str(w.productId), vintageId = str(w.vintageId)
      if (!productId && !vintageId) continue
      const hit = [...new Set([...(listed.get(productId ?? '') ?? []), ...(listed.get(vintageId ?? '') ?? [])])].sort()
      counts.linked++
      if (hit.length) counts.linkedListed++
      links.push({ code: m[1], wineId: String(w.id ?? ''), productId, vintageId, listed: hit })
    }
  }
} while (cursor !== 0)
await client.quit()

links.sort((a, b) => a.code.localeCompare(b.code) || a.wineId.localeCompare(b.wineId))
console.log(JSON.stringify({ redis: where, lists, counts, links, unreadable: unreadable.sort() }, null, 2))
process.exitCode = links.length > 0 ? 1 : 0
