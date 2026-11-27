// ── Moment Visibility step 2, the app's plumbing (step-2 plan § 7.2) ─────────
//
// Pure modules of apps/mobile, run from the repo root (structural types only, so
// React Native's typings stay out of the web build):
//   §1 the entry rule (lib/momentEntry.ts) and someone's Moments row keys
//   §2 the link matcher on the RAW URL + redirectSystemPath (lib/lookInLinks.ts)
//   §3 the link store: the pending open vs the tokens of open look-ins
//   §4 the details scheduler and the fetch gate (lib/lookInDetails.ts)
//   §5 the opener's decision from a navigation state (lib/lookInOpener.ts; the
//      router sim t21.cjs drives the same module over real states)
//
// Run: npx tsx scripts/tests/look-in-units.ts

import { momentEntry, momentRowKey } from '../../apps/mobile/src/lib/momentEntry'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  __setLookInLinksTestHooks, clearLookInLinks, consumePendingLookIn, hasPendingLookIn, lookInHeaders, lookInLinkToken, lookInPath, lookInRequestPlan,
  matchLookInUrl, PENDING_TTL_MS, pendingLookInKind, recordLookInLink, redirectLookInPath, setLookInOpenerActive,
} from '../../apps/mobile/src/lib/lookInLinks'
import { DETAILS_MAX_KEYS, detailsTick, LOOK_IN_QUERY_POLICY, LookInGate, pickDetailsBatch, throughGate } from '../../apps/mobile/src/lib/lookInDetails'
import { openerDecision, type NavState } from '../../apps/mobile/src/lib/lookInOpener'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
}

const ID = 'h7k2m9p4q8r3', ID_UP = 'H7K2M9P4Q8R3', TOK = '0123456789abcdef0123456789abcdef'

console.log('\n§1 the entry rule and the list\'s row keys')
check('a known membership opens the moment', momentEntry({ code: 'W9JJ18XV', momentId: ID_UP }), { kind: 'moment', code: 'W9JJ18XV' })
check('a moment id alone opens the look-in', momentEntry({ momentId: ID_UP }), { kind: 'look', momentId: ID_UP })
check('neither: inert', momentEntry({}), { kind: 'inert' })
check('empty values: inert', momentEntry({ code: '', momentId: null }), { kind: 'inert' })
check('a shared row keys on its code', momentRowKey({ code: 'W9JJ18XV' }), 'W9JJ18XV')
check('an open row keys on m: + its moment id', momentRowKey({ momentId: ID_UP }), `m:${ID_UP}`)
const rows = [{ code: 'W9JJ18XV' }, { momentId: ID_UP }, { code: 'W9JJ18XV' }, { momentId: ID_UP }, { momentId: 'W9JJ18XVAAAA' }]
const seen = new Set<string>()
check('dedupe by the key: shared and open never collide, repeats drop', rows.filter(r => (seen.has(momentRowKey(r)) ? false : (seen.add(momentRowKey(r)), true))).map(momentRowKey), ['W9JJ18XV', `m:${ID_UP}`, 'm:W9JJ18XVAAAA'])

