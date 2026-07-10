// Per-theme (and per-family) strength of the family colour in aroma badge/
// row FILLS. The badges mix a share of family colour over `theme.surface`;
// on a near-neutral surface that reads as a clean pastel, but some palette
// values sit too close to their theme's surface tone and the badge fill
// disappears. Simon's per-theme device rulings (2026-07-10, gallery pass)
// live here; unlisted combos are 1:1 so device-ruled looks stay identical.
// Pure module (no react-native) so aroma-pickers-units.ts sweeps the REAL
// ratios.
//
// ⚠️ Ceiling on what any fill boost can do: a hue that matches the surface
// (clay Fruity #C77657 ≈ surface #c06b54) gains presence but not identity —
// distinct hues need a palette re-pick (the Apricot-Bubbles precedent).
const THEME_BOOST: Record<string, number> = { clay: 2.6 };
// Per-family overrides (multiplier on the base ratio; wins over THEME_BOOST).
// 'solid' = the fill IS the 100% family colour (clay Fruity — Simon).
const FAMILY_BOOST: Record<string, Record<string, number | 'solid'>> = {
  mauve: { sweet: 3.5, savory: 3.5 },
  clay: { fruity: 'solid', vegetal: 3.4, chemical: 3.4, mineral: 3.4, savory: 3.4, fire: 3.4 },
  charcoal: { floral: 2.8, fire: 2.2 },
  cobalt: { fire: 2.2, funky: 2.2, chemical: 'solid' },
  aubergine: { fire: 1.7, funky: 1.7, chemical: 1.7 },
};
// Cap keeps a boosted resting fill short of the pure family colour, so the
// full-colour Pronounced border still reads against it.
const BOOST_CAP = 0.75;

export function aromaFillRatio(themeKey: string, familyId: string, r: number): number {
  const f = FAMILY_BOOST[themeKey]?.[familyId] ?? THEME_BOOST[themeKey] ?? 1;
  if (f === 'solid') return 1;
  return f === 1 ? r : Math.min(BOOST_CAP, r * f);
}
