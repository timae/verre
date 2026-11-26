// ── The impression layer's active-page contract (apps/mobile/src/lib/impressionLayerCore.ts) ──
//
// Build 2 (ADR-0011) with build 1's REAL transition guard
// (apps/mobile/src/lib/impressionAutosaveCore.ts createTransitionGuard): every
// CONTROLLED departure (Previous, Next, Finish, an edge swipe, the close button,
// Android Back, a pull-down) shares the layer's ONE guard; it captures the
// OUTGOING page (its drain) before anything moves, holds edits while the drain
// runs, and moves only once the edits are stored, exactly once and only if the
// same page is still the active one; a storage failure leaves that wine active
// and the pager at rest for a PAGE CHANGE, while a CLOSE still leaves (Back
// always leaves). A 'stay' and a cancelled gesture keep the guard until the row
// is back at rest (`abandon`, Codex recheck 2026-11-26). A forced (confirmed
// terminal) teardown captures nothing and keeps everything else out. Also: the
// pull-down's sequencing (its guarded drain starts DURING the drag, once the
// text capture is in) and the page's text capture (createInputCapture).
//
// Run: npx tsx scripts/tests/impression-layer-units.ts

import { createTransitionGuard } from '../../apps/mobile/src/lib/impressionAutosaveCore'
import {
  createInputCapture,
  createLayerTransitions,
  createPullClose,
  neighbourId,
  type LayerDest,
} from '../../apps/mobile/src/lib/impressionLayerCore'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
}

type Deferred = { promise: Promise<boolean>; resolve: (ok: boolean) => void }
const deferred = (): Deferred => {
  let resolve!: (ok: boolean) => void
  const promise = new Promise<boolean>((r) => { resolve = r })
  return { promise, resolve }
}

function harness(ids = ['a', 'b', 'c']) {
  const guard = createTransitionGuard()
  const state = { active: 'b', live: true, ids, drains: [] as string[], held: [] as boolean[] }
  const pending: Deferred[] = []
  let auto: boolean | null = true // resolve drains at once with this, null = manual
  const tx = createLayerTransitions({
    guard,
    activeId: () => state.active,
    drain: (id) => {
      state.drains.push(id)
      if (auto !== null) return Promise.resolve(auto)
      const d = deferred()
      pending.push(d)
      return d.promise
    },
    live: () => state.live,
    destValid: (dest: LayerDest, from) => dest.kind === 'close' || neighbourId(state.ids, from, dest.dir) === dest.wineId,
    onHeld: (h) => state.held.push(h),
  })
  return { guard, tx, state, pending, manual: () => { auto = null }, failDrains: () => { auto = false } }
}
const next = { kind: 'page', wineId: 'c', dir: 1 } as const
const prev = { kind: 'page', wineId: 'a', dir: -1 } as const
const close = { kind: 'close' } as const

