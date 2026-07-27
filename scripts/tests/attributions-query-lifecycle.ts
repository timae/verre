// ── Attributions query LIFECYCLE pins (real QueryObserver, real options) ────
//
// 🔒 THIS SUITE IMPORTS THE PRODUCTION OPTIONS. It must never restate them.
// An earlier version kept its own QUERY_OPTIONS copy, which meant restoring a
// flat staleTime in the screen alone would have left the suite green — it
// verified the copy, not the app. `attributionsQueryOptions` is the single
// source of truth shared with apps/mobile/src/app/attributions.tsx.
//
// It also drives a real QueryObserver rather than only fetchQuery, because the
// options under test are OBSERVER options: refetchOnMount / refetchOnWindowFocus
// are evaluated by the observer on mount and on focus events, and `fetchQuery`
// never consults them. That gap hid a real defect — with those options set to
// 'always', `shouldFetchOn` short-circuits on `value === "always"` BEFORE
// checking staleness (queryObserver.js), so a FRESH live result was re-fetched
// on every mount and every foreground.
//
// Run: npx tsx scripts/tests/attributions-query-lifecycle.ts

import Module from 'node:module'
import { writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { QueryClient, QueryObserver, focusManager, onlineManager } from '@tanstack/query-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The production options module imports the fetcher, which imports the RN-only
// apiFetch. Stub that one edge so the REAL options object can be imported
// unmodified; every test supplies its own queryFn, so the stub is never used.
const SHIM = join(root, 'scripts/tests/.apifetch-lifecycle-shim.cjs')
writeFileSync(SHIM, 'module.exports = { apiFetch: async () => { throw new Error("unused"); } };\n')
// Map the mobile tsconfig's `@/` alias (which does not resolve from the repo
// root) onto the real files, and point the RN-only apiFetch at the stub.
const M = Module as unknown as { _resolveFilename: (...a: unknown[]) => string }
const originalResolve = M._resolveFilename
M._resolveFilename = function (req: unknown, ...rest: unknown[]) {
  if (req === '@/lib/apiFetch') return SHIM
  if (typeof req === 'string' && req.startsWith('@/')) {
    return originalResolve.call(this, join(root, 'apps/mobile/src', req.slice(2)), ...rest)
  }
  return originalResolve.call(this, req, ...rest)
}
const nodeRequire = Module.createRequire(import.meta.url)

// 🔒 THE PRODUCTION OPTIONS, imported — not a copy.
const { attributionsQueryOptions } = nodeRequire(
  join(root, 'apps/mobile/src/lib/api/legalQuery.ts'),
) as { attributionsQueryOptions: Record<string, unknown> }

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
}

type Result = { entries: unknown[]; origin: 'live' | 'bundled' }
const BUNDLED: Result = { entries: [{ id: 'bundled' }], origin: 'bundled' }
const LIVE: Result = { entries: [{ id: 'live' }], origin: 'live' }

// Build observer options from the PRODUCTION object, swapping only the queryFn
// so each scenario can control what the "server" returns. Everything that
// governs refetch behaviour (staleTime, networkMode, refetch* flags) comes from
// production untouched.
// ⚠️ `client.mount()` IS REQUIRED for focus/online events to reach observers.
// QueryClient subscribes to focusManager/onlineManager only inside mount()
// (queryClient.js) — which is what QueryClientProvider does in the app. Without
// it, setFocused/setOnline notify nothing and the §2/§4 scenarios silently
// "fail" for a harness reason rather than a product one.
function mountedClient() {
  const client = new QueryClient()
  client.mount()
  return client
}

function opts(queryFn: () => Promise<Result>) {
  return { ...attributionsQueryOptions, queryFn } as never
}

// Mount an observer, wait for it to settle, then unmount — the real lifecycle
// the screen goes through when it is opened.
async function mountOnce(client: QueryClient, queryFn: () => Promise<Result>) {
  const observer = new QueryObserver<Result>(client, opts(queryFn))
  const unsub = observer.subscribe(() => {})
  await new Promise((r) => setTimeout(r, 20))
  unsub()
  observer.destroy()
  return observer.getCurrentResult().data as Result | undefined
}

