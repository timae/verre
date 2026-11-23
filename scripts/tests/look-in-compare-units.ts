// ── Moment Visibility step 2, Compare in a look-in (step-2 plan T13, § 7.2) ──
//
//   §1 lib/compareItems.ts buildItems + the sorts WITHOUT the look-in's props:
//      today's output on a fixture (the moment's own Compare is unchanged)
//   §2 with `groupStats` (R4 both ways), a hidden-only bottle's card,
//      `hasAromas` as comparable input
//   §3 the adapter (lib/lookInCompare.ts): ids, blind rows, people order, guest
//      ids, the aromas merged in
//   §4 lib/lookInView.ts: a bottle's stars and "N more ratings", the people foot
//   §5 lib/momentVisibilityCopy.ts: the picker's names (R9), the hub row's value
//
// Run: npx tsx scripts/tests/look-in-compare-units.ts

import { buildItems, SORT_FNS, type CompareSort } from '../../apps/mobile/src/lib/compareItems'
import { adaptLookIn, lookInPersonId, mergeAromas } from '../../apps/mobile/src/lib/lookInCompare'
import { bottleStars, footFaces } from '../../apps/mobile/src/lib/lookInView'
import type { LookIn } from '../../apps/mobile/src/lib/lookInWire'
import { blockLook } from '../../apps/mobile/src/lib/blockLook'
import { audienceLabel, audienceSummary, guestCirclesApply, guestCirclesTitle, widerThan } from '../../apps/mobile/src/lib/momentVisibilityCopy'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
}

const w = (id: string, extra: object = {}) => ({ id, colour: 'red', sparkling: false, ...extra })
const r = (score: number, flavors: Record<string, number> = {}, aromas: { a: string; m: string | null }[] = [], extra: object = {}) => ({ score, flavors, aromas, ...extra })
const wines = [w('A'), w('B'), w('C'), w('D')]
const roster = { participants: [{ id: 'u:ann' }, { id: 'u:bob' }, { id: 'a:guest' }] }
// Ann: A 4, B 2, C notes-only; Bob: A 3, B 5 with structure; guest: A an aroma
// only; D: only a notes-only rating (no card). A rater not in the roster last.
const ratings = {
  'a:guest': { displayName: 'Gus', ratings: { A: r(0, {}, [{ a: 'fruity', m: null }]) } },
  'u:bob': { displayName: 'Bob', ratings: { A: r(3), B: r(5, { body: 3 }) } },
  'u:ann': { displayName: 'Ann', ratings: { A: r(4), B: r(2), C: r(0), D: r(0) } },
  'u:old': { displayName: 'Old', ratings: { B: r(4) } },
}
const items = buildItems(wines, ratings, roster, new Set())
const summary = (xs: ReturnType<typeof buildItems>) => xs.map(it => ({ id: it.wine.id, raters: it.raters.map(x => x.id), avg: it.avg, count: it.count, spread: it.spread, hiddenOnly: it.hiddenOnly ?? false }))

console.log('\n§1 the moment\'s own Compare, unchanged')
check('cards: a notes-only rating is no input (C and D have no card); raters in roster order, the off-roster rater last; avg over scores above 0',
  summary(items), [
    { id: 'A', raters: ['u:ann', 'u:bob', 'a:guest'], avg: 3.5, count: 3, spread: 1, hiddenOnly: false },
    { id: 'B', raters: ['u:ann', 'u:bob', 'u:old'], avg: 3.75, count: 3, spread: 3, hiddenOnly: false },
  ])
check('an aroma-only rater counts as input (the guest on A)', items[0].raters.some(x => x.id === 'a:guest'), true)
const order = (s: CompareSort, xs = items) => [...xs].sort(SORT_FNS[s]).map(it => it.wine.id)
check('sorts: line-up, highest, lowest, most agreement, least agreement, most ratings',
  (['lineup', 'top', 'bottom', 'agree', 'split', 'most'] as CompareSort[]).map(s => order(s)), [['A', 'B'], ['B', 'A'], ['A', 'B'], ['A', 'B'], ['B', 'A'], ['A', 'B']])
const sel = buildItems(wines, ratings, roster, new Set(['u:bob']))
check('a deselection recomputes over the selection', summary(sel), [
  { id: 'A', raters: ['u:ann', 'a:guest'], avg: 4, count: 2, spread: null, hiddenOnly: false },
  { id: 'B', raters: ['u:ann', 'u:old'], avg: 3, count: 2, spread: 2, hiddenOnly: false },
])
check('nobody selected: no cards', buildItems(wines, ratings, roster, new Set(['u:ann', 'u:bob', 'a:guest', 'u:old'])).length, 0)
check('no wines or no ratings: no cards', [buildItems(null, ratings, roster, new Set()).length, buildItems(wines, null, roster, new Set()).length], [0, 0])

