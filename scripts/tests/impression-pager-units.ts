// ── The impression layer's pager math (apps/mobile/src/lib/impressionLayerCore.ts) ──
//
// Build 2 (ADR-0011): the moment impression is a layer inside the line-up whose
// pages are the open impression and its LINE-UP neighbours (±1), each at
// `left: slot * width` in one translated row. Pins: the window follows the
// line-up order whatever sort or search shows; first / last page nowhere (no
// wrap, no close from the left edge); a reorder keeps the active page's slot (no
// mounted page moves in a commit); the edge swipe's follow, rubber band and
// release decision; the landing scroll + the "whole row in the band" test the
// fold uses (anything else takes the fade); the reserved window of a page
// change in flight, the slide's completion and the edge-swipe arbiter (Codex
// review 2026-11-26).
//
// Run: npx tsx scripts/tests/impression-pager-units.ts

import {
  createEdgeRuns,
  EDGE_STRIP,
  PAGE_COMMIT_FRACTION,
  PAGE_FLICK_VELOCITY,
  edgeOffset,
  frameVisible,
  landingScroll,
  neighbourId,
  pagerWindow,
  releaseTarget,
  restX,
  rubberBand,
  slideOutcome,
} from '../../apps/mobile/src/lib/impressionLayerCore'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
}
const W = 390
const ids = ['a', 'b', 'c', 'd']
const brief = (pages: ReturnType<typeof pagerWindow>) => pages.map((p) => `${p.id}@${p.slot}${p.active ? '*' : ''}#${p.index}`)

console.log('\n§1 the window: the active page and its line-up neighbours')
check('middle: previous, active, next at slot ±1', brief(pagerWindow(ids, 'b', 0)), ['a@-1#0', 'b@0*#1', 'c@1#2'])
check('first: no previous page (nothing to page to)', brief(pagerWindow(ids, 'a', 0)), ['a@0*#0', 'b@1#1'])
check('last: no next page', brief(pagerWindow(ids, 'd', 3)), ['c@2#2', 'd@3*#3'])
check('one bottle: the page alone', brief(pagerWindow(['a'], 'a', 0)), ['a@0*#0'])
check('neighbours off (the open flight): the active page alone', brief(pagerWindow(ids, 'b', 0, false)), ['b@0*#1'])
check('exactly one active page', pagerWindow(ids, 'c', 5).filter((p) => p.active).length, 1)
check('a bottle that left the line-up keeps ONE page (index -1) for its terminal transition', brief(pagerWindow(ids, 'x', 2)), ['x@2*#-1'])
check('an empty line-up (hidden for you): the active page alone', brief(pagerWindow([], 'b', 0)), ['b@0*#-1'])

console.log('\n§2 the slot survives a reorder; only the neighbours change')
const before = pagerWindow(['a', 'b', 'c'], 'b', 4)
const after = pagerWindow(['c', 'a', 'b'], 'b', 4)
check('the active page keeps its slot after a host reorder', [before.find((p) => p.active)!.slot, after.find((p) => p.active)!.slot], [4, 4])
check('its true line-up index moves (the "#2 of 3" label)', after.find((p) => p.active)!.index, 2)
check('the new previous page is the new line-up neighbour', brief(after), ['a@3#1', 'b@4*#2'])
check('a wine added after it becomes the next page', brief(pagerWindow(['a', 'b', 'n', 'c'], 'b', 4)), ['a@3#0', 'b@4*#1', 'n@5#2'])

console.log('\n§3 neighbours in line-up order (Previous / Next and the strips)')
check('next of b', neighbourId(ids, 'b', 1), 'c')
check('previous of b', neighbourId(ids, 'b', -1), 'a')
check('🔒 previous of the first: none (the left edge never closes)', neighbourId(ids, 'a', -1), null)
check('🔒 next of the last: none (no wrap to the first)', neighbourId(ids, 'd', 1), null)
check('a gone wine has no neighbours', neighbourId(ids, 'x', 1), null)

console.log('\n§4 the row at rest, the follow and the rubber band')
check('rest = -slot × width', [restX(0, W), restX(2, W), restX(-1, W)], [0, -780, 390])
check('the strip is 15 pt (the structure tracks start ~20 pt in)', EDGE_STRIP, 15)
check('left strip, free: the row follows the finger 1:1', edgeOffset(120, W, -1, true), 120)
check('left strip: never more than one page', edgeOffset(900, W, -1, true), W)
check('left strip: a drag back past the start never pages the other way', edgeOffset(-80, W, -1, true), 0)
check('right strip, free: leftward follow', edgeOffset(-150, W, 1, true), -150)
check('right strip: a rightward drag stays at rest', edgeOffset(60, W, 1, true), 0)
const band = edgeOffset(200, W, -1, false)
check('first page, left strip: a rubber band, less than the finger', band > 0 && band < 200, true)
check('rubber band matches rubberBand()', band, rubberBand(200, W))
check('rubber band is odd (direction kept)', rubberBand(-200, W), -rubberBand(200, W))
check('rubber band never reaches a page', rubberBand(10_000, W) < W, true)
check('zero width: no movement', rubberBand(50, 0), 0)