console.log('\n§2 the link matcher, fed the RAW URL')
const link = { kind: 'link', momentId: ID_UP, token: TOK }
check('io.verre.app://l/<id>.<token>', matchLookInUrl(`io.verre.app://l/${ID}.${TOK}`), link)
check('…with a query', matchLookInUrl(`io.verre.app://l/${ID}.${TOK}?utm=x`), link)
check('…with a fragment', matchLookInUrl(`io.verre.app://l/${ID}.${TOK}#f`), link)
check('…all upper case (normalised, not a bad link)', matchLookInUrl(`IO.VERRE.APP://L/${ID_UP}.${TOK.toUpperCase()}`), link)
check('…a triple slash', matchLookInUrl(`io.verre.app:///l/${ID}.${TOK}`), link)
check('the bare l/<x> form', matchLookInUrl(`l/${ID}.${TOK}`), link)
check('a leading slash', matchLookInUrl(`/l/${ID}.${TOK}`), link)
check('one slash after the scheme (review r1: never into routing)', matchLookInUrl(`io.verre.app:/l/${ID}.${TOK}`), link)
check('no slash after the scheme', matchLookInUrl(`io.verre.app:l/${ID}.${TOK}`), link)
check('a percent-encoded slash', matchLookInUrl(`io.verre.app://l%2F${ID}.${TOK}`), link)
check('an https host (registered app links one day, R12)', matchLookInUrl(`https://verre.app/l/${ID}.${TOK}`), link)
// Spellings only the router's own reading (WHATWG URL host + pathname) puts under l/ (build review recheck).
for (const [label, u] of [['userinfo', `io.verre.app://x@l/${ID}.${TOK}`], ['an empty port', `io.verre.app://l:/${ID}.${TOK}`], ['dot segments', `io.verre.app:///x/../l/${ID}.${TOK}`],
  ['a ./ segment', `io.verre.app:/./l/${ID}.${TOK}`], ['a tab in the host', `io.verre.app://l\t/${ID}.${TOK}`], ['a leading space', ` io.verre.app://l/${ID}.${TOK}`], ['https dot segments', `https://verre.app/x/../l/${ID}.${TOK}`]] as const)
  check(`🔒 the router's reading: ${label}`, matchLookInUrl(u), link)
for (const [label, u] of [['an 11-character id', `l/${ID.slice(1)}.${TOK}`], ['a 31-hex token', `l/${ID}.${TOK.slice(1)}`], ['bad hex', `l/${ID}.${'g'.repeat(32)}`],
  ['extra dots', `l/${ID}.${TOK}.x`], ['a trailing slash', `l/${ID}.${TOK}/`], ['no token', `l/${ID}`], ['just l/', 'l/'], ['just l', 'io.verre.app://l'],
  ['an id that is not a public id (I)', `l/i7k2m9p4q8r3.${TOK}`], ['a deeper path', `l/${ID}.${TOK}/more`], ['an https host, malformed', 'https://verre.app/l/x']] as const) check(`bad: ${label}`, matchLookInUrl(u), { kind: 'bad' })
for (const u of ['io.verre.app:///', 'io.verre.app://', 'io.verre.app://moments', 'exp+verre://expo-development-client/?url=http%3A%2F%2F10.0.0.1%3A8081', '/feed/41', 'io.verre.app://look/x',
  'https://verre.app/legal/attributions', 'https://verre.app/feed/1', 'io.verre.app://legal', 'io.verre.app://moments/session/W9JJ18XV', '/moments', 'io.verre.app://legal/attributions'])
  check(`passes through: ${u}`, matchLookInUrl(u), null)
__setLookInLinksTestHooks({ now: () => 1000, mint: () => 'h' })
check('redirectSystemPath, warm: null (no navigation), the link recorded', [redirectLookInPath({ path: `io.verre.app://l/${ID}.${TOK}`, initial: false }), hasPendingLookIn()], [null, true])
__setLookInLinksTestHooks({})
check('cold: the Moments home as the first route', [redirectLookInPath({ path: `io.verre.app://l/${ID}.${TOK}`, initial: true }), hasPendingLookIn()], ['/moments', true])
__setLookInLinksTestHooks({})
check('the cold home-screen launch passes through UNCHANGED, nothing recorded', [redirectLookInPath({ path: 'io.verre.app:///', initial: true }), hasPendingLookIn()], ['io.verre.app:///', false])
check('any other URL passes through unchanged, warm too', [redirectLookInPath({ path: 'io.verre.app://moments', initial: false }), hasPendingLookIn()], ['io.verre.app://moments', false])
check('a bad link: recorded as bad (cold: still the Moments home)', [redirectLookInPath({ path: `io.verre.app://l/${ID}`, initial: true }), consumePendingLookIn()], ['/moments', { kind: 'bad' }])

