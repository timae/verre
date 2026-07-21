// End-to-end behavioural verification of the wine-product layer against a live
// migrated DB. Exercises the REAL linkWineToProduct + getProductAggregate, plus
// the migration's backfill SQL. Run:
//   DATABASE_URL=... npx tsx scripts/tests/wine-product-e2e.ts
import { prisma } from '../../lib/prisma'
import { linkWineToProduct } from '../../lib/wineProductLink'
import { getProductAggregate } from '../../lib/productAggregate'

let fails = 0
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log(`  ok  ${msg}`); return }
  fails++; console.log(`FAIL  ${msg}\n        expected ${e}\n        actual   ${a}`)
}

const TAG = 'E2E_WPT_'   // marker so we only touch our own rows
let W = 0
const wid = () => `${TAG}w${++W}`

async function cleanup() {
  await prisma.rating.deleteMany({ where: { wine: { name: { startsWith: TAG } } } })
  await prisma.wine.deleteMany({ where: { name: { startsWith: TAG } } })
  await prisma.wineProduct.deleteMany({ where: { name: { startsWith: TAG } } })
  // Sessions are soft-delete-only (prevent_session_hard_delete trigger) — scrub
  // via UPDATE, not DELETE, so re-runs stay idempotent without tripping it.
  await prisma.$executeRawUnsafe(`UPDATE sessions SET deleted_at = NOW(), name = NULL WHERE name LIKE '${TAG}%'`)
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } })
}

