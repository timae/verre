#!/usr/bin/env node
// Integration tests for the wine-catalog phase-1 schema invariants.
//
// WHY THIS EXISTS: the check-schema CI gate compares schema.prisma against the
// migrations directory. It CANNOT see CHECK bodies, deferred constraint
// triggers, partial uniqueness, NULLS NOT DISTINCT, audit immutability, or
// concurrency behaviour — Prisma's diff ignores objects it can't model. So a
// regression that narrows the lead trigger back to `UPDATE OF "role"`, or drops
// a NOT NULL, or removes the last-admin guard, would pass that gate silently.
// Every assertion below covers something the gate is blind to, and several of
// them are defects that ACTUALLY SHIPPED in review drafts.
//
// Run against a DISPOSABLE database — it writes and deletes rows, and one test
// deliberately leaves an admin grant in place. Never point it at a database
// with real data.
//
//   DATABASE_URL=postgresql://…/catalog_test node scripts/tests/catalog-schema-integration.mjs
//
// Wired into .github/workflows/check-schema.yml against its own database,
// separate from Prisma's shadow database (the shadow DB is Prisma's scratch
// space for computing diffs; sharing it would let the two stomp on each other).

import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const prisma = new PrismaClient()
let pass = 0
const failures = []

function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { failures.push(label); console.log(`  FAIL ${label}`) }
}

// Asserts the statement is REJECTED **BY THE EXPECTED CONSTRAINT**.
//
// 🔒 `expect` is MANDATORY, and that is the whole point. An earlier version of
// this helper treated ANY exception as success, which made assertions silently
// vacuous: mutation testing showed the suite still reported 65/65 after the
// unwanted `scope` default was restored, the staff-role CHECK was dropped, and a
// tested primary key was dropped — because each statement still failed, just for
// an UNRELATED reason (usually the lead-producer trigger firing first). A test
// that passes for the wrong reason is worse than no test: it reports coverage it
// does not have.
//
// `expect` is matched against the error text (constraint name, or a distinctive
// fragment of a RAISE message). If the statement fails for a different reason,
// that is a FAILURE, not a pass.
//
// `SET CONSTRAINTS ALL IMMEDIATE` forces the DEFERRED triggers to fire inside
// the savepoint — without it a deferred violation escapes to the outer COMMIT
// where it cannot be attributed to this statement.
async function rejects(label, sql, expect) {
  if (!expect) { ok(false, `${label} (TEST BUG: no expected constraint given)`); return }
  try {
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(sql)
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
    })
    ok(false, `${label} (was ACCEPTED — should be rejected by ${expect})`)
  } catch (e) {
    const msg = String(e.message || e)
    if (msg.includes(expect)) ok(true, label)
    else ok(false, `${label} (rejected by the WRONG thing — wanted ${expect}, got: ${
      msg.replace(/\s+/g, ' ').slice(0, 160)})`)
  }
}

async function accepts(label, sql) {
  try {
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(sql)
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
    })
    ok(true, label)
  } catch (e) { ok(false, `${label} (was REJECTED: ${e.message.split('\n')[0]})`) }
}

const raw = sql => prisma.$queryRawUnsafe(sql)

