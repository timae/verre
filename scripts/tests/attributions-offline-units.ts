// ── Attributions offline/reconnect pins ────────────────────────────────────
//
// Pins the two behaviours that make the legal surface work without a network.
// Both were REAL defects caught in review, not hypotheticals:
//
//  1. `fetchAttributions` must RESOLVE (never throw, never return empty) for
//     every failure mode, so the screen can always render something. A legal
//     surface that renders blank breaches the licences it exists to satisfy.
//
//  2. The query must be configured to RUN WHILE OFFLINE and to REFETCH ON
//     RECONNECT. TanStack defaults to networkMode:'online' and lib/query.tsx
//     wires NetInfo into onlineManager — so by default the query is PAUSED
//     offline and `fetchAttributions` never runs to return its fallback: the
//     screen sits on a spinner in exactly the case the fallback exists for.
//     And because networkMode:'always' DISABLES the default reconnect refetch,
//     `refetchOnReconnect:'always'` is required alongside it — the literal
//     'always' rather than `true`, since a bundled result is fresh for an hour
//     and `true` would honour staleTime and skip the refetch.
//
// Pin 2 is asserted against the SCREEN SOURCE rather than by booting RN: the
// options are the whole behaviour, and a source assertion is what fails when
// someone "simplifies" them away. Run: npx tsx scripts/tests/attributions-offline-units.ts

import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The module under test imports '@/lib/apiFetch' — an alias defined by the
// MOBILE tsconfig, which does not resolve from the repo root. Map it to a stub
// so the REAL legal.ts can be imported completely unmodified. `apiFetch` is the
// only thing it pulls in, and every test case drives it directly.
type ApiFetchStub = (path: string) => Promise<unknown>
let apiFetchStub: ApiFetchStub = async () => { throw new Error('no stub installed') }
const nodeRequire = Module.createRequire(import.meta.url)
const originalResolve = (Module as unknown as { _resolveFilename: (...a: unknown[]) => string })._resolveFilename
const APIFETCH_SHIM = join(root, 'scripts/tests/.apifetch-shim.cjs')
require('node:fs').writeFileSync(
  APIFETCH_SHIM,
  'module.exports = { apiFetch: (...a) => globalThis.__vrApiFetch(...a) };\n',
)
;(Module as unknown as { _resolveFilename: (...a: unknown[]) => string })._resolveFilename = function (req: unknown, ...rest: unknown[]) {
  if (req === '@/lib/apiFetch') return APIFETCH_SHIM
  return originalResolve.call(this, req, ...rest)
}
;(globalThis as Record<string, unknown>).__vrApiFetch = (...a: unknown[]) => apiFetchStub(...(a as [string]))

const { fetchAttributions, BUNDLED_ATTRIBUTIONS } = nodeRequire(
  join(root, 'apps/mobile/src/lib/api/legal.ts'),
) as {
  fetchAttributions: () => Promise<{ entries: unknown[]; origin: string }>
  BUNDLED_ATTRIBUTIONS: unknown[]
}
let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
}

// ── 1. The fetcher always resolves ─────────────────────────────────────────
// Exercise the REAL module against each failure mode by stubbing apiFetch.
const legalPath = join(root, 'apps/mobile/src/lib/api/legal.ts')
const legalSrc = readFileSync(legalPath, 'utf8')

console.log('\n§1 fetchAttributions resolves for every failure mode')

// Drive the REAL module. tsx resolves the `@/` alias and strips the types, so
// the file is imported as written — no source rewriting, no reconstruction (a
// hand-rewritten copy masking a real bug is a known trap in this repo).
// `apiFetch` is stubbed by intercepting global fetch, which is what apiFetch
// itself calls, so the module under test is entirely unmodified.
const withFetch = async (stub: ApiFetchStub) => {
  apiFetchStub = stub
  return fetchAttributions()
}

