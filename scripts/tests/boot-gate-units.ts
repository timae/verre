// ── Stale-launch pins for the root layout (public-user-ids § 6) ─────────────
//
// The first launch after the switch to public ids restores a Better Auth
// session cached by the previous build, whose `user.id` is the old INTEGER.
// The layout must treat it as not yet known: no route group mounts on it, a
// failed or still-integer get-session keeps it unknown (and retried), a 401
// resolves as signed out, and a 426 that arrives meanwhile still shows (the
// layout renders the update screen itself: no navigator is mounted to route
// into). These pins drive the REAL pure decisions (apps/mobile/src/lib/
// bootGate.ts) and the REAL update gate through a small simulator of the
// layout's state + effects; React itself is not under test.
//
// Run: npx tsx scripts/tests/boot-gate-units.ts

import Module from 'node:module'
import { writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHIM = join(root, 'scripts/tests/.expo-router-shim-boot.cjs')
writeFileSync(SHIM, 'module.exports = { router: { replace: () => {} } };\n')
const M = Module as unknown as { _resolveFilename: (...a: unknown[]) => string }
const originalResolve = M._resolveFilename
M._resolveFilename = function (req: unknown, ...rest: unknown[]) {
  if (req === 'expo-router') return SHIM
  return originalResolve.call(this, req, ...rest)
}
const nodeRequire = Module.createRequire(import.meta.url)
type Body = { minVersion?: string; storeUrl?: string }
const boot = nodeRequire(join(root, 'apps/mobile/src/lib/bootGate.ts')) as typeof import('../../apps/mobile/src/lib/bootGate.ts')
const gate = nodeRequire(join(root, 'apps/mobile/src/lib/updateGate.ts')) as {
  routeToUpdateRequired: (body: Body | null) => void
  markUpdateNavigationReady: () => void
  subscribePendingUpdate: (l: () => void) => () => void
  getPendingUpdate: () => Body | null
  __resetUpdateGate: (replace?: (b: Body) => void) => void
}

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
}

const INT = { user: { id: '42' } }
const PUB = { user: { id: 'K7M2Q9X4B8RT' } }
type Snap = { session: { user: { id: string } } | null; isPending: boolean; isRefetching?: boolean }

// The layout's state + effects, in render-then-effects order.
function layoutSim() {
  let resolvedOnce = false
  let waitedTooLong = false
  let lastUserId: string | null = null
  let first = true
  const out = { clears: 0, screens: [] as string[], mountedOnInteger: false, ready: false, retryArmed: [] as boolean[] }
  return {
    out,
    deadline() { waitedTooLong = true },
    render(s: Snap) {
      const st = boot.bootState({ session: s.session, isPending: s.isPending, resolvedOnce, waitedTooLong })
      const updatePending = gate.getPendingUpdate() != null
      const screen = boot.bootScreen({ splashCanHide: st.splashCanHide, sessionResolved: st.sessionResolved, updatePending })
      out.screens.push(screen === 'stack' ? (st.signedIn ? 'tabs' : 'auth') : screen)
      if (screen === 'stack' && st.signedIn && !/^[A-Z]/.test(s.session!.user.id)) out.mountedOnInteger = true
      // effects
      if (first) { lastUserId = st.viewerId; first = false }
      else { if (lastUserId !== null && lastUserId !== st.viewerId) out.clears++; lastUserId = st.viewerId }
      if (boot.marksResolved(s.isPending, st.stale)) resolvedOnce = true
      if (st.sessionResolved && !out.ready) { out.ready = true; gate.markUpdateNavigationReady() }
      out.retryArmed.push(boot.shouldRetryStale({ stale: st.stale, isPending: s.isPending, isRefetching: !!s.isRefetching, updatePending }))
      return st
    },
  }
}

console.log('\n§1 a cached INTEGER session, then the heartbeat returns the public id')
{
  gate.__resetUpdateGate(() => {})
  const sim = layoutSim()
  sim.render({ session: INT, isPending: true, isRefetching: true })
  sim.deadline()
  sim.render({ session: INT, isPending: true, isRefetching: true })
  sim.render({ session: PUB, isPending: false })
  check('splash, then the neutral screen, then the tabs', JSON.stringify(sim.out.screens) === JSON.stringify(['splash', 'neutral', 'tabs']), JSON.stringify(sim.out.screens))
  check('no route group ever mounts on the integer', !sim.out.mountedOnInteger)
  // stale → public is a FIRST resolution (the viewer id was null while stale):
  // nothing was mounted, and clearing here would detach the tabs that mount in
  // the same commit. A real account switch still clears (§ 6).
  check('the cache is not cleared on stale → public (nothing to clear, tabs just mounted)', sim.out.clears === 0, `clears=${sim.out.clears}`)
  check('no retry was armed while the request was in flight', !sim.out.retryArmed[0] && !sim.out.retryArmed[1])
}

