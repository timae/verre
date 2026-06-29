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
  structureSubset,
  type StructureAxis,
  type WineStyle,
} from '@verre/core'

export { resolveAxes, perRatingAxes, structureSubset }
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

// Write-side registry gate (§6g). Returns an error string if `flavors` carries
// any key NOT in resolveAxes(category, style) — used at every write boundary so
// only structure keys can land. This is what keeps descriptor keys from being
// resurrected after the migration: a stale client POSTing a descriptor key
// (oak/floral/…) is rejected 400 rather than written back. Returns null when
// every key is valid (incl. an empty/absent map).
//
// (Historical: during the Expand window reads stayed tolerant of legacy
// descriptor rows while writes did not — the asymmetry that motivated the
// EDIT-PATH rule, §6g. Now that the migration has run, no descriptor rows
// remain; the gate just keeps writes registry-keyed. structureSubset() is the
// client-side edit-path transform.)
export function assertRegistryKeyed(
  flavors: Record<string, number> | null | undefined,
  category: string | null | undefined,
  style: string | null | undefined,
): string | null {
  if (!flavors) return null
  const allowed = new Set(resolveAxes(category, style).map(a => a.k))
  for (const key of Object.keys(flavors)) {
    if (!allowed.has(key)) return `unknown flavor key: ${key}`
  }
  return null
}

// structureSubset (the client-side EDIT-PATH transform, §6g) lives in @verre/core
// — it's pure and shared with the native edit surface — and is re-exported above.
