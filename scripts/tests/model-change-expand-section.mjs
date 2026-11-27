// § 22 of catalog-schema-integration.mjs: the catalogue model change's EXPAND
// migration (docs/dev/proposals/wine-catalog-model-change.md § 1, § 5, § 5a,
// § 7; build plan step 2). What `migrate diff` cannot see: the origin trigger,
// the CHECKs, the two partial uniques (deliberately NOT in the Prisma datamodel,
// so pinned here from pg_indexes), the bookmark keys into the catalogue, the
// 249-code country CHECK against @verre/core, the FK pin with its negative
// control, the backfill on the re-survey's odd rows, and the columns-file update.
//
// Written before the migration and run against the previous chain first: every
// check below failed there (the build records it).
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COUNTRY_CODES } from '../../packages/core/src/countries.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROLLBACK = Symbol('rollback')

export async function modelChangeExpandSection({ prisma, ok, rejects, accepts, raw, makeProduct }) {
  // A query that may fail on the previous schema: an error is a value, so each
  // check fails on its own instead of ending the section.
  const q = async (sql, params) => { try { return await raw(sql, params) } catch (e) { return { error: String(e.message || e).split('\n')[0] } } }
  const one = async (sql, params) => { const r = await q(sql, params); return Array.isArray(r) ? r[0] : r }
  const node = (script, args = [], env = {}) => spawnSync(process.execPath, [join(ROOT, script), ...args],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000 })
  const lastJson = s => { try { return JSON.parse(String(s).trim().split('\n').pop()) } catch { return null } }

  // ── fixtures shared by the subsections ──
  await prisma.$executeRawUnsafe(`INSERT INTO sessions (id,code,host_name) VALUES (900910,'TESTCMC1','H'), (900911,'TESTCMC2','H')`)
  await prisma.$executeRawUnsafe(`
    INSERT INTO users (id,name,email,updated_at,created_at) VALUES
      (900950,'Ua','ua@example.invalid',now(),now()), (900951,'Ub','ub@example.invalid',now(),now()),
      (900952,'Uc','uc@example.invalid',now(),now())`)
  await prisma.$executeRawUnsafe(`INSERT INTO producers (id,name,status,country) VALUES ('test_pMC','MC Estate','confirmed','FR')`)
  for (const p of ['test_wpMC1', 'test_wpMC2', 'test_wpMC3']) await makeProduct(p, 'test_pMC')
  await prisma.$executeRawUnsafe(`
    INSERT INTO wine_vintages (id,product_id,year,status) VALUES
      ('test_vMC1','test_wpMC1',2018,'confirmed'), ('test_vMC1b','test_wpMC1',2019,'confirmed'),
      ('test_vMC2','test_wpMC2',2018,'confirmed')`)

  console.log('\n22a. wines: origin (insert trigger), the snapshot colour / sparkling / abv')
  // 🔒 The previous release keeps serving during the rolling deploy and writes
  // wines without the new columns: these are its insert shapes.
  await accepts('the old release still inserts a session bottle (no new columns named)',
    `INSERT INTO wines (id,session_id,name,style) VALUES ('test_mc_s',900910,'S','red')`)
  await accepts('…and a standalone check-in wine',
    `INSERT INTO wines (id,session_id,name,style) VALUES ('test_mc_c',NULL,'C','spark')`)
  const o = await q(`SELECT id, origin, colour, sparkling, abv FROM wines WHERE id IN ('test_mc_s','test_mc_c') ORDER BY id`)
  ok(Array.isArray(o) && o.find(r => r.id === 'test_mc_s')?.origin === 'session' && o.find(r => r.id === 'test_mc_c')?.origin === 'standalone',
    '🔒 the insert trigger fills origin from session_id when the writer leaves it NULL')
  ok(Array.isArray(o) && o.every(r => r.colour === null && r.sparkling === false && r.abv === null),
    '…and the snapshot starts unwritten (colour NULL, sparkling false, abv NULL): the backfill derives it, not a trigger')
  await accepts('a writer that names origin keeps its value', `INSERT INTO wines (id,session_id,name,origin) VALUES ('test_mc_x',NULL,'X','session')`)
  ok((await one(`SELECT origin FROM wines WHERE id='test_mc_x'`))?.origin === 'session', '…origin session on a bottle with no moment stays session (the trigger fills NULL only)')
  await accepts('orphaning a bottle (session_id → NULL, a later UPDATE)', `UPDATE wines SET session_id=NULL WHERE id='test_mc_s'`)
  ok((await one(`SELECT origin FROM wines WHERE id='test_mc_s'`))?.origin === 'session', '🔒 …keeps origin session: the trigger is INSERT only (orphaning is never an insert)')
  await rejects('origin outside session / standalone', `UPDATE wines SET origin='tasting' WHERE id='test_mc_c'`, 'wines_origin_check')
  const trg = await q(`
    SELECT t.tgname, (t.tgtype & 2) <> 0 AS before, (t.tgtype & 4) <> 0 AS ins, (t.tgtype & 16) <> 0 AS upd, (t.tgtype & 1) <> 0 AS per_row,
           p.proconfig
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'wines'::regclass AND NOT t.tgisinternal`)
  ok(Array.isArray(trg) && trg.length === 1 && trg[0].tgname === 'wines_origin_default' && trg[0].before && trg[0].ins && !trg[0].upd && trg[0].per_row
     && (trg[0].proconfig ?? []).includes('search_path=pg_catalog, public'),
    `one trigger on wines: wines_origin_default, BEFORE INSERT, per row, its function's search_path pinned to pg_catalog, public${Array.isArray(trg) ? ` (${JSON.stringify(trg.map(t => [t.tgname, t.proconfig]))})` : ''}`)
  await rejects('colour orange (orange wine is white)', `UPDATE wines SET colour='orange' WHERE id='test_mc_c'`, 'wines_colour_check')
  for (const c of ['red', 'white', 'rose']) await accepts(`colour ${c}`, `UPDATE wines SET colour='${c}' WHERE id='test_mc_c'`)
  await rejects('sparkling NULL (no unknown state)', `UPDATE wines SET sparkling=NULL WHERE id='test_mc_c'`, 'violates not-null constraint')
  await rejects('abv above 25', `UPDATE wines SET abv=25.01 WHERE id='test_mc_c'`, 'wines_abv_range_check')
  await rejects('abv below 0', `UPDATE wines SET abv=-0.01 WHERE id='test_mc_c'`, 'wines_abv_range_check')
  for (const v of ['0', '0.5', '25', 'NULL']) await accepts(`abv ${v}`, `UPDATE wines SET abv=${v} WHERE id='test_mc_c'`)
  const types = await q(`
    SELECT c.relname || '.' || a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
           pg_get_expr(d.adbin, d.adrelid) AS dflt
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
       AND (c.relname, a.attname) IN (('wines','origin'),('wines','colour'),('wines','sparkling'),('wines','abv'),
            ('sessions','lineup_revision'),('bookmarks','wine_id'),('bookmarks','product_id'),('bookmarks','vintage_id'),
            ('bookmarks','name'),('bookmarks','producer'),('bookmarks','vintage'),('bookmarks','source_session_id'),
            ('wine_products','country'),('wine_products','description'),('wine_products','vinification'))
     ORDER BY 1`)
  const want = {
    'bookmarks.name': 'character varying(255) null', 'bookmarks.producer': 'character varying(255) null',
    'bookmarks.product_id': 'character varying(21) null', 'bookmarks.source_session_id': 'integer null',
    'bookmarks.vintage': 'character(4) null', 'bookmarks.vintage_id': 'character varying(21) null',
    'bookmarks.wine_id': 'character varying(21) null',
    'sessions.lineup_revision': 'integer null',
    'wine_products.country': 'character varying(2) null', 'wine_products.description': 'character varying(1000) null',
    'wine_products.vinification': 'character varying(1000) null',
    'wines.abv': 'numeric(4,2) null', 'wines.colour': 'character varying(16) null', 'wines.origin': 'character varying(16) null',
    'wines.sparkling': 'boolean not null default false',
  }
  const got = Array.isArray(types) ? Object.fromEntries(types.map(t => [t.col, `${t.type} ${t.nullable ? 'null' : 'not null'}${t.dflt ? ` default ${t.dflt}` : ''}`])) : types
  ok(JSON.stringify(got) === JSON.stringify(want),
    `the new columns' types (lineup_revision integer: no BigInt reaches JSON; wine_id now nullable)${JSON.stringify(got) === JSON.stringify(want) ? '' : ` — got ${JSON.stringify(got)}`}`)

  console.log('\n22b. bookmarks: the catalogue link, its keys and the partial unique')
  await accepts('a bookmark of a catalogue wine with no source bottle (wine_id NULL)',
    `INSERT INTO bookmarks (user_id,product_id) VALUES (900950,'test_wpMC1')`)
  await rejects('a second product-grain bookmark of that wine by the same person',
    `INSERT INTO bookmarks (user_id,product_id) VALUES (900950,'test_wpMC1')`, 'bookmarks_user_product_vintage_key')
  await accepts('a vintage-grain bookmark beside it (a different meaning, its own row)',
    `INSERT INTO bookmarks (user_id,product_id,vintage_id) VALUES (900950,'test_wpMC1','test_vMC1')`)
  await rejects('…but not twice', `INSERT INTO bookmarks (user_id,product_id,vintage_id) VALUES (900950,'test_wpMC1','test_vMC1')`,
    'bookmarks_user_product_vintage_key')
  await accepts('another vintage of the same wine', `INSERT INTO bookmarks (user_id,product_id,vintage_id) VALUES (900950,'test_wpMC1','test_vMC1b')`)
  await accepts('another person, the same wine', `INSERT INTO bookmarks (user_id,product_id) VALUES (900951,'test_wpMC1')`)
  await rejects('a vintage of ANOTHER product (the composite key)',
    `INSERT INTO bookmarks (user_id,product_id,vintage_id) VALUES (900951,'test_wpMC2','test_vMC1')`, 'bookmarks_vintage_id_product_id_fkey')
  await rejects('a vintage with no product (MATCH SIMPLE would let it through)',
    `INSERT INTO bookmarks (user_id,vintage_id) VALUES (900951,'test_vMC2')`, 'bookmarks_catalog_link_check')
  await rejects('an unknown product', `INSERT INTO bookmarks (user_id,product_id) VALUES (900951,'test_nope')`, 'bookmarks_product_id_fkey')
  for (let i = 1; i <= 3; i++) {
    await accepts(`a purged bookmark (no product, no source) #${i}: unlimited, exempt from the unique`,
      `INSERT INTO bookmarks (user_id,name,producer) VALUES (900950,'Gone','Same')`)
  }
  await rejects('a moment that does not exist', `INSERT INTO bookmarks (user_id,product_id,source_session_id) VALUES (900951,'test_wpMC2',999999999)`,
    'bookmarks_source_session_id_fkey')
  await accepts('…one that does', `INSERT INTO bookmarks (user_id,product_id,source_session_id) VALUES (900951,'test_wpMC2',900910)`)
  await accepts('a bookmark of another wine', `INSERT INTO bookmarks (user_id,product_id) VALUES (900952,'test_wpMC3')`)
  await rejects('🔒 deleting a product a bookmark points at fails (NO ACTION: a purge must clear the reference first)',
    `DELETE FROM wine_products WHERE id='test_wpMC3'`, 'bookmarks_product_id_fkey')
  await rejects('…and so does deleting a vintage a bookmark points at', `DELETE FROM wine_vintages WHERE id='test_vMC1b'`,
    'bookmarks_vintage_id_product_id_fkey')
  await prisma.$executeRawUnsafe(`INSERT INTO wines (id,session_id,name) VALUES ('test_mc_bw',900910,'B')`)
  await accepts('a bookmark of a bottle (the old release\'s shape)', `INSERT INTO bookmarks (user_id,wine_id) VALUES (900950,'test_mc_bw')`)
  await rejects('🔒 bookmarks_user_id_wine_id_key is untouched: one save per person per source bottle',
    `INSERT INTO bookmarks (user_id,wine_id) VALUES (900950,'test_mc_bw')`, 'bookmarks_user_id_wine_id_key')
  await accepts('deleting the bottle', `DELETE FROM wines WHERE id='test_mc_bw'`)
  ok(Number((await one(`SELECT count(*)::int AS n FROM bookmarks WHERE wine_id='test_mc_bw'`))?.n) === 0,
    '🔒 …still cascades to its bookmarks (bookmarks_wine_id_fkey keeps ON DELETE CASCADE, Codex r1: no FK change can be timed safely)')
  const fkDel = await q(`
    SELECT conname, confdeltype::text AS del FROM pg_constraint
     WHERE conrelid = 'bookmarks'::regclass AND contype = 'f' ORDER BY conname`)
  ok(Array.isArray(fkDel) && JSON.stringify(fkDel.map(f => `${f.conname}:${f.del}`)) === JSON.stringify([
    'bookmarks_product_id_fkey:a', 'bookmarks_source_item_id_fkey:n', 'bookmarks_source_session_id_fkey:a', 'bookmarks_user_id_fkey:c',
    'bookmarks_vintage_id_product_id_fkey:a', 'bookmarks_wine_id_fkey:c']),
    `bookmarks' keys: product, vintage and moment NO ACTION; user and source bottle CASCADE; the post it came from SET NULL (step 5)${Array.isArray(fkDel) ? ` (${fkDel.map(f => `${f.conname}:${f.del}`).join(' ')})` : ''}`)
  // 🔒 The two partial uniques are NOT in the Prisma datamodel (an @@unique
  // cannot carry a WHERE, so the drift gate would ask for a different index):
  // this is what pins their predicate, columns and NULLS NOT DISTINCT.
  const idx = await q(`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
       AND indexname IN ('bookmarks_user_product_vintage_key','ratings_standalone_wine_id_key','bookmarks_user_id_wine_id_key') ORDER BY 1`)
  const idxWant = [
    'CREATE UNIQUE INDEX bookmarks_user_id_wine_id_key ON public.bookmarks USING btree (user_id, wine_id)',
    'CREATE UNIQUE INDEX bookmarks_user_product_vintage_key ON public.bookmarks USING btree (user_id, product_id, vintage_id) NULLS NOT DISTINCT WHERE (product_id IS NOT NULL)',
    'CREATE UNIQUE INDEX ratings_standalone_wine_id_key ON public.ratings USING btree (wine_id) WHERE (session_id IS NULL)',
  ]
  ok(Array.isArray(idx) && JSON.stringify(idx.map(i => i.indexdef)) === JSON.stringify(idxWant),
    `🔒 pg_indexes: the two partial uniques exactly (columns, NULLS NOT DISTINCT, predicate) and the kept (user, wine) unique${
      Array.isArray(idx) ? ` — got ${JSON.stringify(idx.map(i => i.indexdef))}` : ''}`)

  console.log('\n22c. ratings: one rating per standalone occurrence')
  await prisma.$executeRawUnsafe(`INSERT INTO wines (id,session_id,name) VALUES ('test_mc_sa',NULL,'SA'), ('test_mc_sb',NULL,'SB')`)
  await accepts('a check-in\'s rating', `INSERT INTO ratings (wine_id,user_id,session_id,origin,rater_name,rated_at) VALUES ('test_mc_sa',900950,NULL,'standalone','Ua',now())`)
  await rejects('🔒 a second standalone rating of the same occurrence (the check-in replay, spec § 8a)',
    `INSERT INTO ratings (wine_id,user_id,session_id,origin,rater_name,rated_at) VALUES ('test_mc_sa',900951,NULL,'standalone','Ub',now())`,
    'ratings_standalone_wine_id_key')
  await accepts('the same person\'s rating of another check-in',
    `INSERT INTO ratings (wine_id,user_id,session_id,origin,rater_name,rated_at) VALUES ('test_mc_sb',900950,NULL,'standalone','Ua',now())`)
  await prisma.$executeRawUnsafe(`UPDATE wines SET session_id=900910 WHERE id='test_mc_s'`)
  for (const u of [900950, 900951]) {
    await accepts(`a session rating of one bottle by user ${u} (session ratings are outside the predicate)`,
      `INSERT INTO ratings (wine_id,user_id,session_id,origin,rater_name,rated_at) VALUES ('test_mc_s',${u},900910,'session','U',now())`)
  }
  // Prod holds 4 legacy SESSION ratings written before ratings carried a session
  // (origin 'session', session_id NULL, one per bottle): the predicate is
  // session_id IS NULL, so they sit under it too, strictly "one session-less
  // rating per bottle".
  await prisma.$executeRawUnsafe(`INSERT INTO wines (id,session_id,name) VALUES ('9000000000009',NULL,'Legacy')`)
  await accepts('a legacy session rating with no session (the shape prod holds 4 of)',
    `INSERT INTO ratings (wine_id,user_id,session_id,origin,rater_name,rated_at) VALUES ('9000000000009',900950,NULL,'session','Ua',now())`)
  await rejects('…is under the same unique: a second session-less rating of that bottle is refused',
    `INSERT INTO ratings (wine_id,user_id,session_id,origin,rater_name,rated_at) VALUES ('9000000000009',900951,NULL,'standalone','Ub',now())`,
    'ratings_standalone_wine_id_key')
  // 🔒 The migration's § 0 refusal (the @recipe:model-change-refusal block, run
  // verbatim): with the unique dropped inside a rolled-back transaction, 12
  // bottles each holding two session-less ratings, one of them a legacy session
  // rating, must be refused with the count and the first ten ids.
  try {
    const refusal = (await import('../lib/modelChangeBackfill.mjs')).readRecipe('model-change-refusal')
    const outcome = {}
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SAVEPOINT clean`)
      outcome.clean = await tx.$executeRawUnsafe(refusal).then(() => 'passed', e => String(e.message))
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT clean`)
      await tx.$executeRawUnsafe(`DROP INDEX ratings_standalone_wine_id_key`)
      await tx.$executeRawUnsafe(`INSERT INTO wines (id,name) SELECT 'test_dup' || lpad(g::text, 2, '0'), 'D' FROM generate_series(1, 12) g`)
      await tx.$executeRawUnsafe(`INSERT INTO ratings (wine_id,origin,rater_name,rated_at,user_id)
        SELECT 'test_dup' || lpad(g::text, 2, '0'), CASE WHEN k = 1 AND g = 1 THEN 'session' ELSE 'standalone' END, 'R', now(), 900950
          FROM generate_series(1, 12) g, generate_series(1, 2) k`)
      outcome.dirty = await tx.$executeRawUnsafe(refusal).then(() => 'passed', e => String(e.message))
      throw ROLLBACK
    }, { timeout: 30_000 }).catch(e => { if (e !== ROLLBACK) outcome.error = String(e.message || e) })
    ok(outcome.clean === 'passed', `the § 0 refusal passes a clean database${outcome.clean === 'passed' ? '' : ` (${outcome.clean ?? outcome.error})`}`)
    ok(/12 wine\(s\) hold more than one rating with no session/.test(outcome.dirty ?? '') && /first ids: test_dup01, test_dup02, .*test_dup10\)/.test(outcome.dirty ?? '')
       && !(outcome.dirty ?? '').includes('test_dup11'),
      `🔒 …and refuses 12 offending bottles with the full count and the first ten ids${/12 wine/.test(outcome.dirty ?? '') ? '' : ` (${outcome.dirty ?? outcome.error})`}`)
  } catch (e) { ok(false, `the § 0 refusal block is readable from the migration (${e.message})`) }

  console.log('\n22d. wine_products: country of origin / description / vinification (contract v3)')
  // 🔒 The CHECK is the FULL code list, inline. Its list is read from the
  // database and compared with @verre/core both ways, over every two-letter
  // string plus case and length variants.
  const strings = new Set([...COUNTRY_CODES].map(c => c.toLowerCase()).concat(['', 'C', 'CHE', 'Ch', ' CH', 'CH ']))
  for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') strings.add(a + b)
  const table = [...strings]
  for (const [rel, con] of [['wine_products', 'wine_products_country_check'], ['producers', 'producers_country_check']]) {
    const chk = await one(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`, [con, rel])
    if (typeof chk?.def !== 'string') { ok(false, `🔒 ${con} exists (${JSON.stringify(chk)})`); continue }
    const verdicts = await q(`SELECT country, COALESCE(${chk.def.replace(/^CHECK /, '')}, FALSE) AS ok FROM unnest($1::text[]) AS t(country)`, [table])
    const disagree = Array.isArray(verdicts) ? verdicts.filter(v => v.ok !== COUNTRY_CODES.has(v.country)).map(v => v.country) : [verdicts]
    ok(Array.isArray(verdicts) && verdicts.length === table.length && disagree.length === 0,
      `🔒 ${con} accepts exactly the ${COUNTRY_CODES.size} codes of COUNTRY_CODES over ${table.length} strings, both ways${disagree.length ? ` (disagree: ${disagree.slice(0, 10).join(' ')})` : ''}`)
    const nul = await one(`SELECT COALESCE(${chk.def.replace(/^CHECK /, '')}, FALSE) AS ok FROM (SELECT NULL::varchar AS country) t`)
    ok(nul?.ok === true, `…and ${con} accepts NULL (unknown)`)
  }
  await rejects('wine_products.country XX', `UPDATE wine_products SET country='XX' WHERE id='test_wpMC1'`, 'wine_products_country_check')
  await rejects('wine_products.country lowercase', `UPDATE wine_products SET country='fr' WHERE id='test_wpMC1'`, 'wine_products_country_check')
  await accepts('wine_products.country FR', `UPDATE wine_products SET country='FR' WHERE id='test_wpMC1'`)
  await rejects('producers.country XX (the same list on the company\'s home)', `UPDATE producers SET country='XX' WHERE id='test_pMC'`, 'producers_country_check')
  for (const col of ['description', 'vinification']) {
    const con = `wine_products_${col}_not_blank_check`
    for (const [label, v] of [['empty', `''`], ['spaces', `'   '`], ['tab and newline', `E'\\t\\n'`], ['NBSP', `E'\\u00a0'`], ['a zero-width space', `E'\\u200b'`]]) {
      await rejects(`${col} ${label} (blank through the fold)`, `UPDATE wine_products SET ${col}=${v} WHERE id='test_wpMC2'`, con)
    }
    await accepts(`${col}: a sentence`, `UPDATE wine_products SET ${col}='Aged in oak for a year.' WHERE id='test_wpMC2'`)
    await accepts(`${col}: 1000 characters`, `UPDATE wine_products SET ${col}=repeat('é', 1000) WHERE id='test_wpMC2'`)
    await rejects(`${col}: 1001 characters`, `UPDATE wine_products SET ${col}=repeat('é', 1001) WHERE id='test_wpMC2'`, 'value too long')
    await accepts(`${col}: NULL`, `UPDATE wine_products SET ${col}=NULL WHERE id='test_wpMC2'`)
  }

  console.log('\n22e. catalog_review_items (every user mint is recorded as unreviewed, spec § 7)')
  await accepts('a user mint\'s review item', `INSERT INTO catalog_review_items (entity_type,entity_id,reason) VALUES ('product','test_wpMC1','user-mint')`)
  const item = await one(`SELECT created_at IS NOT NULL AS stamped, resolved_at, resolved_by FROM catalog_review_items WHERE entity_id='test_wpMC1'`)
  ok(item?.stamped === true && item.resolved_at === null && item.resolved_by === null, 'created_at stamped, resolved_at / resolved_by empty until phase 3')
  await rejects('an entity type outside producer / product / vintage', `INSERT INTO catalog_review_items (entity_type,entity_id,reason) VALUES ('wine','test_x','user-mint')`,
    'catalog_review_items_entity_type_check')
  await rejects('a reason outside the list', `INSERT INTO catalog_review_items (entity_type,entity_id,reason) VALUES ('product','test_x','spam')`,
    'catalog_review_items_reason_check')
  await rejects('a resolver without a resolution time', `INSERT INTO catalog_review_items (entity_type,entity_id,reason,resolved_by) VALUES ('product','test_x','user-mint',900952)`,
    'catalog_review_items_resolved_check')
  await accepts('a resolved item', `INSERT INTO catalog_review_items (entity_type,entity_id,reason,resolved_at,resolved_by) VALUES ('vintage','test_vMC1','user-mint',now(),900952)`)
  await accepts('the resolver\'s account is deleted', `DELETE FROM users WHERE id=900952`)
  const kept = await one(`SELECT resolved_at IS NOT NULL AS resolved, resolved_by FROM catalog_review_items WHERE entity_id='test_vMC1'`)
  ok(kept?.resolved === true && kept.resolved_by === null, '…the item stays, resolved, its resolver SET NULL')
  // Two keys, both into `users` (the reporter of an alcohol joined the resolver
  // in 0.2.0 build 2, 20261127120100), none into the catalogue.
  const rfk = await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'catalog_review_items'::regclass AND contype = 'f' ORDER BY 1`)
  ok(Array.isArray(rfk) && JSON.stringify(rfk.map(r => r.def)) === JSON.stringify(['FOREIGN KEY (reported_by) REFERENCES users(id) ON DELETE SET NULL', 'FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL']),
    '🔒 no key into the catalogue (polymorphic entity; a purge deletes the entity and its item together); the data side\'s replace mode LOCKS it instead')

  console.log('\n22f. The FK pin: every key into the catalogue is NO ACTION (spec § 5a)')
  const pin = () => node('scripts/check-catalog-inbound-fks.mjs')
  const green = pin()
  ok(green.status === 0, `the pin passes on the migrated chain${green.status === 0 ? '' : ` (exit ${green.status}: ${(green.stderr || green.stdout).trim().slice(0, 300)})`}`)
  ok(Number(green.stdout.match(/^ok\s+(\d+) foreign keys/)?.[1]) === 11,
    `…over 11 keys (the nine forward catalogue keys + the two from bookmarks)${green.stdout ? ` — ${green.stdout.trim()}` : ''}`)
  for (const action of ['ON DELETE CASCADE', 'ON DELETE SET NULL', 'ON UPDATE CASCADE', 'DEFERRABLE INITIALLY DEFERRED', 'DEFERRABLE INITIALLY IMMEDIATE']) {
    await prisma.$executeRawUnsafe(`CREATE TABLE test_fk_pin_probe (id int PRIMARY KEY, product_id varchar(21) REFERENCES wine_products(id) ${action})`)
    const red = pin()
    await prisma.$executeRawUnsafe(`DROP TABLE test_fk_pin_probe`)
    ok(red.status === 1 && red.stderr.includes('test_fk_pin_probe.') && red.stderr.includes(action.startsWith('DEFERRABLE') ? ', DEFERRABLE;' : action),
      `🔒 negative control: a NEW table with an ${action} key into the catalogue fails the pin, named${red.status === 1 ? '' : ` (exit ${red.status}: ${red.stdout.trim()})`}`)
  }
  ok(pin().status === 0, '…and the pin is green again once it is gone')

  console.log('\n22g. The backfill (the migration\'s @recipe block), on the re-survey\'s odd rows')
  let lib = null
  try { lib = await import('../lib/modelChangeBackfill.mjs'); lib.readBackfillSteps() } catch (e) { ok(false, `the backfill block is readable from the migration (${e.message})`); lib = null }
  if (lib) {
    const steps = lib.readBackfillSteps()
    ok(JSON.stringify(steps.map(s => s.name)) === JSON.stringify(['origin', 'snapshot', 'abv', 'bookmark-snapshot', 'bookmark-moment', 'bookmark-link']),
      `the steps, in order: ${steps.map(s => s.name).join(', ')}`)
    // Bottles as the previous release leaves them (Q5a of the re-survey), and the
    // pairs a new writer or an old instance's PATCH leaves: id, session, category,
    // style, adder, position, then the stored snapshot (colour, sparkling, abv).
    const W = [
      ['test_mcb_sess', 900910, 'wine', 'red', null, null],       // in a moment
      ['test_mcb_orph', null, 'wine', 'white', null, null],       // orphaned, a session rating left
      ['test_mcb_solo', null, 'wine', 'spark', null, null],       // a check-in with its rating
      ['9000000000001', null, 'wine', 'rose', null, null],        // legacy Date.now() id, nothing left: session
      ['9000000000002', null, 'wine', 'nonalc', null, null],      // legacy id WITH a standalone rating: the rating wins
      ['test_mcb_addr', null, 'wine', null, 'u:900950', null],    // an adder: session
      ['test_mcb_posn', null, 'wine', 'red', null, 3],            // a position: session
      ['test_mcb_gone', null, 'wine', 'white', null, null],       // a check-in whose rating was deleted: standalone
      ['test_mcb_edit', 900910, 'wine', 'red', null, null,        // an old PATCH changed white → red: re-derived
        'white', false, null],
      ['test_mcb_e2sp', 900910, 'wine', 'red', null, null,        // an old PATCH changed spark → red: re-derived
        null, true, null],
      ['test_mcb_rose', 900910, 'wine', 'spark', null, null,      // a sparkling rosé (new code): never touched
        'rose', true, null],
      ['test_mcb_dsrt', 900910, 'wine', 'dessert', null, null],   // a token that derives to neither: untouched
      ['test_mcb_beer', 900910, 'test_beer', 'red', null, null],  // another category: untouched
      ['test_mcb_abv0', 900910, 'wine', 'red', null, null,        // abv 0 left on a bottle no longer alcohol-free: reported
        null, false, '0'],
      ['test_mcb_l1', 900910, 'wine', 'red', null, null],         // linked bottles for the bookmark link
      ['test_mcb_l2', null, 'wine', 'red', null, null],
      ['test_mcb_l3', null, 'wine', 'red', null, null],
    ]
    const expected = {
      test_mcb_sess: ['session', 'red', false, null], test_mcb_orph: ['session', 'white', false, null],
      test_mcb_solo: ['standalone', null, true, null], '9000000000001': ['session', 'rose', false, null],
      '9000000000002': ['standalone', null, false, '0.00'], test_mcb_addr: ['session', null, false, null],
      test_mcb_posn: ['session', 'red', false, null], test_mcb_gone: ['standalone', 'white', false, null],
      test_mcb_edit: ['session', 'red', false, null], test_mcb_e2sp: ['session', 'red', false, null],
      test_mcb_rose: ['session', 'rose', true, null], test_mcb_dsrt: ['session', null, false, null],
      test_mcb_beer: ['session', null, false, null], test_mcb_abv0: ['session', 'red', false, '0.00'],
    }
    const ids = W.map(w => `'${w[0]}'`).join(',')
    const fixture = async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO categories (category,label) VALUES ('test_beer','Test') ON CONFLICT DO NOTHING`)
      await tx.$executeRawUnsafe(`INSERT INTO category_styles (category,style,label) VALUES ('test_beer','red','Red ale') ON CONFLICT DO NOTHING`)
      for (const [id, sid, cat, style, adder, pos] of W) {
        await tx.$executeRawUnsafe(`INSERT INTO wines (id,session_id,name,producer,vintage,category,style,added_by_identity_id,position) VALUES ($1,$2,$3,'P','2019',$4,$5,$6,$7)`,
          id, sid, `N ${id}`, cat, style, adder, pos)
      }
      await tx.$executeRawUnsafe(`UPDATE wines SET product_id='test_wpMC1', vintage_id='test_vMC1' WHERE id IN ('test_mcb_l1','test_mcb_l2')`)
      await tx.$executeRawUnsafe(`UPDATE wines SET product_id='test_wpMC2' WHERE id='test_mcb_l3'`)
      await tx.$executeRawUnsafe(`
        INSERT INTO ratings (wine_id,user_id,session_id,origin,rater_name,rated_at) VALUES
          ('test_mcb_orph',900951,900911,'session','Ub',now()), ('test_mcb_solo',900950,NULL,'standalone','Ua',now()),
          ('9000000000002',900950,NULL,'standalone','Ua',now())`)
      // The pre-migration state (the trigger filled origin on insert), then the
      // pairs some rows were left with.
      await tx.$executeRawUnsafe(`UPDATE wines SET origin=NULL, colour=NULL, sparkling=false, abv=NULL WHERE id IN (${ids})`)
      for (const [id, , , , , , colour, sparkling, abv] of W.filter(w => w.length > 6)) {
        await tx.$executeRawUnsafe(`UPDATE wines SET colour=$2, sparkling=$3, abv=$4::numeric WHERE id=$1`, id, colour, sparkling, abv)
      }
      // Bookmarks the old release writes (a source bottle, nothing else), and one a
      // new writer wrote (linked, its own snapshot) that the steps must not touch.
      await tx.$executeRawUnsafe(`
        INSERT INTO bookmarks (user_id,wine_id,saved_at) VALUES
          (900950,'test_mcb_sess','2026-01-01'), (900950,'test_mcb_orph','2026-01-02'), (900950,'test_mcb_gone','2026-01-03'),
          (900951,'test_mcb_l2','2026-02-01'), (900951,'test_mcb_l1','2026-03-01'),
          (900950,'test_mcb_l1','2026-01-04'), (900950,'test_mcb_l3','2026-01-05')`)
      await tx.$executeRawUnsafe(`INSERT INTO bookmarks (user_id,wine_id,product_id,saved_at) VALUES (900950,'test_mcb_solo','test_wpMC3','2026-01-06')`)
    }
    const state = tx => tx.$queryRawUnsafe(`
      SELECT 'w:' || w.id AS k, concat_ws('|', w.origin, w.colour, w.sparkling, w.abv) AS v FROM wines w WHERE w.id IN (${ids})
      UNION ALL
      SELECT 'b:' || b.user_id || ':' || b.wine_id, concat_ws('|', b.name, b.producer, b.vintage, b.source_session_id, b.product_id, b.vintage_id)
        FROM bookmarks b WHERE b.wine_id LIKE 'test_mcb_%'
      ORDER BY 1`)
    const outcome = {}
    try {
      await prisma.$transaction(async (tx) => {
        await fixture(tx)
        for (const s of steps) await tx.$executeRawUnsafe(s.sql)
        outcome.wines = await tx.$queryRawUnsafe(`SELECT id, origin, colour, sparkling, abv::text AS abv FROM wines WHERE id IN (${ids})`)
        outcome.bookmarks = await tx.$queryRawUnsafe(`
          SELECT user_id, wine_id, name, producer, vintage, source_session_id, product_id, vintage_id FROM bookmarks WHERE wine_id LIKE 'test_mcb_%'`)
        const before = JSON.stringify(await state(tx))
        outcome.second = 0
        for (const s of steps) outcome.second += await tx.$executeRawUnsafe(s.sql)
        outcome.unchanged = JSON.stringify(await state(tx)) === before
        throw ROLLBACK
      }, { timeout: 60_000 })
    } catch (e) { if (e !== ROLLBACK) outcome.error = String(e.message || e).split('\n')[0] }
    ok(!outcome.error, `the steps run${outcome.error ? ` (${outcome.error})` : ''}`)
    const wrong = Object.entries(expected).filter(([id, [origin, colour, sparkling, abv]]) => {
      const r = outcome.wines?.find(x => x.id === id)
      return !r || r.origin !== origin || r.colour !== colour || r.sparkling !== sparkling || r.abv !== abv
    }).map(([id]) => `${id}=${JSON.stringify(outcome.wines?.find(x => x.id === id))}`)
    ok(outcome.wines && wrong.length === 0,
      `🔒 origin by the ruled order (moment or session rating → standalone rating → legacy 13-digit id → adder or position → standalone); the pair re-derived from style where it derives to something else, ONE direction (a sparkling rosé, a dessert token and another category untouched); abv fill-only${wrong.length ? ` — wrong: ${wrong.join('; ')}` : ''}`)
    const bk = (u, w) => outcome.bookmarks?.find(b => b.user_id === u && b.wine_id === w)
    const b1 = bk(900950, 'test_mcb_sess'), b2 = bk(900950, 'test_mcb_orph'), b3 = bk(900950, 'test_mcb_gone')
    ok(b1?.name === 'N test_mcb_sess' && b1.producer === 'P' && b1.vintage === '2019' && b1.source_session_id === 900910,
      'a bookmark gets its bottle\'s snapshot (name, producer, vintage) and its moment')
    ok(b2?.source_session_id === 900911, '…an orphaned bottle\'s bookmark gets the moment of its ratings (cravingSessionIdSql\'s rule)')
    ok(b3 && b3.source_session_id === null, '…and one whose bottle has no moment at all keeps none')
    ok(bk(900951, 'test_mcb_l2')?.product_id === 'test_wpMC1' && bk(900951, 'test_mcb_l2')?.vintage_id === 'test_vMC1'
       && bk(900951, 'test_mcb_l1')?.product_id === null,
      '🔒 two bookmarks of one person whose bottles link to one wine: the EARLIER takes the link, the other stays unlinked for the conversion\'s merge (no unique violation)')
    ok(bk(900950, 'test_mcb_l1')?.product_id === null, '…and a bookmark whose wine the person already saves stays unlinked too')
    ok(bk(900950, 'test_mcb_l3')?.product_id === 'test_wpMC2' && bk(900950, 'test_mcb_l3')?.vintage_id === null, 'a product-grain bottle links its bookmark at product grain')
    const nw = bk(900950, 'test_mcb_solo')
    ok(nw && nw.name === null && nw.source_session_id === null && nw.product_id === 'test_wpMC3',
      '🔒 a linked craving (a new writer\'s) is never touched by the bookmark steps')
    ok(outcome.second === 0 && outcome.unchanged === true, `🔒 idempotent: a second run changes nothing (${outcome.second} rows)`)

    // The release-day script runs the same block. Its guards first.
    const url = new URL(process.env.DATABASE_URL), db = `${url.hostname}/${decodeURIComponent(url.pathname.slice(1))}`
    const noEnv = spawnSync(process.execPath, [join(ROOT, 'scripts/backfill-model-change.mjs')],
      { env: { ...process.env, DATABASE_URL: '' }, encoding: 'utf8', cwd: tmpdir() })
    ok(noEnv.status === 2 && noEnv.stderr.includes('not set in the environment'), '🔒 the script refuses to start without DATABASE_URL in the environment (never the checkout\'s .env)')
    const noExpect = node('scripts/backfill-model-change.mjs', ['--apply'])
    ok(noExpect.status === 2, '…and --apply without --expect-db is a usage error')
    await prisma.$transaction(fixture, { timeout: 60_000 })
    const stateOf = async () => JSON.stringify(await state(prisma))
    const pre = await stateOf()
    const wrongDb = node('scripts/backfill-model-change.mjs', ['--apply', '--expect-db', `${url.hostname}/not_this_one`])
    ok(wrongDb.status === 1 && wrongDb.stderr.includes('is not the target') && (await stateOf()) === pre,
      '🔒 --apply against a host / database other than --expect-db is refused before connecting, nothing written')
    // Never a real connection: refused before connecting. Inherited Deplo.io CA
    // variables are stripped too, so "no CA" means none.
    const noCaEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NINE_PGDB_[A-Z0-9_]+_CA_CERT$/.test(k)))
    const farAway = spawnSync(process.execPath, [join(ROOT, 'scripts/backfill-model-change.mjs'), '--apply', '--expect-db', 'db.example.invalid/verre'],
      { env: { ...noCaEnv, DATABASE_URL: 'postgres://u:p@db.example.invalid:5432/verre', DATABASE_CA_CERT: '' }, encoding: 'utf8', timeout: 30_000 })
    ok(farAway.status === 1 && farAway.stderr.includes('needs the database CA') && farAway.stderr.includes('tls none (no CA in the environment'),
      '🔒 --apply to a host that is not loopback without the CA in the environment is refused before connecting, the TLS state printed')
    const urlTls = spawnSync(process.execPath, [join(ROOT, 'scripts/backfill-model-change.mjs'), '--apply', '--expect-db', 'db.example.invalid/verre'],
      { env: { ...noCaEnv, DATABASE_URL: 'postgres://u:p@db.example.invalid:5432/verre?sslmode=no-verify', DATABASE_CA_CERT: 'dummy' }, encoding: 'utf8', timeout: 30_000 })
    ok(urlTls.status === 1 && urlTls.stderr.includes('needs the database CA') && urlTls.stderr.includes('set by the URL'),
      '🔒 …and so is one whose URL carries its own TLS parameters (pg lets them replace the CA), named as such')
    // 🔒 Codex r1: the URL's query can move the HOST (`?host=`, encoded too) and pg
    // follows it, so the guard reads pg's resolved configuration, never the URL text.
    for (const q of ['host=db.example.invalid', '%68ost=db.example.invalid']) {
      const moved = spawnSync(process.execPath, [join(ROOT, 'scripts/backfill-model-change.mjs'), '--apply', '--expect-db', 'localhost/verre'],
        { env: { ...noCaEnv, DATABASE_URL: `postgres://u:p@localhost:5432/verre?${q}`, DATABASE_CA_CERT: '' }, encoding: 'utf8', timeout: 30_000 })
      ok(moved.status === 1 && moved.stderr.includes('target db.example.invalid:5432/verre') && moved.stderr.includes('is not the target'),
        `🔒 a URL whose query moves the host (?${q}) is shown and checked as the host pg will connect to, refused before connecting`)
    }
    // 🔒 Codex r2: a host-less URL takes PGHOST from the environment, and the client
    // loads the checkout's .env after the guard ran: the guard loads it first.
    const envDir = mkdtempSync(join(tmpdir(), 'verre-dotenv-'))
    try {
      writeFileSync(join(envDir, '.env'), 'PGHOST=db.example.invalid\nPGSSLMODE=no-verify\n')
      const bare = Object.fromEntries(Object.entries(noCaEnv).filter(([k]) => !/^PG(HOST|PORT|DATABASE|SSLMODE|USER|PASSWORD)$/.test(k)))
      const hostless = spawnSync(process.execPath, [join(ROOT, 'scripts/backfill-model-change.mjs'), '--apply', '--expect-db', 'localhost/verre'],
        { env: { ...bare, DATABASE_URL: 'postgres:///verre', DATABASE_CA_CERT: '' }, encoding: 'utf8', timeout: 30_000, cwd: envDir })
      ok(hostless.status === 1 && hostless.stderr.includes('target db.example.invalid:5432/verre') && hostless.stderr.includes('is not the target'),
        `🔒 a host-less URL resolves with the .env the client will load (PGHOST there), refused before connecting${hostless.status === 1 ? '' : ` (${hostless.stderr.trim()})`}`)
    } finally { rmSync(envDir, { recursive: true, force: true }) }
    const mig = lib.expandMigrationIdentity()
    let edited
    try {
      await prisma.$executeRawUnsafe(`UPDATE _prisma_migrations SET checksum = $1 WHERE migration_name = $2`, '0'.repeat(64), mig.name)
      edited = node('scripts/backfill-model-change.mjs', ['--apply', '--expect-db', db])
    } finally {
      await prisma.$executeRawUnsafe(`UPDATE _prisma_migrations SET checksum = $1 WHERE migration_name = $2`, mig.sha256, mig.name)
    }
    ok(edited.status === 1 && lastJson(edited.stdout)?.refused?.includes('is not the file the database applied') && (await stateOf()) === pre,
      '🔒 a checkout whose migration file is not the one the database applied (sha256 ≠ the recorded checksum) is refused, nothing written')
    // A database error (here a lock timeout: another transaction holds bookmarks)
    // keeps its code and message in the result, and writes nothing.
    const locked = {}
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE bookmarks IN ACCESS EXCLUSIVE MODE`)
      locked.r = node('scripts/backfill-model-change.mjs', ['--apply', '--expect-db', db])
      throw ROLLBACK
    }, { timeout: 60_000 }).catch(e => { if (e !== ROLLBACK) locked.error = String(e.message || e) })
    ok(locked.r?.status === 1 && /55P03.*lock timeout/.test(lastJson(locked.r.stdout)?.refused ?? '') && (await stateOf()) === pre,
      `🔒 a database error (a lock timeout, 55P03) is reported with its code and message, nothing written${locked.r?.status === 1 ? '' : ` (${locked.error ?? locked.r?.stdout})`}`)
    const dry = node('scripts/backfill-model-change.mjs')
    const dryOut = lastJson(dry.stdout)
    ok(dry.status === 0 && dryOut?.mode === 'dry-run' && dryOut.steps.origin >= W.length && (await stateOf()) === pre
       && /idle_in_transaction_session_timeout 30s/.test(dryOut.bounds ?? '') && dry.stderr.includes(`target ${url.hostname}`),
      `the dry run counts, writes nothing, prints the target first and runs under the server-side bounds${dry.status === 0 ? '' : ` (exit ${dry.status}: ${dry.stderr.trim()})`}`)
    const run = node('scripts/backfill-model-change.mjs', ['--apply', '--expect-db', db])
    const runOut = lastJson(run.stdout)
    ok(run.status === 0 && runOut?.mode === 'apply' && (await stateOf()) !== pre
       && runOut.report.bookmarksLeftUnlinked.length >= 2 && runOut.report.abvContradictsStyle.includes('test_mcb_abv0')
       && !runOut.report.abvContradictsStyle.includes('9000000000002'),
      `…--apply writes, and reports (never changes) the unlinked bookmarks and an abv that contradicts its style${run.status === 0 ? '' : ` (exit ${run.status}: ${run.stdout.trim()})`}`)
    const again = lastJson(node('scripts/backfill-model-change.mjs', ['--apply', '--expect-db', db]).stdout)
    ok(again && Object.values(again.steps).every(n => n === 0), `…a second --apply changes nothing (${JSON.stringify(again?.steps)})`)
  }

  console.log('\n22h. The columns file (file 2): the guarded one-off update')
  const dir = mkdtempSync(join(tmpdir(), 'verre-cols-'))
  try {
    const url = new URL(process.env.DATABASE_URL), db = `${url.hostname}/${decodeURIComponent(url.pathname.slice(1))}`
    const digestOf = async (rowSql, from) => (await raw(`SELECT count(*)::int AS rows, encode(sha256(convert_to(count(*)::text || E'\\n' || coalesce(string_agg(
        json_build_array(${rowSql})::text, E'\\n' ORDER BY t.id COLLATE "C"), ''), 'UTF8')), 'hex') AS digest FROM ${from} t`))[0]
    const builtOn = async () => digestOf('t.id, t.name, t.category, t.style, t.colour, t.sparkling, t.abv, t.grapes, t.region, t.scope, t.status, t.links_to, t.curator_locked, t.added_by, t.curated_by', 'public.wine_products')
    // A manifest for file bytes and the rows the other side hashed (rowsSql).
    const manifestFor = async (name, bytes, rowsSql, mut = m => m) => {
      const d = await digestOf('t.id, t.country, t.description, t.vinification', `(${rowsSql})`)
      const m = mut({ contentDigest: { version: 'cd1', tables: { wine_products: { rows: d.rows, digest: d.digest } } },
        tables: [{ table: 'wine_products', columns: ['id', 'country', 'description', 'vinification'], rows: d.rows, bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') }],
        builtOn: { version: 'cd1', wine_products: await builtOn() } })
      const path = join(dir, `${name}.json`)
      writeFileSync(path, JSON.stringify(m))
      return path
    }
    // Written by Postgres itself (COPY … TO STDOUT through psql), so the escaping is COPY's.
    const copyFile = (name, rowsSql) => {
      const r = spawnSync('psql', [process.env.DATABASE_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c',
        `COPY (SELECT * FROM (${rowsSql}) x ORDER BY x.id COLLATE "C") TO STDOUT`])
      if (r.status !== 0) throw new Error(`psql COPY failed: ${r.stderr}`)
      const file = join(dir, `${name}.copy`)
      writeFileSync(file, r.stdout)
      return { file, bytes: r.stdout }
    }
    // Written by hand, for what COPY TO never emits.
    const handFile = (name, text) => { const file = join(dir, `${name}.copy`), bytes = Buffer.from(text, 'utf8'); writeFileSync(file, bytes); return { file, bytes } }
    const update = (m, f, extra = []) => node('scripts/catalog-columns-update.mjs', ['--manifest', m, '--file', f, ...extra])
    const cols = async () => JSON.stringify(await raw(`SELECT id, country, description, vinification, xmax::text AS xmax FROM wine_products WHERE id LIKE 'test_wpMC%' ORDER BY id`))
    await prisma.$executeRawUnsafe(`UPDATE wine_products SET country=NULL, description=NULL, vinification=NULL, curator_locked='{}' WHERE id LIKE 'test_wpMC%'`)
    const rowsSql = `SELECT * FROM (VALUES
        ('test_wpMC1', NULL::text, NULL::text, NULL::text),
        ('test_wpMC2', 'IT', E'Tab\\there, a newline\\nand a backslash \\\\ é ü 🍷', NULL),
        ('test_wpMC3', 'CH', NULL, 'Whole-bunch fermented.')
      ) v(id, country, description, vinification) WHERE country IS NOT NULL OR description IS NOT NULL OR vinification IS NOT NULL`
    const good = copyFile('good', rowsSql)
    const goodManifest = await manifestFor('good', good.bytes, rowsSql)
    const before = await cols()
    // 🔒 The dry run READS only: no UPDATE attempted (an aborted UPDATE would set
    // xmax on the rows), no lock.
    const dry = update(goodManifest, good.file)
    const dryOut = lastJson(dry.stdout)
    ok(dry.status === 0 && dryOut?.rows === 2 && dryOut.writes.country === 2 && dryOut.writes.description === 1 && (await cols()) === before,
      `the dry run passes every check and writes nothing, not even an aborted UPDATE (xmax unchanged)${dry.status === 0 ? '' : ` (exit ${dry.status}: ${dry.stdout.trim()} ${dry.stderr.trim()})`}`)
    ok(update(goodManifest, good.file, ['--apply']).status === 2, '--apply without --expect-db is a usage error')
    const other = update(goodManifest, good.file, ['--apply', '--expect-db', `${url.hostname}/not_this_one`])
    ok(other.status === 1 && other.stderr.includes('is not the target') && (await cols()) === before, '🔒 --apply against a host / database other than --expect-db is refused before connecting, nothing written')
    const refusals = [
      ['a tampered sha256', m => { m.tables[0].sha256 = '0'.repeat(64); return m }, 'sha256 is not'],
      ['a bytes count that is not the file\'s', m => { m.tables[0].bytes += 1; return m }, 'bytes, the manifest says'],
      ['a wrong row count', m => { m.tables[0].rows = 3; m.contentDigest.tables.wine_products.rows = 3; return m }, 'the file has 2 rows, the manifest says 3'],
      ['a digest that is not the decoded rows\'', m => { m.contentDigest.tables.wine_products.digest = 'a'.repeat(64); return m }, 'content digest'],
      ['a file built on another catalogue (builtOn differs)', m => { m.builtOn.wine_products.digest = 'b'.repeat(64); return m }, 'not the one the file was built on'],
      ['a manifest that does not say which catalogue it was built on', m => { delete m.builtOn; return m }, 'built on'],
    ]
    for (const [label, mut, word] of refusals) {
      const r = update(await manifestFor(`r${refusals.findIndex(x => x[0] === label)}`, good.bytes, rowsSql, mut), good.file)
      ok(r.status === 1 && lastJson(r.stdout)?.refused?.reason.includes(word) && (await cols()) === before,
        `refused: ${label}, nothing written${r.status === 1 && lastJson(r.stdout)?.refused?.reason.includes(word) ? '' : ` (exit ${r.status}: ${r.stdout.trim()})`}`)
    }
    const nul = 'NULL::text'
    const one1 = (id, c, d, v) => `SELECT ${id}::text AS id, ${c} AS country, ${d} AS description, ${v} AS vinification`
    for (const [label, sql, word] of [
      ['an unknown id', one1(`'test_nope'`, `'FR'::text`, nul, nul), 'not a product'],
      ['a code outside the list', one1(`'test_wpMC1'`, `'XX'::text`, nul, nul), '249 codes'],
      ['a blank text', one1(`'test_wpMC1'`, nul, `E'\\u00a0'::text`, nul), 'not as the contract'],
      ['a row with no value', one1(`'test_wpMC1'`, nul, nul, nul), 'no value'],
      ['a text longer than 1000 characters', one1(`'test_wpMC1'`, nul, `repeat('a', 1001)`, nul), 'longer than 1000'],
      ['a text not in NFC', one1(`'test_wpMC1'`, nul, `E'Cafe\\u0301.'::text`, nul), 'not as the contract'],
      ['an untrimmed text', one1(`'test_wpMC1'`, nul, `' Untrimmed.'::text`, nul), 'not as the contract'],
      ['a text holding a character scrub removes', one1(`'test_wpMC1'`, nul, `E'Zero\\u200bwidth.'::text`, nul), 'not as the contract'],
    ]) {
      const f = copyFile(`s${label.length}`, sql)
      const r = update(await manifestFor(`s${label.length}`, f.bytes, sql), f.file)
      ok(r.status === 1 && lastJson(r.stdout)?.refused?.reason.includes(word) && (await cols()) === before,
        `refused: ${label}, nothing written${r.status === 1 && lastJson(r.stdout)?.refused?.reason.includes(word) ? '' : ` (exit ${r.status}: ${r.stdout.trim()})`}`)
    }
    // Hand-written files: octal and hex escapes decode to UTF-8 bytes (é = C3 A9),
    // a leading U+FEFF is KEPT (and then refused by the scrub rule, not lost into
    // a digest mismatch), ids out of order and repeated are refused.
    const eSql = one1(`'test_wpMC2'`, `'IT'::text`, `'Né. Hé.'::text`, nul)
    const esc = handFile('escapes', 'test_wpMC2\tIT\tN\\303\\251. H\\xc3\\xa9.\t\\N\n')
    const escRun = update(await manifestFor('escapes', esc.bytes, eSql), esc.file)
    ok(escRun.status === 0, `octal (\\303\\251) and hex (\\xc3\\xa9) escapes decode to the same text the other side hashed${escRun.status === 0 ? '' : ` (${escRun.stdout.trim()})`}`)
    const bom = handFile('bom', 'test_wpMC2\tIT\t﻿Leading mark.\t\\N\n')
    const bomRun = update(await manifestFor('bom', bom.bytes, one1(`'test_wpMC2'`, `'IT'::text`, `E'\\ufeffLeading mark.'::text`, nul)), bom.file)
    ok(bomRun.status === 1 && lastJson(bomRun.stdout)?.refused?.reason.includes('not as the contract'), `a field starting with U+FEFF keeps it (refused by the scrub rule, not by a digest mismatch)${bomRun.status === 1 ? '' : ` (${bomRun.stdout.trim()})`}`)
    for (const [label, text] of [['out of order', 'test_wpMC3\tCH\t\\N\t\\N\ntest_wpMC2\tIT\t\\N\t\\N\n'], ['repeated', 'test_wpMC2\tIT\t\\N\t\\N\ntest_wpMC2\tCH\t\\N\t\\N\n']]) {
      const f = handFile(`order${label.length}`, text)
      const r = update(await manifestFor(`order${label.length}`, f.bytes, rowsSql, m => { m.tables[0].rows = 2; m.contentDigest.tables.wine_products.rows = 2; return m }), f.file)
      ok(r.status === 1 && lastJson(r.stdout)?.refused?.reason.includes('strictly ascending'), `refused: ids ${label}${r.status === 1 ? '' : ` (${r.stdout.trim()})`}`)
    }
    await prisma.$executeRawUnsafe(`UPDATE wine_products SET country='FR' WHERE id='test_wpMC3'`)
    const taken = update(await manifestFor('taken', good.bytes, rowsSql), good.file)
    ok(taken.status === 1 && lastJson(taken.stdout)?.refused?.reason.includes('already holds') && lastJson(taken.stdout)?.refused?.examples?.[0] === 'test_wpMC3',
      'refused: a target column already filled (fill NULL only), the id named')
    await prisma.$executeRawUnsafe(`UPDATE wine_products SET country=NULL, curator_locked='{country}' WHERE id='test_wpMC3'`)
    const locked = update(await manifestFor('locked', good.bytes, rowsSql), good.file)
    ok(locked.status === 1 && lastJson(locked.stdout)?.refused?.reason.includes('locked by a curator') && lastJson(locked.stdout)?.refused?.examples?.[0] === 'test_wpMC3',
      'refused: a target column a curator locked (curator_locked), the id named')
    await prisma.$executeRawUnsafe(`UPDATE wine_products SET curator_locked='{}', description='Kept.' WHERE id='test_wpMC3'`)
    const finalManifest = await manifestFor('final', good.bytes, rowsSql)
    const held = {}
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE wine_products IN ACCESS EXCLUSIVE MODE`)
      held.r = update(finalManifest, good.file, ['--apply', '--expect-db', db])
      throw ROLLBACK
    }, { timeout: 60_000 }).catch(e => { if (e !== ROLLBACK) held.error = String(e.message || e) })
    ok(held.r?.status === 1 && /^error: .*55P03.*lock timeout/.test(lastJson(held.r.stdout)?.refused?.reason ?? ''),
      `🔒 a database error (a lock timeout, 55P03) is reported with its code and message, nothing written${held.r?.status === 1 ? '' : ` (${held.error ?? held.r?.stdout})`}`)
    const applied = update(finalManifest, good.file, ['--apply', '--expect-db', db])
    const after = await raw(`SELECT id, country, description, vinification FROM wine_products WHERE id LIKE 'test_wpMC%' ORDER BY id`)
    ok(applied.status === 0 && after[0].country === null && after[1].country === 'IT'
       && after[1].description === 'Tab\there, a newline\nand a backslash \\ é ü 🍷' && after[2].country === 'CH'
       && after[2].vinification === 'Whole-bunch fermented.' && after[2].description === 'Kept.',
      `--apply writes exactly the file's values (COPY escapes decoded), and a \\N leaves the column as it is${applied.status === 0 ? '' : ` (exit ${applied.status}: ${applied.stdout.trim()})`}`)
    const rerun = update(finalManifest, good.file, ['--apply', '--expect-db', db])
    ok(rerun.status === 1 && lastJson(rerun.stdout)?.refused?.reason.includes('already holds'),
      '…and a re-run is refused: the catalogue still matches builtOn (cd1 does not cover the three columns), and the filled targets refuse it')
  } catch (e) {
    ok(false, `the columns-file subsection ran (${String(e.message || e).split('\n')[0]})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
