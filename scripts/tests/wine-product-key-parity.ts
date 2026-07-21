// Parity + behaviour pins for the wine-product match key (lib/wineProductKey.ts
// ↔ the SQL twin f_wine_match_key / f_wine_norm in
// prisma/migrations/20260721120000_wine_products/migration.sql).
//
// PART A (always, no DB): pins the TS normalization on a fixture set — the
//   canonical algorithm (NFD → strip combining marks → lower → collapse
//   [^a-z0-9] → trim) and the key composition.
// PART B (only when DATABASE_URL is set + reachable): runs each fixture through
//   the SQL f_wine_match_key and asserts it equals the TS wineMatchKey —
//   the byte-for-byte parity that keeps runtime find-or-create aligned with the
//   backfilled keys. Skipped with a notice when no DB, so it stays runnable
//   offline in CI's typecheck lane.
//
// Run from repo root:  npx tsx scripts/tests/wine-product-key-parity.ts
//   (add DATABASE_URL=... to include the SQL-parity half)

import { normWineField, wineMatchKey } from '../../lib/wineProductKey'

const SEP = String.fromCharCode(1)
let fails = 0

function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { console.log(`  ok  ${msg}`); return }
  fails++
  console.log(`FAIL  ${msg}\n        expected ${e}\n        actual   ${a}`)
}

// [producer, name, vintage]
const FIXTURES: [string | null, string | null, string | null][] = [
  ['Château Margaux', 'Château Margaux', '2019'],
  ['Moët & Chandon', 'Dom Pérignon', null],
  [null, '  Zöllner  ', 'NV'],
  ['A.O.C.', 'Test-Wine!!!', '2020'],
  ['Bruggård', 'Møller', '2018'],   // å decomposes (→ a), ø does NOT (→ word break) — pins the known tradeoff
  ['', '   ', ''],                    // empty / whitespace-only → empty components
]

console.log('PART A — TS normalization pins')
// normWineField outputs are only [a-z0-9 ] — no separator, safe to assert raw.
eq(normWineField('Château Margaux'), 'chateau margaux', 'accents fold via NFD (â → a)')
eq(normWineField('Moët & Chandon'), 'moet chandon', 'punctuation/ampersand collapse to single space, trimmed')
eq(normWineField('  Zöllner  '), 'zollner', 'ö folds, surrounding whitespace trimmed')
eq(normWineField('A.O.C. Test-Wine!!!'), 'a o c test wine', 'dots/hyphen/bangs collapse, trailing trimmed')
eq(normWineField('Bruggård'), 'bruggard', 'å (decomposable ring) folds to a')
eq(normWineField('Møller'), 'm ller', 'ø (non-decomposable) is not a letter in [a-z0-9] → word break (documented tradeoff)')
eq(normWineField(null), '', 'null → empty')
eq(normWineField('   '), '', 'whitespace-only → empty')
eq(normWineField('2019'), '2019', 'digits preserved')

// Key composition: three normalized components joined by U+0001, in
// producer / name / vintage order.
{
  const key = wineMatchKey('Château Margaux', 'Château Margaux', '2019')
  eq(key.split(SEP), ['chateau margaux', 'chateau margaux', '2019'], 'wineMatchKey = [norm(producer), norm(name), norm(vintage)] joined by U+0001')
  eq(key.split(SEP).length, 3, 'exactly two separators')
}

async function partB() {
  console.log('\nPART B — SQL parity (f_wine_match_key)')
  if (!process.env.DATABASE_URL) {
    console.log('  SKIP  DATABASE_URL not set — run with a migrated DB to check TS↔SQL parity')
    return
  }
  const { prisma } = await import('../../lib/prisma')
  for (const [producer, name, vintage] of FIXTURES) {
    const tsKey = wineMatchKey(producer, name, vintage)
    const rows = await prisma.$queryRaw<{ k: string }[]>`
      SELECT f_wine_match_key(${producer}::text, ${name}::text, ${vintage}::text) AS k
    `
    const dbKey = rows[0]?.k ?? '<null>'
    eq(dbKey, tsKey, `SQL == TS for (${JSON.stringify(producer)}, ${JSON.stringify(name)}, ${JSON.stringify(vintage)})`)
  }
  await prisma.$disconnect()
}

partB().then(() => {
  console.log('')
  if (fails > 0) {
    console.log(`${fails} assertion(s) failed`)
    process.exit(1)
  }
  console.log('all wine-product-key parity pins passed')
})