async function run() {
  console.log('\n§1 a BUNDLED result recovers on the next observer MOUNT (no connectivity change)')
  {
    // 🔒 THE MOTIVATING SCENARIO. The device never goes offline, so
    // refetchOnReconnect can never fire — recovery must come from the bundled
    // result being stale.
    const client = mountedClient()
    let serverUp = false
    let calls = 0
    const queryFn = async () => { calls++; return serverUp ? LIVE : BUNDLED }

    const first = await mountOnce(client, queryFn)
    check('while the server is down the screen shows the bundled copy', first?.origin === 'bundled')

    serverUp = true
    const second = await mountOnce(client, queryFn)
    check(
      'remounting picks up LIVE data',
      second?.origin === 'live',
      `got origin=${second?.origin} after ${calls} fetches — the bundled result was treated as fresh.`,
    )
    client.unmount(); client.clear()
  }

  console.log('\n§2 a BUNDLED result recovers on FOREGROUND (focus) too')
  {
    const client = mountedClient()
    let serverUp = false
    const queryFn = async () => (serverUp ? LIVE : BUNDLED)
    const observer = new QueryObserver<Result>(client, opts(queryFn))
    const unsub = observer.subscribe(() => {})
    await new Promise((r) => setTimeout(r, 20))
    check('starts on the bundled copy', observer.getCurrentResult().data?.origin === 'bundled')

    serverUp = true
    focusManager.setFocused(false)
    focusManager.setFocused(true) // the app returns to the foreground
    await new Promise((r) => setTimeout(r, 30))
    check(
      'foregrounding refetches and lands on LIVE data',
      observer.getCurrentResult().data?.origin === 'live',
      `got origin=${observer.getCurrentResult().data?.origin}`,
    )
    unsub(); observer.destroy(); client.unmount(); client.clear()
    focusManager.setFocused(undefined)
  }

  console.log('\n§3 a FRESH LIVE result is NOT re-fetched on mount or foreground')
  {
    // ⚠️ This is what refetchOnMount/refetchOnWindowFocus: 'always' broke —
    // 'always' bypasses staleness entirely, so fresh legal text was re-fetched
    // on every screen open and every foreground.
    const client = mountedClient()
    let calls = 0
    const queryFn = async () => { calls++; return LIVE }

    await mountOnce(client, queryFn)
    check('the first mount fetches once', calls === 1, `calls=${calls}`)

    await mountOnce(client, queryFn)
    check('a REMOUNT does not refetch fresh live data', calls === 1, `calls=${calls}`)

    const observer = new QueryObserver<Result>(client, opts(queryFn))
    const unsub = observer.subscribe(() => {})
    await new Promise((r) => setTimeout(r, 20))
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await new Promise((r) => setTimeout(r, 30))
    check('FOREGROUNDING does not refetch fresh live data', calls === 1, `calls=${calls}`)
    unsub(); observer.destroy(); client.unmount(); client.clear()
    focusManager.setFocused(undefined)
  }

  console.log('\n§4 offline→online STILL refetches (refetchOnReconnect must survive)')
  {
    const client = mountedClient()
    let serverUp = false
    let calls = 0
    const queryFn = async () => { calls++; return serverUp ? LIVE : BUNDLED }
    const observer = new QueryObserver<Result>(client, opts(queryFn))
    const unsub = observer.subscribe(() => {})
    await new Promise((r) => setTimeout(r, 20))
    const before = calls

    serverUp = true
    onlineManager.setOnline(false)
    onlineManager.setOnline(true) // a real connectivity transition
    await new Promise((r) => setTimeout(r, 30))
    check(
      'reconnecting triggers a refetch',
      calls > before && observer.getCurrentResult().data?.origin === 'live',
      `calls ${before}→${calls}, origin=${observer.getCurrentResult().data?.origin}`,
    )
    unsub(); observer.destroy(); client.unmount(); client.clear()
    onlineManager.setOnline(true)
  }

  console.log('\n§5 the production options do not use the freshness-bypassing values')
  {
    // A direct assertion on the imported object, so the intent is pinned even
    // if a future refactor changes how the observer is exercised above.
    const o = attributionsQueryOptions as Record<string, unknown>
    check(
      "refetchOnMount is not 'always'",
      o.refetchOnMount !== 'always',
      "'always' short-circuits before the staleness check (queryObserver.js shouldFetchOn).",
    )
    check("refetchOnWindowFocus is not 'always'", o.refetchOnWindowFocus !== 'always')
    check("networkMode is 'always'", o.networkMode === 'always')
    check("refetchOnReconnect is 'always'", o.refetchOnReconnect === 'always')
    check('staleTime is a function (data-dependent)', typeof o.staleTime === 'function')
  }

  try { unlinkSync(SHIM) } catch { /* already gone */ }
  console.log(
    failures === 0
      ? `\nOK — attributions query lifecycle pins all pass.`
      : `\nFAILED — ${failures} check(s) failed.`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

void run()