console.log('\n§3 the link store')
let t = 0, seq = 0
__setLookInLinksTestHooks({ now: () => t, mint: () => `h${++seq}` })
setLookInOpenerActive(true)
recordLookInLink({ kind: 'link', momentId: 'AAAAAAAAAAAA', token: 'a'.repeat(32) })
recordLookInLink({ kind: 'link', momentId: ID_UP, token: TOK })
const o1 = consumePendingLookIn()
check('the latest wins; ONE consume mints a handle', [o1, consumePendingLookIn()], [{ kind: 'link', momentId: ID_UP, handle: 'h1' }, null])
check('…the handle carries the token; the route never does', lookInLinkToken('h1'), TOK)
t += PENDING_TTL_MS + 1
check('consuming / expiring the pending open never drops an opening\'s token', lookInLinkToken('h1'), TOK)
recordLookInLink({ kind: 'link', momentId: ID_UP, token: TOK })
t += PENDING_TTL_MS
check('a pending open lives 15 minutes…', hasPendingLookIn(), true)
t += 1
check('…and is dropped after', [hasPendingLookIn(), consumePendingLookIn()], [false, null])
check('via=link with an unknown handle: no token (never the audience)', [lookInLinkToken('nope'), lookInLinkToken(undefined), lookInLinkToken(null)], [null, null, null])
// Two openings of one moment: a valid link, then an older (reset) one.
recordLookInLink({ kind: 'link', momentId: ID_UP, token: 'b'.repeat(32) })
const valid = consumePendingLookIn()
recordLookInLink({ kind: 'link', momentId: ID_UP, token: 'c'.repeat(32) })
const reset = consumePendingLookIn()
check('two openings of one moment keep their own tokens (a later dead link changes nothing)',
  [valid?.kind === 'link' && lookInLinkToken(valid.handle), reset?.kind === 'link' && lookInLinkToken(reset.handle), lookInLinkToken('h1')], ['b'.repeat(32), 'c'.repeat(32), TOK])
recordLookInLink({ kind: 'link', momentId: ID_UP, token: TOK })
clearLookInLinks()
check('sign-out clears the pending open AND every opening\'s token', [hasPendingLookIn(), lookInLinkToken('h1'), valid?.kind === 'link' && lookInLinkToken(valid.handle)], [false, null, null])
setLookInOpenerActive(false)
recordLookInLink({ kind: 'bad' })
setLookInOpenerActive(true)
check('a bad link recorded while signed out is dropped at sign-in (no alert later)', hasPendingLookIn(), false)
setLookInOpenerActive(false)
recordLookInLink({ kind: 'link', momentId: ID_UP, token: TOK })
setLookInOpenerActive(true)
check('a GOOD link recorded while signed out survives sign-in (R13)', consumePendingLookIn()?.kind, 'link')
recordLookInLink({ kind: 'bad' })
setLookInOpenerActive(true)
check('a bad link recorded while signed in is kept for its alert (the opener peeks its kind first)', [pendingLookInKind(), consumePendingLookIn(), pendingLookInKind()], ['bad', { kind: 'bad' }, null])

