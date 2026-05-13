// Wine-type accent colors — single source of truth.
//
// Used by:
//   - Wine card / list-row accent stripe (full-opacity).
//   - Modal swatch + in-glass fill + image-placeholder gradient
//     (translucent — see `tcolAlpha` below).
//   - Anywhere else surfacing a wine's type at a glance.
//
// Five canonical wine types: red, white, spark (sparkling), rose, nonalc.

export const TCOL: Record<string, string> = {
  red:    '#B84040',
  white:  '#E6D296',
  spark:  '#F5E1AA',
  rose:   '#C86880',
  nonalc: '#D0A064',
}

// Wine-type icon emoji. Surfaces that need a quick glyph alongside the
// stripe color (e.g. blind-tasting placeholder, AddWineModal chip row).
export const ICO: Record<string, string> = {
  red:    '🍷',
  white:  '🥂',
  spark:  '🍾',
  rose:   '🌸',
  nonalc: '🌿',
}

// Human-readable type label (English). Used in the wine-info hero
// "varietal · TYPE" line and anywhere the type needs a word, not an
// icon.
export const TYPE_LABEL: Record<string, string> = {
  red:    'red',
  white:  'white',
  spark:  'sparkling',
  rose:   'rosé',
  nonalc: 'non-alcoholic',
}

// Returns a wine-type color at the given alpha. Used for in-glass fills
// and tinted backgrounds — the swatch / wine-list stripe use the raw
// hex value above instead.
//
// `Object.hasOwn` rather than `TCOL[type] || TCOL.red` so a prototype-
// chain lookup like `__proto__` returns the fallback red, not the
// inherited Object.prototype which has no `.replace` and would throw.
// Today `wine.type` is server-validated to a closed set, but defending
// here means the helper is safe even if validation ever loosens.
export function tcolAlpha(type: string, alpha: number): string {
  const hex = Object.hasOwn(TCOL, type) ? TCOL[type] : TCOL.red
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
