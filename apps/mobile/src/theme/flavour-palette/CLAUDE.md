# Flavour data-visualization palette

The full colour system for flavour data-viz — every attribute, every theme.
`palette.js` here is the tracked reference AND the runtime source (the design
working copy in `.local/design/flavour-palette.js` is gitignored). Pasted by
Simon 2026-07-01; re-paste from that source, don't hand-tune here.

## What's here vs what's wired

`palette.js` is a superset. It carries colours the app does NOT use yet, on
purpose — so the values are captured once and each future axis set just derives
its subset when it ships.

| Set | Keys | Wired today? |
|---|---|---|
| `structure` (wine subset) | sweet · acid · body · finish · aroma · flavour · tannin (+ bubbles on spark) | ✅ derived at load by `../flavourColors.ts` (imports this file), used by the native flavour input + wheel |
| `structure` (other-category keys) | Warmth · Bitterness · Umami · Saltyness · Funk | ❌ future categories (cheese/beer/spirits) — NOT extra wine axes |
| `aroma` (12 keys) | Fruity · Spice · Kernel · Fire · Woody · Sweet · Savory · Vegetal · Mineral · Chemical · Funky · Floral | ❌ not wired to a screen yet — keys match the taxonomy tier-1 family labels (`@verre/core` `aroma/taxonomy.json`; re-keyed Nut/Cocoa→Kernel, Roasted→Fire with the design source, Simon 2026-07-08) |

The rated axes today are WINE only — 8 structure intensities. The registry lives
in `@verre/core` `structureAxes.ts` (`resolveAxes(category, style)`), carries NO
colour (colour is per-platform presentation), and reserves `category` for the
future non-wine sets. When a category or the aroma feature lands, add its axis
keys to the registry and a key→label map beside `../flavourColors.ts`
`KEY_TO_LABEL` — the colours derive from here, no copying.

## The three files, and the rule

- **`palette.js`** (this folder) — the FULL data, all sets, all themes. A
  verbatim paste of the design source; **the only tracked place a hex lives**.
- **`palette.d.ts`** — hand-written types for the paste (six literal theme keys
  + literal LABEL unions per set), the same pattern as `../vero-tokens.d.ts`.
  The label unions make a misspelled/removed label in a key→label map a compile
  error; a re-paste that renames a label must update the union here too.
- **`../flavourColors.ts`** — NO hexes: derives the wine-8 runtime subset from
  `palette.js` at module load via its `KEY_TO_LABEL` map, plus
  `useFlavourColors()`, which resolves an axis's colour from the user's ACTIVE
  theme at render time (proposal §3a — native colour is theme-resolved, never a
  baked hex). Drift between palette and runtime is impossible by construction —
  there is no second copy to drift. (An earlier draft hand-vendored the subset
  and policed it with a CI gate; the direct import replaced both.)

Registry-key → design-label mapping (`KEY_TO_LABEL` in `../flavourColors.ts` is
the code counterpart — keep them in lockstep):

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
share a hex in most themes but are different attributes — the derivation reads
each theme's `structure` block only, so cross-wiring can't happen silently.

## When you touch this

- Adding a category's axis set → expand the registry in `@verre/core`, then add
  that category's key→label map beside `KEY_TO_LABEL` in `../flavourColors.ts`.
  Keep the mapping explicit like the table above.
- Changing colour VALUES → change them in the design source
  (`.local/design/flavour-palette.js`), re-paste the whole block here. Done —
  the runtime derives from this file; there is no third copy to update.
- The web app is deprecated / being redesigned; its palette
  (`lib/flavours.ts WEB_PALETTE`) is a separate concern derived from
  apricot (light) / charcoal (dark) — do NOT sync it from here casually.

Design source of truth for the app: `docs/design/` (ADRs + patterns) +
`apps/mobile/CLAUDE.md` (component catalog). This folder is the colour-data map.
