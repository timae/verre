// Hand-written types for palette.js (the verbatim design-palette paste) — the
// same pattern as ../vero-tokens.d.ts. The six literal theme keys keep the
// derived FLAVOUR_COLORS record compile-time exhaustive against ThemeKey, and
// the literal LABEL unions make a misspelled/removed label in a key→label map
// (../flavourColors.ts KEY_TO_LABEL) a type error instead of a silent
// undefined-at-runtime (this replaced the vendored copy's CI drift gate).
// Residual: the d.ts drifting from the .js paste — same accepted risk as
// vero-tokens; a re-paste that renames a label must update the union here,
// and the compiler then flags every stale consumer.
export type StructureLabel =
  | 'Flavour'
  | 'Spiciness'
  | 'Body'
  | 'Tannin'
  | 'Finish'
  | 'Sweetness'
  | 'Acidity'
  | 'Bitterness'
  | 'Umami'
  | 'Saltyness'
  | 'Bubbles'
  | 'Funk'
  | 'Aroma';

export type AromaLabel =
  | 'Fruity'
  | 'Spice'
  | 'Kernel'
  | 'Fire'
  | 'Woody'
  | 'Sweet'
  | 'Savory'
  | 'Vegetal'
  | 'Mineral'
  | 'Chemical'
  | 'Funky'
  | 'Floral';

export type FlavourPaletteTheme = {
  bg: string;
  structure: Record<StructureLabel, string>;
  aroma: Record<AromaLabel, string>;
};

export declare const FLAVOUR_PALETTE: Record<
  'apricot' | 'charcoal' | 'cobalt' | 'aubergine' | 'clay' | 'mauve',
  FlavourPaletteTheme
>;

export default FLAVOUR_PALETTE;
