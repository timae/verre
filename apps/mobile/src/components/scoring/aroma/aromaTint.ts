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
// The resting ratio a 'solid' family should map to exactly 1.0 (the standard
// chip/badge resting site). Sub-resting requests (a muted 0.09 rail chip)
// then scale PROPORTIONALLY below solid instead of also snapping to 1.0 —
// otherwise a muted clay-Fruity chip rendered at full armed strength with
// sub-3:1 words, indistinguishable from its selected sibling (review finding).
const SOLID_RESTING = 0.2;

export function aromaFillRatio(themeKey: string, familyId: string, r: number): number {
  const f = FAMILY_BOOST[themeKey]?.[familyId] ?? THEME_BOOST[themeKey] ?? 1;
  // 'solid': resting site → 1.0; a smaller r (muted) scales down from there.
  // Not capped — solid is the point — but a muted request stays below solid.
  if (f === 'solid') return Math.min(1, r / SOLID_RESTING);
  return f === 1 ? r : Math.min(BOOST_CAP, r * f);
}

// ARMED (solid-fill) intensity. The 100% palette colour is the ceiling any
// FILL boost can reach — where even that reads weak against the theme
// (Simon's gallery pass, 2026-07-12: clay ALL, cobalt chemical+vegetal,
// mauve sweet+savory), the ARMED fill pulls toward theme.ink, the
// max-contrast direction on light AND dark themes (darkens on clay,
// lightens on cobalt). Armed/focused state ONLY — never resting fills, and
// never the resting 'solid' bumps: the delta is what lets armed read as
// armed on families whose resting fill is already solid.
const ARMED_BOOST: Record<string, number | Record<string, number>> = {
  clay: 0.2,
  cobalt: { chemical: 0.2, vegetal: 0.2 },
  mauve: { sweet: 0.2, savory: 0.2 },
};

// Share of theme.ink to mix INTO the armed solid fill (0 = the plain
// 100% family colour). Caller mixes: mix(familyColor, theme.ink, ratio).
export function aromaArmedInk(themeKey: string, familyId: string): number {
  const t = ARMED_BOOST[themeKey];
  if (t == null) return 0;
  return typeof t === 'number' ? t : (t[familyId] ?? 0);
}

// ⚠️ REJECTED (Simon, 2026-07-12): an ink pull on the DEEPER-TINT armed
// fill (a DEEP_ARMED_INK table mirroring ARMED_BOOST) — mixing toward the
// theme ink mutates the hue and "changes to ugly colors". The deep-armed
// delta on FAMILY_BOOST-bumped families (whose resting fill already sits at
// BOOST_CAP / 'solid', leaving no tint headroom) is instead carried by
// CONTEXT: siblings MUTE while a pick is armed — the hexStage focus
// treatment Simon device-ruled for the pickers. Don't reintroduce ink/hue
// mutation on tinted fills.
