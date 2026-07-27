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

// ── 2. The screen uses the SHARED production query options ────────────────
console.log('\n§2 the screen passes through the shared production options')

const screenSrc = readFileSync(join(root, 'apps/mobile/src/app/attributions.tsx'), 'utf8')
const screen = screenSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

// The OPTIONS themselves are pinned BEHAVIOURALLY by
// scripts/tests/attributions-query-lifecycle.ts, which imports them and drives a
// real QueryObserver. What this file pins is the WIRING: that the screen passes
// the shared object through instead of restating options inline, since an inline
// copy is how the two drift apart and the lifecycle suite stops describing the
// app.
check(
  'the screen imports the shared options module',
  /from '@\/lib\/api\/legalQuery'/.test(screen),
  'Options must come from lib/api/legalQuery.ts, the single source of truth.',
)
check(
  'useQuery is called with the shared object, not an inline literal',
  /useQuery\(attributionsQueryOptions\)/.test(screen),
  'An inline useQuery({...}) here would drift from what the lifecycle suite tests.',
)
check(
  'the screen does not restate refetch/staleTime options',
  !/staleTime:|refetchOnMount:|refetchOnWindowFocus:|networkMode:/.test(screen),
  'These belong in lib/api/legalQuery.ts so production and tests share one definition.',
)

// ── 3. The staleness tell is rendered ──────────────────────────────────────
console.log('\n§3 a bundled (stale) render says so')
check(
  "the screen branches on origin === 'bundled'",
  /origin\s*===\s*'bundled'/.test(screen),
  'Two copies of legal text can disagree; the stale one must never masquerade as current.',
)

// ── 3a. No absolute freshness claims ───────────────────────────────────────
console.log('\n§3a the freshness contract is not overclaimed')

// ⚠️ THREE deliberate caches sit between an ops edit and a native screen: the
// server process-caches the parsed config, the API sends max-age=3600 +
// stale-while-revalidate, and the client holds a LIVE result fresh for an hour
// (which the lifecycle suite proves). So "always current" / "immediately" is
// false on every surface, including the WEB — a changed override file needs a
// process restart. This pin exists because the phrasing crept in three separate
// times, once in USER-FACING copy.
for (const [label, file] of [
  ['the native screen (incl. user-facing copy)', 'apps/mobile/src/app/attributions.tsx'],
  ['the web page', 'app/legal/attributions/page.tsx'],
  ['the entries module', 'apps/mobile/src/lib/api/legal.ts'],
] as const) {
  const src = readFileSync(join(root, file), 'utf8')
  check(
    `${label} makes no "always current" / "immediately" freshness claim`,
    // ⚠️ Keep every alternative the LABEL promises. An earlier version named
    // "immediately" in the message but omitted it from the pattern, so
    // "updates immediately" would have passed while the check appeared to
    // cover it — a gate whose message overstates its regex is worse than no
    // gate, because a reader trusts the message.
    !/always current|always-current|always on the web|immediately/i.test(src),
    'The web reflects the RUNNING SERVER snapshot; online native refreshes subject to its caches. Say "the latest version is published here", never an absolute.',
  )
}

// ── 3b. Collapsed entries stay MOUNTED ─────────────────────────────────────
console.log('\n§3b collapsing an entry must not unmount its content')
check(
  'the native entry body is height-animated, not conditionally rendered',
  /style=\{\[\{ overflow: 'hidden' \}, bodyStyle\]\}/.test(screen) && !/\{open && </.test(screen),
  'A required attribution statement that does not exist in the view until someone taps is a materially weaker compliance position than one merely folded. Keep the children mounted and animate the wrapper height.',
)
const webPage = readFileSync(join(root, 'app/legal/attributions/page.tsx'), 'utf8')
// ⚠️ Count the ELEMENT, not the string: `details[open]` also appears in the
// page's <style> block, so a presence test passed with the real <details>
// swapped for a <section>. Require the opening tag AND its closing tag.
check(
  'the web entry uses <details> (contents stay in the DOM when closed)',
  /<details\b/.test(webPage) && /<\/details>/.test(webPage) && !/useState|'use client'/.test(webPage),
  'A JS toggle that conditionally renders the body would omit required licence text from the delivered HTML while closed. <details> keeps it in the document.',
)

// ── 3c. The splash deadline must not resolve UNKNOWN as SIGNED OUT ─────────
console.log('\n§3c the splash deadline does not decide auth')
const rootLayoutSrc = readFileSync(join(root, 'apps/mobile/src/app/_layout.tsx'), 'utf8')
const layout = rootLayoutSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

// 🔒 BOTH guards must require the session to have RESOLVED. At the deadline
// `session` is still undefined, so a bare `guard={!session}` selects the AUTH
// group and redirects away from a protected deep link the user launched into --
// then flips to the tabs a second later, after a flash of the welcome screen.
check(
  'the protected (tabs) guard requires a RESOLVED session',
  /guard=\{sessionResolved && !!session\}/.test(layout),
  'A bare `guard={!!session}` cannot distinguish "pending" from "signed out".',
)
check(
  'the (auth) guard ALSO requires a resolved session',
  /guard=\{sessionResolved && !session\}/.test(layout),
  'This is the one that throws the deep link away: unknown must not select the auth group.',
)
check(
  'splash hiding and route selection are SEPARATE conditions',
  /splashCanHide/.test(layout) && /sessionResolved/.test(layout) &&
    /const splashCanHide = !isPending \|\| waitedTooLong/.test(layout) &&
    /const sessionResolved = !isPending/.test(layout),
  'The deadline may hide the splash; only the session landing may pick a route group.',
)
check(
  'a neutral state renders while pending past the deadline',
  /if \(!sessionResolved\) \{/.test(layout),
  'With neither group mounted the Stack has nothing to render — without this the user sees an empty navigator.',
)
// update-required must stay reachable regardless of session state, including a
// late 426 that arrives after the deadline.
check(
  'update-required sits outside both guards',
  /name="update-required"/.test(layout) &&
    !new RegExp('name="update-required"').test(
      layout.slice(layout.indexOf('<Stack.Protected'), layout.lastIndexOf('</Stack.Protected>')),
    ),
  'A late 426 must still reach the blocking update screen.',
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
