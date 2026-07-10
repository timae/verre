// Per-theme flavour-axis colours — the structure-wheel palette, DERIVED.
// ─────────────────────────────────────────────────────────────────────────
// Colour is per-platform presentation: the @verre/core axis registry
// (structureAxes.ts) carries NO colour on purpose; native resolves an axis's
// colour from the user's ACTIVE THEME at render time (proposal §3a / §10 #14).
// This module is that native resolution — a (theme, axis key) → hex table plus
// a hook that reads the current theme.
//
// The hexes are NOT copied here: they're derived at module load from the
// tracked full palette (`./flavour-palette/palette.js` — all 13 structure +
// 12 aroma keys × 6 themes; typed via its sibling `palette.d.ts`, the same
// pattern as `vero-tokens.js`). Drift between the full palette and the runtime
// subset is impossible by construction — change a colour in palette.js (re-
// pasted from the design source `.local/design/flavour-palette.js`) and every
// consumer retints. The full palette also holds colours for future categories
// (cheese/beer/spirits) and the later aroma feature; wiring a new axis set =
// adding its keys to KEY_TO_LABEL's sibling table when the registry grows.
//
// Registry key → design-palette `structure` label (the design names attributes
// by label; the registry by key). ⚠️ registry `sweet` → structure "Sweetness",
// NOT the aroma-set "Sweet" — different attributes that share a hex in most
// themes; reading `structure` scoped below makes cross-wiring impossible.

import { FLAVOUR_PALETTE, type AromaLabel, type StructureLabel } from './flavour-palette/palette';
import { useTheme, type ThemeKey } from '@/theme';
import { AROMA_FAMILIES } from '@verre/core';

// The 9 wine axis keys carried today (structureAxes.ts WINE_BASE incl. Funk
// since Simon's 2026-07-09 ruling, + Bubbles on spark). A record keeps every
// theme's table exhaustive — TypeScript flags a forgotten axis when a new
// theme is added or an axis renamed.
export type FlavourAxisKey =
  | 'sweet'
  | 'acid'
  | 'body'
  | 'tannin'
  | 'finish'
  | 'aroma'
  | 'flavour'
  | 'funk'
  | 'bubbles';

type AxisPalette = Record<FlavourAxisKey, string>;

// StructureLabel-typed: a misspelled or since-removed design label here is a
// COMPILE error (palette.d.ts literal union), not a silent accent-fallback.
const KEY_TO_LABEL: Record<FlavourAxisKey, StructureLabel> = {
  sweet: 'Sweetness',
  acid: 'Acidity',
  body: 'Body',
  tannin: 'Tannin',
  finish: 'Finish',
  aroma: 'Aroma',
  flavour: 'Flavour',
  funk: 'Funk',
  bubbles: 'Bubbles',
};

function wineSubset(theme: keyof typeof FLAVOUR_PALETTE): AxisPalette {
  const structure = FLAVOUR_PALETTE[theme].structure;
  const out = {} as AxisPalette;
  for (const key of Object.keys(KEY_TO_LABEL) as FlavourAxisKey[]) out[key] = structure[KEY_TO_LABEL[key]];
  return out;
}

// Explicitly keyed (not Object.keys-derived) so BOTH exhaustiveness checks
// stay compile-time: a new ThemeKey errors this record; a theme missing from
// palette.js errors the wineSubset argument.
export const FLAVOUR_COLORS: Record<ThemeKey, AxisPalette> = {
  apricot: wineSubset('apricot'),
  charcoal: wineSubset('charcoal'),
  cobalt: wineSubset('cobalt'),
  aubergine: wineSubset('aubergine'),
  clay: wineSubset('clay'),
  mauve: wineSubset('mauve'),
};

