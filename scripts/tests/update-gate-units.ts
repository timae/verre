// ── 426 update-gate readiness pins ─────────────────────────────────────────
//
// A 426 can arrive from the very first get-session round-trip, before the root
// navigator exists. The gate buffers it and flushes on readiness.
//
// The defect these pin: the previous implementation called `router.replace`
// inside a try/catch and treated a THROW as "not ready yet" — but expo-router
// QUEUES a replace rather than throwing, and its queue can silently discard the
// action when no navigation ref exists. Worse, it cleared `pending` BEFORE
// navigating, so a silently-dropped replace lost the 426 permanently: nothing
// threw, so nothing was caught, and nothing was left to retry. A blocking
// update screen that never appears is a client that keeps talking to an
// incompatible server.
//
// Readiness is now an explicit state, and `pending` is cleared only on the
// known-ready dispatch path. These pins drive the REAL module through its
// injected replace seam — no router, no renderer.
//
// Run: npx tsx scripts/tests/update-gate-units.ts

import Module from 'node:module'
import { writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The module imports `expo-router` purely for `router.replace`. Stub it so the
// REAL updateGate can be loaded unmodified outside a native runtime; every test
// injects its own replace via the module's own seam, so the stub is never the
// thing under test.
const SHIM = join(root, 'scripts/tests/.expo-router-shim.cjs')
writeFileSync(SHIM, 'module.exports = { router: { replace: () => {} } };\n')
const M = Module as unknown as { _resolveFilename: (...a: unknown[]) => string }
const originalResolve = M._resolveFilename
M._resolveFilename = function (req: unknown, ...rest: unknown[]) {
  if (req === 'expo-router') return SHIM
  return originalResolve.call(this, req, ...rest)
}

const nodeRequire = Module.createRequire(import.meta.url)
const gate = nodeRequire(join(root, 'apps/mobile/src/lib/updateGate.ts')) as {
  routeToUpdateRequired: (body: { minVersion?: string; storeUrl?: string } | null) => void
  markUpdateNavigationReady: () => void
  __resetUpdateGate: (replace?: (b: { minVersion?: string; storeUrl?: string }) => void) => void
  __updateGateState: () => { pending: unknown; navigationReady: boolean }
}

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
}

type Body = { minVersion?: string; storeUrl?: string }
function harness() {
  const calls: Body[] = []
  gate.__resetUpdateGate((b) => { calls.push(b) })
  return calls
}

console.log('\n§1 a 426 BEFORE readiness navigates nothing (but is not lost)')
{
  const calls = harness()
  gate.routeToUpdateRequired({ minVersion: '1.2.0', storeUrl: 'https://apps.example/app' })
  check('zero navigation calls before readiness', calls.length === 0, `got ${calls.length}`)
  check('the body is retained as pending', gate.__updateGateState().pending !== null)
}

console.log('\n§2 marking readiness flushes EXACTLY ONE navigation, parameters intact')
{
  const calls = harness()
  gate.routeToUpdateRequired({ minVersion: '1.2.0', storeUrl: 'https://apps.example/app' })
  gate.markUpdateNavigationReady()
  check('exactly one navigation', calls.length === 1, `got ${calls.length}`)
  check(
    'minVersion and storeUrl are preserved',
    calls[0]?.minVersion === '1.2.0' && calls[0]?.storeUrl === 'https://apps.example/app',
    JSON.stringify(calls[0]),
  )
  check('pending is cleared on the known-ready path', gate.__updateGateState().pending === null)
}

console.log('\n§3 a 426 AFTER readiness routes immediately')
{
  const calls = harness()
  gate.markUpdateNavigationReady()
  check('marking readiness with nothing pending navigates nothing', calls.length === 0)
  gate.routeToUpdateRequired({ minVersion: '2.0.0' })
  check('a later 426 navigates at once', calls.length === 1, `got ${calls.length}`)
  check('its parameters are preserved', calls[0]?.minVersion === '2.0.0')
}

console.log('\n§4 two pre-ready 426s → ONE navigation with the LATEST body')
{
  const calls = harness()
  gate.routeToUpdateRequired({ minVersion: '1.0.0' })
  gate.routeToUpdateRequired({ minVersion: '3.0.0', storeUrl: 'https://apps.example/newer' })
  gate.markUpdateNavigationReady()
  check('exactly one navigation', calls.length === 1, `got ${calls.length}`)
  check(
    'the LATEST requirement wins (an older minVersion is strictly staler)',
    calls[0]?.minVersion === '3.0.0' && calls[0]?.storeUrl === 'https://apps.example/newer',
    JSON.stringify(calls[0]),
  )
}

console.log('\n§5 repeated readiness calls never duplicate navigation')
{
  const calls = harness()
  gate.routeToUpdateRequired({ minVersion: '1.2.0' })
  gate.markUpdateNavigationReady()
  gate.markUpdateNavigationReady()
  gate.markUpdateNavigationReady()
  check('still exactly one navigation', calls.length === 1, `got ${calls.length}`)
}

console.log('\n§6 a null body still routes (with empty parameters)')
{
  const calls = harness()
  gate.routeToUpdateRequired(null)
  gate.markUpdateNavigationReady()
  check('a null body navigates once', calls.length === 1, `got ${calls.length}`)
  check(
    'missing parameters resolve to empty rather than undefined at the route',
    calls[0] !== undefined && calls[0].minVersion === undefined,
    JSON.stringify(calls[0]),
  )
}

gate.__resetUpdateGate()
try { unlinkSync(SHIM) } catch { /* already gone */ }

console.log(
  failures === 0
    ? `\nOK — update-gate readiness pins all pass.`
    : `\nFAILED — ${failures} check(s) failed.`,
)
process.exit(failures === 0 ? 0 : 1)
