// scripts/convert-legacy-bottles.mts against THROWAWAY copies of the sandbox's prod copy with file 1 + the release
// + file 2 (release 0.2.0 runbook 2.2; NOT a CI suite: it needs the real legacy rows and the ruled list, both
// operator-local). Every refusal on a modified list or database, then the real list applied, then a re-run.
//   CONV_DB=postgres://…/<copy> CONV_DB_NOF2=postgres://…/<copy without file 2> REDIS_URL=redis://127.0.0.1:<empty>
//   CONV_LIST=<verdicts-file1.csv> CONV_MERGED=<merged.csv> CONV_REMOVED=<removed.csv> CONV_FALLBACK=<users.id>
//   npx tsx scripts/tests/convert-legacy-bottles.mts
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createClient } from 'redis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const E = process.env, DB = E.CONV_DB!, DB2 = E.CONV_DB_NOF2!, LIST = E.CONV_LIST!, MERGED = E.CONV_MERGED!, REMOVED = E.CONV_REMOVED!, FB = E.CONV_FALLBACK!
if (![DB, DB2, LIST, MERGED, REMOVED, FB, E.REDIS_URL].every(Boolean) || !/127\.0\.0\.1/.test(DB + DB2 + E.REDIS_URL)) { console.error('see the header'); process.exit(2) }
const exp = (u: string) => { const t = new URL(u); return `${t.hostname}/${t.pathname.slice(1)}` }
let failed = 0
const check = (label: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(detail)?.slice(0, 600)}`}`); if (!ok) failed++ }
const OUT = mkdtempSync(join(tmpdir(), 'conv-'))
// dummy S3 for --apply: the copy's photo URLs are not under it, so they are listed, never deleted
const S3 = { S3_ENDPOINT: 'http://127.0.0.1:9', S3_BUCKET: 'conv-test', S3_ACCESS_KEY: 'x', S3_SECRET_KEY: 'x', S3_REGION: 'us-east-1' }
let outDir = OUT
const run = (db: string, list: string, extra: string[] = [], merged = MERGED, env: Record<string, string | undefined> = S3) => {
  const r = spawnSync('npx', ['tsx', 'scripts/convert-legacy-bottles.mts', '--verdicts', list, '--merged', merged, '--removed', REMOVED,
    '--fallback-adder', FB, '--out', outDir, ...extra], { cwd: ROOT, encoding: 'utf8', env: { ...E, ...env, DATABASE_URL: db, DATABASE_CONNECTION_LIMIT: '2' }, timeout: 300_000 })
  let out: Record<string, any> = {} // eslint-disable-line @typescript-eslint/no-explicit-any -- the script's JSON
  try { out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}') } catch { /* below */ }
  return { status: r.status, out, stderr: r.stderr }
}
const csvText = readFileSync(LIST, 'utf8')
const header = csvText.split('\n')[0]
const lines = csvText.split('\n').slice(1).filter(Boolean)
// one CSV line → fields (quotes, doubled quotes); the list's notes carry commas
const fields = (l: string) => { const o: string[] = []; let f = '', qd = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (qd) { if (ch === '"' && l[i + 1] === '"') { f += '"'; i++ } else if (ch === '"') qd = false; else f += ch } else if (ch === '"') qd = true; else if (ch === ',') { o.push(f); f = '' } else f += ch } o.push(f); return o }
const VERDICT = header.split(',').indexOf('verdict')
const verdictOf = (l: string) => fields(l)[VERDICT]
const variant = (name: string, f: (rows: string[]) => string[]) => { const p = join(OUT, name); writeFileSync(p, [header, ...f(lines)].join('\n') + '\n'); return p }
const db = new pg.Client({ connectionString: DB }); await db.connect()
const redis = createClient({ url: E.REDIS_URL }); await redis.connect()
if ((await redis.dbSize()) !== 0) { console.error('REDIS_URL must be an EMPTY throwaway'); process.exit(2) }
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
const unlinked = async () => Number((await q(`SELECT count(*) FROM wines WHERE product_id IS NULL`))[0].count)
const before = { unlinked: await unlinked(), products: Number((await q(`SELECT count(*) FROM wine_products`))[0].count), reviews: Number((await q(`SELECT count(*) FROM catalog_review_items`))[0].count) }

// ── the dry run of the real list ──────────────────────────────────────────────
const d = run(DB, LIST)
check('dry run of the ruled list exits 0', d.status === 0, d.stderr)
const c = d.out.counts ?? {}
check('dry run: 57 linked, 1 producer + 1 wine + 49 years created, 67 deleted, 26 kept', c.linked === 57 && c.producersMinted === 1 && c.productsMinted === 1 && c.vintagesMinted === 49 && c.dropped === 67 && c.kept === 26, c)
check('dry run writes nothing', (await unlinked()) === before.unlinked && Number((await q(`SELECT count(*) FROM wine_products`))[0].count) === before.products)
check('dry run writes no files', !existsSync(join(OUT, 'mint-list.csv')))

