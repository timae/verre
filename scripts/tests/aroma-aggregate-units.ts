// Pure-unit pins for the aroma compare roll-up (aroma-layer.md §8). Four groups:
//   (1) the RAW AGGREGATE (aggregateAromaRollup, @verre/core) — the settled core
//       primitive: upward-only subsumption, per-taster set-union dedupe,
//       modifier-stripped grain, both denominators exposed, byFamily ordering.
//   (2) the CONSENSUS SELECTOR (aromaConsensus, @verre/core — moved into core in
//       Slice 3a with the ruled defaults baked) — the role-based display tree,
//       verified over the TEN pinned panels + the primary floor + the two knobs +
//       the no-opts default. The selector's math is asserted here, never eyeballed.
//   (3) the CONTRIBUTOR HELPER (buildAromaContributors, the gallery-owned compare
//       module) — "who is behind THIS aroma": the identity invariant (unique
//       contributors === aggregate count), exact supporter/modifier sets,
//       Pronounced preservation, subsumption, per-taster dedupe, unknown skip.
//   (4) the COMPARE-VIEW derivations (aromaCompareView, gallery-owned) — the pure
//       behaviour the Tier 2 JSX renders over: strip flatten + rank (incl. global
//       taxonomy tie-break), popover Led-by peak PATHS + caps, contributor
//       preview cap, selection reducer, Tier 3 routing.
// Run from repo root:  npx tsx .local/test-env/scripts/aroma-aggregate-units.ts
// No DB/Redis/network — pure functions only.
//
// Taxonomy facts used: strawberry/raspberry/blackberry/blueberry/blackcurrant/
// lingonberry → fruity.berry ; lemon/lime/grapefruit/orange → fruity.citrus ;
// Citrus PRECEDES Berry in the Fruity subfamily order. skunky/petrol → chemical
// (skunky → chemical.sulphur, petrol → chemical.petrol). cucumber → vegetal.
// vanilla → sweet.vanilla ; honey → sweet.honey.

import {
  aggregateAromaRollup,
  aromaAncestorChain,
  aromaConsensus,
  getAromaNode,
  isValidAromaSelection,
  DEFAULT_CONSENSUS_OPTS,
  type AromaRollup,
  type AromaSelection,
  type AromaConsensusOpts,
  type AromaConsensusResult,
  type ConsensusDisplayNode,
  type ConsensusRole,
} from '@verre/core'
import {
  buildAromaContributors,
  type AromaContributorInput,
} from '../../apps/mobile/src/components/moments/aromaContributors'
import {
  tier2Strip,
  popoverContent,
  packStrip,
  unionStrip,
  unionPopoverContent,
  buildCompareAromaModel,
  consensusBunNotes,
  sortAromaMentions,
  groupAromaMentions,
  filterAromaMentions,
  filterAromaParticipants,
  matchingParticipantPickKeys,
  exactAromaPopoverContent,
  aromaTasteSummary,
  tasteSharedEvidence,
  hasModifierDistinction,
  detailPillColors,
  flattenRgbaOver,
  pronouncedForNode,
  pronouncedNodeIds,
  hasResolvableAroma,
  compareAromaInputSignature,
  stripChipMeasureKey,
  compareSelectionReducer,
  viewContributorsRoute,
  tier3Tabs,
  selectionContributors,
  supportingPickKeys,
  supportedNodeIds,
  aromaAncestorIds,
  pickKey,
  buildAgreementOverview,
  familyFingerprint,
  topAromaPyramid,
  pyramidLayout,
  wrapPyramidLabel,
  overviewCountLabel,
  overviewHeadFloor,
  OVERVIEW_DOT_MAX,
  LED_BY_CAP,
  PREVIEW_CAP,
  STRIP_LINES,
  type AromaRef,
  type CompareSelection,
} from '../../apps/mobile/src/components/moments/aromaCompareView'
// Theme tokens + contrast math for the pill-colour pins (38d) — both node-pure.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain-JS token module (no d.ts)
import { themes } from '../../apps/mobile/src/theme/vero-tokens.js'
import { contrastRatio } from '../../apps/mobile/src/lib/contrast'

let fails = 0
function ok(msg: string) { console.log(`  ✅ ${msg}`) }
function bad(msg: string) { console.log(`  ❌ ${msg}`); fails++ }
function step(msg: string) { console.log(`\n=== ${msg} ===`) }
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) ok(`${label} → ${a}`)
  else bad(`${label}: got ${a}, expected ${e}`)
}
function assert(cond: boolean, label: string) {
  if (cond) ok(label)
  else bad(label)
}

const aS = (a: string, m: string | null = null): AromaSelection => ({ a, m })
const rep = (n: number, f: () => AromaSelection[]) => Array.from({ length: n }, f)
const node = (r: AromaRollup, id: string) => r.nodes.get(id)

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 — the raw aggregate (11 enduring core contracts)
// ═══════════════════════════════════════════════════════════════════════════

step('1 · ⭐ canonical mixed-grain contract (Codex #2 — the ruling this settles)')
// A picks fruity, B picks fruity.berry, C picks strawberry.
{
  const r = aggregateAromaRollup([[aS('fruity')], [aS('fruity.berry')], [aS('strawberry')]])
  eq(node(r, 'fruity')!.count, 3, 'fruity count 3 (all three subsume up)')
  eq(node(r, 'fruity')!.atGrain, 1, 'fruity atGrain 1 (only A said it at grain)')
  eq(node(r, 'fruity.berry')!.count, 2, 'fruity.berry count 2 (B + C)')
  eq(node(r, 'fruity.berry')!.atGrain, 1, 'fruity.berry atGrain 1 (only B)')
  eq(node(r, 'strawberry')!.count, 1, 'strawberry count 1 (only C — B does NOT vote for it)')
  eq(node(r, 'strawberry')!.atGrain, 1, 'strawberry atGrain 1')
}

step('2 · per-taster subfamily dedupe (strawberry + raspberry → Berry once)')
{
  const r = aggregateAromaRollup([[aS('strawberry'), aS('raspberry')]])
  eq(node(r, 'fruity.berry')!.count, 1, 'fruity.berry count 1 (one taster, not 2)')
  eq(node(r, 'fruity')!.count, 1, 'fruity count 1')
  eq(node(r, 'fruity.berry')!.atGrain, 0, 'fruity.berry atGrain 0 (picked leaves, not the subfamily)')
}

step('3 · upward-only (a fruity pick never fabricates descendants)')
{
  const r = aggregateAromaRollup([[aS('fruity')]])
  eq(node(r, 'fruity')!.count, 1, 'fruity count 1')
  eq(node(r, 'fruity')!.atGrain, 1, 'fruity atGrain 1')
  assert(!r.nodes.has('fruity.berry') && !r.nodes.has('strawberry'), 'no descendant nodes exist')
}

step('4 · full ancestor reach + per-tier atGrain (a strawberry pick)')
{
  const r = aggregateAromaRollup([[aS('strawberry')]])
  eq([node(r, 'fruity')!.count, node(r, 'fruity.berry')!.count, node(r, 'strawberry')!.count], [1, 1, 1], 'chain all count 1')
  eq(node(r, 'strawberry')!.atGrain, 1, 'strawberry atGrain 1')
  eq([node(r, 'fruity')!.atGrain, node(r, 'fruity.berry')!.atGrain], [0, 0], 'ancestors atGrain 0')
}

step('5 · unknown-id skip (no throw)')
{
  const r = aggregateAromaRollup([[aS('not-real'), aS('strawberry')]])
  eq(r.n, 1, 'n 1 (the taster is still engaged via strawberry)')
  assert(!r.nodes.has('not-real'), 'unknown id absent from nodes')
}

step('6 · empty input')
{
  const r = aggregateAromaRollup([])
  eq([r.n, r.nodes.size, r.byFamily.length], [0, 0, 0], 'n 0, nodes 0, byFamily 0')
}

step('7 · unanimous leaf (4× strawberry)')
{
  const r = aggregateAromaRollup(rep(4, () => [aS('strawberry')]))
  eq(node(r, 'strawberry')!.count, 4, 'strawberry count 4')
  eq(node(r, 'strawberry')!.atGrain, 4, 'strawberry atGrain 4')
  eq(node(r, 'fruity')!.count, 4, 'fruity count 4 (subsumed)')
}

step('8 · monotonicity (parent.count >= node.count via parentId)')
{
  const r = aggregateAromaRollup([[aS('strawberry'), aS('lemon')], [aS('raspberry')], [aS('fruity')], [aS('skunky')]])
  let mono = true
  for (const [, nd] of r.nodes) {
    if (nd.parentId === null) continue
    const parent = r.nodes.get(nd.parentId)
    if (!parent || parent.count < nd.count) mono = false
  }
  assert(mono, 'every node with a parent has parent.count >= node.count')
}

step('9 · modifier stripping / fresh+cooked collapse (Codex #2)')
{
  const one = aggregateAromaRollup([[aS('strawberry', null), aS('strawberry', 'cooked')]])
  eq(node(one, 'strawberry')!.count, 1, 'one taster, both modifiers → strawberry count 1')
  eq(node(one, 'strawberry')!.atGrain, 1, 'strawberry atGrain 1')
  const two = aggregateAromaRollup([[aS('strawberry', null)], [aS('strawberry', 'cooked')]])
  eq(node(two, 'strawberry')!.count, 2, 'two tasters (fresh + cooked) → strawberry count 2')
  eq(node(two, 'strawberry')!.atGrain, 2, 'strawberry atGrain 2')
}

step('10 · parentId correctness')
{
  const r = aggregateAromaRollup([[aS('strawberry')]])
  eq(node(r, 'strawberry')!.parentId, 'fruity.berry', 'strawberry.parentId = fruity.berry')
  eq(node(r, 'fruity.berry')!.parentId, 'fruity', 'fruity.berry.parentId = fruity')
  eq(node(r, 'fruity')!.parentId, null, 'fruity.parentId = null')
  eq(aromaAncestorChain(getAromaNode('strawberry')!), ['fruity', 'fruity.berry', 'strawberry'], 'shared core ancestor chain = family → subfamily → leaf')
}