console.log('\n§2 a stale 200 (the answer still carries an integer) retries, then recovers')
{
  gate.__resetUpdateGate(() => {})
  const sim = layoutSim()
  sim.render({ session: INT, isPending: true, isRefetching: true })
  const st = sim.render({ session: INT, isPending: false })
  check('a settled integer answer stays unresolved (not the stack)', !st.sessionResolved && sim.out.screens[1] === 'neutral', JSON.stringify(sim.out.screens))
  check('…and arms the retry (not only on an error)', sim.out.retryArmed[1] === true)
  sim.render({ session: INT, isPending: false, isRefetching: true })
  check('the retry is disarmed while its request is in flight', sim.out.retryArmed[2] === false)
  sim.render({ session: PUB, isPending: false })
  check('the public id resolves to the tabs', sim.out.screens.at(-1) === 'tabs')
  check('never mounted on the integer', !sim.out.mountedOnInteger)
}

console.log('\n§3 a 503 (Better Auth keeps the cached data, isPending false), then success')
{
  gate.__resetUpdateGate(() => {})
  const sim = layoutSim()
  sim.render({ session: INT, isPending: true, isRefetching: true })
  const failed = sim.render({ session: INT, isPending: false })
  check('a settled failure does NOT open the stack (the old bare !isPending did)', !failed.sessionResolved && sim.out.screens[1] === 'neutral', JSON.stringify(sim.out.screens))
  check('the update gate is not opened while stale', !sim.out.ready)
  check('a retry is armed', sim.out.retryArmed[1] === true)
  sim.render({ session: PUB, isPending: false })
  check('success lands on the tabs', sim.out.screens.at(-1) === 'tabs')
  check('the update gate opens on resolution', sim.out.ready)
}

console.log('\n§4 a 401 resolves as signed out')
{
  gate.__resetUpdateGate(() => {})
  const sim = layoutSim()
  sim.render({ session: INT, isPending: true, isRefetching: true })
  const st = sim.render({ session: null, isPending: false })
  check('the auth group mounts', sim.out.screens.at(-1) === 'auth', JSON.stringify(sim.out.screens))
  check('not stale, resolved', !st.stale && st.sessionResolved)
  check('the update gate opens', sim.out.ready)
  check('no retry', sim.out.retryArmed[1] === false)
}

console.log('\n§5 a cached integer session + a 426: the update screen shows in place of the neutral screen')
{
  const routed: Body[] = []
  gate.__resetUpdateGate((b) => { routed.push(b) })
  let notified = 0
  const unsub = gate.subscribePendingUpdate(() => { notified++ })
  const sim = layoutSim()
  sim.render({ session: INT, isPending: true, isRefetching: true })
  gate.routeToUpdateRequired({ minVersion: '0.1.5', storeUrl: 'https://testflight.apple.com/join/x' })
  check('the pending body is published to subscribers', notified === 1 && gate.getPendingUpdate()?.minVersion === '0.1.5')
  sim.render({ session: INT, isPending: false })
  check('the update screen renders (no navigator is mounted to route into)', sim.out.screens.at(-1) === 'update', JSON.stringify(sim.out.screens))
  check('the buffered body is NOT consumed (no router.replace into nothing)', routed.length === 0 && gate.getPendingUpdate() !== null)
  check('no stale retry while an update is pending', sim.out.retryArmed.at(-1) === false)
  unsub()
}

console.log('\n§6 a signed-out launch is never stale')
{
  gate.__resetUpdateGate(() => {})
  const sim = layoutSim()
  sim.render({ session: null, isPending: true, isRefetching: true })
  const st = sim.render({ session: null, isPending: false })
  check('resolves to the auth group', sim.out.screens.at(-1) === 'auth' && !st.stale)
  check('the update gate opens (markUpdateNavigationReady still runs)', sim.out.ready)
}

console.log('\n§7 a real account switch still clears the cache once')
{
  gate.__resetUpdateGate(() => {})
  const sim = layoutSim()
  sim.render({ session: PUB, isPending: false })
  sim.render({ session: null, isPending: false })
  sim.render({ session: { user: { id: 'Z9Z9Z9Z9Z9Z9' } }, isPending: false })
  check('X → null → Y clears exactly once (at the sign-out)', sim.out.clears === 1, `clears=${sim.out.clears}`)
}

console.log('\n§8 the retry backoff')
{
  const d = [0, 1, 2, 3, 4, 5].map(boot.staleRetryDelayMs)
  check('2, 4, 8, 16, 30, 30 seconds', JSON.stringify(d) === JSON.stringify([2000, 4000, 8000, 16000, 30000, 30000]), JSON.stringify(d))
}

M._resolveFilename = originalResolve
try { unlinkSync(SHIM) } catch { /* already gone */ }
console.log(failures === 0 ? '\nOK — boot-gate pins pass.' : `\nFAILED — ${failures} boot-gate pin(s).`)
process.exit(failures === 0 ? 0 : 1)
