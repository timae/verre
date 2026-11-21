// ── listPostIndex pins (apps/mobile/src/lib/listPost.ts) ────────────────────
//
// Which impression of a post a profile-list row opens. Since blind rows of
// someone else's post carry no wine id (moment-visibility step 1a), the match
// is an explicit selector: Impressions by the rating id, Cravings by the wine
// id. The trap this pins: matching an absent id against an absent id
// (`undefined === undefined`) opens the FIRST blind row.
//
// Run: npx tsx scripts/tests/list-post-units.ts

import { listPostIndex } from '../../apps/mobile/src/lib/listPost'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
}

const row = (ratingId: number, id?: string) => ({ ratingId, ...(id ? { id } : {}), _blind: !id })
// Someone else's moment post: two blind rows without a wine id around a named one.
const theirs = { type: 'session' as const, session: { wines: [row(11), row(12, 'wineB'), row(13)] } }
// Your own post: every row carries its wine id, blind or not.
const mine = { type: 'session' as const, session: { wines: [row(21, 'wineX'), row(22, 'wineY')] } }
const standalone = { type: 'checkin' as const, checkin: { id: 5 } }

console.log('\n§1 Impressions: the list row\'s id is the post row\'s ratingId')
check('a blind row without a wine id is found by its rating', listPostIndex(theirs, { ratingId: 13 }), 2)
check('the first blind row', listPostIndex(theirs, { ratingId: 11 }), 0)
check('a named row', listPostIndex(theirs, { ratingId: 12 }), 1)
check('a rating that left the post → -1 (never clamped to another row)', listPostIndex(theirs, { ratingId: 99 }), -1)

console.log('\n§2 Cravings: by the wine id (their rows carry no rating id)')
check('a named row of someone else\'s post', listPostIndex(theirs, { wineId: 'wineB' }), 1)
check('your own post, second row', listPostIndex(mine, { wineId: 'wineY' }), 1)
check('a wine not in the post → -1', listPostIndex(theirs, { wineId: 'nope' }), -1)
check('🔒 an empty wine id never matches a row without one', listPostIndex(theirs, { wineId: '' }), -1)
check('🔒 an absent wine id (a bad caller) never matches a row without one', listPostIndex(theirs, { wineId: undefined as unknown as string }), -1)

console.log('\n§3 a standalone post is its one impression; no post → -1')
check('standalone, by rating', listPostIndex(standalone, { ratingId: 1 }), 0)
check('standalone, by wine', listPostIndex(standalone, { wineId: 'w' }), 0)
check('no item', listPostIndex(null, { ratingId: 1 }), -1)

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall list-post pins passed')
