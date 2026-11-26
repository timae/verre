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

import { fieldEndEditing } from '../../apps/mobile/src/lib/fieldCapture'
import { createTransitionGuard } from '../../apps/mobile/src/lib/impressionAutosaveCore'
import { createScoreField, scoreFromDraft } from '../../apps/mobile/src/lib/scoreDraft'
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

  console.log('\n§12 a field ends its edit at end-editing, with the FINAL text, once, on both platforms (Codex recheck 2)')
  {
    // A field as ScoreInput / NotesField wire it: blur is focus UI only; the
    // end-editing event applies its final text through the setter, THEN ends
    // the capture (fieldEndEditing). Driven in both native orders.
    const run = async (order: ('blur' | 'end')[]) => {
      let belt: (() => void) | null = null
      const cap = createInputCapture({ beltMs: 300, setTimer: (fn) => { belt = fn; return 1 }, clearTimer: () => { belt = null } })
      const stored: string[] = [] // what the rating setter received
      let resolvedWith: string[] | null = null
      let resolutions = 0
      cap.focus('note')
      stored.push('Ripe che') // the last onChangeText that reached JS
      const p = cap.capture().then(() => { resolutions++; resolvedWith = [...stored] })
      let ended = false
      for (const ev of order) {
        if (ev === 'blur') { /* focus UI only: the capture is not told */ }
        else { fieldEndEditing(cap, 'note', () => stored.push('Ripe cherry')); ended = true } // the IME commit's final text
        await flush()
        if (ev === 'blur' && !ended) check(`${order.join(' → ')}: the blur alone does not end the capture`, resolutions, 0)
      }
      await p
      check(`${order.join(' → ')}: resolved once`, resolutions, 1)
      check(`${order.join(' → ')}: AFTER the final text reached the setter`, resolvedWith, ['Ripe che', 'Ripe cherry'])
      check(`${order.join(' → ')}: the belt was not needed`, belt, null)
    }
    await run(['blur', 'end']) // Android: ReactTextInputManager's focus listener
    await run(['end', 'blur']) // iOS: textInputDidEndEditing
  }
  {
    const cap = createInputCapture({ beltMs: 300 })
    cap.focus('score')
    let n = 0
    const p = cap.capture().then(() => { n++ })
    let threw = false
    try { fieldEndEditing(cap, 'score', () => { throw new Error('setter') }) } catch { threw = true }
    await p
    check('a setter that throws still ends the capture (no hang)', [threw, n], [true, 1])
    fieldEndEditing(cap, 'score', () => {}) // a second end (e.g. the unmount fallback)
    check('a second end for the same field is a no-op', cap.editing, false)
    check('no provider: nothing to tell, the text is still applied', (() => { let a = 0; fieldEndEditing(null, 'x', () => { a++ }); return a })(), 1)
  }
  {
    const cap = createInputCapture({ beltMs: 300 })
    cap.focus('note')
    cap.focus('score')
    let n = 0
    const p = cap.capture().then(() => { n++ })
    fieldEndEditing(cap, 'note', () => {})
    await flush()
    check('one field ended, the other still editing: waits', n, 0)
    cap.done('score') // the score field unmounted mid-edit (the fallback)
    await p
    check('the unmount fallback ends the last one', n, 1)
  }

  console.log('\n§13 the score number: ONE conversion live and at end-editing; a CHANGED edit only; deduped against the draft NOW (Codex rechecks 3 + 4)')
  // ScoreInput as wired: the store is the autosave draft (its setter updates it
  // synchronously; `scoreNow` reads it); `rendered` is the last rendered score,
  // which ScoreInput never dedupes against. `focus` takes the RENDERED value
  // (the component's `field.focus(value)`); `change` / `end` take the raw
  // onChangeText / onEndEditing nativeEvent.text; `slide` the slider's pick.
  const scoreHost = (start: number) => {
    const host = { store: start, rendered: start, writes: [] as number[] }
    const field = createScoreField({ current: () => host.store, write: (v) => { host.store = v; host.writes.push(v) } })
    const focus = () => field.focus(host.rendered)
    const render = () => { host.rendered = host.store }
    return { host, field, focus, render }
  }
  {
    // Recheck 3: erase 4.5; the deletion never reaches onChangeText, only the
    // end-editing event carries ""; then depart (the capture resolves after).
    const t = scoreHost(4.5)
    const cap = createInputCapture({ beltMs: 300 })
    let drainedWith: number | null = null
    t.focus()
    cap.focus('score')
    const departure = cap.capture().then(() => { drainedWith = t.host.store })
    fieldEndEditing(cap, 'score', () => { t.field.end('') })
    await departure
    check('🔒 erased at end-editing → the departure drains 0, not the old 4.5', drainedWith, 0)
  }
  {
    // Recheck 4 (a): an unrated field is focused (seed ""), the stored score
    // loads meanwhile (the autosave seeds the clean field: 4.5), the person
    // types nothing and leaves.
    const t = scoreHost(0)
    t.focus()
    t.host.store = 4.5 // the snapshot arrived while the field was focused
    t.render()
    check('🔒 untouched field, a score loaded while it was focused: nothing written at the end', t.field.end(''), 'none')
    check('the stored score stays', t.host.store, 4.5)
    check('no write at all', t.host.writes, [])
  }
  {
    // Recheck 4 (b): rendered 0; a live "4" and the final erase arrive before
    // React renders again.
    const t = scoreHost(0)
    t.focus()
    check('live "4" writes 4 (the draft NOW)', t.field.change('4'), true)
    check('no render in between: rendered is still 0', t.host.rendered, 0)
    check('🔒 the final erase writes 0 (deduped against the draft, not the rendered 0)', t.field.end(''), 'wrote')
    check('the score is 0', t.host.store, 0)
    // The same burst deduped against the RENDERED score (the old wiring) loses it:
    const old = { store: 0 }
    const stale = createScoreField({ current: () => 0 /* rendered, never re-rendered */, write: (v) => { old.store = v } })
    stale.focus(0)
    stale.change('4')
    stale.end('')
    check('(contrast) deduped against the rendered score, 4 would have drained', old.store, 4)
  }
  {
    // Recheck 5 (1): a quick focus and blur. Native ends the edit before the
    // focus seed "" reached it and reports the pre-focus "0.00"; a saved score
    // loaded meanwhile.
    const t = scoreHost(0)
    t.focus()
    t.host.store = 4.5
    check('🔒 no live change, final "0.00" means the shown 0: untouched, nothing written', t.field.end('0.00'), 'none')
    check('the loaded 4.5 stays', t.host.store, 4.5)
    const r = scoreHost(4.5)
    r.focus()
    check('rated: the pre-focus "4.50" is untouched too', r.field.end('4.50'), 'none')
    r.focus()
    check('and the seed "4.5"', r.field.end('4.5'), 'none')
    r.focus()
    check('🔒 a real erase of a rated score still writes 0', [r.field.end(''), r.host.store], ['wrote', 0])
    const u = scoreHost(0)
    u.focus()
    u.field.change('4')
    check('a live change makes it an edit: typed 4 then back to "", the end writes 0', [u.field.end(''), u.host.store], ['wrote', 0])
  }
  for (const order of ['keystroke, slider', 'slider, keystroke'] as const) {
    // Recheck 5 (2): 3 rendered; the typed "2" and the slider's 3 land before
    // the next render, in either order; then the field ends with the typed text.
    const t = scoreHost(3)
    t.focus()
    const keystroke = () => t.field.change('2')
    const slider = () => { t.field.abandon(); t.field.slide(3) } // setFromX: abandon while editing, then the pick
    if (order === 'keystroke, slider') { keystroke(); slider() } else { slider(); keystroke() }
    check(`${order}: no render in between`, t.host.rendered, 3)
    check(`🔒 ${order}: the slider's 3 is the score (deduped against the draft NOW; the queued keystroke rejected)`, t.host.store, 3)
    check(`${order}: the end writes nothing (abandoned)`, t.field.end('2'), 'abandoned')
    check(`${order}: still the slider's 3`, t.host.store, 3)
  }
  {
    const t = scoreHost(3)
    t.focus()
    t.field.abandon()
    t.field.end('1')
    t.focus()
    check('the next edit starts clean (no stale abandon)', t.field.change('2'), true)
    check('and ends normally', t.field.end('2'), 'none')
    check('the score is the typed one', t.host.store, 2)
  }
  {
    const t = scoreHost(3.5)
    t.focus()
    check('live writes only when the score moves: "3" → 3, "3." → still 3, "3.5" → 3.5', [t.field.change('3'), t.field.change('3.'), t.field.change('3.5')], [true, false, true])
    check('a changed edit that ends on the score the draft already holds writes nothing more', t.field.end('3.5'), 'none')
    check('the score is the typed one', t.host.store, 3.5)
    check('an end with no focus (a stray event) writes nothing', t.field.end('1'), 'none')
  }
  {
    const texts = ['', '.', 'abc', '0', '2', '25', '2.5', '2.6', '4,75', '9', '3.', '.5']
    // From a shown 1, so every text in the table means another score.
    const live = texts.map((x) => { const t = scoreHost(1); t.focus(); t.field.change(x); return t.host.store })
    const end = texts.map((x) => { const t = scoreHost(1); t.focus(); t.field.end(x); return t.host.store })
    check('live and end-editing write the same score for every text (one conversion)', end, live)
    check('empty / unreadable → 0 (not rated)', ['', '.', 'abc'].map(scoreFromDraft), [0, 0, 0])
    check('"25" reads 2.5, off-grid snaps, the cap holds', ['25', '2.6', '9', '4,75'].map(scoreFromDraft), [2.5, 2.5, 5, 4.75])
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