console.log('\n§5 the release decision')
const past = W * PAGE_COMMIT_FRACTION + 1
check('left strip past the line: the previous page', releaseTarget(past, 0, W, -1, true), -1)
check('right strip past the line: the next page', releaseTarget(-past, 0, W, 1, true), 1)
check('short of the line, slow: stays', releaseTarget(60, 100, W, -1, true), 0)
check('short but a flick toward it: pages', releaseTarget(40, PAGE_FLICK_VELOCITY + 1, W, -1, true), -1)
check('right strip flick', releaseTarget(-40, -(PAGE_FLICK_VELOCITY + 1), W, 1, true), 1)
check('past the line but flicked back: stays', releaseTarget(past, -PAGE_FLICK_VELOCITY, W, -1, true), 0)
check('a flick with no travel toward it: stays', releaseTarget(0, PAGE_FLICK_VELOCITY * 2, W, -1, true), 0)
check('🔒 no neighbour (first / last): never pages', releaseTarget(W, PAGE_FLICK_VELOCITY * 3, W, -1, false), 0)

console.log('\n§6 landing: the whole row in the band, or the fade')
const bandBox = { top: 200, bottom: 741 }
const row = (y: number, h = 72) => ({ x: 22, y, width: 346, height: h })
check('a row inside the band is visible', frameVisible(row(300), bandBox), true)
check('under the pinned toolbar: clipped', frameVisible(row(180), bandBox), false)
check('under the tab bar clearance: clipped', frameVisible(row(700), bandBox), false)
check('touching the band edges (half a point slack) is visible', frameVisible(row(199.6, 541.8), bandBox), true)
check('no frame (unmounted, late): the fade', frameVisible(null, bandBox), false)
// The OPEN check and the landing's final check use the screen's bottom (a row
// behind the tab bar is still wholly visible); the clearance band is only the
// landing scroll's target.
check('a row behind the tab bar: visible against the screen bottom', frameVisible(row(760), { top: 200, bottom: 844 }), true)
check('…but the landing scroll still lifts it into the clearance band', landingScroll(row(760), bandBox, 400, 2000) !== null, true)
check('a row past the screen bottom: the fade', frameVisible(row(800), { top: 200, bottom: 844 }), false)
check('an empty frame: the fade', frameVisible({ x: 0, y: 300, width: 0, height: 72 }, bandBox), false)
check('in view: no scroll', landingScroll(row(300), bandBox, 400, 2000), null)
check('below: centred in the band', landingScroll(row(900), bandBox, 400, 2000), 400 + 936 - 470.5)
check('above: centred in the band', landingScroll(row(60), bandBox, 400, 2000), 400 + 96 - 470.5)
check('clamped at the top', landingScroll(row(60), bandBox, 100, 2000), 0)
check('clamped at the end of the list', landingScroll(row(900), bandBox, 400, 600), 600)
check('already at the end: no scroll (the row stays clipped → the fade)', landingScroll(row(900), bandBox, 600, 600), null)
check('negative max (a short list): no scroll', landingScroll(row(60), bandBox, 0, -50), null)

console.log('\n§7 a page change in flight shows exactly its reserved source and destination')
check('next reserved: source at its slot, destination at slot + 1, nothing else', brief(pagerWindow(ids, 'b', 0, true, { to: 'c', dir: 1 })), ['b@0*#1', 'c@1#2'])
check('previous reserved: in line-up order', brief(pagerWindow(ids, 'b', 0, true, { to: 'a', dir: -1 })), ['a@-1#0', 'b@0*#1'])
check('a reorder mid-slide does not swap the page under it', brief(pagerWindow(['c', 'b', 'a', 'd'], 'b', 0, true, { to: 'c', dir: 1 })), ['b@0*#1', 'c@1#0'])
check('another bottle moved into the slot: still the destination there', brief(pagerWindow(['a', 'b', 'x', 'c', 'd'], 'b', 0, true, { to: 'c', dir: 1 })), ['b@0*#1', 'c@1#3'])
check('the destination left the line-up: its own key, index -1 (its last-seen copy)', brief(pagerWindow(['a', 'b', 'd'], 'b', 2, true, { to: 'c', dir: 1 })), ['b@2*#1', 'c@3#-1'])
check('the reservation wins over neighbours-off', brief(pagerWindow(ids, 'b', 0, false, { to: 'c', dir: 1 })), ['b@0*#1', 'c@1#2'])
check('no reservation: the plain window again', brief(pagerWindow(ids, 'b', 0, true, null)), ['a@-1#0', 'b@0*#1', 'c@1#2'])