step('11 · byFamily ordering (active families, AROMA_FAMILIES order, taxonomy traversal)')
{
  // vanilla (sweet) + strawberry (fruity) + skunky (chemical). Families order:
  // fruity < sweet < chemical. Within fruity: family node, then fruity.berry, then strawberry.
  const r = aggregateAromaRollup([[aS('strawberry'), aS('vanilla'), aS('skunky')]])
  eq(r.byFamily.map((f) => f.familyId), ['fruity', 'sweet', 'chemical'], 'active families in declaration order')
  eq(r.byFamily[0].nodes.map((n) => n.id), ['fruity', 'fruity.berry', 'strawberry'], 'fruity members in traversal order')
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2 — the consensus selector, over the TEN pinned panels + floor + knobs
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT: AromaConsensusOpts = { primary: 'majority', peakNum: 1, peakDen: 3 }
const consensus = (tasters: AromaSelection[][], opts = DEFAULT) => aromaConsensus(aggregateAromaRollup(tasters), opts)

// A compact serialiser of the recursive tree — role, id, counted, children — so
// an assertion pins the STRUCTURE, not just a flat id-set (the tree IS the
// contract). Shape: { r: role, id, c: counted, k: [children] }.
type Shape = { r: ConsensusRole; id: string; c: boolean; k: Shape[] }
function shape(nodes: ConsensusDisplayNode[]): Shape[] {
  return nodes.map((d) => ({ r: d.role, id: d.node.id, c: d.counted, k: shape(d.children) }))
}
function tree(res: AromaConsensusResult, expected: Shape[], strong: boolean, label: string) {
  eq(shape(res.roots), expected, `${label} — tree`)
  eq(res.hasStrongAgreement, strong, `${label} — hasStrongAgreement ${strong}`)
}
const P = (id: string, k: Shape[] = []): Shape => ({ r: 'primary', id, c: true, k })
const S = (id: string, k: Shape[] = []): Shape => ({ r: 'secondary', id, c: true, k })
const C = (id: string, k: Shape[] = []): Shape => ({ r: 'context', id, c: true, k })
const H = (id: string, k: Shape[] = []): Shape => ({ r: 'heading', id, c: false, k })
const K = (id: string, k: Shape[] = []): Shape => ({ r: 'peak', id, c: true, k })

step('12 · P1 heading-pruned (§rule H, 1 displayed child)')
// 4 straw / 2 rasp / 2 lingon (n8): Fruity≡Berry8 → collapse; Berry keeps 1
// displayed child (Strawberry 4/8 ≥⅓) so Fruity heading is REMOVED, Berry primary.
{
  const res = consensus([...rep(4, () => [aS('strawberry')]), ...rep(2, () => [aS('raspberry')]), ...rep(2, () => [aS('lingonberry')])])
  tree(res, [P('fruity.berry', [K('strawberry')])], true, 'P1')
  assert(!res.roots.some((r) => r.node.id === 'fruity'), 'P1 — no fruity node (removed)')
}

step('13 · P2 context › primary › peak (single chain)')
// 4 straw / 2 berry / 2 fruity (n8): Fruity 8 context → Berry 6 primary → Strawberry 4 peak.
tree(
  consensus([...rep(4, () => [aS('strawberry')]), ...rep(2, () => [aS('fruity.berry')]), ...rep(2, () => [aS('fruity')])]),
  [C('fruity', [P('fruity.berry', [K('strawberry')])])],
  true,
  'P2',
)

step('14 · P3 no-strong-agreement, Chemical survives (strict drop keeps ancestor)')
// 3 raspberry / (2 vegetal + 1 cucumber → vegetal 3) / (2 skunky + 1 petrol → chemical 3, skunky 2).
{
  const res = consensus([aS('raspberry'), aS('raspberry'), aS('raspberry'), aS('vegetal'), aS('vegetal'), aS('cucumber'), aS('skunky'), aS('skunky'), aS('petrol')].map((sel) => [sel]))
  tree(res, [S('raspberry'), S('vegetal'), S('chemical', [K('skunky')])], false, 'P3')
}

step('15 · P4 heading kept (§rule H, 2 displayed children)')
// 3× (distinct berry + distinct citrus leaves) (n3): Fruity≡Berry≡Citrus → heading; two primaries.
tree(
  consensus([[aS('strawberry'), aS('lemon')], [aS('raspberry'), aS('lime')], [aS('blackberry'), aS('grapefruit')]]),
  [H('fruity', [P('fruity.citrus'), P('fruity.berry')])],
  true,
  'P4',
)

step('16 · P5 compounding killed (staged peak gating)')
// 4 fruity / 2 berry / 2 straw (n8): Fruity 8 primary → Berry 4 peak (4/8) → Strawberry 2 peak (2/4).
tree(
  consensus([...rep(4, () => [aS('fruity')]), ...rep(2, () => [aS('fruity.berry')]), ...rep(2, () => [aS('strawberry')])]),
  [P('fruity', [K('fruity.berry', [K('strawberry')])])],
  true,
  'P5',
)

step('17 · P6 heading kept, collapse-to-leaf')
// 6×(straw+lemon)+cucumber+petrol (n8): Fruity6≡Lemon6≡Straw6 → heading; two leaf primaries.
tree(
  consensus([...rep(6, () => [aS('strawberry'), aS('lemon')]), [aS('cucumber')], [aS('petrol')]]),
  [H('fruity', [P('lemon'), P('strawberry')])],
  true,
  'P6',
)

step('18 · ⭐ P7 primary + strong secondary, different families')
// 5 raspberry / 4 vegetal (n9): Raspberry 5 primary, Vegetal 4 secondary (spread stays visible).
tree(
  consensus([...rep(5, () => [aS('raspberry')]), ...rep(4, () => [aS('vegetal')])]),
  [P('raspberry'), S('vegetal')],
  true,
  'P7',
)

step('19 · ⭐ P8 shared context, sibling mixed roles (Codex #3)')
// 5 berry(distinct) / 4 citrus(distinct) (n9): Fruity 9 context (9≠5, 9≠4) → Berry 5 primary + Citrus 4 secondary.
tree(
  consensus([[aS('strawberry')], [aS('raspberry')], [aS('blackberry')], [aS('blueberry')], [aS('blackcurrant')], [aS('lemon')], [aS('lime')], [aS('grapefruit')], [aS('orange')]]),
  [C('fruity', [P('fruity.berry'), S('fruity.citrus')])],
  true,
  'P8',
)

step('20 · ⭐ P9 equal-primary + weaker sibling (Codex #4, §rule H)')
// 5 berry(distinct); 2 also citrus(distinct) (n5): Fruity 5≡Berry 5 → HEADING; Berry primary + Citrus 2 secondary.
{
  const res = consensus([[aS('strawberry'), aS('lemon')], [aS('raspberry'), aS('lime')], [aS('blackberry')], [aS('blueberry')], [aS('blackcurrant')]])
  tree(res, [H('fruity', [P('fruity.berry'), S('fruity.citrus')])], true, 'P9')
  eq(res.roots[0].counted, false, 'P9 — fruity counted:false (heading)')
}

step('21 · primary >=2 floor (Codex #1) — a solo taster is never a consensus')
{
  tree(consensus([[aS('strawberry')]]), [], false, 'solo')
  tree(consensus([[aS('strawberry')]], { primary: 'twoThirds', peakNum: 1, peakDen: 3 }), [], false, 'solo (twoThirds)')
}

step('22 · ⭐ knob sensitivity that ACTUALLY changes output (Codex #4)')
// P5 under peak 2/3: Berry 4/8=50% < ⅔ FAILS → Fruity 8 primary ALONE.
tree(
  consensus([...rep(4, () => [aS('fruity')]), ...rep(2, () => [aS('fruity.berry')]), ...rep(2, () => [aS('strawberry')])], { primary: 'majority', peakNum: 2, peakDen: 3 }),
  [P('fruity')],
  true,
  'P5 peak 2/3 → Fruity alone',
)
// P7 under twoThirds primary (need count*3 >= 18, i.e. >=6): Raspberry 5 → 15 < 18 → both secondary.
tree(
  consensus([...rep(5, () => [aS('raspberry')]), ...rep(4, () => [aS('vegetal')])], { primary: 'twoThirds', peakNum: 1, peakDen: 3 }),
  [S('raspberry'), S('vegetal')],
  false,
  'P7 twoThirds → both secondary',
)

step('23 · ⭐ primary ⅔ INCLUSIVE boundary (Codex #5)')
// 2 strawberry / 1 lemon (n3). twoThirds: 2*3=6 >= 3*2=6 TRUE → primary. majority: 2*2=4 > 3 TRUE → primary.
// (Fruity 3 sits above as counted context: 3 != strawberry 2, a strict drop.)
tree(
  consensus([[aS('strawberry')], [aS('strawberry')], [aS('lemon')]], { primary: 'twoThirds', peakNum: 1, peakDen: 3 }),
  [C('fruity', [P('strawberry')])],
  true,
  '⅔ boundary twoThirds (2-of-3 qualifies)',
)
tree(
  consensus([[aS('strawberry')], [aS('strawberry')], [aS('lemon')]], DEFAULT),
  [C('fruity', [P('strawberry')])],
  true,
  '⅔ boundary majority (also primary)',
)

step('24 · ⭐ empty-input selector contract (Codex #2) — no throw, no division')
{
  const empty = aggregateAromaRollup([])
  eq(aromaConsensus(empty, DEFAULT), { roots: [], hasStrongAgreement: false, n: 0 }, 'empty under majority')
  eq(aromaConsensus(empty, { primary: 'twoThirds', peakNum: 2, peakDen: 3 }), { roots: [], hasStrongAgreement: false, n: 0 }, 'empty under twoThirds')
}

step('24b · 🔒 RULED core defaults (Slice 3a) — aromaConsensus(rollup) with NO opts === majority / ⅓')
{
  // The ruled shipped defaults are baked into core: DEFAULT_CONSENSUS_OPTS +
  // the optional `opts` param. Pin the exact values AND that calling with no
  // opts returns the COMPLETE result (n, hasStrongAgreement, and the full roots
  // payload — counts/labels/atGrain, not just tree shape) identical to explicit
  // majority/⅓ across several panels.
  eq(DEFAULT_CONSENSUS_OPTS, { primary: 'majority', peakNum: 1, peakDen: 3 }, 'DEFAULT_CONSENSUS_OPTS = majority / ⅓ (Simon 2026-07-14)')
  const panels = [
    [...rep(4, () => [aS('strawberry')]), ...rep(2, () => [aS('raspberry')]), ...rep(2, () => [aS('lingonberry')])], // P1
    [...rep(4, () => [aS('fruity')]), ...rep(2, () => [aS('fruity.berry')]), ...rep(2, () => [aS('strawberry')])],   // P5 (peak-sensitive)
    [[aS('strawberry')], [aS('raspberry')], [aS('blackberry')], [aS('blueberry')], [aS('blackcurrant')], [aS('lemon')], [aS('lime')], [aS('grapefruit')], [aS('orange')]], // P8
  ]
  panels.forEach((p, i) => {
    const rollup = aggregateAromaRollup(p)
    eq(aromaConsensus(rollup), aromaConsensus(rollup, { primary: 'majority', peakNum: 1, peakDen: 3 }), `panel ${i}: no-opts === explicit majority/⅓ (COMPLETE result)`)
  })
}

step('25 · ⭐ P10 unbounded cardinality (Codex — no cap)')
// 2 spray 8 distinct-family leaves + 6 scattered singletons (honey lifts Sweet→3, Vanilla stays 2).
{
  const spray8 = () => [aS('strawberry'), aS('cucumber'), aS('black_pepper'), aS('vanilla'), aS('almond'), aS('toast'), aS('oak'), aS('flint')]
  const res = consensus([spray8(), spray8(), [aS('honey')], [aS('rose')], [aS('butter')], [aS('yeast')], [aS('acetone')], [aS('lavender')]])
  eq(res.hasStrongAgreement, false, 'P10 — no strong agreement')
  const secondaryRoots = res.roots.filter((r) => r.role === 'secondary')
  assert(secondaryRoots.length >= 8, `P10 — >=8 secondary roots (got ${res.roots.length} roots) — UNCAPPED`)
  const sweet = res.roots.find((r) => r.node.id === 'sweet')
  assert(sweet != null && sweet.role === 'secondary' && sweet.node.count === 3, 'P10 — Sweet secondary count 3')
  assert(sweet?.children.length === 1 && sweet.children[0].node.id === 'vanilla' && sweet.children[0].role === 'peak' && sweet.children[0].node.count === 2, 'P10 — Sweet ↳ Vanilla(peak) 2')
  // The sprayed families collapse to a single leaf each; ranking orders, never truncates.
  const ids = new Set(res.roots.map((r) => r.node.id))
  assert(['strawberry', 'cucumber', 'black_pepper', 'almond', 'toast', 'oak', 'flint'].every((id) => ids.has(id)), 'P10 — every sprayed family present as its collapsed leaf')
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 3 — the compare contributor helper (buildAromaContributors)
// The compare surface's "who is behind THIS aroma" map. NOT core; a shared
// compare-feature helper. The load-bearing invariant: every AGREEMENT node's
// UNIQUE contributor count === its aggregate count (the helper and the aggregate
// must agree). Plus subsumption in contributors, All-aromas base/modifier
// grouping, per-taster dedupe, and unknown-id skip.
// ═══════════════════════════════════════════════════════════════════════════

const R = (id: string, picks: Array<{ a: string; m?: string | null }>): AromaContributorInput => ({
  id,
  displayName: id.toUpperCase(),
  aromas: picks.map((x) => ({ a: x.a, m: x.m ?? null })),
})
const uniqueIds = (contribs: ReadonlyArray<{ id: string }> | undefined) => new Set((contribs ?? []).map((c) => c.id)).size

step('26 · 🔒 INVARIANT — every agreement node unique-contributor count === aggregate count')
{
  // Run over several structurally-distinct panels (the same shapes the selector
  // pins use) so the invariant is not a single-panel coincidence.
  const panels: AromaContributorInput[][] = [
    // mixed grain
    [R('a', [{ a: 'fruity' }]), R('b', [{ a: 'fruity.berry' }]), R('c', [{ a: 'strawberry' }]), R('d', [{ a: 'raspberry', m: 'cooked' }])],
    // P8-shaped: 5 distinct berry / 4 distinct citrus
    [R('a', [{ a: 'strawberry' }]), R('b', [{ a: 'raspberry' }]), R('c', [{ a: 'blackberry' }]), R('d', [{ a: 'blueberry' }]), R('e', [{ a: 'blackcurrant' }]), R('f', [{ a: 'lemon' }]), R('g', [{ a: 'lime' }]), R('h', [{ a: 'grapefruit' }]), R('i', [{ a: 'orange' }])],
    // sibling dedupe: one taster, two berry leaves + a citrus
    [R('a', [{ a: 'strawberry' }, { a: 'raspberry' }, { a: 'lemon' }]), R('b', [{ a: 'blackberry' }])],
    // cross-family + modifiers
    [R('a', [{ a: 'skunky' }, { a: 'petrol' }]), R('b', [{ a: 'skunky' }]), R('c', [{ a: 'vanilla', m: 'cooked' }])],
  ]
  let allOk = true
  for (const raters of panels) {
    const idx = buildAromaContributors(raters)
    const agg = aggregateAromaRollup(raters.map((r) => (r.aromas ?? []).map((x) => ({ a: x.a, m: x.m }))))
    // Every aggregate node must have exactly that many unique contributors.
    for (const [id, nd] of agg.nodes) {
      if (uniqueIds(idx.agreement.get(id)) !== nd.count) { allOk = false; bad(`node ${id}: contributors ${uniqueIds(idx.agreement.get(id))} != aggregate ${nd.count}`) }
    }
    // And the helper must not invent agreement nodes the aggregate doesn't have.
    for (const id of idx.agreement.keys()) {
      if (!agg.nodes.has(id)) { allOk = false; bad(`agreement node ${id} absent from aggregate`) }
    }
  }
  assert(allOk, 'agreement contributor counts === aggregate counts across all panels (both directions)')
}

step('27 · agreement subsumption — EXACT supporter sets, not just counts (Codex #4)')
{
  const idx = buildAromaContributors([R('a', [{ a: 'fruity' }]), R('b', [{ a: 'fruity.berry' }]), R('c', [{ a: 'strawberry' }]), R('d', [{ a: 'raspberry', m: 'cooked' }])])
  const supporters = (id: string) => [...(idx.agreement.get(id) ?? [])].map((c) => c.id).sort()
  // Pin the exact WHO at every node — swapped/wrong people would pass a count check.
  eq(supporters('fruity'), ['a', 'b', 'c', 'd'], 'Fruity supporters = A B C D')
  eq(supporters('fruity.berry'), ['b', 'c', 'd'], 'Berry supporters = B(berry) + C(strawberry) + D(raspberry) — finer picks roll up')
  eq(supporters('strawberry'), ['c'], 'strawberry supporters = ONLY C (B does not vote down — upward-only)')
  eq(supporters('raspberry'), ['d'], 'raspberry supporters = ONLY D')
  const d = idx.agreement.get('fruity.berry')!.find((c) => c.id === 'd')!
  eq(d.picks.map((p) => `${p.a}${p.m ? '+' + p.m : ''}`), ['raspberry+cooked'], "D's supporting pick keeps its modifier")
}

step('28 · Pronounced flag preserved on contributor picks (Codex #1)')
{
  // A picks strawberry PRONOUNCED; B picks strawberry plain. The flag must
  // survive into both the agreement and byBase pick lists.
  const idx = buildAromaContributors([
    { id: 'a', displayName: 'A', aromas: [{ a: 'strawberry', m: null, p: true }] },
    { id: 'b', displayName: 'B', aromas: [{ a: 'strawberry', m: null }] },
  ])
  const aAgree = idx.agreement.get('strawberry')!.find((c) => c.id === 'a')!
  eq(aAgree.picks[0].p, true, "A's agreement pick carries p:true")
  const bAgree = idx.agreement.get('strawberry')!.find((c) => c.id === 'b')!
  eq(bAgree.picks[0].p, undefined, "B's agreement pick has no p (only-when-true)")
  const straw = idx.byBase.find((g) => g.baseId === 'strawberry')!
  eq(straw.contributors.find((c) => c.id === 'a')!.picks[0].p, true, "A's byBase pick carries p:true")
}

step('29 · All-aromas base+modifier grouping + per-modifier contributors (Codex #2, #4)')
{
  // E picks strawberry fresh AND cooked; F picks strawberry fresh. Base = 2
  // distinct tasters; fresh 2, cooked 1 → mods sum 3 > base 2.
  const idx = buildAromaContributors([R('e', [{ a: 'strawberry' }, { a: 'strawberry', m: 'cooked' }]), R('f', [{ a: 'strawberry' }])])
  const straw = idx.byBase.find((g) => g.baseId === 'strawberry')!
  eq(straw.count, 2, 'strawberry base count = 2 distinct tasters (NOT 3 picks)')
  eq(straw.byModifier.map((m) => `${m.m ?? 'fresh'}:${m.count}`), ['fresh:2', 'cooked:1'], 'modifier tallies: fresh 2 · cooked 1 (sum 3 > base 2)')
  eq(uniqueIds(straw.contributors), 2, 'two contributors (E once despite two picks)')
  // EXACT (base, modifier) supporter sets — the per-modifier contributors are
  // directly exposed, no re-filtering by the consumer (Codex #2).
  const fresh = straw.byModifier.find((m) => m.m === null)!
  const cooked = straw.byModifier.find((m) => m.m === 'cooked')!
  eq(fresh.contributors.map((c) => c.id).sort(), ['e', 'f'], 'fresh strawberry contributors = E, F (exact)')
  eq(cooked.contributors.map((c) => c.id).sort(), ['e'], 'cooked strawberry contributors = ONLY E (exact)')
  // base grain is EXACT — a coarse "fruity.berry" pick is its own base, never folded into strawberry.
  const idx2 = buildAromaContributors([R('a', [{ a: 'fruity.berry' }]), R('b', [{ a: 'strawberry' }])])
  eq(idx2.byBase.map((g) => g.baseId).sort(), ['fruity.berry', 'strawberry'], 'All-aromas keeps each exact grain as its own base (no subsumption)')
}

step('30 · per-taster dedupe in agreement (one contributor once per node)')
{
  // One taster picks strawberry + raspberry (both Berry). Berry has ONE
  // contributor with BOTH supporting picks.
  const idx = buildAromaContributors([R('a', [{ a: 'strawberry' }, { a: 'raspberry' }])])
  const berry = idx.agreement.get('fruity.berry')!
  eq(uniqueIds(berry), 1, 'Berry: one contributor (not 2)')
  eq(berry[0].picks.map((p) => p.a).sort(), ['raspberry', 'strawberry'], 'that contributor carries BOTH supporting picks')
}

step('31 · unknown / re-homed id skipped, never thrown')
{
  const idx = buildAromaContributors([R('g', [{ a: 'not-real' }, { a: 'lemon' }])])
  assert(!idx.byBase.some((g) => g.baseId === 'not-real'), 'unknown base absent from byBase')
  assert(idx.agreement.has('lemon') && idx.agreement.has('fruity.citrus') && idx.agreement.has('fruity'), 'the valid lemon pick still indexes its chain')
  eq(uniqueIds(idx.agreement.get('lemon')), 1, 'lemon has its one contributor')
}

step('32 · empty / aroma-less raters → empty index (no throw)')
{
  const idx = buildAromaContributors([{ id: 'a', displayName: 'A', aromas: null }, { id: 'b', displayName: 'B', aromas: [] }])
  eq([idx.agreement.size, idx.byBase.length], [0, 0], 'no aromas anywhere → empty maps')
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 4 — the compare presentation derivations (aromaCompareView, Slice 2)
// PURE behaviour the JSX renders over — the device owns only pixels/anchoring/
// feel. Tier 2 strip flatten+rank; popover Led-by branch cap + contributor
// preview cap; selection replacement + Tier 3 routing.
// ═══════════════════════════════════════════════════════════════════════════

const consensusRes = (tasters: AromaSelection[][], opts = DEFAULT) => aromaConsensus(aggregateAromaRollup(tasters), opts)
const named = (tasters: Array<{ id: string; picks: string[] }>): AromaContributorInput[] =>
  tasters.map((t) => ({ id: t.id, displayName: t.id.toUpperCase(), aromas: t.picks.map((a) => ({ a, m: null })) }))

step('33 · Tier 2 strip — primaries+secondaries only, flattened, ranked (Codex)')
{
  // P8: Fruity 9 [C] › Berry 5 [P] · Citrus 4 [S]. Strip EXCLUDES the context
  // Fruity; primary before secondary.
  const p8 = consensusRes([[aS('strawberry')], [aS('raspberry')], [aS('blackberry')], [aS('blueberry')], [aS('blackcurrant')], [aS('lemon')], [aS('lime')], [aS('grapefruit')], [aS('orange')]])
  eq(tier2Strip(p8).map((c) => `${c.role}:${c.id}:${c.count}`), ['primary:fruity.berry:5', 'secondary:fruity.citrus:4'], 'P8 strip = Berry(P) then Citrus(S); Fruity context EXCLUDED')
  // P5: Fruity 8 [P] ↳ Berry ↳ Strawberry (peaks). Strip = the single primary; NO peaks.
  const p5 = consensusRes([...rep(4, () => [aS('fruity')]), ...rep(2, () => [aS('fruity.berry')]), ...rep(2, () => [aS('strawberry')])])
  eq(tier2Strip(p5).map((c) => c.id), ['fruity'], 'P5 strip = [Fruity primary] only (peaks excluded)')
  // P4: Fruity H › Citrus 3 [P] · Berry 3 [P]. Two primaries, tie on count(3) →
  // deeper-tier/taxonomy order preserved (Citrus precedes Berry).
  const p4 = consensusRes([[aS('strawberry'), aS('lemon')], [aS('raspberry'), aS('lime')], [aS('blackberry'), aS('grapefruit')]])
  eq(tier2Strip(p4).map((c) => c.id), ['fruity.citrus', 'fruity.berry'], 'P4 strip = two primaries in taxonomy order (Citrus, Berry)')
  // P3: no primaries → three secondaries carry the spread.
  const p3 = consensusRes([aS('raspberry'), aS('raspberry'), aS('raspberry'), aS('vegetal'), aS('vegetal'), aS('cucumber'), aS('skunky'), aS('skunky'), aS('petrol')].map((s) => [s]))
  eq(tier2Strip(p3).map((c) => `${c.role}:${c.id}`), ['secondary:raspberry', 'secondary:vegetal', 'secondary:chemical'], 'P3 strip = three secondaries (no primary → spread)')
  // GLOBAL taxonomy tie-break (Codex #3): equal-count secondaries in DIFFERENT
  // families must sort by the absolute taxonomy index (fruity < kernel < woody),
  // never by tree/collection order. Picked here in REVERSE taxonomy order.
  const tie = consensusRes([...rep(2, () => [aS('oak')]), ...rep(2, () => [aS('almond')]), ...rep(2, () => [aS('strawberry')])])
  eq(tier2Strip(tie).map((c) => c.id), ['strawberry', 'almond', 'oak'], 'equal-count cross-family secondaries → taxonomy order (fruity, kernel, woody), NOT input order')
}

step('34 · popover Led-by — starts at children, never repeats the node, full chain (Codex #5)')
{
  const p5 = consensusRes([...rep(4, () => [aS('fruity')]), ...rep(2, () => [aS('fruity.berry')]), ...rep(2, () => [aS('strawberry')])])
  const empty = buildAromaContributors([])
  // Selected Fruity → Led by Berry 4 → Strawberry 2 (Fruity NOT repeated).
  const fruity = popoverContent(p5, empty, 'fruity')!
  eq(fruity.ledBy.map((br) => br.map((s) => `${s.id}:${s.count}`)), [['fruity.berry:4', 'strawberry:2']], 'selected Fruity → Led by Berry 4 → Strawberry 2')
  // Selected Berry → Led by Strawberry 2 (starts at Berry's CHILD).
  const berry = popoverContent(p5, empty, 'fruity.berry')!
  eq(berry.ledBy.map((br) => br.map((s) => s.id)), [['strawberry']], 'selected Berry → Led by Strawberry (child), Berry not repeated')
  // A node with no qualifying peak child → ledBy empty (line omitted).
  const p8 = consensusRes([[aS('strawberry')], [aS('raspberry')], [aS('blackberry')], [aS('blueberry')], [aS('blackcurrant')], [aS('lemon')], [aS('lime')], [aS('grapefruit')], [aS('orange')]])
  eq(popoverContent(p8, empty, 'fruity.berry')!.ledBy, [], 'P8 Berry has no peak child → Led-by empty')
  eq(popoverContent(p8, empty, 'fruity.citrus')!.ledBy, [], 'P8 Citrus has no peak child → Led-by empty')
  // FORK — a peak node with TWO peak children yields TWO paths, neither dropped
  // (Codex #2). Fruity 8 [P] → Berry 4 → {Strawberry 2, Raspberry 2}.
  const fork = consensusRes([...rep(4, () => [aS('fruity')]), [aS('fruity'), aS('strawberry')], [aS('fruity'), aS('strawberry')], [aS('fruity'), aS('raspberry')], [aS('fruity'), aS('raspberry')]])
  const forkLed = popoverContent(fork, empty, 'fruity')!
  eq(forkLed.ledBy.map((br) => br.map((s) => `${s.id}:${s.count}`)), [['fruity.berry:4', 'strawberry:2'], ['fruity.berry:4', 'raspberry:2']], 'fork → BOTH root-to-leaf peak paths (Berry→Strawberry AND Berry→Raspberry)')
  eq(forkLed.moreBranches, 0, 'both paths fit the 2-cap → no overflow')
}

step('35 · popover caps — Led-by 2 branches + moreBranches; contributor preview 3 + moreContributors')
{
  eq([LED_BY_CAP, PREVIEW_CAP], [2, 3], 'caps pinned at 2 branches / 3 names')
  // Contributor preview cap: 5 supporters of unanimous Strawberry → 3 shown + 2 more.
  const res = consensusRes(rep(5, () => [aS('strawberry')]))
  const contrib = buildAromaContributors(named([{ id: 'a', picks: ['strawberry'] }, { id: 'b', picks: ['strawberry'] }, { id: 'c', picks: ['strawberry'] }, { id: 'd', picks: ['strawberry'] }, { id: 'e', picks: ['strawberry'] }]))
  const pc = popoverContent(res, contrib, tier2Strip(res)[0].id)!
  eq(pc.contributors.map((c) => c.displayName), ['A', 'B', 'C'], 'preview = first 3 names')
  assert(pc.contributors.every((c) => typeof c.id === 'string' && c.id.length > 0), 'preview contributors carry stable ids')
  eq(pc.moreContributors, 2, 'moreContributors = 2 (5 − 3)')
  // Led-by branch cap: Fruity 6 (primary) with THREE peak subfamilies (Berry /
  // Citrus / Stone each 2 — 2/6 ≥ ⅓ peak, but 2 ≤ 6/2 so NOT primary). 3
  // qualifying branches → 2 shown + 1 folded into moreBranches.
  const threePeaks = consensusRes([
    [aS('fruity'), aS('strawberry')], [aS('fruity'), aS('raspberry')],
    [aS('fruity'), aS('lemon')], [aS('fruity'), aS('lime')],
    [aS('fruity'), aS('peach')], [aS('fruity'), aS('apricot')],
  ])
  const fruityNode = popoverContent(threePeaks, buildAromaContributors([]), 'fruity')!
  eq(fruityNode.ledBy.length, LED_BY_CAP, `Led-by capped to ${LED_BY_CAP} branches (3 qualify)`)
  eq(fruityNode.moreBranches, 1, 'moreBranches = 1 (the 3rd peak branch, → Tier 3)')
  // Non-existent node id → null (never throws).
  eq(popoverContent(res, contrib, 'not-a-node'), null, 'unknown node id → null')
}

step('36 · selection reducer — single-select, replace, retap-clears, mutual exclusion, AromaRef discriminant')
{
  const node = (a: string): AromaRef => ({ kind: 'node', a })
  let s: CompareSelection = { kind: 'none' }
  s = compareSelectionReducer(s, { type: 'tapAroma', ref: node('berry') })
  eq(s, { kind: 'aroma', ref: { kind: 'node', a: 'berry' } }, 'tap aroma → aroma selected (subsumed-node ref)')
  s = compareSelectionReducer(s, { type: 'tapParticipant', id: 'ana' })
  eq(s, { kind: 'participant', id: 'ana' }, 'tap participant REPLACES aroma (mutually exclusive)')
  s = compareSelectionReducer(s, { type: 'tapParticipant', id: 'ana' })
  eq(s, { kind: 'none' }, 'retap same participant → clears')
  s = compareSelectionReducer(s, { type: 'tapAroma', ref: node('berry') })
  s = compareSelectionReducer(s, { type: 'tapAroma', ref: node('citrus') })
  eq(s, { kind: 'aroma', ref: { kind: 'node', a: 'citrus' } }, 'new aroma replaces prior aroma')
  s = compareSelectionReducer(s, { type: 'clear' })
  eq(s, { kind: 'none' }, 'clear → none')
  // The KIND is part of identity (Codex rounds 1+2): the same aroma id tapped
  // at another granularity is a DIFFERENT selection — it replaces rather than
  // clears; only the full same-ref retap clears.
  const pair: AromaRef = { kind: 'pair', a: 'strawberry', m: 'cooked' }
  s = compareSelectionReducer({ kind: 'aroma', ref: node('strawberry') }, { type: 'tapAroma', ref: pair })
  eq(s, { kind: 'aroma', ref: pair }, 'pair over the same id REPLACES the node selection (not a clear)')
  s = compareSelectionReducer(s, { type: 'tapAroma', ref: { kind: 'pair', a: 'strawberry', m: 'cooked' } })
  eq(s, { kind: 'none' }, 'retap the same pair → clears')
  s = compareSelectionReducer({ kind: 'aroma', ref: node('fruity') }, { type: 'tapAroma', ref: { kind: 'base', a: 'fruity' } })
  eq(s, { kind: 'aroma', ref: { kind: 'base', a: 'fruity' } }, 'base over the same id REPLACES the node selection (node ≠ base)')
}

step('37 · Tier 3 routing — View contributors targets Participants mode filtered to the aroma')
{
  eq(
    viewContributorsRoute({ kind: 'node', a: 'fruity.berry' }),
    { mode: 'participants', aromaFilter: { kind: 'node', a: 'fruity.berry' } },
    'agreement popover → node ref (subsumed) passes through',
  )
  eq(
    viewContributorsRoute({ kind: 'base', a: 'fruity' }),
    { mode: 'participants', aromaFilter: { kind: 'base', a: 'fruity' } },
    'union popover → base ref (literal picks) passes through — the route never invents a kind',
  )
}

step('37b · participants index + tier3Tabs — the People tab data + tab availability (slice 3d)')
{
  // Respondents only, roster (input) order, exact picks preserved (m + p + pick
  // order). An empty rater and an all-unknown rater are NOT respondents.
  const raters: AromaContributorInput[] = [
    { id: 'u:1', displayName: 'Ana', aromas: [{ a: 'strawberry', m: 'cooked', p: true }, { a: 'oak', m: null }] },
    { id: 'u:2', displayName: 'Ben', aromas: [] },
    { id: 'u:3', displayName: 'Cle', aromas: [{ a: 'not-a-node', m: null }] },
    { id: 'u:4', displayName: 'Dan', aromas: [{ a: 'fruity.berry', m: null }] },
  ]
  const idx = buildAromaContributors(raters)
  eq(idx.participants.map((c) => c.id), ['u:1', 'u:4'], 'respondents only, roster order (empty + all-unknown raters excluded)')
  eq(idx.participants[0].picks, [{ a: 'strawberry', m: 'cooked', p: true }, { a: 'oak', m: null }], 'exact picks preserved — modifier + pronounced + pick order')
  // participants.length === the consensus n (the respondents denominator) — the
  // People tab lists exactly the tasters the counts are out of.
  const res = aromaConsensus(aggregateAromaRollup(raters.map((r) => (r.aromas ?? []).map((x) => ({ a: x.a, m: x.m })))))
  eq(idx.participants.length, res.n, 'participants.length === consensus n')
  // The FILTERED People read (the viewContributorsRoute target) resolves via
  // selectionContributors at the ref's OWN granularity. A subsumed-node ref
  // reads the agreement map — filtering to Berry lists the strawberry picker
  // too, with only their SUPPORTING picks.
  const route = viewContributorsRoute({ kind: 'node', a: 'fruity.berry' })
  const filtered = selectionContributors(idx, route.aromaFilter!)
  eq(filtered.map((c) => c.id), ['u:1', 'u:4'], 'node ref: filter Berry → strawberry picker + coarse Berry picker (subsumed)')
  eq(filtered[0].picks, [{ a: 'strawberry', m: 'cooked', p: true }], 'filtered picks = the SUPPORTING picks only (oak dropped)')
  // A PAIR ref resolves the (base, modifier) group's own set — the same base
  // with a different modifier is a different supporter set (the discriminant).
  const exactIdx = buildAromaContributors([
    { id: 'u:1', displayName: 'Ana', aromas: [{ a: 'strawberry', m: 'cooked' }] },
    { id: 'u:2', displayName: 'Ben', aromas: [{ a: 'strawberry', m: 'cooked' }] },
    { id: 'u:3', displayName: 'Cle', aromas: [{ a: 'strawberry', m: null }] },
  ])
  eq(selectionContributors(exactIdx, { kind: 'pair', a: 'strawberry', m: 'cooked' }).map((c) => c.id), ['u:1', 'u:2'], 'pair ref: (strawberry, cooked) → its two pickers only')
  eq(selectionContributors(exactIdx, { kind: 'pair', a: 'strawberry', m: null }).map((c) => c.id), ['u:3'], 'pair ref: (strawberry, default) → the default picker only')
  eq(selectionContributors(exactIdx, { kind: 'base', a: 'strawberry' }).map((c) => c.id), ['u:1', 'u:2', 'u:3'], 'base ref: strawberry across all modifiers → all three')
  eq(selectionContributors(exactIdx, { kind: 'node', a: 'strawberry' }).map((c) => c.id), ['u:1', 'u:2', 'u:3'], 'node ref on a leaf: same set here — the base/node split shows on mixed grain below')
  eq(selectionContributors(exactIdx, { kind: 'pair', a: 'not-a-node', m: null }).length, 0, 'unknown pair ref → [] (never throws)')
  eq(selectionContributors(exactIdx, { kind: 'base', a: 'not-a-node' }).length, 0, 'unknown base ref → []')
  eq(selectionContributors(exactIdx, { kind: 'node', a: 'not-a-node' }).length, 0, 'unknown node ref → []')
  // ⭐ Codex round-2 REGRESSION — node vs base on MIXED GRAIN: one respondent
  // picked coarse Fruity AND cooked Strawberry. The union Fruity badge (base)
  // must carry only the LITERAL fruity pick; the agreement Fruity node (node)
  // subsumes the strawberry pick too. Routing the union popover as a node ref
  // was the round-2 bug (People showed Fruity + Strawberry).
  const mixedIdx = buildAromaContributors([
    { id: 'u:9', displayName: 'Mia', aromas: [{ a: 'fruity', m: null }, { a: 'strawberry', m: 'cooked' }] },
  ])
  eq(selectionContributors(mixedIdx, { kind: 'base', a: 'fruity' })[0].picks, [{ a: 'fruity', m: null }], 'base Fruity → ONLY the literal coarse pick (no upward roll)')
  eq(selectionContributors(mixedIdx, { kind: 'node', a: 'fruity' })[0].picks, [{ a: 'fruity', m: null }, { a: 'strawberry', m: 'cooked' }], 'node Fruity → both picks (subsumed)')
  // aromaAncestorIds — the Agreement tab's contextual dim for base/pair
  // selections (their supporter set is narrower than any consensus count, so
  // they must never accent a node directly — Codex round 2).
  eq([...aromaAncestorIds('strawberry')].sort(), ['fruity', 'fruity.berry', 'strawberry'], 'strawberry supports its whole upward chain')
  eq([...aromaAncestorIds('fruity')], ['fruity'], 'a family pick supports only itself')
  eq(aromaAncestorIds('not-a-node').size, 0, 'unknown id → empty set')
  // supportingPickKeys — the exact picks FEEDING a node (All-tab muting): the
  // subsumed Berry selection keeps strawberry·cooked lit, never citrus picks.
  const keys = supportingPickKeys(idx, 'fruity.berry')
  assert(keys.has(pickKey('strawberry', 'cooked')) && keys.has(pickKey('fruity.berry', null)), 'Berry support keys = strawberry·cooked + the coarse Berry pick')
  eq(keys.size, 2, 'no unrelated picks leak into the support set (oak excluded)')
  // supportedNodeIds — a participant's branches (tree highlighting): Ana's
  // strawberry supports strawberry + Berry + Fruity, never oak's chain.
  const anaNodes = supportedNodeIds(idx, 'u:1')
  assert(anaNodes.has('strawberry') && anaNodes.has('fruity.berry') && anaNodes.has('fruity'), "Ana's strawberry supports the whole upward chain")
  assert(anaNodes.has('woody'), "Ana's oak pick supports Woody too (all HER picks count)")
  eq(supportedNodeIds(idx, 'u:4').has('strawberry'), false, "Dan's coarse Berry never fabricates the strawberry descendant")
  // Tab availability (Simon 2026-07-15): Agreement only when the panel agrees;
  // the FIRST entry is the sheet's default tab.
  eq(tier3Tabs(true), ['agreement', 'participants', 'all'], 'agreement mode → Overview / People / All Aromas, Overview default')
  eq(tier3Tabs(false), ['agreement', 'participants', 'all'], 'fallback keeps the Overview tab (rail parity, Simon 2026-07-19) — fingerprint + mentioned tail')
  // Representative of production data: the pair must be gate-valid.
  assert(isValidAromaSelection('oak', 'smoked'), 'oak+smoked is a gate-valid pair')
}

step('38 · packStrip — two-line pack at line boundaries + measured-pill overflow (Codex #1)')
{
  eq(STRIP_LINES, 2, 'STRIP_LINES = 2')
  const gap = 8
  // rowW 100: chips of width 40 → 2 per line, 2 lines = 4 fit exactly, no pill.
  eq(packStrip([40, 40, 40, 40], 100, gap, 30), { fit: 4, overflow: 0 }, '4×40 fit exactly in 2 lines of 100 → no overflow')
  // A 5th 40-chip can't fit in 2 lines → overflow; the pill (30) is reserved on
  // the last line, so fewer chips fit than a naive 2-line count.
  const p5 = packStrip([40, 40, 40, 40, 40], 100, gap, 30)
  assert(p5.overflow >= 1 && p5.fit + p5.overflow === 5, `5×40 → overflow (fit ${p5.fit} + overflow ${p5.overflow} = 5)`)
  // Pill WIDTH matters — STRICTLY. Use FIVE 40px chips (which overflow 2 lines of
  // 100, so the pill is actually reserved) and a rowW where a wide pill bumps a
  // chip off. rowW 128: 3 chips per line (40+8+40+8+40=136 > 128 → 2/line), so 4
  // fit in 2 lines. A NARROW pill (10) fits after the 4th on line 2 (cursor
  // 40+8+40=88, +8+10=106 ≤ 128) → fit 4. A WIDE pill (60) does NOT (88+8+60=156
  // > 128 → line 3) → forces fit 3. Strict fewer.
  const five = [40, 40, 40, 40, 40]
  const narrow = packStrip(five, 128, gap, 10)
  const wide = packStrip(five, 128, gap, 60)
  assert(wide.fit < narrow.fit, `wider pill fits STRICTLY fewer chips (narrow fit ${narrow.fit} > wide fit ${wide.fit})`)
  assert(narrow.fit + narrow.overflow === 5 && wide.fit + wide.overflow === 5, 'fit + overflow = total in both')
  // Everything fits on ONE line → no overflow regardless of pill.
  eq(packStrip([20, 20], 100, gap, 40), { fit: 2, overflow: 0 }, 'all fit on one line → no overflow')
  // Degenerate: unmeasured rowW → show all (renderer waits for measurement).
  eq(packStrip([40, 40], 0, gap, 30), { fit: 2, overflow: 0 }, 'rowW 0 → show all (pre-measure)')
  // A single chip too wide for the row still counts as fit 1 (never a 0-chip strip).
  eq(packStrip([200], 100, gap, 30), { fit: 1, overflow: 0 }, 'one oversized chip → fit 1 (never empties the strip)')

  // ── alwaysReserveTail: the compare "Aroma detail" pill is ALWAYS rendered, so
  // the packer must reserve it EVEN when chips fit without it — else a full-but-
  // fitting chip set leaves the always-present pill to spill to a 3rd line
  // (Codex review #1: the two-line guarantee was broken). The review's exact
  // repro: 4×40 fit both lines, but the pill (30) then has nowhere to go.
  const noTail = packStrip([40, 40, 40, 40], 100, gap, 30, false)
  eq(noTail, { fit: 4, overflow: 0 }, 'default (tail on overflow only): 4×40 fit, no overflow')
  const withTail = packStrip([40, 40, 40, 40], 100, gap, 30, true)
  assert(withTail.overflow >= 1 && withTail.fit + withTail.overflow === 4,
    `alwaysReserveTail: the ever-present pill forces overflow so it stays on 2 lines (fit ${withTail.fit} + overflow ${withTail.overflow} = 4)`)
  // When the chips + pill DO fit in 2 lines, alwaysReserveTail still returns no
  // overflow (it doesn't over-reserve): 2×40 + pill 30 on rowW 100 → line1 40+40,
  // line2 pill → fits.
  eq(packStrip([40, 40], 100, gap, 30, true), { fit: 2, overflow: 0 }, 'alwaysReserveTail: chips + pill fit in 2 lines → no overflow')
}

step('38b · unionStrip — flat fallback when there is no agreement (Simon 2026-07-14)')
{
  // Total scatter: 3 tasters, 3 distinct singletons → NO agreement, but the
  // union must surface all three with count 1 each, ordered occurrence-then-tax.
  const scatter = buildAromaContributors([R('a', [{ a: 'strawberry' }]), R('b', [{ a: 'lemon' }]), R('c', [{ a: 'oak' }])])
  const us = unionStrip(scatter)
  eq(us.length, 3, 'scatter → 3 union chips (every distinct base)')
  assert(us.every((c) => c.count === 1), 'each scatter aroma has mention count 1')
  assert(us.every((c) => c.pronounced === false), 'union chips carry no pronounced ring (agreement-only signal)')
  // Occurrence ordering: 2 pick strawberry, 1 picks lemon → strawberry first.
  const weighted = buildAromaContributors([R('a', [{ a: 'strawberry' }]), R('b', [{ a: 'strawberry' }]), R('c', [{ a: 'lemon' }])])
  const wu = unionStrip(weighted)
  eq(wu[0].id, 'strawberry', 'higher-occurrence aroma sorts first')
  eq(wu[0].count, 2, 'strawberry count = 2 distinct tasters')
  // Single respondent (n<2): still lists that person's aromas.
  const solo = unionStrip(buildAromaContributors([R('a', [{ a: 'strawberry' }, { a: 'oak' }])]))
  eq(solo.length, 2, 'single respondent → their 2 aromas listed')
  // No aromas at all → empty union (caller omits the block).
  eq(unionStrip(buildAromaContributors([R('a', [])])).length, 0, 'no aromas → empty union')

  // unionPopoverContent — the fallback chip's contributor popover (Simon: union
  // badges must be tappable to inspect who + how).
  const contribU = buildAromaContributors([
    R('a', [{ a: 'strawberry', m: 'cooked' }]),
    R('b', [{ a: 'strawberry', m: 'cooked' }]),
    R('c', [{ a: 'strawberry' }]),
  ])
  const upc = unionPopoverContent(contribU, 'strawberry')
  assert(upc != null, 'unionPopoverContent resolves a picked base')
  eq(upc!.count, 3, 'strawberry perceived by 3 distinct tasters')
  eq(upc!.contributors.length, 3, 'all 3 contributors present (within preview cap)')
  // Contributors carry stable ids, NOT just names (Codex: name keys can collide).
  assert(upc!.contributors.every((c) => typeof c.id === 'string' && c.id.length > 0), 'each contributor carries a stable id')
  // Two distinct modifiers with EXACT counts: cooked ×2, fresh/default ×1.
  eq(upc!.byModifier.length, 2, 'two distinct modifiers → breakdown shown')
  const cooked = upc!.byModifier.find((g) => g.m === 'cooked')
  const fresh = upc!.byModifier.find((g) => g.m === null)
  eq(cooked?.count, 2, 'cooked modifier count = 2')
  eq(fresh?.count, 1, 'default (fresh) modifier count = 1')
  // A lone default-modifier base shows NO modifier line (nothing to distinguish).
  const soloMod = unionPopoverContent(buildAromaContributors([R('a', [{ a: 'oak' }]), R('b', [{ a: 'oak' }])]), 'oak')
  eq(soloMod!.byModifier.length, 0, 'lone default modifier → no breakdown line')
  eq(unionPopoverContent(contribU, 'not_a_base'), null, 'unknown base → null')

  // DUPLICATE-NAME regression (Codex): two tasters BOTH named "Alex" with
  // DIFFERENT identity ids. Display names collide, so the popover MUST expose
  // distinct ids (the render keys on id — name keys would clash + misreconcile).
  const twoAlex: AromaContributorInput[] = [
    { id: 'u:11', displayName: 'Alex', aromas: [{ a: 'strawberry', m: null }] },
    { id: 'u:22', displayName: 'Alex', aromas: [{ a: 'strawberry', m: null }] },
  ]
  const alexPc = unionPopoverContent(buildAromaContributors(twoAlex), 'strawberry')!
  eq(alexPc.contributors.map((c) => c.displayName), ['Alex', 'Alex'], 'both display names are "Alex" (collision)')
  const alexIds = alexPc.contributors.map((c) => c.id)
  eq(new Set(alexIds).size, 2, 'the two Alexes carry DISTINCT ids (no React-key clash)')
  assert(alexIds.includes('u:11') && alexIds.includes('u:22'), 'ids are the stable identity ids, not the names')
  // Same regression on the AGREEMENT popover path (both pick a unanimous node).
  const agRes = aromaConsensus(aggregateAromaRollup(twoAlex.map((t) => t.aromas!.map((a) => ({ a: a.a, m: a.m })))))
  const agPc = popoverContent(agRes, buildAromaContributors(twoAlex), tier2Strip(agRes)[0].id)!
  eq(new Set(agPc.contributors.map((c) => c.id)).size, 2, 'agreement popover: two Alexes keep distinct ids too')
}

step('38c · buildCompareAromaModel — the ONE derivation strip + sheet consume (Codex 2026-07-15)')
{
  eq(hasResolvableAroma(undefined), false, 'missing aroma array is not compare aroma input')
  eq(hasResolvableAroma([{ a: 'not-real' }]), false, 'unknown-only historical ids do not admit a dead compare card')
  eq(hasResolvableAroma([{ a: 'not-real' }, { a: 'strawberry' }]), true, 'one resolvable pick admits the aroma respondent')
  const signatureInput = [R('sig', [{ a: 'strawberry', m: null }])]
  eq(
    compareAromaInputSignature(signatureInput),
    compareAromaInputSignature([R('sig', [{ a: 'strawberry', m: null }])]),
    'semantic aroma signature is stable across fresh poll objects',
  )
  assert(
    compareAromaInputSignature(signatureInput) !== compareAromaInputSignature([R('sig', [{ a: 'strawberry', m: 'cooked' }])]),
    'semantic aroma signature changes with modifier-bearing input',
  )
  const measureChip = { id: 'strawberry', tier: 'leaf' as const, label: 'Strawberry', familyId: 'fruity', count: 9, role: 'primary' as const, pronounced: false }
  assert(
    stripChipMeasureKey(measureChip) !== stripChipMeasureKey({ ...measureChip, count: 10 }),
    'strip measurement key changes across a live count-width boundary',
  )
  // AGREEMENT panel: 3 of 4 share strawberry (majority) — plus one singleton
  // (oak from a lone taster) and one modifier split (cooked vs default).
  const agree = buildCompareAromaModel([
    R('a', [{ a: 'strawberry', m: 'cooked' }]),
    R('b', [{ a: 'strawberry' }]),
    R('c', [{ a: 'strawberry' }]),
    R('d', [{ a: 'oak' }]),
  ])
  assert(agree.hasAgreement, 'majority strawberry → agreement mode')
  assert(agree.strip.some((c) => c.id === 'strawberry'), 'agreement strip carries the consensus node')
  assert(!agree.strip.some((c) => c.id === 'oak'), 'the singleton never enters the 2-line strip')
  eq(agree.bun, consensusBunNotes(agree.result), 'model carries the full pure consensus-Bun projection')
  // The Bun is NOT the two-line strip. This panel produces the pinned
  // Fruity(context/primary head) → Berry → Strawberry chain: the compact strip
  // exposes only its head, while every counted node enters the Bun and the Bun
  // geometry alone decides which labels physically fit.
  const bunChain = buildCompareAromaModel([
    ...Array.from({ length: 4 }, (_, i) => R(`f${i}`, [{ a: 'fruity' }])),
    ...Array.from({ length: 2 }, (_, i) => R(`b${i}`, [{ a: 'fruity.berry' }])),
    ...Array.from({ length: 2 }, (_, i) => R(`s${i}`, [{ a: 'strawberry' }])),
  ])
  eq(bunChain.strip.map((c) => c.id), ['fruity'], 'compact strip keeps only the primary head')
  eq(bunChain.bun.map((note) => `${note.role}:${note.id}:${note.count}`), [
    'primary:fruity:8',
    'peak:fruity.berry:4',
    'peak:strawberry:2',
  ], 'Aroma Bun receives every counted consensus node, including peaks hidden by the strip')
  // All Aromas redesign: every literal (aroma, modifier) pair is its own
  // canonical badge. Mentions is flat; modifiers stay inside the badge.
  eq(agree.allAromas.map((row) => `${row.a}|${row.m ?? '_'}:${row.count}`), [
    'strawberry|_:2',
    'strawberry|cooked:1',
    'oak|_:1',
  ], 'flat exact-pair rows: default strawberry 2 · jammy strawberry 1 · oak 1')
  eq(agree.allAromas[1].ref, { kind: 'pair', a: 'strawberry', m: 'cooked' }, 'every All Aromas badge carries an exact pair ref')
  assert(agree.allAromas.some((row) => row.a === 'oak' && row.m === null && row.count === 1), 'singleton oak remains visible as a canonical badge')
  // One taster choosing two modifiers produces two literal badges, each with
  // its own exact distinct-taster count.
  const multi = buildCompareAromaModel([R('a', [{ a: 'strawberry', m: 'cooked' }, { a: 'strawberry', m: 'jammy' }])])
  eq(multi.allAromas.map((row) => [row.a, row.m, row.count]), [
    ['strawberry', 'cooked', 1],
    ['strawberry', 'jammy', 1],
  ], 'two modifiers → two canonical exact-pair badges')
  // FALLBACK: total scatter → union strip, no agreement.
  const scatter = buildCompareAromaModel([R('a', [{ a: 'lemon' }]), R('b', [{ a: 'oak' }])])
  assert(!scatter.hasAgreement, 'scatter → fallback mode')
  eq(scatter.bun, [], 'no agreement → no consensus Aroma Bun')
  eq(scatter.strip.length, 2, 'fallback strip = the union')
  eq(scatter.allAromas.length, 2, 'fallback All Aromas = the same literal picks')
  // Mentions is occurrence-ranked and flat. Family sums literal mentions at
  // every grain, so several Fruity rows together can outrank one larger Oak
  // row; taxonomy order is only the tie-break.
  const sortModel = buildCompareAromaModel([
    R('a', [{ a: 'oak' }]),
    R('b', [{ a: 'oak' }]),
    R('c', [{ a: 'oak' }]),
    R('d', [{ a: 'lemon' }]),
    R('e', [{ a: 'lemon' }]),
    R('f', [{ a: 'fruity.berry' }]),
    R('g', [{ a: 'fruity' }]),
  ])
  eq(sortModel.allAromas.map((row) => row.a), ['oak', 'lemon', 'fruity', 'fruity.berry'], 'model order = occurrence desc (oak ×3 first)')
  eq(sortAromaMentions(sortModel.allAromas, 'occurrence').map((row) => row.a), ['oak', 'lemon', 'fruity', 'fruity.berry'], 'Mentions keeps occurrence order')
  const familySorted = sortAromaMentions(sortModel.allAromas, 'family')
  eq(familySorted.map((row) => row.a), ['lemon', 'fruity', 'fruity.berry', 'oak'], 'Family sort = family total desc, then row occurrence')
  eq(groupAromaMentions(familySorted).map((family) => `${family.familyId}:${family.totalCount}:${family.rows.map((row) => row.a).join(',')}`), [
    'fruity:4:lemon,fruity,fruity.berry',
    'woody:3:oak',
  ], 'Family mode sums family + subfamily + leaf mentions and ranks family groups')
  eq(filterAromaMentions(agree.allAromas, 'jammy').map((row) => [row.a, row.m]), [['strawberry', 'cooked']], 'aroma search matches the displayed modifier override')
  eq(filterAromaMentions(agree.allAromas, 'fruity').map((row) => row.a), ['strawberry', 'strawberry'], 'aroma search matches family vocabulary')
  eq(filterAromaParticipants(agree.contrib.participants, 'oak').map((person) => person.id), ['d'], 'People search matches a participant through their aroma')
  eq(filterAromaParticipants(agree.contrib.participants, 'jammy').map((person) => person.id), ['a'], 'People search matches displayed modifier vocabulary')
  eq(filterAromaParticipants(agree.contrib.participants, 'fruity').map((person) => person.id), ['a', 'b', 'c'], 'People family search Fruity includes every descendant Fruity pick')
  eq([...matchingParticipantPickKeys(agree.contrib.participants[0], 'fruity')], ['strawberry|cooked'], 'People family search moves matching descendant badges first')
  const nora = buildAromaContributors([{ id: 'nora', displayName: 'Nora', aromas: [{ a: 'strawberry', m: null }] }]).participants[0]
  eq([...matchingParticipantPickKeys(nora, 'Nora')], [], 'name-only search does not pale that person’s aroma badges')
  const exactPop = exactAromaPopoverContent(agree.contrib, { kind: 'pair', a: 'strawberry', m: null })!
  eq([exactPop.count, exactPop.contributors.map((person) => person.id)], [2, ['b', 'c']], 'All Aromas exact badge popover = the pair supporters')
  const alsoPop = exactAromaPopoverContent(agree.contrib, { kind: 'pair', a: 'strawberry', m: null }, 'b')!
  eq([alsoPop.count, alsoPop.contributors.map((person) => person.id)], [2, ['c']], 'People badge popover keeps total count but excludes its row owner from "Also perceived by"')
  const taste = aromaTasteSummary(buildAromaContributors([
    R('ana', [{ a: 'strawberry' }]),
    R('ben', [{ a: 'raspberry' }]),
    R('cara', [{ a: 'oak' }]),
  ]).participants)!
  eq([taste.closestPair.people.map((person) => person.id), taste.closestPair.score], [['ana', 'ben'], 50], 'related Berry leaves → closest pair at 50%')
  eq([taste.farthestPair.people.map((person) => person.id), taste.farthestPair.score], [['ana', 'cara'], 0], 'unrelated Fruity/Woody → farthest pair at 0%')
  eq([taste.closestToGroup.person.id, taste.closestToGroup.score], ['ana', 25], 'closest to group = highest mean pair overlap (stable roster tie-break)')
  eq([taste.mostIndividual.person.id, taste.mostIndividual.score], ['cara', 0], 'most individual = lowest mean pair overlap')
  // Minimum THREE respondents (Simon 2026-07-17): with two, every stat names
  // the same pair — the summary is suppressed entirely.
  const twoTaste = aromaTasteSummary(buildAromaContributors([
    R('ana', [{ a: 'strawberry', m: 'cooked' }]),
    R('ben', [{ a: 'strawberry' }]),
  ]).participants)
  eq(twoTaste, null, 'two respondents → no taste summary (minimum is 3)')
  // Full rankings (stat-card tap-through, Simon 2026-07-17): every pair sorted
  // best-first (stable roster order on ties), every person by mean overlap.
  eq(taste.pairs.map((pair) => [pair.people.map((person) => person.id).join('+'), pair.score]),
    [['ana+ben', 50], ['ana+cara', 0], ['ben+cara', 0]], 'pairs = complete ranking, sorted desc, stable ties')
  eq(taste.group.map((member) => [member.person.id, member.score]),
    [['ana', 25], ['ben', 25], ['cara', 0]], 'group = every respondent by mean overlap, sorted desc, stable ties')
  eq([taste.pairs[0], taste.group[0]], [taste.closestPair, taste.closestToGroup], 'sorted heads agree with the reduce-picked extremes')
  // Extremes gate (scientific review 2026-07-19): a 1-pick respondent is
  // mechanically low-overlap, so ungated Most Individual crowns the least
  // ENGAGED taster. With >=2 multi-pick respondents, the named extremes draw
  // only from them; the all-1-pick trio above falls back ungated (unchanged).
  const gated = aromaTasteSummary(buildAromaContributors([
    R('ana', [{ a: 'strawberry' }, { a: 'oak' }]),
    R('ben', [{ a: 'strawberry' }, { a: 'oak' }]),
    R('cara', [{ a: 'strawberry' }, { a: 'vanilla' }]),
    R('dana', [{ a: 'vegetal' }]),
  ]).participants)!
  assert(gated.group.some((member) => member.person.id === 'dana'), 'the 1-pick respondent stays IN the ranking list')
  eq(gated.mostIndividual.person.id, 'cara', 'Most Individual = lowest mean among >=2-pick respondents (never the 1-pick dana)')
  // Tie disclosure (Simon 2026-07-19): the cards must say when an extreme is
  // SHARED. ana+cara and ben+cara both score 0 → farthest tied; ana and ben
  // share the top mean → closest-to-group tied.
  eq([taste.closestPairTies, taste.farthestPairTies, taste.closestToGroupTies, taste.mostIndividualTies],
    [1, 2, 2, 1], 'tie counts over pairs + the (gated) person pool')
  eq(gated.mostIndividualTies, 1, 'gated extremes count ties within the eligible pool only')
  // eligibleGroup = the pool the person extremes come from — the ranking
  // sheet ranks THIS so row #1 matches the card (Codex: the ungated group put
  // one-pick dana above the card's cara on Most Individual).
  eq(gated.eligibleGroup.map((member) => member.person.id).includes('dana'), false, 'eligibleGroup excludes the 1-pick respondent')
  eq(gated.eligibleGroup.length, 3, 'eligibleGroup = the three multi-pick respondents')
  eq([...gated.eligibleGroup].sort((x, y) => x.score - y.score)[0].person.id, 'cara', 'ascending eligibleGroup head = the Most Individual card pick')
  eq(taste.eligibleGroup, taste.group, 'no gate active → eligibleGroup IS the group')
  // tasteSharedEvidence — the "why" chips behind a pair's score.
  const evP = (aAromas: Array<{ a: string; m?: string | null }>, bAromas: Array<{ a: string; m?: string | null }>) => {
    const ps = buildAromaContributors([R('x', aAromas), R('y', bAromas)]).participants
    return tasteSharedEvidence(ps[0], ps[1])
  }
  eq(evP([{ a: 'strawberry', m: 'cooked' }], [{ a: 'strawberry' }]),
    { exact: [], leaves: ['strawberry'], related: [] }, 'same leaf through different modifiers → SHARED leaf, no related echo')
  eq(evP([{ a: 'strawberry', m: 'cooked' }], [{ a: 'strawberry', m: 'cooked' }]),
    { exact: [{ a: 'strawberry', m: 'cooked' }], leaves: [], related: [] }, 'identical exact pick → exact only')
  eq(evP([{ a: 'strawberry' }], [{ a: 'raspberry' }]),
    { exact: [], leaves: [], related: [{ id: 'fruity.berry', label: 'Berry' }] }, 'different Berry leaves → shared subfamily, family suppressed')
  eq(evP([{ a: 'strawberry' }], [{ a: 'lemon' }]),
    { exact: [], leaves: [], related: [{ id: 'fruity', label: 'Fruity' }] }, 'family-only overlap → family territory')
  eq(evP([{ a: 'fruity.berry' }], [{ a: 'strawberry' }]),
    { exact: [], leaves: [], related: [{ id: 'fruity.berry', label: 'Berry' }] }, 'coarse subfamily pick vs its leaf → shared subfamily')
  eq(evP([{ a: 'strawberry' }], [{ a: 'oak' }]),
    { exact: [], leaves: [], related: [] }, 'disjoint families → no evidence (renderer shows the different-reads copy)')
  // Solo respondent: n=1 always falls back.
  const solo = buildCompareAromaModel([R('a', [{ a: 'lemon' }])])
  assert(!solo.hasAgreement && solo.result.n === 1, 'single respondent → fallback, n=1')
  // pronouncedIds: 3-of-4 pronounced strawberry clears the majority bar.
  const P2 = (id: string, p: boolean): AromaContributorInput => ({ id, displayName: id.toUpperCase(), aromas: [{ a: 'strawberry', m: null, p }] })
  const pron = buildCompareAromaModel([P2('a', true), P2('b', true), P2('c', true), P2('d', false)])
  assert(pron.pronouncedIds.has('strawberry'), 'group-pronounced node id lands in pronouncedIds')
  // The shared modifier-distinction predicate (also used by unionPopoverContent).
  eq(hasModifierDistinction([{ m: null, count: 2, contributors: [] }]), false, 'lone default modifier → no distinction')
  eq(hasModifierDistinction([{ m: 'cooked', count: 1, contributors: [] }]), true, 'single non-default → distinction')
}

step('38d · detailPillColors — pure UI decision (Codex 2026-07-15)')
{
  // Every theme's chosen text ink must clear WCAG 4.5:1 on its chosen fill —
  // never device-eyeball-only. Clay fails BOTH accent-on-tint (~2.11) and
  // ink-on-tint (~2.85), so it must take the solid-accent rung.
  for (const [key, t] of Object.entries(themes) as Array<[string, { accent: string; accentTint: string; accentLine: string; accentInk: string; ink: string; surface: string }]>) {
    const c = detailPillColors(t)
    // The effective background pixels: rgba tints composite over the surface.
    const bgFlat = c.bg.startsWith('rgba') ? flattenRgbaOver(c.bg, t.surface) : c.bg
    const ratio = contrastRatio(c.ink, bgFlat)
    assert(ratio >= 4.5, `${key}: pill ink clears 4.5:1 on its fill (got ${ratio.toFixed(2)})`)
  }
  const clay = detailPillColors((themes as Record<string, { accent: string; accentTint: string; accentLine: string; accentInk: string; ink: string; surface: string }>).clay)
  eq(clay.bg, (themes as Record<string, { accent: string }>).clay.accent, 'clay takes the SOLID accent rung (tint fails both text inks)')

}

step('39 · pronounced (group-level) — SUPPORTER-majority bar (scientific review 2026-07-19)')
{
  // Denominator = the node's SUPPORTERS, not the aroma respondents (supersedes
  // the earlier respondents bar): a non-perceiver has no opinion on intensity —
  // counting them against the bar treated missing evidence as a negative vote.
  // Matches the popover's "X of Y supporters" copy, which always said this.
  const named = (picks: AromaSelection[][]) => picks.map((aromas, i) => ({ id: `t${i}`, displayName: `T${i + 1}`, aromas }))
  const aSp = (a: string): AromaSelection => ({ a, m: null, p: true })
  // 3 of 5 supporters pronounced: 3>=2 && 3*2>5 → PANEL pronounced.
  const five = named([[aSp('strawberry')], [aSp('strawberry')], [aSp('strawberry')], [aS('strawberry')], [aS('strawberry')]])
  const c5 = buildAromaContributors(five)
  eq(pronouncedForNode(c5, 'strawberry'), { pronouncedCount: 3, supporterCount: 5, isPanelPronounced: true }, '3 of 5 supporters pronounced → group-pronounced')
  const result5 = aromaConsensus(aggregateAromaRollup(five.map((r) => r.aromas)), DEFAULT)
  const strip5 = tier2Strip(result5, pronouncedNodeIds(result5, c5))
  eq(strip5.find((c) => c.id === 'strawberry')!.pronounced, true, 'PR-A strip chip carries pronounced=true')
  // Same 3-of-5-supporters at n=8: the extra raspberry tasters are NOT
  // strawberry evidence → still pronounced (the OLD respondents bar wrongly
  // failed this at 3*2 ≤ 8).
  const eight = named([[aSp('strawberry')], [aSp('strawberry')], [aSp('strawberry')], [aS('strawberry')], [aS('strawberry')], [aS('raspberry')], [aS('raspberry')], [aS('raspberry')]])
  const c8 = buildAromaContributors(eight)
  const pr8 = pronouncedForNode(c8, 'strawberry')
  eq([pr8.pronouncedCount, pr8.supporterCount, pr8.isPanelPronounced], [3, 5, true], '3 of 5 supporters pronounced at n=8 → STILL group-pronounced (supporter denominator)')
  // Upward-only: a pronounced strawberry makes Berry/Fruity pronounced too, never a sibling.
  eq(pronouncedForNode(c5, 'fruity.berry').pronouncedCount, 3, 'pronounced rolls UP to Berry')
  eq(pronouncedForNode(c5, 'fruity').pronouncedCount, 3, 'pronounced rolls UP to Fruity')
  // A DIFFERENT taster's plain raspberry doesn't add pronounced to Berry beyond
  // the 3 — but it DOES widen Berry's supporter denominator (8): 3*2 ≤ 8 → the
  // broader node does NOT flag while leaf strawberry does. Grain-honest.
  const brB = pronouncedForNode(c8, 'fruity.berry')
  eq([brB.pronouncedCount, brB.supporterCount, brB.isPanelPronounced], [3, 8, false], 'Berry: 3 pronounced of 8 supporters → not group-pronounced')
  // Popover mirrors the node verdict + counts.
  const pop = popoverContent(aromaConsensus(aggregateAromaRollup(eight.map((r) => r.aromas)), DEFAULT), c8, 'strawberry')!
  eq([pop.pronouncedCount, pop.isPanelPronounced], [3, true], 'popover reports 3 pronounced + panel-pronounced ("3 of 5 supporters")')
  // The bar is a PARAMETER (deferred knob) — twoThirds is stricter: 3-of-5 clears
  // majority (6>5) but NOT twoThirds (3*3=9 >= 5*2=10 is FALSE).
  eq(pronouncedForNode(c5, 'strawberry', 'majority').isPanelPronounced, true, '3-of-5 clears majority bar')
  eq(pronouncedForNode(c5, 'strawberry', 'twoThirds').isPanelPronounced, false, '3-of-5 does NOT clear the stricter twoThirds bar')
  // 4-of-5 clears BOTH (4*3=12 >= 10).
  const four = named([[aSp('strawberry')], [aSp('strawberry')], [aSp('strawberry')], [aSp('strawberry')], [aS('strawberry')]])
  eq(pronouncedForNode(buildAromaContributors(four), 'strawberry', 'twoThirds').isPanelPronounced, true, '4-of-5 clears twoThirds')

  // ⭐ PR-B end-to-end THROUGH tier2Strip (the gallery fixture — Codex): 5 straw
  // (3 pronounced) + 3 VEGETAL (distinct family, so Strawberry stays the visible
  // primary — NOT hidden under Berry as it was with 3 raspberry). The strip UI,
  // not just the raw node lookup, is what must be right.
  const prB = named([[aSp('strawberry')], [aSp('strawberry')], [aSp('strawberry')], [aS('strawberry')], [aS('strawberry')], [aS('vegetal')], [aS('vegetal')], [aS('vegetal')]])
  const cB = buildAromaContributors(prB)
  const resB = aromaConsensus(aggregateAromaRollup(prB.map((r) => r.aromas)), DEFAULT)
  const stripB = tier2Strip(resB, pronouncedNodeIds(resB, cB)) // default majority bar
  eq(stripB.map((c) => `${c.role}:${c.id}`), ['primary:strawberry', 'secondary:vegetal'], 'PR-B strip = Strawberry primary + Vegetal secondary (Strawberry VISIBLE, not a hidden peak)')
  eq(stripB.find((c) => c.id === 'strawberry')!.pronounced, true, 'PR-B Strawberry chip group-pronounced (3 of its 5 SUPPORTERS — vegetal tasters are not strawberry evidence)')
  const popB = popoverContent(resB, cB, 'strawberry')!
  eq([popB.count, popB.pronouncedCount, popB.isPanelPronounced], [5, 3, true], 'PR-B popover: count 5, pronounced 3 → "3 of 5 supporters", group-pronounced')
}

step('40 · Agreement Overview — the redesigned aggregate page (scientific review 2026-07-19)')
{
  // k-of-n below the dot cap (natural frequency discloses the sample size);
  // whole percent above it (at that n the fraction is noise, the % is solid).
  eq(OVERVIEW_DOT_MAX, 10, 'dot/bar + k-of-n/% threshold frozen at 10')
  eq(overviewCountLabel(4, 6), '4 of 6', 'small n → natural frequency')
  eq(overviewCountLabel(52, 80), '65%', 'large n → whole percent')
  eq(overviewCountLabel(1, 3), '33%'.replace('33%', '1 of 3'), 'n=3 stays k-of-n')
  // Significance floor: a bar row needs >= 1/3 of respondents (core's peak
  // bar), never fewer than 2 — the absolute-only first cut let 2-of-14 (14%)
  // heads earn bars (Simon's insignificance call).
  eq([overviewHeadFloor(5), overviewHeadFloor(7), overviewHeadFloor(14), overviewHeadFloor(80)], [2, 3, 5, 27], 'floor = max(2, ceil(n/3))')

  // Small panel: 3 strawberry (1 cooked) + 1 raspberry + 2 oak + 1 lone vanilla.
  // Heads: Berry primary (4 > 6/2... n=7: 4 > 3.5 ✓) + Oak secondary; vanilla
  // is a 1-count scatter → below floor 2 → never a head → Also-mentioned.
  const seven = buildCompareAromaModel([
    R('a', [{ a: 'strawberry', m: 'cooked' }]),
    R('b', [{ a: 'strawberry' }]),
    R('c', [{ a: 'strawberry' }]),
    R('d', [{ a: 'raspberry' }]),
    R('e', [{ a: 'oak' }]),
    R('f', [{ a: 'oak' }]),
    R('g', [{ a: 'vanilla' }]),
  ])
  const ov = buildAgreementOverview(seven)
  eq(ov.n, 7, 'overview n = aroma respondents')
  eq(ov.rows.map((r) => `${r.role}:${r.id}:${r.count}`), ['primary:fruity.berry:4'], 'rows = floor-kept heads (oak 2-of-7 < ceil(7/3)=3 folds)')
  eq(ov.foldedHeads, 1, 'the insignificant oak head folded')
  const berry = ov.rows[0]
  // Round-3 ruling: the bar IS the breakdown — segments partition the head's
  // supporters by their deepest supporting pick.
  eq(berry.segments.map((s) => `${s.id}:${s.count}`), ['strawberry:3', 'raspberry:1'], 'bar segments = contributing aromas partitioning the head')
  eq(berry.segments.reduce((sum, s) => sum + s.count, 0), berry.count, 'Σ segment counts === head count (the partition invariant)')
  eq(berry.segments[0].ref, { kind: 'base', a: 'strawberry' }, 'segment popovers resolve via base refs (literal picks)')
  const solo3 = buildAgreementOverview(buildCompareAromaModel([
    R('a', [{ a: 'oak' }]), R('b', [{ a: 'oak' }]), R('c', [{ a: 'oak' }]),
  ]))
  eq(solo3.rows[0].segments.map((s) => `${s.id}:${s.count}`), ['oak:3'], 'a head supported only by its own literal picks = one solo segment')
  // Deepest-pick attribution: a supporter with BOTH a coarse and a deeper
  // supporting pick counts once, in the deeper segment; a coarse-only
  // supporter keeps an own-head segment.
  const mixed = buildAgreementOverview(buildCompareAromaModel([
    R('a', [{ a: 'fruity.berry' }, { a: 'strawberry' }]),
    R('b', [{ a: 'fruity.berry' }]),
    R('c', [{ a: 'raspberry' }]),
  ]))
  eq(mixed.rows[0].id, 'fruity.berry', 'mixed-grain panel → Berry head')
  eq(mixed.rows[0].segments.map((s) => `${s.id}:${s.count}`).sort(), ['fruity.berry:1', 'raspberry:1', 'strawberry:1'], 'two-pick supporter attributes to the deeper pick; coarse-only keeps an own-head segment')
  eq(ov.alsoMentioned.map((c) => `${c.id}:${c.count}`), ['oak:2', 'vanilla:1'], 'folded head + uncovered scatter land in Also-mentioned (raspberry is covered by the Berry row)')
  // Family fingerprint (the Overview header strip) — PEOPLE-weighted (review
  // round 2): count = distinct family supporters (subsumed), mentions kept as
  // tie-break + popover detail. Fixture: every taster has 1 pick, so people
  // == mentions here; the probative fixtures follow.
  const fp = familyFingerprint(seven.contrib, seven.allAromas)
  eq(fp.map((f) => `${f.familyId}:${f.count}:${f.mentions}`), ['fruity:4:4', 'woody:2:2', 'sweet:1:1'], 'fingerprint = per-family distinct supporters, share desc')
  eq(fp.map((f) => Math.round(f.share * 100)), [57, 29, 14], 'shares partition the (person, family) units')
  eq(familyFingerprint(seven.contrib, []), [], 'no mentions → empty fingerprint')
  // One prolific fruity taster (3 mentions) vs two oak tasters: PEOPLE rank
  // wins — the mention-weighted first cut ranked fruity first ("Fire
  // swallowed" class of inversion, now impossible).
  const prolific = buildCompareAromaModel([
    R('a', [{ a: 'strawberry' }, { a: 'raspberry' }, { a: 'lemon' }]),
    R('b', [{ a: 'oak' }]),
    R('c', [{ a: 'oak' }]),
  ])
  eq(familyFingerprint(prolific.contrib, prolific.allAromas).map((f) => `${f.familyId}:${f.count}:${f.mentions}`),
    ['woody:2:2', 'fruity:1:3'], 'two oak tasters outrank one prolific fruity taster')
  // Equal people → MENTIONS break the tie (the one legitimate breadth
  // channel), beating taxonomy order.
  const tied = buildCompareAromaModel([
    R('a', [{ a: 'skunky' }, { a: 'petrol' }]),
    R('b', [{ a: 'strawberry' }]),
  ])
  eq(familyFingerprint(tied.contrib, tied.allAromas).map((f) => f.familyId),
    ['chemical', 'fruity'], 'people tie → richer-explored family first (mention tie-break beats taxonomy)')
  // Top-aromas pyramid (All Aromas header): fixed 1/2/3/4 tiers over the top
  // 10 occurrence-ranked exact mentions; short lists truncate tier-wise.
  const pyr = topAromaPyramid(seven.allAromas)
  eq(pyr.map((tier) => tier.map((row) => pickKey(row.a, row.m))), [
    ['strawberry|'],
    ['oak|', 'strawberry|cooked'],
    ['raspberry|', 'vanilla|'],
  ], 'pyramid = occurrence rank chunked 1/2/3/4, truncated to available rows')
  eq(topAromaPyramid([]), [], 'no mentions → no pyramid')
  // True-triangle geometry: 4 bands, apex label centered, base band spans the
  // full width, cell counts follow the tier sizes.
  const geo = pyramidLayout([1, 2, 3, 4], 400, 188)
  eq(geo.map((band) => band.length), [1, 2, 3, 4], 'pyramid geometry = one cell row per tier')
  eq(geo[0][0].cx, 200, 'apex label anchor centered')
  eq([geo[3][0].x, geo[3][3].x + geo[3][3].w], [0, 400], 'base band spans the full width')
  eq(pyramidLayout([], 400, 188), [], 'no tiers → no geometry')
  eq(geo[0][0].slopedSides, 2, 'apex cell = two sloped sides')
  eq(geo[3].map((c) => c.slopedSides), [1, 0, 0, 1], 'base band: sloped edges only on the outer cells')
  // Slope-aware label wrap: upper lines shrink; a one-word-too-wide name is
  // honestly null (unlabelled facet), never truncated.
  eq(wrapPyramidLabel('Green bell pepper', 70, 6, 10, 2), ['Green bell', 'pepper'], 'multi-word wraps within the line budget')
  eq(wrapPyramidLabel('Petrol / kerosene', 60, 6, 0, 2), ['Petrol /', 'kerosene'], 'slash names wrap on spaces')
  eq(wrapPyramidLabel('Passionfruit', 40, 6, 0, 3), null, 'unwrappable word wider than every line → null')
  eq(wrapPyramidLabel('Oak', 70, 6, 10, 2), ['Oak'], 'short names stay one line')
  // No primary → all-secondary heads still render as rows (no special casing).
  const scatter = buildCompareAromaModel([
    R('a', [{ a: 'strawberry' }]),
    R('b', [{ a: 'strawberry' }]),
    R('c', [{ a: 'oak' }]),
    R('d', [{ a: 'oak' }]),
    R('e', [{ a: 'vegetal' }]),
  ])
  const ovS = buildAgreementOverview(scatter)
  assert(ovS.rows.every((r) => r.role === 'secondary'), 'scatter panel → all secondary heads')
  // Fallback parity (rail-style): no agreement → no bar rows, every base in
  // the mentioned tail (fingerprint + tail IS the fallback page).
  const solo2 = buildAgreementOverview(buildCompareAromaModel([R('a', [{ a: 'lemon' }])]))
  eq([solo2.n, solo2.rows, solo2.foldedHeads, solo2.alsoMentioned.map((c) => `${c.id}:${c.count}`)], [1, [], 1, ['lemon:1']], 'fallback → rows empty, bases land in the mentioned tail')
  // Large-n floor end-to-end: 30 tasters, 16 strawberry + 2 oak → floor
  // ceil(30/3)=10 folds the oak head (vegetal 12 clears); its base surfaces
  // in Also-mentioned instead.
  const big = buildCompareAromaModel([
    ...Array.from({ length: 16 }, (_, i) => R(`s${i}`, [{ a: 'strawberry' }])),
    ...Array.from({ length: 2 }, (_, i) => R(`o${i}`, [{ a: 'oak' }])),
    ...Array.from({ length: 12 }, (_, i) => R(`v${i}`, [{ a: 'vegetal' }])),
  ])
  const ovB = buildAgreementOverview(big)
  eq(ovB.rows.map((r) => r.id), ['strawberry', 'vegetal'], 'floor(30)=10 folds the 2-of-30 oak head')
  eq(ovB.foldedHeads, 1, 'folded head counted')
  eq(ovB.alsoMentioned.map((c) => c.id), ['oak'], 'folded head\'s base falls back to Also-mentioned')
  eq(overviewCountLabel(ovB.rows[0].count, ovB.n), '53%', '16 of 30 renders as 53%')
}

console.log('')
if (fails > 0) {
  console.log(`${fails} assertion(s) failed`)
  process.exit(1)
}
console.log('all aroma-aggregate + consensus + contributor + compare-view pins passed')