async function main() {
  console.log('\n§1 a page change: capture the OUTGOING page first, move once, then release')
  {
    const h = harness()
    check('begin takes the guard', h.tx.begin(next), true)
    check('the guard is held (the pages\' edits wait)', h.guard.held, true)
    check('only the outgoing (active) page was drained', h.state.drains, ['b'])
    check('a second departure meanwhile is refused (one per waiter)', h.tx.begin(close), false)
    check('end(true) → go once the edits are stored', await h.tx.end(true), 'go')
    check('the guard stays held through the slide', h.guard.held, true)
    check('a late second end is ignored', await h.tx.end(true), 'stay')
    h.state.active = 'c'
    h.tx.settle()
    check('settle: guard back, edits resume on the new page', h.guard.held, false)
    check('the worklet mirror followed the guard', h.state.held, [true, false])
    check('a new departure after the move begins normally', h.tx.begin(prev), true)
  }

  console.log('\n§2 the capture is awaited: a pending drain holds the move ("the layer holds its position")')
  {
    const h = harness()
    h.manual()
    h.tx.begin(next)
    let outcome: string | null = null
    const p = h.tx.end(true).then((o) => { outcome = o })
    await Promise.resolve()
    check('nothing moves while the edits are not yet stored', outcome, null)
    check('the guard is held meanwhile', h.guard.held, true)
    h.pending[0].resolve(true)
    await p
    check('stored → go', outcome, 'go')
  }

  console.log('\n§3 a storage failure: a page change stays, a close still leaves')
  {
    const h = harness()
    h.failDrains()
    h.tx.begin(next)
    check('a page change: end(true) → stay', await h.tx.end(true), 'stay')
    check('🔒 the guard stays held while the row returns to rest (Codex recheck)', h.guard.held, true)
    check('returning', h.tx.returning, true)
    check('nothing else begins while it returns', h.tx.begin(prev), false)
    h.tx.abandon()
    check('back at rest: abandon gives it back (editing on the same wine)', h.guard.held, false)
    h.tx.begin(prev)
    check('Previous / an edge swipe: stay too', await h.tx.end(true), 'stay')
    h.tx.abandon()
    h.tx.begin(close)
    check('🔒 a close (the close button, Finish, Android Back, a pull-down) still goes: never trapped', await h.tx.end(true), 'go')
    check('the close keeps the guard while it folds away', h.guard.held, true)
  }
  {
    const h = harness()
    h.failDrains()
    h.tx.begin(close)
    h.state.live = false
    check('a close whose layer is no longer live (blurred, unmounted) does not run', await h.tx.end(true), 'stay')
  }

  console.log('\n§4 "still current": the move goes only if the same page is active, live, and the destination is still its neighbour')
  {
    const h = harness()
    h.manual()
    h.tx.begin(next)
    const p = h.tx.end(true)
    h.state.live = false // blurred (Next then Back) or unmounted meanwhile
    h.pending[0].resolve(true)
    check('not live → stay', await p, 'stay')
    check('the guard waits for the return', h.guard.held, true)
    h.tx.abandon()
    check('guard released once back at rest', h.guard.held, false)
  }
  {
    const h = harness()
    h.manual()
    h.tx.begin(next)
    const p = h.tx.end(true)
    h.state.ids = ['a', 'b', 'n', 'c'] // a wine added between b and c
    h.pending[0].resolve(true)
    check('the destination is no longer the neighbour → stay (never a jump past a page)', await p, 'stay')
  }
  {
    const h = harness()
    h.manual()
    h.tx.begin(next)
    const p = h.tx.end(true)
    h.state.active = 'a'
    h.pending[0].resolve(true)
    check('another page became active → stay', await p, 'stay')
  }

  console.log('\n§5 a cancelled gesture (or a boundary swipe that never began)')
  {
    const h = harness()
    h.tx.begin(prev)
    check('end(false) → stay at once', await h.tx.end(false), 'stay')
    check('🔒 a cancelled swipe keeps the guard until the row is back at rest', h.guard.held, true)
    check('nothing in flight meanwhile (no slide)', h.tx.current(), null)
    check('another swipe or a button is refused meanwhile', h.tx.begin(next), false)
    h.tx.abandon()
    check('the guard is back once the return landed', h.guard.held, false)
    check('the outgoing page WAS captured (its edits stay in the entry)', h.state.drains, ['b'])
    check('a boundary swipe never begins, so nothing is captured', neighbourId(h.state.ids, 'a', -1), null)
    check('end without a begin is a no-op', await h.tx.end(true), 'stay')
  }

  console.log('\n§6 close shares the SAME guard with paging (Codex r16 8: a close that skipped it could race a Next)')
  {
    const h = harness()
    h.manual()
    check('Next begins', h.tx.begin(next), true)
    check('the close button meanwhile is refused', h.tx.begin(close), false)
    check('a pull-down meanwhile is refused', h.tx.begin(close), false)
    h.pending[0].resolve(true)
    await h.tx.end(true)
    h.state.active = 'c'
    h.tx.settle()
    check('after the move the close begins', h.tx.begin(close), true)
    check('the close captured the NEW active page', h.state.drains, ['b', 'c'])
    h.pending[1].resolve(true)
    check('close → go once stored', await h.tx.end(true), 'go')
    check('the guard stays held while the layer folds away', h.guard.held, true)
  }
  {
    const h = harness()
    h.tx.begin(close)
    check('a page change during a close is refused', h.tx.begin(next), false)
  }

  console.log('\n§7 a forced teardown (the bottle gone, Delete Impression): no capture, nothing after it')
  {
    const h = harness()
    h.tx.force()
    check('no drain', h.state.drains, [])
    check('the guard is held (no more edits)', h.guard.held, true)
    check('nothing begins afterwards', h.tx.begin(close), false)
    h.tx.settle()
    check('settle never releases a forced layer', h.guard.held, true)
  }
  {
    const h = harness()
    h.manual()
    h.tx.begin(next)
    const p = h.tx.end(true)
    h.tx.force()
    h.pending[0].resolve(true)
    check('a departure in flight yields to the forced teardown', await p, 'stay')
    check('and the guard stays held', h.guard.held, true)
    check('busy', h.tx.busy, true)
  }

  console.log('\n§8 a drain that throws counts as a storage failure')
  {
    const guard = createTransitionGuard()
    const tx = createLayerTransitions({
      guard,
      activeId: () => 'b',
      drain: () => { throw new Error('boom') },
      live: () => true,
      destValid: () => true,
    })
    check('begin still takes the guard', tx.begin(next), true)
    check('a page change → stay', await tx.end(true), 'stay')
    tx.abandon()
    check('guard back once at rest', guard.held, false)
    check('a close begins', tx.begin(close), true)
    check('a close → go (never trapped)', await tx.end(true), 'go')
  }

  console.log('\n§9 a slide that did not land (Codex review 2026-11-26): abandon gives the guard back, the source stays')
  {
    const h = harness()
    h.tx.begin(next)
    check('go', await h.tx.end(true), 'go')
    check('held through the slide', h.guard.held, true)
    h.tx.abandon()
    check('abandon: guard back (the return spring landed)', h.guard.held, false)
    check('the source is still the active page', h.state.active, 'b')
    check('the mirror followed', h.state.held, [true, false])
    check('nothing in flight', h.tx.current(), null)
    check('a new departure begins normally', h.tx.begin(prev), true)
  }
  {
    const h = harness()
    h.tx.begin(next)
    await h.tx.end(true)
    h.tx.force()
    h.tx.abandon()
    check('abandon never releases a forced layer', h.guard.held, true)
  }
  {
    const h = harness()
    h.tx.abandon()
    check('abandon with nothing in flight is a no-op', h.guard.held, false)
  }

  console.log('\n§10 the pull-down: its guarded drain starts DURING the drag, once the text capture is in (Codex recheck)')
  const flush = () => new Promise<void>((r) => setTimeout(r, 0))
  const pullHarness = () => {
    const h = harness()
    let capDone!: () => void
    const capture = () => new Promise<void>((r) => { capDone = r })
    const order: string[] = []
    let closing = false
    const pull = createPullClose({ tx: h.tx, capture, closing: () => closing, onBegun: () => order.push('begun') })
    return { h, pull, order, finishCapture: () => capDone(), setClosing: (v: boolean) => { closing = v } }
  }
  {
    const p = pullHarness()
    check('activate: accepted', p.pull.activate(), true)
    check('nothing drained while the text is captured', p.h.state.drains, [])
    check('no guard yet (a field may still report)', p.h.guard.held, false)
    p.finishCapture()
    await flush()
    check('🔒 capture in → the close begins DURING the drag: the guard', p.h.guard.held, true)
    check('and the drain of the outgoing page', p.h.state.drains, ['b'])
    check('the layer was told (it revokes a swipe)', p.order, ['begun'])
    check('release → close once stored', await p.pull.release(), 'close')
    check('the close keeps the guard while it folds', p.h.guard.held, true)
    check('nothing for settled() to give back', p.pull.held, false)
  }
  {
    const p = pullHarness()
    p.pull.activate()
    const out = p.pull.release() // a quick pull: released before the capture is in
    await flush()
    check('a release before the capture waits: no drain yet', p.h.state.drains, [])
    p.finishCapture()
    check('then begins and closes', await out, 'close')
    check('drained once', p.h.state.drains, ['b'])
  }
  {
    const p = pullHarness()
    p.pull.activate()
    p.finishCapture()
    await flush()
    p.pull.cancel()
    check('🔒 a cancel short of the line KEEPS the guard while it springs back', p.h.guard.held, true)
    check('nothing else begins meanwhile', p.h.tx.begin(next), false)
    check('a new pull is denied meanwhile', p.pull.activate(), false)
    p.pull.settled()
    check('settled (back open): the guard goes back', p.h.guard.held, false)
    check('a new pull may start', p.pull.activate(), true)
  }
  {
    const p = pullHarness()
    p.pull.activate()
    p.pull.cancel()
    p.finishCapture()
    await flush()
    check('cancelled before the capture was in: never begins', p.h.guard.held, false)
    check('no drain', p.h.state.drains, [])
    p.pull.settled()
    check('settled is a no-op then', p.h.guard.held, false)
  }
  {
    const p = pullHarness()
    p.h.tx.begin(next) // a slide / a drain in flight
    check('denied while another transition holds the guard', p.pull.activate(), false)
  }
  {
    const p = pullHarness()
    p.h.manual()
    p.pull.activate()
    p.finishCapture()
    await flush()
    p.h.state.live = false // blurred mid-pull
    const out = p.pull.release()
    p.h.pending[0].resolve(true)
    check('no longer live at the release → back open', await out, 'open')
    check('the guard waits for the spring back', p.h.guard.held, true)
    p.pull.settled()
    check('then goes back', p.h.guard.held, false)
  }
  {
    const p = pullHarness()
    p.pull.activate()
    p.finishCapture()
    await flush()
    p.h.tx.force() // the bottle gone mid-pull
    p.setClosing(true)
    check('a forced close took over: the release does nothing', await p.pull.release(), 'none')
    p.pull.settled()
    check('and settled() never releases the forced layer', p.h.guard.held, true)
  }
  {
    const p = pullHarness()
    p.h.failDrains()
    p.pull.activate()
    p.finishCapture()
    await flush()
    check('a storage failure still closes (never trapped)', await p.pull.release(), 'close')
  }

  console.log('\n§11 the page\'s text capture: every departure joins ONE capture that waits for the fields\' native end (Codex recheck)')
  {
    let fire: (() => void) | null = null
    const cap = createInputCapture({ beltMs: 300, setTimer: (fn) => { fire = fn; return 1 }, clearTimer: () => { fire = null } })
    let settled = false
    check('no field editing: resolves at once', await cap.capture().then(() => 'done'), 'done')
    cap.focus('note')
    // The root dismissed the keyboard on touch-down: React Native's focus
    // record is already empty, but the note's blur has not reached JS yet.
    const a = cap.capture().then(() => { settled = true })
    const b = cap.capture()
    check('🔒 a second departure JOINS the capture in flight', a !== undefined && b === cap.capture(), true)
    await flush()
    check('waits while the note has not reported its end', settled, false)
    cap.done('note')
    await a
    check('the note\'s blur / end-editing resolves it', settled, true)
    check('the belt was cleared', fire, null)
  }
  {
    let fire: (() => void) | null = null
    const cap = createInputCapture({ beltMs: 300, setTimer: (fn) => { fire = fn; return 1 }, clearTimer: () => { fire = null } })
    cap.focus('score')
    cap.focus('note')
    let settled = false
    const a = cap.capture().then(() => { settled = true })
    cap.done('score')
    await flush()
    check('two fields: waits for both', settled, false)
    cap.done('note')
    await a
    check('both ended → resolved', settled, true)
    cap.focus('score')
    let late = false
    const c = cap.capture().then(() => { late = true })
    fire!()
    await c
    check('a field that never reports: the bounded belt resolves it', late, true)
    check('and it is forgotten (the next capture does not wait on it)', cap.editing, false)
  }

  if (failures) {
    console.error(`\n${failures} FAILED`)
    process.exit(1)
  }
  console.log('\nimpression layer contract: all pins hold')
}

// An await that never settles would end the process quietly with code 0: the
// run only passes when main() reached its end.
let finished = false
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('\nFAIL: the pins did not run to the end (an await never settled)')
    process.exitCode = 1
  }
})
main().then(() => { finished = true }, (e) => { console.error(e); process.exit(1) })
