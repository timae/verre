// Full flavour data-visualization palette — every attribute, every theme.
// ─────────────────────────────────────────────────────────────────────────
// The COMPLETE colour system for flavour data-viz (wheels, fill-track inputs,
// chips). Broader than what the app wires TODAY on purpose — it carries colours
// for attributes that land with future categories and the aroma feature, so the
// values are captured once; each axis set derives its subset when it ships
// (../flavourColors.ts imports this file — the wine-8 subset today).
//
// Pasted by Simon (2026-07-01). Mirrors `.local/design/flavour-palette.js` (the
// gitignored design working copy); THIS committed file is the tracked reference
// a developer discovers via the sibling CLAUDE.md. See that CLAUDE.md for the
// scope rules (what's live vs future) and the registry-key → label mapping.
//
// Two attribute sets per theme:
//   • structure (13): Flavour · Warmth · Body · Tannin · Finish · Sweetness ·
//     Acidity · Bitterness · Umami · Saltyness · Bubbles · Funk · Aroma
//       — WINE uses 8 of these today (see CLAUDE.md); the other 5 (Warmth,
//         Bitterness, Umami, Saltyness, Funk) belong to future categories
//         (cheese/beer/spirits), NOT extra wine axes.
//   • aroma (12): Fruity · Spice · Nut/Cocoa · Roasted · Woody · Sweet · Savory
//     · Vegetal · Mineral · Chemical · Funky · Floral
//       — a LATER feature (the aroma descriptor tree); not wired anywhere yet.
//
// Grounds are each theme's `bg`. Colours are authored to read on that ground
// with the theme's `rule` guides.

export const FLAVOUR_PALETTE = {
  apricot: {
    bg: '#f6ecde',
    structure: {
      Flavour: '#D9605C',
      Warmth: '#BF4E30',
      Body: '#a85f3e',
      Tannin: '#6B3C2A',
      Finish: '#b98a37',
      Sweetness: '#e0b85f',
      Acidity: '#cabb74',
      Bitterness: '#646F58',
      Umami: '#80998a',
      Saltyness: '#587784',
      Bubbles: '#f3d9b8',
      Funk: '#726E97',
      Aroma: '#C6878F',
    },
    aroma: {
      Fruity: '#D9605C',
      Spice: '#BF4E30',
      'Nut/Cocoa': '#a85f3e',
      Roasted: '#6B3C2A',
      Woody: '#b98a37',
      Sweet: '#e0b85f',
      Savory: '#cabb74',
      Vegetal: '#646F58',
      Mineral: '#587784',
      Chemical: '#29303D',
      Funky: '#726E97',
      Floral: '#C6878F',
    },
  },

  charcoal: {
    bg: '#1a1815',
    structure: {
      Flavour: '#d96f45',
      Warmth: '#a8472c',
      Body: '#896343',
      Tannin: '#5e3526',
      Finish: '#ab7626',
      Sweetness: '#dfa847',
      Acidity: '#9F9756',
      Bitterness: '#67724a',
      Umami: '#3c4f59',
      Saltyness: '#8a9da5',
      Bubbles: '#E8C9B0',
      Funk: '#6f607e',
      Aroma: '#533a50',
    },
    aroma: {
      Fruity: '#d96f45',
      Spice: '#a8472c',
      'Nut/Cocoa': '#896343',
      Roasted: '#5e3526',
      Woody: '#ab7626',
      Sweet: '#dfa847',
      Savory: '#9F9756',
      Vegetal: '#67724a',
      Mineral: '#8a9da5',
      Chemical: '#3c4f59',
      Funky: '#6f607e',
      Floral: '#533a50',
    },
  },

  cobalt: {
    bg: '#122142',
    structure: {
      Flavour: '#d98e5f',
      Warmth: '#BF4E30',
      Body: '#a85f3e',
      Tannin: '#6B3C2A',
      Finish: '#b98a37',
      Sweetness: '#e0b85f',
      Acidity: '#cabb74',
      Bitterness: '#646F58',
      Umami: '#395f5a',
      Saltyness: '#587784',
      Bubbles: '#80998a',
      Funk: '#555177',
      Aroma: '#C6878F',
    },
    aroma: {
      Fruity: '#d98e5f',
      Spice: '#BF4E30',
      'Nut/Cocoa': '#a85f3e',
      Roasted: '#6B3C2A',
      Woody: '#b98a37',
      Sweet: '#e0b85f',
      Savory: '#cabb74',
      Vegetal: '#646F58',
      Mineral: '#587784',
      Chemical: '#29303D',
      Funky: '#555177',
      Floral: '#C6878F',
    },
  },

  aubergine: {
    bg: '#2b1530',
    structure: {
      Flavour: '#cf6f5a',
      Warmth: '#a44a4c',
      Body: '#b67847',
      Tannin: '#7e4c29',
      Finish: '#cbb077',
      Sweetness: '#dba24f',
      Acidity: '#9aac82',
      Bitterness: '#557068',
      Umami: '#34527e',
      Saltyness: '#6a90a4',
      Bubbles: '#e5a196',
      Funk: '#5a4a83',
      Aroma: '#a392cf',
    },
    aroma: {
      Fruity: '#cf6f5a',
      Spice: '#a44a4c',
      'Nut/Cocoa': '#b67847',
      Roasted: '#7e4c29',
      Woody: '#cbb077',
      Sweet: '#dba24f',
      Savory: '#9aac82',
      Vegetal: '#557068',
      Mineral: '#6a90a4',
      Chemical: '#34527e',
      Funky: '#5a4a83',
      Floral: '#a392cf',
    },
  },

  clay: {
    bg: '#b35a45',
    structure: {
      Flavour: '#C77657',
      Warmth: '#a84838',
      Body: '#443340',
      Tannin: '#6b3f2e',
      Finish: '#d8b88c',
      Sweetness: '#d8a83f',
      Acidity: '#aab39a',
      Bitterness: '#65715a',
      Umami: '#8898a7',
      Saltyness: '#c0cbd3',
      Bubbles: '#f8ecdb',
      Funk: '#b793a5',
      Aroma: '#e0a08f',
    },
    aroma: {
      Fruity: '#C77657',
      Spice: '#a84838',
      'Nut/Cocoa': '#d8b88c',
      Roasted: '#443340',
      Woody: '#d8a868',
      Sweet: '#d8a83f',
      Savory: '#aab39a',
      Vegetal: '#65715a',
      Mineral: '#8898a7',
      Chemical: '#326B86',
      Funky: '#b793a5',
      Floral: '#e0a08f',
    },
  },

  mauve: {
    bg: '#c8a8a3',
    structure: {
      Flavour: '#D9605C',
      Warmth: '#BF4E30',
      Body: '#a85f3e',
      Tannin: '#6B3C2A',
      Finish: '#b98a37',
      Sweetness: '#e0b85f',
      Acidity: '#cabb74',
      Bitterness: '#646F58',
      Umami: '#587784',
      Saltyness: '#80998a',
      Bubbles: '#f3d9b8',
      Funk: '#726E97',
      Aroma: '#bb7d88',
    },
    aroma: {
      Fruity: '#D9605C',
      Spice: '#BF4E30',
      'Nut/Cocoa': '#a85f3e',
      Roasted: '#6B3C2A',
      Woody: '#b98a37',
      Sweet: '#e0b85f',
      Savory: '#cabb74',
      Vegetal: '#646F58',
      Mineral: '#587784',
      Chemical: '#29303D',
      Funky: '#726E97',
      Floral: '#bb7d88',
    },
  },
};

export default FLAVOUR_PALETTE;