console.log('\n§8 a slide commits only when its own spring finished and the destination is still there')
check('finished, present, live: commit', slideOutcome(ids, 'c', true, true), 'commit')
check('interrupted spring (finished=false): cancel back to the source', slideOutcome(ids, 'c', true, false), 'cancel')
check('the destination left the line-up mid-slide: cancel', slideOutcome(['a', 'b', 'd'], 'c', true, true), 'cancel')
check('the layer blurred or unmounted: cancel', slideOutcome(ids, 'c', false, true), 'cancel')
check('reordered but present: commit', slideOutcome(['c', 'a', 'b', 'd'], 'c', true, true), 'commit')

console.log('\n§9 the edge-swipe arbiter: a swipe writes only once granted, a refused one never')
{
  const e = createEdgeRuns()
  e.start(1, 1)
  check('a release before the grant is deferred (the input capture still runs)', e.release(1, { target: 1, vx: 900 }), 'deferred')
  check('the grant replays it', e.grant(1, 'page'), { released: { target: 1, vx: 900 } })
  check('and the run is over: a second release is stale', e.release(1, { target: 0, vx: 0 }), null)
}
{
  const e = createEdgeRuns()
  e.start(2, -1)
  check('granted first: nothing to replay', e.grant(2, 'page'), { released: null })
  check('the release then finishes it, with its grant and direction', e.release(2, { target: -1, vx: 0 }), { grant: 'page', dir: -1 })
}
{
  const e = createEdgeRuns()
  e.start(3, 1)
  check('refused: the grant answers (nothing to own)', e.grant(3, 'refused'), { released: null })
  check('a refused swipe\'s release does nothing', e.release(3, { target: 1, vx: 0 }), null)
}
{
  const e = createEdgeRuns()
  e.start(4, 1)
  e.release(4, { target: 1, vx: 0 })
  check('refused after a deferred release: the release is dropped, not replayed', e.grant(4, 'refused'), { released: null })
  check('and the run is gone', e.dirOf(4), null)
}
{
  // Codex recheck 2026-11-26: a second finger on the OPPOSITE edge while a
  // swipe holds the row must never displace it (it held the guard: stranded).
  const e = createEdgeRuns()
  check('the first swipe starts', e.start(5, 1), true)
  check('🔒 a swipe on the opposite edge meanwhile is refused at start', e.start(6, -1), false)
  check('its grant is ignored', e.grant(6, 'page'), null)
  check('its release is ignored', e.release(6, { target: -1, vx: 0 }), null)
  check('the first one is still current', e.dirOf(5), 1)
  check('and is granted', e.grant(5, 'page'), { released: null })
  check('a second finger while it is granted: refused too', e.start(7, -1), false)
  check('the granted swipe still finishes with its own release', e.release(5, { target: 1, vx: 0 }), { grant: 'page', dir: 1 })
  check('after it, a new swipe may start', e.start(8, -1), true)
}
{
  const e = createEdgeRuns()
  e.start(9, 1)
  e.release(9, { target: 0, vx: 0 })
  check('a deferred release keeps the run until its grant: a new swipe is refused', e.start(10, 1), false)
  e.grant(9, 'page')
  check('the grant replayed it and freed the row', e.start(10, 1), true)
}
{
  const e = createEdgeRuns()
  e.start(7, 1)
  e.grant(7, 'band')
  e.revoke()
  check('revoked (a button page change, a close): the release is void', e.release(7, { target: 0, vx: 0 }), null)
  e.start(8, -1)
  e.revoke()
  check('revoked before its grant: the grant is stale', e.grant(8, 'page'), null)
}
{
  const e = createEdgeRuns()
  e.start(9, 1)
  e.grant(9, 'band')
  check('a granted rubber band finishes as a band', e.release(9, { target: 1, vx: 2000 }), { grant: 'band', dir: 1 })
  check('a second grant for the same id is ignored', e.grant(9, 'page'), null)
}

if (failures) {
  console.error(`\n${failures} FAILED`)
  process.exit(1)
}
console.log('\nimpression pager: all pins hold')
