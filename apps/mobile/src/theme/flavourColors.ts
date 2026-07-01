// Per-theme flavour-axis colours — the structure-wheel palette, vendored.
// ─────────────────────────────────────────────────────────────────────────
// Colour is per-platform presentation: the @verre/core axis registry
// (structureAxes.ts) carries NO colour on purpose; native resolves an axis's
// colour from the user's ACTIVE THEME at render time (proposal §3a / §10 #14).
// This module is that native resolution — a (theme, axis key) → hex table plus
// a hook that reads the current theme.
//
// This file is the VENDORED runtime copy of the WINE subset (the 8 rated axes
// that exist today). The FULL data-viz palette (all 13 structure + 12 aroma keys
// × 6 themes) + the scope/mapping rules live in the tracked reference
// `./flavour-palette/` (`palette.js` + its CLAUDE.md); the gitignored design
// working copy is `.local/design/flavour-palette.js`. Re-vendor from there when
// values change or a new category's axes ship — do NOT hand-tune here. The full
// palette also holds colours for future categories (cheese/beer/spirits) and the
// later aroma feature; those are NOT vendored until their backend axis sets land.
//
// Registry-key → design-palette label the values were vendored from:
//   sweet → "Sweetness"  ·  acid → "Acidity"  ·  body → "Body"
//   tannin → "Tannin"    ·  finish → "Finish"  ·  aroma → "Aroma"
//   flavour → "Flavour"  ·  bubbles → "Bubbles"

import { useTheme, type ThemeKey } from '@/theme';

// The 8 wine axis keys carried today (structureAxes.ts WINE_BASE + Bubbles on
// spark). A record keeps every theme's table exhaustive — TypeScript flags a
// forgotten axis when a new theme is added or an axis renamed.
export type FlavourAxisKey =
  | 'sweet'
  | 'acid'
  | 'body'
  | 'tannin'
  | 'finish'
  | 'aroma'
  | 'flavour'
  | 'bubbles';

type AxisPalette = Record<FlavourAxisKey, string>;

// One 8-axis palette per theme. Values transcribed verbatim from
// `.local/design/flavour-palette.js` (the `structure` block of each theme,
// wine subset). Keyed by the same ThemeKey the theme provider uses.
export const FLAVOUR_COLORS: Record<ThemeKey, AxisPalette> = {
  apricot: {
    sweet: '#e0b85f', // Sweetness
    acid: '#cabb74', // Acidity
    body: '#a85f3e', // Body
    tannin: '#6B3C2A', // Tannin
    finish: '#b98a37', // Finish
    aroma: '#C6878F', // Aroma
    flavour: '#D9605C', // Flavour
    bubbles: '#f3d9b8', // Bubbles
  },
  charcoal: {
    sweet: '#dfa847',
    acid: '#9F9756',
    body: '#896343',
    tannin: '#5e3526',
    finish: '#ab7626',
    aroma: '#533a50',
    flavour: '#d96f45',
    bubbles: '#E8C9B0',
  },
  cobalt: {
    sweet: '#e0b85f',
    acid: '#cabb74',
    body: '#a85f3e',
    tannin: '#6B3C2A',
    finish: '#b98a37',
    aroma: '#C6878F',
    flavour: '#d98e5f',
    bubbles: '#80998a',
  },
  aubergine: {
    sweet: '#dba24f',
    acid: '#9aac82',
    body: '#b67847',
    tannin: '#7e4c29',
    finish: '#cbb077',
    aroma: '#a392cf',
    flavour: '#cf6f5a',
    bubbles: '#e5a196',
  },
  clay: {
    sweet: '#d8a83f',
    acid: '#aab39a',
    body: '#443340',
    tannin: '#6b3f2e',
    finish: '#d8b88c',
    aroma: '#e0a08f',
    flavour: '#C77657',
    bubbles: '#f8ecdb',
  },
  mauve: {
    sweet: '#e0b85f',
    acid: '#cabb74',
    body: '#a85f3e',
    tannin: '#6B3C2A',
    finish: '#b98a37',
    aroma: '#bb7d88',
    flavour: '#D9605C',
    bubbles: '#f3d9b8',
  },
};

// The active-theme axis-colour resolver. Returns a `(axisKey) => hex` reader
// bound to the user's current theme; an unknown key falls back to the theme
// accent so a wedge is never colourless. Consumed by the flavour input + the
// wheel wiring so both read one source.
export function useFlavourColors(): (key: string) => string {
  const { themeKey, theme } = useTheme();
  const palette = FLAVOUR_COLORS[themeKey];
  return (key: string) => palette[key as FlavourAxisKey] ?? theme.accent;
}