console.log('\n§3b how a screen asks: the request plan, the wire')
__setLookInLinksTestHooks({ now: () => 0, mint: () => 'hv' })
setLookInOpenerActive(true)
recordLookInLink({ kind: 'link', momentId: ID_UP, token: TOK })
const hv = consumePendingLookIn()
check('by audience: no token, the audience key, never bad', lookInRequestPlan(ID_UP, undefined, undefined), { viaLink: false, token: null, badLink: false, key: ['look-in', ID_UP, 'audience'] })
check('by link with a known handle: its token, a key that names the HANDLE (never the token)', [lookInRequestPlan(ID_UP, 'link', hv?.kind === 'link' ? hv.handle : '')], [{ viaLink: true, token: TOK, badLink: false, key: ['look-in', ID_UP, 'link:hv'] }])
check('🔒 by link with an unknown handle: a dead link (no audience read), its own key', lookInRequestPlan(ID_UP, 'link', 'nope'), { viaLink: true, token: null, badLink: true, key: ['look-in', ID_UP, 'link:nope'] })
check('🔒 via=link with NO handle: dead, and never the audience key (review r1)', lookInRequestPlan(ID_UP, 'link', undefined), { viaLink: true, token: null, badLink: true, key: ['look-in', ID_UP, 'link:-'] })
check('🔒 via as an array, or any other value: dead too', [lookInRequestPlan(ID_UP, ['link', 'x'], 'hv').badLink, lookInRequestPlan(ID_UP, 'x', 'hv').badLink, lookInRequestPlan(ID_UP, 'link', ['hv']).badLink], [true, true, true])
check('🔒 the path never holds a token; the token is only the X-Verre-Link header', [lookInPath(ID_UP), lookInPath(ID_UP, ['a', 'b']), lookInHeaders(TOK), lookInHeaders(null)],
  [`/api/moments/${ID_UP}`, `/api/moments/${ID_UP}?bottles=a,b`, { 'X-Verre-Link': TOK }, {}])
// The wiring the pure functions can't see, pinned on the source (review r1).
const src = (p: string) => readFileSync(join(__dirname, '../../apps/mobile/src', p), 'utf8')
const layout = src('app/_layout.tsx'), useLookIn = src('lib/useLookIn.ts'), api = src('lib/api/moments.ts')
check('🔒 sign-out (a user change) clears the link tokens and the gates beside the viewer cache',
  /lastUserId\.current !== userId\) \{ clearViewerCache\(\); clearLookInLinks\(\); clearLookInGates\(\); \}/.test(layout), true)
