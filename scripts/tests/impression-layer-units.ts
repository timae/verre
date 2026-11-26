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
// always leaves). A cancelled gesture gives the guard back. A forced (confirmed
// terminal) teardown captures nothing and keeps everything else out.
//
// Run: npx tsx scripts/tests/impression-layer-units.ts

import { createTransitionGuard } from '../../apps/mobile/src/lib/impressionAutosaveCore'
import { createLayerTransitions, neighbourId, type LayerDest } from '../../apps/mobile/src/lib/impressionLayerCore'

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
    check('the guard is given back (editing on the same wine)', h.guard.held, false)
    h.tx.begin(prev)
    check('Previous / an edge swipe: stay too', await h.tx.end(true), 'stay')
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
    check('guard released', h.guard.held, false)
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
    check('the guard is back', h.guard.held, false)
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
    check('guard back', guard.held, false)
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