console.log('\n§2 the look-in\'s seams')
const stats = new Map([['A', { avg: 3.2, count: 9 }], ['B', { avg: 3.75, count: 3 }], ['C', { avg: 4.5, count: 2 }], ['D', { avg: null, count: 0 }]])
const gs = buildItems(wines, ratings, roster, new Set(), stats)
check('R4, nobody deselected: the card\'s ★ and count are the server\'s (everyone counted); spread stays over the named',
  summary(gs).map(x => [x.id, x.avg, x.count, x.spread, x.hiddenOnly]), [['A', 3.2, 9, 1, false], ['B', 3.75, 3, 3, false], ['C', 4.5, 2, null, true]])
check('…a bottle only hidden people rated (C) gets a card: hiddenOnly, no rows', gs.find(x => x.wine.id === 'C')?.raters.length, 0)
check('…D (count 0, no input) still has none', gs.some(x => x.wine.id === 'D'), false)
check('…Highest / Lowest / Most ratings read the server\'s numbers', [order('top', gs), order('bottom', gs), order('most', gs)], [['C', 'B', 'A'], ['A', 'B', 'C'], ['A', 'B', 'C']])
const gsSel = buildItems(wines, ratings, roster, new Set(['u:bob']), stats)
check('R4, someone deselected: the selection\'s numbers, and no hidden-only card', summary(gsSel).map(x => [x.id, x.avg, x.count, x.hiddenOnly]), [['A', 4, 2, false], ['B', 3, 2, false]])
const light = { 'u:ann': { displayName: 'Ann', ratings: { A: r(0, {}, [], { hasAromas: true }) } } }
check('hasAromas (aromas not loaded yet) is comparable input', buildItems([w('A')], light, { participants: [{ id: 'u:ann' }] }, new Set()).length, 1)
check('…without the flag the same rating is not', buildItems([w('A')], { 'u:ann': { displayName: 'Ann', ratings: { A: r(0) } } }, { participants: [{ id: 'u:ann' }] }, new Set()).length, 0)

console.log('\n§3 the adapter')
type LookFixture = Pick<LookIn, 'lineup' | 'people' | 'ratings'>
const look: LookFixture = {
  lineup: [
    { key: 'k1', position: 0, name: 'Bottle One', producer: 'Maker', vintage: '2019', grape: null, colour: 'red', sparkling: false, abv: 13, imageUrl: 'https://img/1.jpg', region: null, country: 'AT', vinification: null, description: null, purchaseUrl: null, broughtBy: { id: 'ANNPUBLICID1', name: 'Ann' }, avg: 3.5, count: 4 },
    { key: 'k2', position: 1, blind: true as const, colour: 'white', sparkling: true, avg: 4, count: 2 },
  ],
  people: { total: 9, named: [{ key: 'ANNPUBLICID1', id: 'ANNPUBLICID1', name: 'Ann', imageUrl: null }, { key: 'g0123456789abcde', name: 'Gus', imageUrl: null, guest: true as const }], more: 7 },
  ratings: [
    { person: 'ANNPUBLICID1', bottle: 'k1', score: 4, flavors: { body: 3 }, hasAromas: true as const },
    { person: 'g0123456789abcde', bottle: 'k1', score: 3, flavors: {} },
    { person: 'ANNPUBLICID1', bottle: 'k2', score: 5, flavors: {} },
    { person: 'NOT-NAMED-XX', bottle: 'k1', score: 1, flavors: {} },
  ],
}
const a0 = adaptLookIn(look, new Map())
check('ids: a registered person u:<publicId>, a guest g:<key>', a0.roster.participants.map(p => p.id), ['u:ANNPUBLICID1', 'g:g0123456789abcde'])
check('…the guest id reads as a guest wherever the app asks (blockLook)', [blockLook('g:g0123456789abcde', 'u:ME', [], []), blockLook('u:ANNPUBLICID1', 'u:ME', [], [])], ['guest', 'normal'])
check('…lookInPersonId', [lookInPersonId({ key: 'x', id: 'P' }), lookInPersonId({ key: 'gk', guest: true })], ['u:P', 'g:gk'])
check('bottles: id = the KEY, a blind row is _blind with no name or photo', a0.wines.map(x => [x.id, x._blind ?? false, x.name, x.imageUrl]), [['k1', false, 'Bottle One', 'https://img/1.jpg'], ['k2', true, '', '']])
check('…Brought By carried as the adder', [a0.wines[0].addedByDisplayName, a0.wines[0].addedByUserId], ['Ann', 'ANNPUBLICID1'])
check('ratings: by person id and bottle key; aromas EMPTY until details; hasAromas kept; a rating of someone not named dropped',
  a0.ratings, { 'u:ANNPUBLICID1': { displayName: 'Ann', ratings: { k1: { score: 4, flavors: { body: 3 }, aromas: [], hasAromas: true, notes: '', at: 0 }, k2: { score: 5, flavors: {}, aromas: [], notes: '', at: 0 } } },
    'g:g0123456789abcde': { displayName: 'Gus', ratings: { k1: { score: 3, flavors: {}, aromas: [], notes: '', at: 0 } } } })