async function reset() {
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      DELETE FROM wines WHERE id LIKE 'test_%';
      DELETE FROM product_eans WHERE product_id LIKE 'test_%';
      DELETE FROM wine_vintages WHERE id LIKE 'test_%';
      DELETE FROM product_producers WHERE product_id LIKE 'test_%';
      DELETE FROM wine_products WHERE id LIKE 'test_%';
      DELETE FROM producers WHERE id LIKE 'test_%';
      -- The existing prevent_session_hard_delete trigger (20260514183437)
      -- blocks DELETE FROM sessions — soft-delete is a real DB invariant, not
      -- an app convention. Disable it for this one scoped cleanup, exactly as
      -- the documented operator runbook does.
      BEGIN
        ALTER TABLE sessions DISABLE TRIGGER prevent_session_hard_delete;
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
      DELETE FROM sessions WHERE code = 'TESTCATA';
      BEGIN
        ALTER TABLE sessions ENABLE TRIGGER prevent_session_hard_delete;
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
      -- Teardown must not depend on the trigger EXISTING: if a regression drops
      -- it, the suite has to report a test FAILURE, not crash in cleanup with
      -- 42704 and produce no result at all (which is how a dropped-trigger
      -- mutation first surfaced — as an empty report rather than a red test).
      BEGIN
        ALTER TABLE staff_role_audit DISABLE TRIGGER staff_role_audit_immutable;
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
      DELETE FROM staff_role_audit WHERE subject_id >= 900000;
      BEGIN
        ALTER TABLE staff_role_audit ENABLE TRIGGER staff_role_audit_immutable;
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
      -- Likewise the last-admin guard added by this migration: the fixtures
      -- deliberately end with a sole admin, which is precisely what it refuses
      -- to remove. Disabling it here is the test tearing down its own fixture,
      -- not a bypass of the invariant under test (§17 asserts it while ENABLED).
      BEGIN
        ALTER TABLE staff_roles DISABLE TRIGGER staff_roles_last_admin_guard;
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
      DELETE FROM staff_roles WHERE user_id >= 900000;
      BEGIN
        ALTER TABLE staff_roles ENABLE TRIGGER staff_roles_last_admin_guard;
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
      DELETE FROM users WHERE id >= 900000;
      BEGIN
        ALTER TABLE catalog_audit DISABLE TRIGGER catalog_audit_immutable;
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
      DELETE FROM catalog_audit WHERE entity_id LIKE 'test_%';
      BEGIN
        ALTER TABLE catalog_audit ENABLE TRIGGER catalog_audit_immutable;
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
    END $$;`)
}

// A product can only be created together with its lead link (the creation
// trigger enforces it), so every fixture goes through this.
async function makeProduct(id, producerId, extra = '') {
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(
      `INSERT INTO wine_products (id,name,scope,status${extra ? ',' + extra.split('=')[0] : ''})
       VALUES ('${id}','${id} name','shared','confirmed'${extra ? ",'" + extra.split('=')[1] + "'" : ''})`)
    await tx.$executeRawUnsafe(
      `INSERT INTO product_producers (product_id,producer_id,role)
       VALUES ('${id}','${producerId}','lead')`)
  })
}

async function main() {
  await reset()

  console.log('\n1. Generated folded columns (the single normalization path)')
  await prisma.$executeRawUnsafe(
    `INSERT INTO producers (id,name,status) VALUES ('test_pA','Château Léoville','confirmed')`)
  const [f] = await raw(`SELECT name_folded FROM producers WHERE id='test_pA'`)
  ok(f.name_folded === 'chateau leoville', 'accents folded + lowercased')
  await rejects('a generated column cannot be written',
    `UPDATE producers SET name_folded='hacked' WHERE id='test_pA'`,
    'can only be updated to DEFAULT')
  await prisma.$executeRawUnsafe(`UPDATE producers SET name='Rénamed' WHERE id='test_pA'`)
  const [f2] = await raw(`SELECT name_folded FROM producers WHERE id='test_pA'`)
  ok(f2.name_folded === 'renamed', 'fold tracks display updates (not frozen at insert)')

  console.log('\n2. Array folds: {} stays {}, never NULL')
  await makeProduct('test_wA', 'test_pA')
  const [g] = await raw(`SELECT grapes_folded, cardinality(grapes_folded) c FROM wine_products WHERE id='test_wA'`)
  ok(g.grapes_folded !== null && Number(g.c) === 0, '{} folds to {} — array_agg-over-zero-rows COALESCE holds')
  await prisma.$executeRawUnsafe(
    `UPDATE wine_products SET grapes=ARRAY['Cabernet Sauvignon','Merlot'] WHERE id='test_wA'`)
  const [g2] = await raw(`SELECT grapes_folded FROM wine_products WHERE id='test_wA'`)
  ok(g2.grapes_folded.join(',') === 'cabernet sauvignon,merlot', 'element-wise fold, order preserved')

  console.log('\n3. Arrays are NOT NULL (a NULL array is permanently unenrichable)')
  await rejects('NULL grapes', `UPDATE wine_products SET grapes=NULL WHERE id='test_wA'`,
    '23502')
  await rejects('NULL curator_locked on wine_products',
    `UPDATE wine_products SET curator_locked=NULL WHERE id='test_wA'`,
    '23502')
  await rejects('NULL curator_locked on producers',
    `UPDATE producers SET curator_locked=NULL WHERE id='test_pA'`,
    '23502')

  console.log('\n4. scope has NO default — an omitted scope fails loudly')
  // ⚠️ Assert on the SQLSTATE, not on prose. A loose expectation ('scope')
  // passed even with the default restored, because the mutated INSERT still
  // failed — on the deferred lead trigger — and a substring check was satisfied.
  // Prisma also truncates not-null messages to "Failing row contains …" and
  // drops the column name, so the message text cannot discriminate either. The
  // CODE can: 23502 is not-null (correct schema), 23000 is the trigger's RAISE
  // (the mutant). Verified both ways.
  await rejects('a product with no scope',
    `INSERT INTO wine_products (id,name,status) VALUES ('test_noscope','X','confirmed')`,
    '23502')
  await rejects('an unknown scope value',
    `UPDATE wine_products SET scope='public' WHERE id='test_wA'`,
    'wine_products_scope_check')

  console.log('\n5. Exactly one lead — at most one')
  await prisma.$executeRawUnsafe(
    `INSERT INTO producers (id,name,status) VALUES ('test_pB','B','confirmed'),('test_pC','C','confirmed')`)
  await rejects('a second, different lead on one product',
    `INSERT INTO product_producers (product_id,producer_id,role) VALUES ('test_wA','test_pB','lead')`,
    'Key (product_id)=(test_wA) already exists')
  await accepts('a collaborator alongside the lead',
    `INSERT INTO product_producers (product_id,producer_id,role) VALUES ('test_wA','test_pB','collaborator')`)

  console.log('\n6. Exactly one lead — at least one, at creation')
  await rejects('a product created with no lead link',
    `INSERT INTO wine_products (id,name,scope,status) VALUES ('test_nolead','X','shared','confirmed')`,
    'has no lead producer')

  console.log('\n7. Exactly one lead — at least one, over time')
  await rejects('deleting the sole lead',
    `DELETE FROM product_producers WHERE product_id='test_wA' AND role='lead'`,
    'has no lead producer')
  await rejects('DEMOTING the sole lead (deletes nothing — the missed case)',
    `UPDATE product_producers SET role='collaborator' WHERE product_id='test_wA' AND role='lead'`,
    'has no lead producer')
  // 🔒 THE SHIPPED DEFECT: `AFTER UPDATE OF "role"` did not fire on an
  // UPDATE that changes product_id, so re-pointing a lead left the ORIGIN
  // lead-less — and the same statement satisfied the creation trigger for the
  // destination by stealing the row. The destination must be freshly created
  // and lead-less, or the partial unique catches it and this test passes
  // without exercising the trigger at all.
  await rejects('RE-POINTING a lead into a fresh lead-less product',
    `WITH mk AS (INSERT INTO wine_products (id,name,scope,status)
                VALUES ('test_steal','Steal','shared','confirmed') RETURNING id)
     UPDATE product_producers SET product_id='test_steal'
     WHERE product_id='test_wA' AND role='lead'`,
    'has no lead producer')
  const [lc] = await raw(
    `SELECT count(*)::int n FROM product_producers WHERE product_id='test_wA' AND role='lead'`)
  ok(lc.n === 1, 'the origin product kept its lead')

  console.log('\n8. The legitimate lead swap still commits (deferral is load-bearing)')
  try {
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(
        `UPDATE product_producers SET role='collaborator' WHERE product_id='test_wA' AND producer_id='test_pA'`)
      await tx.$executeRawUnsafe(
        `UPDATE product_producers SET role='lead' WHERE product_id='test_wA' AND producer_id='test_pB'`)
    })
    const [s] = await raw(
      `SELECT count(*)::int n FROM product_producers WHERE product_id='test_wA' AND role='lead'`)
    ok(s.n === 1, 'demote-then-promote swap committed with exactly one lead')
  } catch (e) { ok(false, `swap was rejected: ${e.message.split('\n')[0]}`) }
  // Replacement is not always an INSERT: promoting an existing collaborator
  // must be an UPDATE, or it hits the composite PK.
  await rejects('promoting an existing collaborator via INSERT (must be UPDATE)',
    `INSERT INTO product_producers (product_id,producer_id,role) VALUES ('test_wA','test_pA','lead')`,
    'Key (product_id, producer_id)=(test_wA, test_pA) already exists')

  console.log('\n9. The purge carve-out — the invariant must not block its own cleanup')
  await makeProduct('test_purge', 'test_pC')
  await accepts('purging a product (cascades its join rows)',
    `DELETE FROM wine_products WHERE id='test_purge'`)

  console.log('\n10. Vintage uniqueness — NULLS NOT DISTINCT')
  await prisma.$executeRawUnsafe(
    `INSERT INTO wine_vintages (id,product_id,year,status) VALUES ('test_v18','test_wA',2018,'confirmed')`)
  await rejects('a duplicate year on one product',
    `INSERT INTO wine_vintages (id,product_id,year,status) VALUES ('test_vdup','test_wA',2018,'confirmed')`,
    'Key (product_id, year)=(test_wA, 2018) already exists')
  await prisma.$executeRawUnsafe(
    `INSERT INTO wine_vintages (id,product_id,year,status) VALUES ('test_vnv','test_wA',NULL,'confirmed')`)
  await rejects('a SECOND NV (null-year) row — what a plain unique would allow',
    `INSERT INTO wine_vintages (id,product_id,year,status) VALUES ('test_vnv2','test_wA',NULL,'confirmed')`,
    'Key (product_id, year)=(test_wA, null) already exists')
  await rejects('an out-of-range year',
    `UPDATE wine_vintages SET year=20255 WHERE id='test_v18'`,
    'wine_vintages_year_range_check')

  console.log('\n11. Lifecycle CHECKs')
  await rejects('status=linked with no pointer',
    `INSERT INTO producers (id,name,status) VALUES ('test_bad','X','linked')`,
    'producers_linked_pointer_check')
  await rejects('a pointer without status=linked',
    `UPDATE producers SET links_to='test_pB' WHERE id='test_pA'`,
    'producers_linked_pointer_check')
  await accepts('a real merge tombstone (linked + pointer)',
    `UPDATE producers SET status='linked', links_to='test_pB' WHERE id='test_pA'`)
  await rejects('a row linking to itself',
    `UPDATE producers SET status='linked', links_to='test_pC' WHERE id='test_pC'`,
    'producers_no_self_link_check')
  await rejects('an unknown status value',
    `INSERT INTO producers (id,name,status) VALUES ('test_bad2','X','bogus')`,
    'producers_status_check')
  await rejects('a blank producer name (would share one fold key)',
    `INSERT INTO producers (id,name,status) VALUES ('test_blank','','confirmed')`,
    'producers_name_not_blank_check')
  await rejects('a whitespace-only name',
    `INSERT INTO producers (id,name,status) VALUES ('test_blank2','   ','confirmed')`,
    'producers_name_not_blank_check')

  console.log('\n12. wines link states')
  await prisma.$executeRawUnsafe(
    `INSERT INTO sessions (id,code,host_name) VALUES (900900,'TESTCATA','H')`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO wines (id,session_id,name) VALUES ('test_wine1',900900,'W')`)
  await rejects('vintage_id set with product_id NULL (MATCH SIMPLE skips this)',
    `UPDATE wines SET vintage_id='test_v18', product_id=NULL WHERE id='test_wine1'`,
    'wines_catalog_link_check')
  await accepts('product-grain link (known product, unknown year)',
    `UPDATE wines SET product_id='test_wA', vintage_id=NULL WHERE id='test_wine1'`)
  await accepts('full vintage-grain link',
    `UPDATE wines SET product_id='test_wA', vintage_id='test_v18' WHERE id='test_wine1'`)
  await makeProduct('test_wOther', 'test_pC')
  await rejects('a vintage belonging to a DIFFERENT product',
    `UPDATE wines SET product_id='test_wOther', vintage_id='test_v18' WHERE id='test_wine1'`,
    'wines_vintage_id_product_id_fkey')

  console.log('\n13. product_eans')
  await accepts('an EAN-13 with a leading zero',
    `INSERT INTO product_eans (ean,product_id) VALUES ('0012345678905','test_wA')`)
  const [e] = await raw(`SELECT ean FROM product_eans WHERE product_id='test_wA'`)
  ok(e.ean === '0012345678905', 'the leading zero survived storage')
  await rejects('the same EAN on a second product (a conflict, never auto-reassignment)',
    `INSERT INTO product_eans (ean,product_id) VALUES ('0012345678905','test_wOther')`,
    'Key (ean)=(0012345678905) already exists')
  await rejects('a non-digit EAN', `INSERT INTO product_eans (ean,product_id) VALUES ('12-345','test_wOther')`,
    'product_eans_format_check')
  // Exact GTIN lengths only — {8,14} also accepted 9/10/11, which are not
  // valid GTINs and would become permanent identity keys.
  await rejects('a 9-digit EAN (not a valid GTIN length)',
    `INSERT INTO product_eans (ean,product_id) VALUES ('123456789','test_wOther')`,
    'product_eans_format_check')
  await rejects('an 11-digit EAN',
    `INSERT INTO product_eans (ean,product_id) VALUES ('12345678901','test_wOther')`,
    'product_eans_format_check')
  await accepts('a 12-digit UPC-A',
    `INSERT INTO product_eans (ean,product_id) VALUES ('123456789012','test_wOther')`)
  await rejects('last_seen rewound before first_seen',
    `UPDATE product_eans SET last_seen=first_seen - interval '1 day' WHERE ean='0012345678905'`,
    'product_eans_seen_order_check')

  console.log('\n14. updated_at actually advances (the pull leg depends on it)')
  const [u1] = await raw(`SELECT updated_at FROM producers WHERE id='test_pB'`)
  await new Promise(r => setTimeout(r, 15))
  await prisma.$executeRawUnsafe(`UPDATE producers SET name='Touched' WHERE id='test_pB'`)
  const [u2] = await raw(`SELECT updated_at FROM producers WHERE id='test_pB'`)
  ok(new Date(u2.updated_at) > new Date(u1.updated_at),
    'producers.updated_at advanced on UPDATE (raw SQL, not via Prisma @updatedAt)')

  console.log('\n15. catalog_audit shape')
  await rejects('a merge with no target_id (unreconstructible)',
    `INSERT INTO catalog_audit (entity_type,entity_id,action,prior_status)
     VALUES ('product','test_wA','merge','confirmed')`,
    'catalog_audit_target_check')
  await rejects('a merge with no prior_status (unmerge could not restore)',
    `INSERT INTO catalog_audit (entity_type,entity_id,action,target_id)
     VALUES ('product','test_wA','merge','test_wOther')`,
    'catalog_audit_merge_prior_status_check')
  await rejects('a target_id on a non-merge action',
    `INSERT INTO catalog_audit (entity_type,entity_id,action,target_id)
     VALUES ('product','test_wA','confirm','test_wOther')`,
    'catalog_audit_target_check')
  await accepts('a well-formed merge audit row',
    `INSERT INTO catalog_audit (entity_type,entity_id,action,target_id,prior_status)
     VALUES ('product','test_wA','merge','test_wOther','confirmed')`)

  console.log('\n16. Audit tables are append-only and the DB owns the clock')
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id,name,email,updated_at,created_at)
     VALUES (900001,'T1','t1@test.local',now(),now()),(900002,'T2','t2@test.local',now(),now())`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO staff_role_audit (subject_id,role,action,actor_id,reason)
     VALUES (900001,'admin','grant',NULL,'test')`)
  await rejects('UPDATE on staff_role_audit',
    `UPDATE staff_role_audit SET reason='rewritten' WHERE subject_id=900001`,
    'append-only')
  await rejects('DELETE on staff_role_audit',
    `DELETE FROM staff_role_audit WHERE subject_id=900001`,
    'append-only')
  await rejects('UPDATE on catalog_audit',
    `UPDATE catalog_audit SET reason='rewritten' WHERE entity_id='test_wA'`,
    'append-only')
  await rejects('DELETE on catalog_audit', `DELETE FROM catalog_audit WHERE entity_id='test_wA'`,
    'append-only')
  // Blocking UPDATE/DELETE alone still allows a BACKDATED insert, so the
  // server overwrites created_at. A reviewer forged a 1999 row pre-fix.
  await prisma.$executeRawUnsafe(
    `INSERT INTO staff_role_audit (subject_id,role,action,created_at)
     VALUES (900002,'curator','grant','1999-01-01T00:00:00Z')`)
  const [b] = await raw(`SELECT created_at FROM staff_role_audit WHERE subject_id=900002`)
  ok(new Date(b.created_at).getFullYear() >= 2026,
    'a backdated created_at was overwritten with the server clock')

  console.log('\n17. The last admin cannot be removed — by ANY path')
  await prisma.$executeRawUnsafe(`INSERT INTO staff_roles (user_id,role) VALUES (900001,'admin')`)
  await rejects('deleting the sole admin grant directly',
    `DELETE FROM staff_roles WHERE user_id=900001`,
    'cannot remove the last admin grant')
  // 🔒 DEMOTION deletes nothing, so a DELETE-only trigger never fires. Verified
  // as a real defect before the fix: this left the database with ZERO admins.
  // Same class as the `UPDATE OF "role"` lead-trigger miss — the removal that
  // isn't a deletion.
  await rejects('DEMOTING the sole admin to curator (an UPDATE, not a DELETE)',
    `UPDATE staff_roles SET role='curator' WHERE user_id=900001`,
    'cannot remove the last admin grant')
  // 🔒 The path the app-layer guard could not see: staff_roles cascades from
  // users, so account deletion removed the grant without consulting it. The
  // sole admin deleting their own account left ZERO admins, silently.
  await rejects('DELETING THE SOLE ADMIN’S ACCOUNT (the cascade path)',
    `DELETE FROM users WHERE id=900001`,
    'cannot remove the last admin grant')
  const [soleLeft] = await raw(`SELECT count(*)::int n FROM staff_roles WHERE role='admin'`)
  ok(soleLeft.n === 1, 'the sole admin survived every removal attempt')

  console.log('\n17b. A deliberate revoke is NOT labelled an account deletion')
  // 🔒 The audit trigger hangs off `users`, not `staff_roles`. On staff_roles it
  // fired for EVERY role-row deletion, so a deliberate revoke produced TWO rows
  // — the real one plus a false `actor=NULL, reason='account deletion'` — and a
  // role deleted while its user still existed was labelled an account deletion.
  // That makes the audit log lie about the one thing it exists to record.
  await prisma.$executeRawUnsafe(`INSERT INTO staff_roles (user_id,role) VALUES (900002,'admin')`)
  await accepts('removing one admin once a second exists',
    `DELETE FROM staff_roles WHERE user_id=900002`)
  const [falseLabel] = await raw(
    `SELECT count(*)::int n FROM staff_role_audit
     WHERE subject_id=900002 AND reason='account deletion'`)
  ok(falseLabel.n === 0,
    'a role-row deletion with the user still alive wrote NO "account deletion" row')

  console.log('\n17c. An actual account deletion IS audited')
  await prisma.$executeRawUnsafe(`INSERT INTO staff_roles (user_id,role) VALUES (900002,'curator')`)
  await accepts('deleting a non-admin staff member’s account',
    `DELETE FROM users WHERE id=900002`)
  const [cascadeAudit] = await raw(
    `SELECT count(*)::int n FROM staff_role_audit
     WHERE subject_id=900002 AND action='revoke' AND actor_id IS NULL
       AND reason='account deletion' AND role='curator'`)
  ok(cascadeAudit.n === 1,
    'the cascade appended exactly one revoke row (actor NULL, reason "account deletion", correct role)')
  const [gone] = await raw(`SELECT count(*)::int n FROM staff_roles WHERE user_id=900002`)
  ok(gone.n === 0, 'the grant went with the account')

  console.log('\n17d. A BEFORE UPDATE guard must not silently discard the update')
  // 🔒 A `BEFORE UPDATE` trigger that RETURNS OLD discards the row's new values
  // while the statement still reports success — `UPDATE 1`, no error, nothing
  // changed. A fixed defect: the last-admin guard early-returned OLD when
  // OLD.role was not 'admin', which silently swallowed every curator → admin
  // PROMOTION: the caller reported success and the row stayed curator. Any future edit to that guard's early-return path
  // reintroduces this, so it is pinned here.
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id,name,email,updated_at,created_at)
     VALUES (900004,'Promo','promo@test.local',now(),now())`)
  await prisma.$executeRawUnsafe(`INSERT INTO staff_roles (user_id,role) VALUES (900004,'curator')`)
  await prisma.$executeRawUnsafe(`UPDATE staff_roles SET role='admin' WHERE user_id=900004`)
  const [promoted] = await raw(`SELECT role FROM staff_roles WHERE user_id=900004`)
  ok(promoted.role === 'admin',
    `curator → admin promotion actually applied (row is '${promoted.role}')`)
  // The reverse direction must still be REFUSED when it would zero the admins,
  // and must APPLY when it would not.
  await prisma.$executeRawUnsafe(`UPDATE staff_roles SET granted_by=NULL WHERE user_id=900004`)
  const [stillAdmin] = await raw(`SELECT role FROM staff_roles WHERE user_id=900004`)
  ok(stillAdmin.role === 'admin',
    'an unrelated UPDATE on an admin row left the role intact')

  console.log('\n18. The prisma/CLAUDE.md bootstrap recipes actually work')
  // 🔒 THE DOC IS THE SOURCE; THIS TEST RUNS IT. The recipes are extracted from
  // prisma/CLAUDE.md by their `-- @recipe:` markers and executed verbatim (only
  // `<id>` substituted), so the documentation and the test CANNOT drift — there
  // is only one copy of the SQL.
  //
  // Why this exists: bootstrap is a documented direct-DB operation with no code
  // path, so it had no gate — and THREE successive prose versions of the
  // promotion guard shipped subtly broken while every suite stayed green:
  //   1. no verification at all (audit rows written even when nothing matched);
  //   2. "is the user now an admin?" — passes for someone ALREADY an admin;
  //   3. counting matching audit rows in the table — passes on a RE-RUN, on the
  //      rows the first successful promotion left behind.
  // Each was verified against a fresh fixture, which is exactly why each looked
  // correct. The common error was verifying STATE rather than what the statement
  // DID; `GET DIAGNOSTICS ROW_COUNT` is what fixes that, and the cases below are
  // what keep it fixed.
  {
    const docPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma', 'CLAUDE.md')
    const doc = readFileSync(docPath, 'utf8')
    const extract = name => {
      const m = doc.match(new RegExp(`-- @recipe:${name}\\n([\\s\\S]*?)-- @endrecipe`))
      if (!m) throw new Error(`recipe '${name}' not found in prisma/CLAUDE.md — marker removed?`)
      return m[1]
    }
    const bootstrap = extract('bootstrap')
    const promote = extract('promote')
    ok(/GET DIAGNOSTICS/.test(promote),
      'the promotion recipe still uses GET DIAGNOSTICS (statement-scoped, not a state check)')

    // 🔒 EXECUTED THROUGH psql, not Prisma. These recipes are documented as psql
    // input: the bootstrap one is a `BEGIN; … COMMIT;` script and Prisma's
    // executeRaw rejects multi-statement strings ("cannot insert multiple
    // commands into a prepared statement"). Splitting them for Prisma would mean
    // testing a RESHAPED version of the recipe rather than the recipe — exactly
    // the drift this test exists to prevent. So they go to psql verbatim, which
    // is also how an operator will actually run them.
    const runRecipe = sql => {
      const r = spawnSync('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
        { input: sql, encoding: 'utf8' })
      if (r.error) throw r.error
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'psql failed').trim())
      return r.stdout
    }
    const runBootstrap = id => runRecipe(bootstrap.replaceAll('<id>', String(id)))
    const runPromote = id => runRecipe(promote.replaceAll('<id>', String(id)))

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id,name,email,updated_at,created_at) VALUES
       (900101,'Boot','boot@test.local',now(),now()),
       (900102,'Curator','cur@test.local',now(),now()),
       (900103,'NoRole','norole@test.local',now(),now()),
       (900104,'AlreadyAdmin','aa@test.local',now(),now())`)

    // ── The bootstrap recipe ────────────────────────────────────────────────
    await runBootstrap(900101)
    const [booted] = await raw(`SELECT role FROM staff_roles WHERE user_id=900101`)
    ok(booted?.role === 'admin', 'bootstrap recipe granted admin')
    const [bootAudit] = await raw(
      `SELECT count(*)::int n FROM staff_role_audit
       WHERE subject_id=900101 AND action='grant' AND actor_id IS NULL AND reason='bootstrap'`)
    ok(bootAudit.n === 1, 'bootstrap recipe wrote exactly one system-minted audit row')

    await prisma.$executeRawUnsafe(`INSERT INTO staff_roles (user_id,role) VALUES (900104,'admin')`)

    // ── The promotion recipe: the one legitimate case ───────────────────────
    await prisma.$executeRawUnsafe(`INSERT INTO staff_roles (user_id,role) VALUES (900102,'curator')`)
    await runPromote(900102)
    const [promoted] = await raw(`SELECT role FROM staff_roles WHERE user_id=900102`)
    ok(promoted?.role === 'admin', 'promotion recipe promoted a real curator')
    const [promoAudit] = await raw(
      `SELECT count(*)::int n FROM staff_role_audit WHERE subject_id=900102
         AND reason IN ('superseded by admin','bootstrap promotion')`)
    ok(promoAudit.n === 2, `promotion wrote BOTH halves exactly once (got ${promoAudit.n})`)

    // ── And the four cases that must be REFUSED ─────────────────────────────
    const refuses = async (label, id) => {
      const before = await raw(`SELECT count(*)::int n FROM staff_role_audit WHERE subject_id=${id}`)
      try {
        await runPromote(id)
        ok(false, `${label} (was ACCEPTED — should be refused)`)
      } catch (e) {
        const msg = String(e.message || e)
        ok(/no curator grant/.test(msg), `${label}${
          /no curator grant/.test(msg) ? '' : ` (wrong error: ${msg.slice(0, 80)})`}`)
      }
      const after = await raw(`SELECT count(*)::int n FROM staff_role_audit WHERE subject_id=${id}`)
      ok(before[0].n === after[0].n, `${label} — wrote NO audit rows`)
    }
    // 🔒 The re-run is the case that defeated version 3: user 900102 now has two
    // historical promotion audit rows, so any check that counts table rows
    // instead of the statement's own ROW_COUNT passes here.
    await refuses('RE-RUN on the now-admin user (the historical-rows hole)', 900102)
    await refuses('an already-admin user with no promotion history', 900104)
    await refuses('a user holding no role at all', 900103)
    await refuses('a nonexistent user id', 999999)
  }

  console.log('\n19. One live role row per user (no dual-role state)')
  await rejects('a second role row for a user who already holds one',
    `INSERT INTO staff_roles (user_id,role) VALUES (900001,'curator')`,
    'Key (user_id)=(900001) already exists')
  await rejects('an unknown staff role',
    `INSERT INTO staff_roles (user_id,role) VALUES (900003,'superuser')`,
    'staff_roles_role_check')

  await reset()
  console.log(`\n${pass} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
