// Web flavour/structure-axis surface. The structure-wheel registry (which axes
// exist, their labels, the input subtitle) is the platform-neutral source of
// truth in @verre/core; this module re-exports it and joins the WEB palette on
// top — colour is per-platform presentation, web-only here, native resolves its
// own from theme (proposal §3a / §10 #14, docs/dev/proposals/structure-wheel.md).
//
// The legacy descriptor sets (FL_RED/WHITE/SPARK/ROSE/FL, getFL, detectFL) are
// STILL HERE on purpose — they back the Expand-window dual-read fallback
// (detectLegacyDescriptorFL below). They are deleted in the Contract PR (PR 2),
// after the data migration has run everywhere (proposal §3 "Delete legacy" row,
// §8 rollout). Do NOT delete them in the Expand PR.

import {
  resolveAxes,
  perRatingAxes,
  type StructureAxis,
  type WineStyle,
} from '@verre/core'

export { resolveAxes, perRatingAxes }
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

// ===========================================================================
// LEGACY (Contract-PR deletion) — descriptor sets + detectors. See module header.
// ===========================================================================

export const FL_RED: FlItem[] = [
  { k: 'dark_fruit', l: 'Dark Fruit',  c: '#9C27B0' },
  { k: 'red_fruit',  l: 'Red Fruit',   c: '#C0392B' },
  { k: 'earth',      l: 'Earth',       c: '#795548' },
  { k: 'spice',      l: 'Spice',       c: '#E67E22' },
  { k: 'oak',        l: 'Oak',         c: '#C08858' },
  { k: 'tannin',     l: 'Tannins',     c: '#886048' },
  { k: 'body',       l: 'Body',        c: '#9870C0' },
  { k: 'acid',       l: 'Acidity',     c: '#60A8E0' },
  { k: 'herbal',     l: 'Herbal',      c: '#58B070' },
  { k: 'floral',     l: 'Floral',      c: '#E8809A' },
]

export const FL_WHITE: FlItem[] = [
  { k: 'citrus',   l: 'Citrus',      c: '#E8C040' },
  { k: 'tropical', l: 'Tropical',    c: '#58C870' },
  { k: 'stone',    l: 'Stone Fruit', c: '#E89040' },
  { k: 'floral',   l: 'Floral',      c: '#E8809A' },
  { k: 'herbal',   l: 'Herbal',      c: '#58B070' },
  { k: 'mineral',  l: 'Mineral',     c: '#90A4AE' },
  { k: 'oak',      l: 'Oak',         c: '#C08858' },
  { k: 'body',     l: 'Body',        c: '#9870C0' },
  { k: 'acid',     l: 'Acidity',     c: '#60A8E0' },
  { k: 'sweet',    l: 'Sweet',       c: '#E880B8' },
]

export const FL_SPARK: FlItem[] = [
  { k: 'floral_herb',  l: 'Floral/Herb', c: '#8BC34A' },
  { k: 'citrus',       l: 'Citrus',      c: '#CDDC39' },
  { k: 'tree_fruit',   l: 'Tree Fruit',  c: '#FFC107' },
  { k: 'red_fruit',    l: 'Red Fruit',   c: '#E53935' },
  { k: 'dried_fruit',  l: 'Dried Fruit', c: '#8D6E63' },
  { k: 'earth',        l: 'Earth',       c: '#9E9E9E' },
  { k: 'creamy',       l: 'Creamy',      c: '#D7CCC8' },
  { k: 'oak',          l: 'Oak',         c: '#C08858' },
  { k: 'nutty',        l: 'Nutty/Toast', c: '#D4A017' },
  { k: 'acid',         l: 'Acidity',     c: '#60A8E0' },
]

export const FL_ROSE: FlItem[] = [
  { k: 'red_fruit', l: 'Red Fruit',   c: '#C0392B' },
  { k: 'citrus',    l: 'Citrus',      c: '#E8C040' },
  { k: 'floral',    l: 'Floral',      c: '#E8809A' },
  { k: 'stone',     l: 'Stone Fruit', c: '#E89040' },
  { k: 'herbal',    l: 'Herbal',      c: '#58B070' },
  { k: 'mineral',   l: 'Mineral',     c: '#90A4AE' },
  { k: 'body',      l: 'Body',        c: '#9870C0' },
  { k: 'acid',      l: 'Acidity',     c: '#60A8E0' },
  { k: 'sweet',     l: 'Sweet',       c: '#E880B8' },
  { k: 'tropical',  l: 'Tropical',    c: '#58C870' },
]

