// Locale-STABLE integer grouping for values rendered in SSR'd components.
//
// `n.toLocaleString()` with no locale uses the runtime's default locale, which
// differs between the Node server (often en-US → "1,305") and the user's
// browser (e.g. de-CH → "1'305" or de-DE → "1.305"). In a server-rendered +
// hydrated component that produces a React hydration mismatch. Pinning the
// locale to 'en-US' makes server and client agree deterministically.
//
// Use this for any number shown in a component that renders on the server
// (every 'use client' component still SSRs its first paint). Don't reach for
// raw toLocaleString() on such values.
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}