check('🔒 the look-in query: the plan\'s key, enabled only when not a dead link, every attempt through the gate, the policy',
  [/lookInRequestPlan\(momentId, via, handle\)/.test(useLookIn), /enabled: !badLink/.test(useLookIn), /throughGate\(gate, 'main'/.test(useLookIn), /\.\.\.LOOK_IN_QUERY_POLICY/.test(useLookIn), /detailsTick\(/.test(useLookIn)], [true, true, true, true, true])
check('🔒 the API module sends the token only through lookInHeaders, the paths only through lookInPath',
  [(api.match(/X-Verre-Link/g) ?? []).length <= 2 && !/X-Verre-Link':/.test(api), /headers: lookInHeaders\(link\)/.test(api), (api.match(/`\/api\/moments\//g) ?? []).length], [true, true, 0])

console.log('\n§4 the details scheduler and the fetch gate')
const keys = Array.from({ length: 31 }, (_, i) => `k${String(i).padStart(2, '0')}`)
const open = new Map(keys.map((k, i) => [k, i]))
const all = new Set(keys)
const b1 = pickDetailsBatch({ open, eligible: all, loaded: new Map(), now: 100 })
check('31 open cards: never more than 10 keys in a read', b1.length, DETAILS_MAX_KEYS)
check('…the most recently opened without aromas first', b1.slice(0, 3), ['k30', 'k29', 'k28'])
const loaded = new Map(keys.slice(0, 25).map(k => [k, 50]))
check('cards still without aromas come before the loaded ones', pickDetailsBatch({ open, eligible: all, loaded, now: 100 }).slice(0, 6), ['k30', 'k29', 'k28', 'k27', 'k26', 'k25'])
check('loaded cards are not asked again before 5 s', pickDetailsBatch({ open: new Map([['k00', 0]]), eligible: all, loaded: new Map([['k00', 0]]), now: 4999 }), [])
check('…and are once 5 s have passed', pickDetailsBatch({ open: new Map([['k00', 0]]), eligible: all, loaded: new Map([['k00', 0]]), now: 5000 }), ['k00'])
check('a card rated only by hidden people (not eligible) never enters a read', pickDetailsBatch({ open, eligible: new Set(['k01']), loaded: new Map(), now: 0 }), ['k01'])
// Every open card is refreshed within a bounded number of reads: drive it.
{
  const gate = new LookInGate(() => clock)
  let clock = 0
  const got = new Map<string, number>(), times: number[] = [], firstFour = new Set<string>()
  const lastRefresh = new Map<string, number>()
  let worstGap = 0
  for (clock = 0; clock <= 120_000; clock += 100) {
    if (gate.wait('details') > 0) continue
    const batch = pickDetailsBatch({ open, eligible: all, loaded: got, now: clock })
    if (!batch.length) continue
    gate.take('details')
    times.push(clock)
    if (times.length <= 4) batch.forEach(k => firstFour.add(k))
    for (const k of batch) { if (lastRefresh.has(k)) worstGap = Math.max(worstGap, clock - lastRefresh.get(k)!); lastRefresh.set(k, clock); got.set(k, clock) }
  }
  check('every one of 31 open cards is read within the first 4 reads (ceil(31 / 10))', firstFour.size, 31)
  const gaps = times.slice(1).map((x, i) => x - times[i])
  check('…never two details reads within 2 s', Math.min(...gaps) >= 2000, true)
  check('…and each card is refreshed at least every 12 s with all 31 open', worstGap <= 12_000, true)
}
// The budget at the FETCH boundary with a server that fails every request: no
// retries exist, and whatever drives attempts (a 1 s retry loop, refocus
// refetches, the details ticks every 100 ms), the gate admits ≤ 12 + 30 a minute.
{
  let clock = 0
  const gate = new LookInGate(() => clock)
  let main = 0, details = 0
  for (clock = 0; clock < 60_000; clock += 100) {
    if (clock % 1000 === 0 && gate.take('main')) main++ // an eager refetch every second, failing
    if (gate.take('details')) details++ // a details attempt every tick, failing
  }
  check('≤ 42 requests a minute with every card open and every request failing (12 first reads + 30 details)', [main, details, main + details <= 42], [12, 30, true])
}
{
  let clock = 0
  const gate = new LookInGate(() => clock)
  gate.take('main') // the look-in's poll at 0
  clock = 500 // its bottle page subscribes half a second later (same gate)
  check('the bottle page\'s hand-off adds no burst: its first read waits for the 5 s slot', [gate.take('main'), gate.wait('main')], [false, 4500])
  clock = 5000
  check('…and goes at 5 s', gate.take('main'), true)
}

console.log('\n§5 the opener\'s decision')
const st = (routes: [string, object?, NavState?][], index = routes.length - 1): NavState => ({ index, routes: routes.map(([name, params, state]) => ({ name, params, state })) })
const root = (tab: string, stack?: NavState) => st([['__root', undefined, st([['(tabs)', undefined, st([[tab, undefined, stack]])]])]])
check('a tab root: push there', openerDecision(root('feed', st([['index']])), false), { kind: 'push', mount: { tab: 'feed' } })
check('a tab whose stack is not built yet: push there', openerDecision(root('you'), false), { kind: 'push', mount: { tab: 'you' } })
check('a post open: push on ITS stack', openerDecision(root('feed', st([['index'], ['[id]', { id: '41' }, st([['index']])]])), false), { kind: 'push', mount: { tab: 'feed', post: '41' } })
check('a card on a post\'s stack: still the post\'s stack', openerDecision(root('you', st([['index'], ['[id]', { id: '7' }, st([['index'], ['post/[postId]', { id: '7', postId: '9' }]])]])), false), { kind: 'push', mount: { tab: 'you', post: '7' } })
check('Soon: switch to Moments first', openerDecision(root('soon'), false), { kind: 'switch-to-moments' })
// A post edit is an ordinary push since 2026-11-24 ("like Check In"): the
// look-in opens ON TOP of it (the tab's stack, or the post's), Back returns to it.
const overEdits: [string, NavState, object][] = [
  ['the outer edit (Feed)', root('feed', st([['index'], ['edit/[id]', { id: '5' }]])), { tab: 'feed' }],
  ['the outer edit\'s details', root('moments', st([['index'], ['edit/[id]'], ['edit/details']])), { tab: 'moments' }],
  ['a post\'s own edit', root('feed', st([['index'], ['[id]', { id: '41' }, st([['index'], ['edit/[postId]']])]])), { tab: 'feed', post: '41' }],
  ['a post\'s own details step', root('you', st([['index'], ['[id]', { id: '41' }, st([['index'], ['edit/[postId]'], ['edit/details']])]])), { tab: 'you', post: '41' }],
  ['the catalogue search as a SIBLING of a post\'s edit details', root('moments', st([['index'], ['[id]', { id: '41' }, st([['index'], ['edit/[postId]'], ['edit/details'], ['catalog/search']])]])), { tab: 'moments', post: '41' }],
]
for (const [label, s, mount] of overEdits) check(`opens on top: ${label}`, openerDecision(s, false), { kind: 'push', mount })
const waits: [string, NavState][] = [
  ['About on top of the tabs', st([['__root', undefined, st([['(tabs)', undefined, st([['feed']])], ['about']])]])],
  ['the auth group', st([['__root', undefined, st([['(auth)']])]])],
  ['no state yet', st([])],
]
for (const [label, s] of waits) check(`waits: ${label}`, openerDecision(s, false).kind, 'wait')
check('the photo viewer open: close it first (ruled 2026-11-24)', openerDecision(root('feed', st([['index']])), true).kind, 'close-viewer')
check('waits: undefined state', openerDecision(undefined, false).kind, 'wait')

// The budget at the FETCH boundary, through the real doors: throughGate (the
// queries' only door) and detailsTick (the details reads'), against a server
// that fails every request, driven as eagerly as anything could (review r1).
async function fetchBoundary() {
  let clock = 0
  const sleep = async (ms: number) => { clock += Math.max(ms, 1) }
  const gate = new LookInGate(() => clock)
  let mainFetches = 0
  while (clock < 60_000) {
    // Counted only inside the minute [0, 60 s): an attempt at 60 s opens the next one.
    await throughGate(gate, 'main', async () => { if (clock < 60_000) mainFetches++; throw new Error('500') }, undefined, sleep).catch(() => {})
    clock += 1000 // an eager refetch a second after every failure
  }
  let detailFetches = 0
  const loaded = new Map<string, number>(), inFlight = { current: false }
  for (clock = 0; clock < 60_000; clock += 100) {
    await detailsTick({ gate, open, eligible: all, loaded, inFlight, now: () => clock, fetch: async () => { detailFetches++; throw new Error('500') } })
  }
  check('🔒 at the FETCH boundary, every request failing: ≤ 12 first reads + ≤ 30 details reads a minute (42)', [mainFetches <= 12, detailFetches <= 30, mainFetches + detailFetches], [true, true, mainFetches + detailFetches])
  check('…not vacuous: the drivers did hammer (12 + 30 reached)', [mainFetches, detailFetches], [12, 30])
  check('…a failed details read leaves its keys unloaded (asked again)', loaded.size, 0)
  let okFetches = 0
  const loaded2 = new Map<string, number>()
  const g2 = new LookInGate(() => clock)
  for (clock = 0; clock < 10_000; clock += 100) await detailsTick({ gate: g2, open, eligible: all, loaded: loaded2, inFlight, now: () => clock, fetch: async () => { okFetches++ } })
  check('…an answered read marks its keys loaded; 31 cards are all loaded within 4 reads', [loaded2.size, okFetches <= 5], [31, true])
  check('🔒 the queries\' policy: no retry, no focus or reconnect refetch, a poll every 5 s', LOOK_IN_QUERY_POLICY, { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchInterval: 5000 })
}

void fetchBoundary().then(() => {
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
  console.log('\nall passed')
})
