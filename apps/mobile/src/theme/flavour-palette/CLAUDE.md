# Flavour data-visualization palette

The full colour system for flavour data-viz — every attribute, every theme.
`palette.js` here is the tracked reference so any developer has the values (the
design working copy in `.local/design/flavour-palette.js` is gitignored). Pasted
by Simon 2026-07-01; re-vendor from that source, don't hand-tune here.

## What's here vs what's wired

`palette.js` is a superset. It carries colours the app does NOT use yet, on
purpose — so the values are captured once and re-vendored when each backend axis
set ships.

| Set | Keys | Wired today? |
|---|---|---|
| `structure` (wine subset) | sweet · acid · body · finish · aroma · flavour · tannin (+ bubbles on spark) | ✅ vendored → `../flavourColors.ts`, used by the native flavour input + wheel |
| `structure` (other-category keys) | Warmth · Bitterness · Umami · Saltyness · Funk | ❌ future categories (cheese/beer/spirits) — NOT extra wine axes |
| `aroma` (12 keys) | Fruity · Spice · Nut/Cocoa · Roasted · Woody · Sweet · Savory · Vegetal · Mineral · Chemical · Funky · Floral | ❌ later feature (aroma descriptor tree) |

The rated axes today are WINE only — 8 structure intensities. The registry lives
in `@verre/core` `structureAxes.ts` (`resolveAxes(category, style)`), carries NO
colour (colour is per-platform presentation), and reserves `category` for the
future non-wine sets. When a category or the aroma feature lands, add its axis
keys to the registry and vendor its colours from `palette.js` into a table
alongside `../flavourColors.ts`.

## The two files, and the rule

- **`palette.js`** (this folder) — the FULL data, all sets, all themes. Reference
  + source for future vendoring. Not imported by runtime code.
- **`../flavourColors.ts`** — the VENDORED runtime subset: the wine-8 axis colours
  keyed by the registry key (not the design label), plus `useFlavourColors()`,
  which resolves an axis's colour from the user's ACTIVE theme at render time
  (proposal §3a — native colour is theme-resolved, never a baked hex).

Registry-key → design-label mapping used when vendoring the wine subset:

| registry key | `palette.js` `structure` label |
|---|---|
| `sweet` | Sweetness |
| `acid` | Acidity |
| `body` | Body |
| `tannin` | Tannin |
| `finish` | Finish |
| `aroma` | Aroma |
| `flavour` | Flavour |
| `bubbles` | Bubbles |

⚠️ registry `sweet` → **Sweetness** (structure), NOT the aroma-set "Sweet". They
share a hex in most themes but are different attributes — don't cross-wire them.

## When you touch this

- Adding a category's axis set → expand the registry in `@verre/core`, then
  vendor that category's colours from `palette.js` into a runtime table (mirror
  `../flavourColors.ts`). Keep the label→key mapping explicit like the table
  above.
- Changing colour VALUES → change them in the design source
  (`.local/design/flavour-palette.js`), re-copy the whole block here, then
  re-vendor the affected keys into `../flavourColors.ts`. Never edit a colour in
  only one of the three places.
- The web app is deprecated / being redesigned; its palette
  (`lib/flavours.ts WEB_PALETTE`) is a separate concern derived from
  apricot (light) / charcoal (dark) — do NOT sync it from here casually.

Design source of truth for the app: `docs/design/` (ADRs + patterns) +
`apps/mobile/CLAUDE.md` (component catalog). This folder is the colour-data map.