// ── refusals (each a dry run; nothing changes) ────────────────────────────────
const leaveRow = lines.find(l => verdictOf(l) === 'leave')!
let r = run(DB, variant('missing.csv', rs => rs.filter(l => l !== leaveRow)))
check('🔒 refuses an unlinked bottle that is not on the list', r.status === 1 && /not on the list/.test(r.out.refused?.reason ?? ''), r.out)
const linkLine = lines.find(l => l.startsWith('E8XOTdiOieM0oRG0xhgeT,'))!
r = run(DB, variant('target.csv', rs => rs.map(l => l === linkLine ? l.replace(/1qPydpLX7gHa2TuCzj_oa/g, 'zzzzzzzzzzzzzzzzzzzzz') : l)))
check('🔒 refuses a target that does not exist', r.status === 1 && /does not exist|not linkable/.test(r.out.refused?.reason ?? ''), r.out)
const mergedFix = join(OUT, 'merged-fixture.csv'); writeFileSync(mergedFix, readFileSync(MERGED, 'utf8') + 'product,1qPydpLX7gHa2TuCzj_oa,II9KHzN2ZyEFT_PRvN4A0\n')
r = run(DB, LIST, [], mergedFix)
check('🔒 refuses a target on merged.csv (the list is stale)', r.status === 1 && /merged/.test(r.out.refused?.reason ?? ''), r.out)
const drop = fields(lines.find(l => verdictOf(l) === 'drop')!)[0]
await q(`INSERT INTO bookmarks (user_id, wine_id, saved_at, from_post) VALUES ($1, $2, now(), false)`, [FB, drop])
r = run(DB, LIST)
check('🔒 refuses to delete a bottle something references now', r.status === 1 && /referenced/.test(r.out.refused?.reason ?? ''), r.out)
await q(`DELETE FROM bookmarks WHERE wine_id = $1`, [drop])
const [m] = await q(`SELECT s.code FROM wines w JOIN sessions s ON s.id = w.session_id WHERE w.id = '1778689234786'`)
await redis.set(`s:${m.code}:wines`, '[]')
r = run(DB, LIST)
check('🔒 refuses a moment whose old cache the warm-up has not stamped (run warm-lineups first)', r.status === 1 && /warm-lineups/.test(r.out.refused?.reason ?? ''), r.out)
await redis.del(`s:${m.code}:wines`)
r = run(DB2, LIST)
check('🔒 refuses before file 2 is applied', r.status === 1 && /file 2/.test(r.out.refused?.reason ?? ''), r.out)
r = run(DB2, LIST, ['--without-file2'])
check('--without-file2 lets it run', r.status === 0, r.out)
check('--apply needs --expect-db', run(DB, LIST, ['--apply']).status === 2)
// review r1: the pre-flight refusals (exit 2, before connecting)
check('🔒 refuses without REDIS_URL in the shell (never the checkout\'s .env)', run(DB, LIST, [], MERGED, { ...S3, REDIS_URL: '' }).status === 2)
check('🔒 --apply refuses without the S3 variables (the photo reclaim would do nothing)', run(DB, LIST, ['--apply', '--expect-db', exp(DB)], MERGED, { REDIS_URL: E.REDIS_URL }).status === 2)
check('refuses a bottle named twice on the list', run(DB, variant('dupe.csv', rs => [...rs, rs[0]])).status === 2)
const poiLine = lines.find(l => l.startsWith('JoZCntQPoV33UWAbdg2Ow,'))!
const share = variant('share.csv', rs => rs.map(l => (l === poiLine ? (() => { const f = fields(l); f[header.split(',').indexOf('producer_same_as')] = 'E8XOTdiOieM0oRG0xhgeT'; return f.map(x => (/[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(',') })() : l)))
check('refuses a producer_same_as that is not another mint row', run(DB, share).status === 2)
const badMerged = join(OUT, 'bad-merged.csv'); writeFileSync(badMerged, 'entity,loser,survivor\nproduct,a,b\n')
check('refuses merged.csv without its columns (never fails open)', run(DB, LIST, [], badMerged).status === 2)
const emptyRemoved = join(OUT, 'empty-removed.csv'); writeFileSync(emptyRemoved, 'entity,id\n')
check('a header-only list is accepted (a delivery with no removals)', spawnSync('npx', ['tsx', 'scripts/convert-legacy-bottles.mts', '--verdicts', LIST, '--merged', MERGED, '--removed', emptyRemoved, '--fallback-adder', FB, '--out', OUT],
  { cwd: ROOT, encoding: 'utf8', env: { ...E, ...S3, DATABASE_URL: DB, DATABASE_CONNECTION_LIMIT: '2' } }).status === 0)
await q(`UPDATE wines SET name = name || ' (edited)' WHERE id = 'myv9re9Bny5LByN4MaYz0'`)
r = run(DB, LIST)
check('🔒 refuses a bottle edited since the ruling', r.status === 1 && /since the ruling/.test(r.out.refused?.reason ?? ''), r.out)
await q(`UPDATE wines SET name = regexp_replace(name, ' \\(edited\\)$', '') WHERE id = 'myv9re9Bny5LByN4MaYz0'`)

// ── the real run ──────────────────────────────────────────────────────────────
await q(`INSERT INTO bookmarks (user_id, wine_id, saved_at, from_post) VALUES (1, '1778689234786', now(), false)`) // user 1 already craves the other Vénénum row
const [mm] = await q(`SELECT s.id FROM wines w JOIN sessions s ON s.id = w.session_id WHERE w.id = 'myv9re9Bny5LByN4MaYz0'`)
await q(`UPDATE sessions SET lineup_revision = 1 WHERE id = $1`, [mm.id]) // one moment already stamped (warm-up ran)
const a = run(DB, LIST, ['--apply', '--expect-db', exp(DB)])
check('--apply exits 0', a.status === 0, a.stderr)
const w = async (id: string) => (await q(`SELECT w.*, p.name AS pname, v.year AS vyear FROM wines w LEFT JOIN wine_products p ON p.id = w.product_id LEFT JOIN wine_vintages v ON v.id = w.vintage_id WHERE w.id = $1`, [id]))[0]
const hund = await w('E8XOTdiOieM0oRG0xhgeT')
check('🔒 a link to a delivered vintage: the bottle carries it and shows the entry (name, producer, year)', hund.product_id === '1qPydpLX7gHa2TuCzj_oa' && hund.vintage_id === 'F0gk_rG-pXZd1PKjtbzaj' && hund.name === hund.pname && hund.producer === 'Weingut R&A Pfaffl' && hund.vintage === '2019', hund)
const mn = await w('myv9re9Bny5LByN4MaYz0')
const [mv] = await q(`SELECT * FROM wine_vintages WHERE id = $1`, [mn.vintage_id])
check('🔒 a link whose year the catalogue lacks: the year added (provisional, by the adder or the fallback), with its review item', mn.product_id === '4IDA1h2Wv29I7VuctjH5L' && mv?.year === 2023 && mv.status === 'provisional' && mv.added_by !== null
  && (await q(`SELECT 1 FROM catalog_review_items WHERE entity_type = 'vintage' AND entity_id = $1`, [mv.id])).length === 1, { mn, mv })
const nv = await w('4tgJ0pl5Bm9wYrslICiUr')
check('an NV bottle: an NV vintage', nv.vintage_id !== null && nv.vyear === null && nv.vintage.trim() === 'NV', nv)
const pg_ = await w('wAdK_60u9DH7TTdU2IU2F')
check('a bottle without a year: product grain', pg_.product_id === 'tKSWDpxhYcWfberrkd-m4' && pg_.vintage_id === null, pg_)
const v1 = await w('1777284091742'), v2 = await w('1778689234786')
check('🔒 two rows of one wine share the entry and the one added year', v1.vintage_id && v1.vintage_id === v2.vintage_id, { v1: v1.vintage_id, v2: v2.vintage_id })
const poi = await w('JoZCntQPoV33UWAbdg2Ow')
const [pp] = await q(`SELECT p.*, pr.name AS prname, pr.status AS prstatus FROM wine_products p JOIN product_producers x ON x.product_id = p.id AND x.role = 'lead' JOIN producers pr ON pr.id = x.producer_id WHERE p.id = $1`, [poi.product_id])
check('🔒 Poiray: a new producer and wine (provisional, red) and its 2023', pp?.name === 'Poiray' && pp.prname === 'Jérôme Forget' && pp.status === 'provisional' && pp.prstatus === 'provisional' && pp.colour === 'red' && poi.vyear === 2023, { poi, pp })
check('🔒 a review item per created entry (1 producer, 1 wine, 49 years)', Number((await q(`SELECT count(*) FROM catalog_review_items`))[0].count) === before.reviews + 51)
check('🔒 the 67 deleted, the 26 kept unlinked', Number((await q(`SELECT count(*) FROM wines WHERE id = ANY($1::text[])`, [lines.filter(l => verdictOf(l) === 'drop').map(l => fields(l)[0])]))[0].count) === 0 && (await unlinked()) === 26)
const bk = await q(`SELECT id, user_id, wine_id, product_id, vintage_id, name FROM bookmarks WHERE wine_id IN ('1777284091742', '1778689234786') ORDER BY id`)
check('🔒 cravings follow their bottle; the collision keeps the earlier one', bk.length === 2 && bk.every((b: { product_id: string; name: string }) => b.product_id === '4LHpxe2shhDAzFyPKrsjP' && b.name === 'Venenum') && bk.map((b: { id: number }) => b.id).join() === '2,9' && a.out.counts?.bookmarksMerged === 1, bk)
check('the stamped moment\'s revision bumped, a NULL one left NULL', Number((await q(`SELECT lineup_revision FROM sessions WHERE id = $1`, [mm.id]))[0].lineup_revision) === 2
  && (await q(`SELECT lineup_revision FROM sessions s JOIN wines w ON w.session_id = s.id WHERE w.id = '1778689234786'`))[0].lineup_revision === null)
check('nothing written into a delivered entry, catalog_audit empty', Number((await q(`SELECT count(*) FROM catalog_audit`))[0].count) === 0
  && (await q(`SELECT added_by FROM wine_products WHERE id = '4IDA1h2Wv29I7VuctjH5L'`))[0].added_by === null)
const mints = readFileSync(join(OUT, 'mint-list.csv'), 'utf8').trim().split('\n'), flags = readFileSync(join(OUT, 'flagged-links.csv'), 'utf8').trim().split('\n')
const photos = readFileSync(join(OUT, 'unreclaimed-photos.txt'), 'utf8').trim().split('\n')
check('a photo outside the bucket is listed, never silently kept (3 on the copy)', a.out.photosNotReclaimable === 3 && photos.length === 3 && a.out.committed === true, { p: a.out.photosNotReclaimable, photos })
check('every deleted bottle\'s photo is written down, whatever S3 does', readFileSync(join(OUT, 'deleted-bottles-photos.txt'), 'utf8').trim().split('\n').length === 3)
check('without the shell\'s S3 the dry run does not guess the count', run(DB, LIST, ['--without-file2'], MERGED, { REDIS_URL: E.REDIS_URL }).out.photosNotReclaimable === null)
check('the mint list: 51 entries (+ header), entity type and id', mints.length === 52 && /^entity,id/.test(mints[0]), mints.slice(0, 3))
check('the flagged-link list carries the differences (16)', flags.length === 17, flags.length)
check('no person named in either file', !/Ursula|@/.test(mints.join() + flags.join()))
// ── a re-run changes nothing ──────────────────────────────────────────────────
check('🔒 a second --apply into the same --out refuses (the mint list is kept)', run(DB, LIST, ['--apply', '--expect-db', exp(DB)]).status === 2 && mints.length === readFileSync(join(OUT, 'mint-list.csv'), 'utf8').trim().split('\n').length)
outDir = join(OUT, 'second'); const a2 = run(DB, LIST, ['--apply', '--expect-db', exp(DB)])
check('a second --apply changes nothing (every row reported as done before)', a2.status === 0 && a2.out.counts?.linked === 0 && a2.out.counts?.vintagesMinted === 0 && a2.out.counts?.dropped === 0
  && a2.out.skipped?.linkedSince === 57 && a2.out.skipped?.deletedSince === 67, a2.out)
// ── producer + new wine (Poiray as if its producer were delivered), on the copy without file 2 ──────────────
const db2 = new pg.Client({ connectionString: DB2 }); await db2.connect()
const [prod] = (await db2.query(`SELECT id FROM producers WHERE name = 'Matassa'`)).rows
const pm = variant('pm.csv', rs => rs.map(l => l.startsWith('JoZCntQPoV33UWAbdg2Ow,') ? l.replace(',mint,,', `,producer+mint,${prod.id} Matassa,`) : l))
outDir = join(OUT, 'pm'); const b = run(DB2, pm, ['--without-file2', '--apply', '--expect-db', exp(DB2)])
const [pw] = (await db2.query(`SELECT p.name, x.producer_id FROM wines w JOIN wine_products p ON p.id = w.product_id JOIN product_producers x ON x.product_id = p.id AND x.role = 'lead' WHERE w.id = 'JoZCntQPoV33UWAbdg2Ow'`)).rows
check('producer + new wine: the wine created under the named producer, no new producer', b.status === 0 && pw?.name === 'Poiray' && pw.producer_id === prod.id && b.out.counts?.producersMinted === 0, { b: b.out, pw })
await db2.end(); await db.end(); await redis.quit()
console.log(failed ? `\n${failed} FAILED` : '\nall passed'); process.exit(failed ? 1 : 0)