check('groupStats from the line-up; eligible = cards a named person flagged', [[...a0.groupStats], [...a0.eligible]], [[['k1', { avg: 3.5, count: 4 }], ['k2', { avg: 4, count: 2 }]], ['k1']])
check('the preview roster: registered people only', a0.previewIds, ['u:ANNPUBLICID1'])
const merged = mergeAromas(new Map(), { bottles: [{ key: 'k1', ratings: [{ person: 'ANNPUBLICID1', aromas: [{ a: 'fruity', m: null }] }] }] })
const a1 = adaptLookIn(look, merged)
check('the details read\'s aromas land on the right person and bottle', a1.ratings['u:ANNPUBLICID1'].ratings.k1.aromas, [{ a: 'fruity', m: null }])
const cleared: LookFixture = { ...look, ratings: look.ratings.map(r => (r.person === 'ANNPUBLICID1' && r.bottle === 'k1' ? { person: r.person, bottle: r.bottle, score: r.score, flavors: r.flavors } : r)) }
check('🔒 aromas loaded, then cleared by the taster (the first read no longer flags them): gone at once, not kept from the cache (Codex r1)',
  [adaptLookIn(cleared, merged).ratings['u:ANNPUBLICID1'].ratings.k1.aromas, adaptLookIn(cleared, merged).eligible.has('k1')], [[], false])
const merged2 = mergeAromas(merged, { bottles: [{ key: 'k1', ratings: [] }] })
check('a later answer for a bottle replaces it whole (aromas removed → gone)', adaptLookIn(look, merged2).ratings['u:ANNPUBLICID1'].ratings.k1.aromas, [])
const items2 = buildItems(a0.wines, a0.ratings, a0.roster, new Set(), a0.groupStats)
check('end to end: the adapter feeds buildItems (cards in line-up order, the server\'s ★)', items2.map(it => [it.wine.id, it.avg, it.count]), [['k1', 3.5, 4], ['k2', 4, 2]])

console.log('\n§4 a bottle\'s stars, the people foot')
const page: LookFixture = { ...look, ratings: [
  { person: 'g0123456789abcde', bottle: 'k1', score: 0, flavors: { body: 2 } }, // a named structure-only rating
  { person: 'ANNPUBLICID1', bottle: 'k1', score: 4, flavors: {} },
], lineup: [{ ...look.lineup[0], count: 2 }, look.lineup[1]] }
check('a named structure-only rating is no star row, and a hidden scored one is: N = count − named scored = 1', bottleStars(page, 'k1'), { rows: [{ person: look.people.named[0], score: 4 }], more: 1 })
check('a key not in the line-up: null (the page says it left)', bottleStars(page, 'nope'), null)
check('the people foot: the host first, "+N" = named beyond three + not named', footFaces({
  moment: { host: { id: 'C', name: 'C', imageUrl: null } } as never,
  people: { total: 20, named: ['A', 'B', 'C', 'D'].map(k => ({ key: k, id: k, name: k, imageUrl: null })), more: 16 },
}), { faces: ['C', 'A', 'B'].map(k => ({ key: k, id: k, name: k, imageUrl: null })), extra: 17 })
check('…no host named: the room\'s order', footFaces({ moment: { host: null } as never, people: { total: 2, named: [{ key: 'A', id: 'A', name: 'A', imageUrl: null }], more: 1 } }).faces.map(f => f.key), ['A'])

console.log('\n§5 Moment Visibility\'s words')
check('the host reads "Your", everyone else "Host’s" (R9)', (['members', 'friends', 'followers', 'verre'] as const).map(a => [audienceLabel(a, 'host'), audienceLabel(a, 'other')]),
  [['Only People in It', 'Only People in It'], ['Your Friends', 'Host’s Friends'], ['Your Followers', 'Host’s Followers'], ['Verre Users', 'Verre Users']])
check('the guests\' circle switch: Friends and Followers only, named after the audience', [guestCirclesApply('members'), guestCirclesApply('friends'), guestCirclesApply('followers'), guestCirclesApply('verre'), guestCirclesTitle('friends'), guestCirclesTitle('followers')],
  [false, true, true, false, 'Include Friends of Guests', 'Include Followers of Guests'])
check('the hub row', [audienceSummary('friends', true, 'other'), audienceSummary('followers', true, 'host'), audienceSummary('friends', false, 'host'), audienceSummary('verre', true, 'other')],
  ['Host’s Friends + friends of guests', 'Your Followers + followers of guests', 'Your Friends', 'Verre Users'])
check('frozen: only narrower (members < friends < followers < verre)', [widerThan('verre', 'friends'), widerThan('members', 'friends'), widerThan('friends', 'friends')], [true, false, false])

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall passed')