const cases: Array<[string, (path: string) => Promise<unknown>]> = [
  ['network throws (offline)', async () => { throw new Error('Network request failed') }],
  ['non-ok status', async () => ({ ok: false, status: 500, json: async () => ({}) })],
  ['malformed body (no entries)', async () => ({ ok: true, status: 200, json: async () => ({}) })],
  ['empty entries array', async () => ({ ok: true, status: 200, json: async () => ({ entries: [] }) })],
  ['entry missing required field', async () => ({ ok: true, status: 200, json: async () => ({ entries: [{ source: 'X' }] }) })],
  ['json() itself throws', async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })],
]

async function main() {
for (const [label, stub] of cases) {
  try {
    const res = await withFetch(stub)
    check(
      `${label} → resolves to the bundled snapshot`,
      res.origin === 'bundled' && res.entries.length === BUNDLED_ATTRIBUTIONS.length && res.entries.length > 0,
      `got origin=${res.origin} entries=${res.entries.length}`,
    )
  } catch (err) {
    check(`${label} → resolves to the bundled snapshot`, false, `THREW: ${(err as Error).message}`)
  }
}

// A well-formed live response must be reported as live, or the staleness
// notice would show permanently and the fallback would be indistinguishable.
try {
  const res = await withFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ entries: BUNDLED_ATTRIBUTIONS }),
  }))
  check('well-formed response → origin is "live"', res.origin === 'live', `got origin=${res.origin}`)
} catch (err) {
  check('well-formed response → origin is "live"', false, `THREW: ${(err as Error).message}`)
}

// ── 2. The query is configured to run offline and refetch on reconnect ─────
console.log('\n§2 the attributions query survives offline and refreshes on reconnect')

const screenSrc = readFileSync(join(root, 'apps/mobile/src/app/attributions.tsx'), 'utf8')

// ⚠️ ASSERT AGAINST THE useQuery CALL, NOT THE FILE. Both option names also
// appear in the explanatory comments above the call, so a file-wide regex
// passes even when the real option is deleted — the "a mention is not a call
// site" failure the vintage wiring gate documents. Strip comments, then look
// only inside the useQuery({...}) argument.
const screen = screenSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const qStart = screen.indexOf('useQuery({')
const useQueryArg = qStart === -1 ? '' : screen.slice(qStart, screen.indexOf('});', qStart))

check(
  "networkMode: 'always' is set",
  /networkMode:\s*'always'/.test(useQueryArg),
  "Without it TanStack pauses the query while offline (lib/query.tsx wires NetInfo into onlineManager), so the bundled fallback never renders and the screen spins forever.",
)
check(
  "refetchOnReconnect: 'always' is set",
  /refetchOnReconnect:\s*'always'/.test(useQueryArg),
  "networkMode:'always' disables the default reconnect refetch. The literal 'always' is required — `true` honours staleTime, and a bundled result is fresh for an hour, so the screen would tell the user to reconnect and then not refetch when they did.",
)

// ── 3. The staleness tell is rendered ──────────────────────────────────────
console.log('\n§3 a bundled (stale) render says so')
check(
  "the screen branches on origin === 'bundled'",
  /origin\s*===\s*'bundled'/.test(screen),
  'Two copies of legal text can disagree; the stale one must never masquerade as current.',
)

// ── 4. The legal routes sit OUTSIDE the auth guard ─────────────────────────
console.log('\n§4 the legal screens are reachable signed-out')
const rootLayout = readFileSync(join(root, 'apps/mobile/src/app/_layout.tsx'), 'utf8')
const guardedRegion = rootLayout.slice(
  rootLayout.indexOf('<Stack.Protected'),
  rootLayout.lastIndexOf('</Stack.Protected>'),
)
for (const name of ['about', 'attributions']) {
  check(
    `"${name}" is NOT inside a <Stack.Protected> guard`,
    !new RegExp(`name="${name}"`).test(guardedRegion) && new RegExp(`name="${name}"`).test(rootLayout),
    'The attributions are a licence obligation and must render before an account exists.',
  )
}

console.log(
  failures === 0
    ? `\nOK — attributions offline/reconnect pins all pass.`
    : `\nFAILED — ${failures} check(s) failed.`,
)
// Clean up the resolver shim so it never lingers as an untracked artifact.
try { require('node:fs').unlinkSync(APIFETCH_SHIM) } catch { /* already gone */ }

process.exit(failures === 0 ? 0 : 1)
}

void main()
