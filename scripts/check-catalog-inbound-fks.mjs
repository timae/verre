#!/usr/bin/env node
// ── The FK pin: every foreign key INTO the catalogue is NO ACTION ───────────
//
// docs/dev/proposals/wine-catalog-model-change.md § 5a (agreed with the
// catalog-maintenance side, 2026-11-18). A hard purge clears or redirects every
// reference to a catalogue row in its own transaction and never deletes a user's
// occurrence, rating or bookmark; the NO ACTION keys are its backstop (a purge
// that forgets a reference class fails and rolls back). The catalogue's replace
// mode relies on the same keys: a link committed during a load makes its delete
// FAIL, where a CASCADE or SET NULL key would silently delete or clear it.
//
// So: every FK whose TARGET is one of the five catalogue tables must be
// ON DELETE NO ACTION, with ONE exception, `product_producers.product_id`
// (CASCADE by ruling, prisma/CLAUDE.md), which must stay exactly that; and every
// one ON UPDATE NO ACTION (catalogue ids are permanent; a CASCADE there would
// rewrite user rows if one ever changed).
//
// 🔒 The keys are FOUND FROM pg_constraint by their target, never listed by
// hand: a table that links into the catalogue tomorrow is covered the day it
// lands. A catalogue table that is missing fails the pin (it would otherwise
// pass by finding nothing to check). The five tables are named here; a SIXTH
// catalogue table is the contract gate's job (check-catalog-contract-checks.mjs
// refuses an unwatched table that references the five). Tables are matched by
// schema + name, never by regclass text (which depends on search_path).
//
//   DATABASE_URL=postgres://…/<migrated db> node scripts/check-catalog-inbound-fks.mjs
//
// Wired into check-schema.yml. Negative control: catalog-schema-integration.mjs
// § 22 commits a temporary CASCADE key into the catalogue and requires this
// script to fail on it, then to pass again once it is gone.
import { createPrismaClient } from './lib/prismaClient.mjs'

const CATALOGUE = ['producers', 'wine_products', 'wine_vintages', 'product_producers', 'product_eans']
const EXCEPTION = { table: 'product_producers', columns: 'product_id', target: 'wine_products', action: 'c' }
const ACTION = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }

const prisma = createPrismaClient()
try {
  const present = await prisma.$queryRawUnsafe(`
    SELECT c.relname AS "table" FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY ($1::text[])`, CATALOGUE)
  const missing = CATALOGUE.filter(t => !present.some(p => p.table === t))
  const fks = await prisma.$queryRawUnsafe(`
    SELECT CASE WHEN sn.nspname = 'public' THEN s.relname ELSE sn.nspname || '.' || s.relname END AS "table",
           c.conname                   AS "name",
           t.relname                   AS "target",
           c.confdeltype::text         AS "action",
           c.confupdtype::text         AS "onUpdate",
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS "columns"
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.confrelid JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_class s ON s.oid = c.conrelid JOIN pg_namespace sn ON sn.oid = s.relnamespace
     WHERE c.contype = 'f' AND tn.nspname = 'public' AND t.relname = ANY ($1::text[])
     ORDER BY 1, 2`, CATALOGUE)
  const isException = f => f.table === EXCEPTION.table && f.columns === EXCEPTION.columns && f.target === EXCEPTION.target
  const bad = fks.filter(f => (isException(f) ? f.action !== EXCEPTION.action : f.action !== 'a') || f.onUpdate !== 'a')
  const exceptionSeen = fks.some(isException)
  if (missing.length || bad.length || !exceptionSeen) {
    console.error('FAIL: the foreign keys into the catalogue are not as ruled (wine-catalog-model-change.md § 5a).')
    for (const t of missing) console.error(`  MISSING catalogue table  ${t}`)
    for (const f of bad) {
      const want = isException(f) ? ACTION[EXCEPTION.action] : 'NO ACTION'
      console.error(`  ${f.table}.${f.name} (${f.columns}) → ${f.target}: ON DELETE ${ACTION[f.action] ?? f.action}, ON UPDATE ${ACTION[f.onUpdate] ?? f.onUpdate}; must be ON DELETE ${want}, ON UPDATE NO ACTION`)
    }
    if (!exceptionSeen) console.error('  MISSING product_producers.product_id → wine_products (the one CASCADE, ruled)')
    console.error('\n  A key into the catalogue decides what a catalogue delete does to the row holding it.')
    console.error('  NO ACTION makes a purge or a replace FAIL on a reference it forgot; CASCADE deletes')
    console.error('  user history, SET NULL clears it silently. Change one only by a ruling, announced to')
    console.error('  the catalog-maintenance side, and update this pin in the same change.')
    process.exitCode = 1
  } else {
    console.log(`ok  ${fks.length} foreign keys into the five catalogue tables: NO ACTION, except product_producers.product_id (ON DELETE CASCADE)`)
  }
} finally {
  await prisma.$disconnect()
}
