// Web flavour/structure-axis surface. The structure-wheel registry (which axes
// exist, their labels, the input subtitle) is the platform-neutral source of
// truth in @verre/core; this module re-exports it and joins the WEB palette on
// top — colour is per-platform presentation, web-only here, native resolves its
// own from theme (proposal §3a / §10 #14, docs/dev/proposals/structure-wheel.md).
//
// The legacy descriptor sets + dual-read detector were removed in the Contract PR
// (proposal §3 "Delete legacy" row, §8 rollout) once the data migration had run
// everywhere and prod was verified free of descriptor keys.

import {
  resolveAxes,
  perRatingAxes,
  fillFlavourZeros,
  type StructureAxis,
  type WineStyle,
} from '@verre/core'

export { resolveAxes, perRatingAxes, fillFlavourZeros }
export type { StructureAxis, WineStyle }

// Renderer-facing axis shape: the neutral core axis + a web colour. PolarChart /
// RadarChart / FlavorChips consume `FlItem[]` via their `fl` prop, so colour is
// REQUIRED here (vs `sub?` which is optional and input-chip-only). Produced by
// `withColours` below.
export type FlItem = StructureAxis & { c: string }

// ---------------------------------------------------------------------------
// Web palette — the colour values for the structure axes on web (k → hex).
// ⚠️ PROVISIONAL: the real per-axis palette is a deferred design dependency
// (Simon decides the VALUES when the build reaches it — proposal §10 #5). The
// four carried-over axes reuse their legacy FL hex so migrated rows render
// unchanged; the four net-new axes use placeholders so nothing renders
// colourless. These do NOT lock the palette.
const WEB_PALETTE: Record<string, string> = {
  sweet:   '#E880B8', // legacy FL
  acid:    '#60A8E0', // legacy FL
  body:    '#9870C0', // legacy FL
  tannin:  '#886048', // legacy FL
  finish:  '#B0A0C8', // provisional
  aroma:   '#E0A860', // provisional
  flavour: '#C05878', // provisional
  bubbles: '#88C8E0', // provisional
}

const FALLBACK_COLOUR = '#9870C0'

// Join the web palette onto a neutral core axis array, producing the colour-
// bearing FlItem[] the renderers consume. An axis with no palette entry gets a
// neutral fallback (never colourless). Composes with `perRatingAxes` either
// before or after — both take/return a {k,...} shape.
export function withColours(axes: StructureAxis[]): FlItem[] {
  return axes.map((a) => ({ ...a, c: WEB_PALETTE[a.k] ?? FALLBACK_COLOUR }))
}

// Convenience: the colour-bearing resolved set for a (category, style). Most web
// call sites want this directly.
export function resolveAxesColoured(category: string | null | undefined, style: string | null | undefined): FlItem[] {
  return withColours(resolveAxes(category, style))
}

// Server-side write-boundary normalisation — the registry gate (§6g) + the
// zero-fill (§5) in ONE chokepoint, applied by every flavour write route
// (session rate, checkins POST/PATCH) AFTER validateFlavors. Clients also
// normalise via fillFlavourZeros (nicer optimistic state + the native
// changed-diff), but the SERVER call is what makes the stored shape
// (filled-or-empty) an invariant for every writer — stale binaries, undo
// re-posts, raw API clients included.
//
// Key policy:
//   • Key in resolveAxes(category, style) → kept.
//   • Unknown key with value 0 → STRIPPED, not rejected. A zero off-registry
//     key is a fill artifact from a client that cached a different style
//     (host edited the wine's type mid-rating: {…, bubbles: 0} vs a
//     now-red wine) — no data is lost by dropping it, and rejecting would
//     400 an innocent race.
//   • Unknown key with a NON-ZERO value → 400 (`unknown flavor key`). Real
//     data under a key the registry doesn't know (a stale client posting a
//     descriptor key like oak/floral) must be rejected loudly, never
//     silently discarded — keeps the Contract PR's "no descriptor keys
//     remain" precondition true.
// The kept set is then zero-filled (fillFlavourZeros): any axis rated →
// every axis of the style stored, untouched as explicit 0; all-None → {}.
export function gateAndFillFlavors(
  flavors: Record<string, number> | null | undefined,
  category: string | null | undefined,
  style: string | null | undefined,
): { value: Record<string, number>; error?: undefined } | { value?: undefined; error: string } {
  const src = flavors ?? {}
  const allowed = new Set(resolveAxes(category, style).map(a => a.k))
  const kept: Record<string, number> = {}
  for (const [key, v] of Object.entries(src)) {
    if (allowed.has(key)) kept[key] = v
    else if (v !== 0) return { error: `unknown flavor key: ${key}` }
  }
  return { value: fillFlavourZeros(kept, category, style) }
}
