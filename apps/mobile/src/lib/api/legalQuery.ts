import { fetchAttributions, type AttributionsResult } from '@/lib/api/legal';

// ── The PRODUCTION query options for the attributions surface ──────────────
//
// 🔒 SINGLE SOURCE OF TRUTH. The screen passes this object straight to
// useQuery, and scripts/tests/attributions-query-lifecycle.ts IMPORTS it rather
// than restating it. A test that keeps its own copy of the options proves only
// that the copy behaves — restoring a flat staleTime in the screen alone would
// leave such a suite green. Do not inline these back into the screen.
//
// Each option below is load-bearing:
//
// • staleTime is DATA-DEPENDENT. `fetchAttributions` never throws, so TanStack
//   sees a 500 or a timeout as a SUCCESSFUL result carrying the bundled
//   snapshot. Under a flat one-hour staleTime that fallback was cached as FRESH
//   for an hour, and refetchOnReconnect only fires on a real offline→online
//   edge — so a transient server error while the device stayed online pinned
//   the stale copy with no recovery path. Bundled ⇒ 0 (always stale, so the
//   next mount or foreground retries); live ⇒ one hour (real data, no reason to
//   re-fetch legal text on every screen open).
//
// • networkMode 'always' — TanStack defaults to 'online' and lib/query.tsx
//   wires NetInfo into onlineManager, so by default the query is PAUSED while
//   offline and the fetcher never runs to return its fallback: the screen would
//   spin forever in exactly the case the fallback exists to serve.
//
// • refetchOnReconnect 'always' — networkMode 'always' disables the default
//   reconnect refetch, so this restores it. 'always' rather than `true` because
//   it must fire even when the cached value is a fresh LIVE result.
//
// ⚠️ refetchOnMount / refetchOnWindowFocus are DELIBERATELY OMITTED, and must
// not be set to 'always'. In queryObserver.js `shouldFetchOn` short-circuits on
// `value === "always"` BEFORE consulting staleness, so 'always' bypasses
// freshness entirely and re-fetches a fresh live result on every mount and
// every foreground. The defaults (`true`) already refetch when the data is
// stale — which, thanks to staleTime above, is precisely when the cached value
// is the bundled fallback. That is the whole recovery mechanism; 'always' would
// make it indiscriminate instead of targeted.
export const attributionsQueryOptions = {
  queryKey: ['legal-attributions'] as const,
  queryFn: fetchAttributions,
  staleTime: (query: { state: { data?: AttributionsResult } }) =>
    query.state.data?.origin === 'live' ? 60 * 60 * 1000 : 0,
  networkMode: 'always' as const,
  refetchOnReconnect: 'always' as const,
};