async function main() {
  await cleanup()

  // ── A. Linking: dedup across accent variants, vintage identity, accretion ──
  console.log('A — linkWineToProduct')
  const pA1 = await linkWineToProduct(prisma, { name: `${TAG}Grand Vin`, producer: 'Château X', vintage: '2019', region: null })
  const pA2 = await linkWineToProduct(prisma, { name: `${TAG}Grand Vin`, producer: 'Chateau X', vintage: '2019', region: 'Bordeaux', grape: 'Merlot' })
  eq(pA2, pA1, 'accent variant "Chateau X" == "Château X" → same product')
  const pA3 = await linkWineToProduct(prisma, { name: `${TAG}Grand Vin`, producer: 'Château X', vintage: '2020' })
  eq(pA3 !== pA1, true, 'different vintage (2020) → different product')
  // Accretion: region filled from pA2, and a later null/other value doesn't overwrite.
  await linkWineToProduct(prisma, { name: `${TAG}Grand Vin`, producer: 'Château X', vintage: '2019', region: 'Loire' })
  const prodA1 = await prisma.wineProduct.findUnique({ where: { id: pA1! }, select: { region: true, grape: true } })
  eq(prodA1?.region, 'Bordeaux', 'accretion: first non-null region (Bordeaux) wins, later "Loire" does NOT overwrite')
  eq(prodA1?.grape, 'Merlot', 'accretion: grape filled from the second link')

  // ── B. Aggregation + blind exclusion + anon handling ──
  console.log('\nB — getProductAggregate')
  const u1 = await prisma.user.create({ data: { name: 'U1', email: `${TAG}u1@x.co` } })
  const u2 = await prisma.user.create({ data: { name: 'U2', email: `${TAG}u2@x.co` } })
  const u3 = await prisma.user.create({ data: { name: 'U3', email: `${TAG}u3@x.co` } })
  const sOpen = await prisma.session.create({ data: { name: `${TAG}open`, blind: false } })
  const sBlind = await prisma.session.create({ data: { name: `${TAG}blind`, blind: true } })

  // Product P — the bottle under test. Link a wine to mint it.
  const P = (await linkWineToProduct(prisma, { name: `${TAG}Pinot`, producer: 'Dom Y', vintage: '2021', style: 'red' }))!
  const mkWine = async (sessionId: number | null, revealedAt: Date | null) => {
    const id = wid()
    await prisma.wine.create({ data: { id, name: `${TAG}Pinot`, producer: 'Dom Y', vintage: '2021', style: 'red', category: 'wine', sessionId, productId: P, revealedAt } })
    return id
  }
  const mkRating = (wineId: string, sessionId: number | null, userId: number | null, score: number | null) =>
    prisma.rating.create({ data: { wineId, sessionId, userId, origin: sessionId ? 'session' : 'standalone', raterName: 'r', score, ratedAt: new Date(), flavors: { body: 4, acid: 2 } } })

  const w1 = await mkWine(sOpen.id, null);   await mkRating(w1, sOpen.id, u1.id, 4.0)   // open, scored, user1
  const w2 = await mkWine(null, null);        await mkRating(w2, null, u2.id, 5.0)       // standalone, user2
  const w4 = await mkWine(sOpen.id, null);    await mkRating(w4, sOpen.id, null, 3.0)     // anon (user null)
  const w3 = await mkWine(sBlind.id, null);   await mkRating(w3, sBlind.id, u3.id, 2.0)   // BLIND unrevealed → excluded

  const agg1 = await getProductAggregate(P)
  eq(agg1.ratingCount, 3, 'blind-unrevealed rating excluded → 3 scored (w1,w2,w4)')
  eq(agg1.avgScore, 4.0, 'avg over included scored rows = (4+5+3)/3 = 4.0')
  eq(agg1.tastingCount, 3, 'tastingCount = 3 (blind excluded)')
  eq(agg1.tasterCount, 2, 'distinct logged-in tasters = u1,u2 (anon w4 not counted)')
  eq(agg1.flavors.body, 4, 'community flavour: body weighted-mean = 4')

  // Reveal the blind wine → now its rating counts.
  await prisma.wine.update({ where: { id: w3 }, data: { revealedAt: new Date() } })
  const agg2 = await getProductAggregate(P)
  eq(agg2.ratingCount, 4, 'after reveal → blind rating now included (4 scored)')
  eq(agg2.avgScore, 3.5, 'avg after reveal = (4+5+3+2)/4 = 3.5')
  eq(agg2.tasterCount, 3, 'distinct tasters now u1,u2,u3')

  // ── C. Backfill SQL groups pre-existing unlinked wines ──
  console.log('\nC — migration backfill SQL')
  const b1 = wid(), b2 = wid(), b3 = wid()
  // Insert wines with product_id NULL, bypassing the runtime linker.
  await prisma.$executeRawUnsafe(
    `INSERT INTO wines (id, name, producer, vintage, style, category, region, created_at)
     VALUES ($1,$4,'Café Z','2015','white','wine',NULL, now()),
            ($2,$4,'Cafe Z','2015','white','wine','Alsace', now()),
            ($3,$5,'Café Z','2016','white','wine',NULL, now())`,
    b1, b2, b3, `${TAG}Blanc`, `${TAG}Blanc`)
  // The migration's backfill UPDATE (identical key expression) links them.
  await prisma.$executeRawUnsafe(`
    WITH keyed AS (SELECT w.id, f_wine_match_key(w.producer, w.name, w.vintage) AS mk FROM wines w WHERE f_wine_norm(w.name) <> '')
    INSERT INTO wine_products (id, match_key, name, producer, vintage, category, style, created_at, updated_at)
    SELECT left(replace(gen_random_uuid()::text,'-',''),21), k.mk, w.name, w.producer, w.vintage, w.category, w.style, now(), now()
    FROM (SELECT DISTINCT ON (mk) mk, id FROM keyed ORDER BY mk) k JOIN wines w ON w.id = k.id
    ON CONFLICT (match_key) DO NOTHING`)
  await prisma.$executeRawUnsafe(`
    UPDATE wines w SET product_id = p.id FROM wine_products p
    WHERE p.match_key = f_wine_match_key(w.producer, w.name, w.vintage) AND f_wine_norm(w.name) <> '' AND w.product_id IS NULL`)
  const rows = await prisma.wine.findMany({ where: { id: { in: [b1, b2, b3] } }, select: { id: true, productId: true }, orderBy: { id: 'asc' } })
  const byId = Object.fromEntries(rows.map(r => [r.id, r.productId]))
  eq(byId[b1] === byId[b2] && byId[b1] != null, true, 'backfill: "Café Z"/"Cafe Z" 2015 accent variants → same product')
  eq(byId[b3] !== byId[b1], true, 'backfill: different vintage (2016) → different product')

  await cleanup()
  await prisma.$disconnect()
  console.log('')
  if (fails) { console.log(`${fails} assertion(s) failed`); process.exit(1) }
  console.log('all wine-product e2e checks passed')
}

main().catch(e => { console.error(e); process.exit(1) })
