// Aroma FILTER units: what one pick in Filter Impressions matches (ruled
// 2026-11-14; rule in packages/core/src/aroma/filter.ts). Drives the real core
// module. The SQL twin (lib/profileLists.ts aromaSql) is pinned against real
// rows in scripts/tests/you-profile-integration.mts § 22. Run from repo root:
//   npx tsx scripts/tests/aroma-filter-units.ts

import { aromaFilterMatch, aromaPickMatches, aromaSubtree, gateAromaSelections, type AromaSelection } from '@verre/core'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
// The filter takes CANONICAL picks (the route gates them first).
const pick = (sel: AromaSelection) => {
  const g = gateAromaSelections([sel])
  if (!g.value) throw new Error(`bad pick ${JSON.stringify(sel)}: ${g.error}`)
  return aromaFilterMatch(g.value[0])
}
const hits = (sel: AromaSelection, stored: { a: string; m: string | null; p?: boolean }) => aromaPickMatches(pick(sel), stored)

// 1. Downward inheritance.
check('family finds a leaf under it', hits({ a: 'fruity', m: null }, { a: 'apricot', m: null }))
check('family finds a subfamily under it', hits({ a: 'fruity', m: null }, { a: 'fruity.stone', m: null }))
check('family finds itself', hits({ a: 'fruity', m: null }, { a: 'fruity', m: null }))
check('subfamily finds its leaf', hits({ a: 'fruity.stone', m: null }, { a: 'apricot', m: null }))
check('subfamily misses a sibling subfamily leaf', !hits({ a: 'fruity.stone', m: null }, { a: 'lemon', m: null }))
check('family misses another family', !hits({ a: 'fruity', m: null }, { a: 'floral', m: null }))
check('never upward: a leaf pick misses a stored family', !hits({ a: 'apricot', m: null }, { a: 'fruity', m: null }))
check('never upward: a leaf pick misses its stored subfamily', !hits({ a: 'apricot', m: null }, { a: 'fruity.stone', m: null }))
check('subtree of a family holds every tier', aromaSubtree('fruity').includes('fruity.citrus') && aromaSubtree('fruity').includes('lemon'))
check('unknown id: empty subtree', aromaSubtree('nope').length === 0)

// 2. Modifiers: a plain pick is broad, a refined one exact.
check('plain pick finds a modified one', hits({ a: 'apricot', m: null }, { a: 'apricot', m: 'dried' }))
check('modifier pick finds the same modifier', hits({ a: 'apricot', m: 'dried' }, { a: 'apricot', m: 'dried' }))
check('modifier pick misses plain', !hits({ a: 'apricot', m: 'dried' }, { a: 'apricot', m: null }))
check('modifier pick misses another modifier', !hits({ a: 'apricot', m: 'dried' }, { a: 'apricot', m: 'cooked' }))
check('modifier passes down', hits({ a: 'fruity', m: 'dried' }, { a: 'fig', m: 'dried' }))
check('modifier passes down, wrong modifier misses', !hits({ a: 'fruity', m: 'dried' }, { a: 'fig', m: 'ripe' }))

// 3. Pronounced: only marked ones; unmarked takes either.
check('pronounced pick finds a marked one', hits({ a: 'apricot', m: null, p: true }, { a: 'apricot', m: null, p: true }))
check('pronounced pick misses an unmarked one', !hits({ a: 'apricot', m: null, p: true }, { a: 'apricot', m: null }))
check('unmarked pick finds a marked one', hits({ a: 'apricot', m: null }, { a: 'apricot', m: null, p: true }))
check('pronounced passes down', hits({ a: 'fruity', m: null, p: true }, { a: 'lemon', m: null, p: true }) && !hits({ a: 'fruity', m: null, p: true }, { a: 'lemon', m: null }))

// 4. Promoted leaves (grape + dried is stored as raisin).
check('grape finds raisin', hits({ a: 'grape', m: null }, { a: 'raisin', m: null }))
check('grape + dried canonicalizes to raisin and finds it', pick({ a: 'grape', m: 'dried' }).ids.includes('raisin') && hits({ a: 'grape', m: 'dried' }, { a: 'raisin', m: null }))
check('fruity + dried finds raisin', hits({ a: 'fruity', m: 'dried' }, { a: 'raisin', m: null }))
check('fruity.other + dried finds raisin', hits({ a: 'fruity.other', m: 'dried' }, { a: 'raisin', m: null }))
check('grape + cooked misses raisin', !hits({ a: 'grape', m: 'cooked' }, { a: 'raisin', m: null }))
check('raisin misses plain grape', !hits({ a: 'raisin', m: null }, { a: 'grape', m: null }))
check('pronounced holds on a promoted hit', !hits({ a: 'grape', m: null, p: true }, { a: 'raisin', m: null }) && hits({ a: 'grape', m: null, p: true }, { a: 'raisin', m: null, p: true }))
check('plum finds prune', hits({ a: 'plum', m: null }, { a: 'prune', m: null }))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