// The active-theme axis-colour resolver. Returns a `(axisKey) => hex` reader
// bound to the user's current theme; an unknown key (or a label missing from
// palette.js) falls back to the theme accent so a wedge is never colourless.
// Consumed by the flavour input + the wheel wiring so both read one source.
export function useFlavourColors(): (key: string) => string {
  const { themeKey, theme } = useTheme();
  const palette = FLAVOUR_COLORS[themeKey];
  return (key: string) => palette[key as FlavourAxisKey] ?? theme.accent;
}

// ── Aroma family colours (the descriptor layer's tier-1 tint) ──
// Same derivation pattern as the wine subset, from the palette's `aroma`
// block (12 families, Kernel/Fire keys since the 2026-07-08 re-key). Keyed by
// the TAXONOMY family id (`fruity`, `kernel`, …): the taxonomy's family label
// IS the palette's aroma label (both sides authored to match), so the id→hex
// table is derived from @verre/core's AROMA_FAMILIES at module load — a
// taxonomy label the palette doesn't carry falls out as undefined and the
// hook's accent fallback covers it (visible, not a crash, same posture as
// useFlavourColors). Any node's colour = its FAMILY's colour, all tiers.
function aromaSubset(theme: keyof typeof FLAVOUR_PALETTE): Record<string, string> {
  const aroma = FLAVOUR_PALETTE[theme].aroma;
  const out: Record<string, string> = {};
  for (const family of AROMA_FAMILIES) out[family.id] = aroma[family.label as AromaLabel];
  return out;
}

export const AROMA_COLORS: Record<ThemeKey, Record<string, string>> = {
  apricot: aromaSubset('apricot'),
  charcoal: aromaSubset('charcoal'),
  cobalt: aromaSubset('cobalt'),
  aubergine: aromaSubset('aubergine'),
  clay: aromaSubset('clay'),
  mauve: aromaSubset('mauve'),
};

// Active-theme aroma-colour resolver: (family id) → hex. Callers resolve a
// selection's family via core's getAromaNode(sel.a).family.id.
export function useAromaColors(): (familyId: string) => string {
  const { themeKey, theme } = useTheme();
  const palette = AROMA_COLORS[themeKey];
  return (familyId: string) => palette[familyId] ?? theme.accent;
}

// ── Person-series colours (02d compare — ≤4 radar polygons, people dots) ──
// Simon's rulings (2026-07-02): person colours come from the SAME data-viz
// palette the 5+ wheel draws its wedges with — the theme's structure block, in
// its own canonical (declaration) order, never the mock's baked hexes and no
// bespoke reordering (an earlier hue-spread permutation was rejected on
// device: the radar lines must read as the same colour family as the wheel).
// Deliberately STRUCTURE-only: the aroma set re-uses the same hexes except
// `Chemical` — 13 distinct colours before wrap is plenty.
const PERSON_LABEL_ORDER: StructureLabel[] = [
  'Flavour',
  'Spiciness',
  'Body',
  'Tannin',
  'Finish',
  'Sweetness',
  'Acidity',
  'Bitterness',
  'Umami',
  'Saltyness',
  'Bubbles',
  'Funk',
  'Aroma',
];

function personRamp(theme: keyof typeof FLAVOUR_PALETTE): string[] {
  const structure = FLAVOUR_PALETTE[theme].structure;
  return PERSON_LABEL_ORDER.map((l) => structure[l]);
}

export const PERSON_SERIES: Record<ThemeKey, string[]> = {
  apricot: personRamp('apricot'),
  charcoal: personRamp('charcoal'),
  cobalt: personRamp('cobalt'),
  aubergine: personRamp('aubergine'),
  clay: personRamp('clay'),
  mauve: personRamp('mauve'),
};

// Active-theme person-colour resolver: stable index (roster order) → hex,
// wrapping past the ramp's end. Assign from the SESSION roster position, not
// the current selection, so a person keeps their colour when the selection
// changes.
export function usePersonColors(): (index: number) => string {
  const { themeKey } = useTheme();
  const ramp = PERSON_SERIES[themeKey];
  return (index: number) => ramp[((index % ramp.length) + ramp.length) % ramp.length];
}