// Legacy generic FL (for old ratings & profile aggregation)
export const FL: FlItem[] = [
  { k: 'floral',   l: 'Floral',   c: '#E8809A' },
  { k: 'citrus',   l: 'Citrus',   c: '#E8C040' },
  { k: 'stone',    l: 'Stone',    c: '#E89040' },
  { k: 'tropical', l: 'Tropical', c: '#58C870' },
  { k: 'herbal',   l: 'Herbal',   c: '#58B070' },
  { k: 'oak',      l: 'Oak',      c: '#C08858' },
  { k: 'body',     l: 'Body',     c: '#9870C0' },
  { k: 'tannin',   l: 'Tannins',  c: '#886048' },
  { k: 'acid',     l: 'Acidity',  c: '#60A8E0' },
  { k: 'sweet',    l: 'Sweet',    c: '#E880B8' },
]

export type WineType = 'red' | 'white' | 'spark' | 'rose' | 'nonalc'

export function getFL(type: WineType | string): FlItem[] {
  if (type === 'red')   return FL_RED
  if (type === 'white') return FL_WHITE
  if (type === 'spark') return FL_SPARK
  if (type === 'rose')  return FL_ROSE
  return FL_WHITE
}

export function detectFL(flavors: Record<string, number>): FlItem[] {
  const keys = Object.keys(flavors)
  if (keys.includes('dark_fruit')) return FL_RED
  if (keys.includes('floral_herb') || keys.includes('tree_fruit')) return FL_SPARK
  if (keys.includes('mineral') && keys.includes('stone') && !keys.includes('dark_fruit')) {
    if (keys.includes('red_fruit')) return FL_ROSE
    return FL_WHITE
  }
  return FL
}

// The 16 descriptor keys with NO structure home (proposal §4 DUMP set). A row
// carrying ANY of these is historical descriptor data that must keep rendering
// as a legacy wheel during the Expand window — these keys are NOT in the
// structure registry, so perRatingAxes would silently drop them.
const DUMP_KEYS = new Set([
  'dark_fruit', 'red_fruit', 'dried_fruit', 'tree_fruit', 'tropical', 'stone',
  'citrus', 'floral', 'floral_herb', 'herbal', 'mineral', 'oak', 'earth',
  'spice', 'creamy', 'nutty',
])

// Expand-window legacy detector (proposal §8). Returns a legacy FlItem[] when the
// row is a real historical DESCRIPTOR rating (≥1 DUMP-set key present), else null
// so the caller falls through to the structure path:
//
//   detectLegacyDescriptorFL(row) ?? perRatingAxes(row, resolveAxes(cat, style))
//
// ⚠️ The primary rule is "≥1 KNOWN DUMP-set key", NOT detectFL's 4 sentinels.
// detectFL only checks dark_fruit / floral_herb / tree_fruit / mineral+stone, so
// a legacy row like {oak:3} or {floral:2,earth:4} has NO sentinel — under a
// sentinel-only test it would be misread as structure and its descriptor data
// would VANISH from the render. We gate on the full DUMP set, then reuse the
// sentinel logic ONLY to pick which legacy set (RED/WHITE/SPARK/ROSE) for label
// fidelity, falling back to generic FL.
//
// Unknown keys (neither structure-registry nor DUMP-set — malformed / future
// junk) are a SEPARATE policy: they are NOT legacy display data. This detector
// ignores them (returns null if no DUMP key is present); the write side rejects
// them (§6g). A pure-structure row (only sweet/acid/body/finish/aroma/flavour/
// tannin/bubbles) → null.
export function detectLegacyDescriptorFL(flavors: Record<string, number>): FlItem[] | null {
  for (const k of Object.keys(flavors)) {
    if (DUMP_KEYS.has(k)) return detectFL(flavors)
  }
  return null
}
