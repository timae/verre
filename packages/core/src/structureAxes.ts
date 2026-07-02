// Structure-wheel axis registry — the rated axes are STRUCTURE intensities
// (Sweet, Acidity, Body, Finish, Aroma, Flavour, Tannin, Bubbles…), not
// flavour descriptors. Lives in @verre/core so the native input surface shares
// one source of truth with web; pure data + pure functions only (no node:*,
// next, prisma, React, DOM — core's platform-purity rule). lib/flavours.ts
// re-exports from here (the dependency arrow points web → core, never back).
//
// See docs/dev/proposals/structure-wheel.md §3 (registry) + §1 (axis model).
//
// COLOUR IS DELIBERATELY ABSENT. Colour is presentation, and presentation is
// per-platform: web uses a fixed palette (lib/flavours.ts WEB_PALETTE), native
// resolves axis colour from the user's active THEME at render time. Baking a
// static hex into this neutral table would be wrong for both. Core owns only
// the platform-neutral truth — which axes exist, their labels, the input
// subtitle. Each platform joins its own colour onto `k`.

// One axis definition. `k` is the JSON key in ratings.flavors; `l` is the
// label; `sub` is an optional plain-language subtitle read ONLY by the rating
// INPUT chip (FlavorChips) — the wheel renderers ignore it, so adding it keeps
// "renderers untouched" literally true (proposal §6f / §10 #12). No colour
// here — see the module header.
export type StructureAxis = { k: string; l: string; sub?: string }

// Drink categories own their own complete axis set; `style` only refines within
// a category (proposal §1 — no universal axis set). Today only `wine` exists;
// future categories (coffee, cheese…) are one new entry each in WINE_AXES's
// sibling tables.
export type WineStyle = 'red' | 'white' | 'rose' | 'spark' | 'nonalc'

// The base wine set — every wine type (red/white/rose) gets exactly these, in
// this order. No per-type pruning: a low-tannin white sits at Tannin = None
// (valid data), it does not drop the axis (proposal §1, orange-wine rationale).
// `spark` appends Bubbles (see WINE_SPARK below). Order is presentational
// (wedge position) and locks once data ships (proposal §1 axis-order note).
//
// Aroma/Flavour carry plain-language subtitles on the INPUT chip only, to
// disambiguate "Aroma = smell" / "Flavour = taste" (proposal §6f / §10 #12).
const WINE_BASE: StructureAxis[] = [
  { k: 'sweet',   l: 'Sweet' }, // short label: 'Sweetness' (9ch) clipped at a side wheel cardinal past PolarChart's viewBox pad
  { k: 'acid',    l: 'Acidity' },
  { k: 'body',    l: 'Body' },
  { k: 'finish',  l: 'Finish' },
  { k: 'aroma',   l: 'Aroma',   sub: 'smell' },
  { k: 'flavour', l: 'Flavour', sub: 'taste' },
  { k: 'tannin',  l: 'Tannin' },
]

const WINE_SPARK: StructureAxis[] = [
  ...WINE_BASE,
  { k: 'bubbles', l: 'Bubbles' },
]

// Per-style registry. Frozen so a call site can't mutate a shared array.
// `nonalc` is a TRANSITIONAL style (being retired to a drink attribute in a
// separate proposal, §1/§1a) — mapped defensively to the base wine set so
// resolveAxes never breaks on a legacy nonalc row in the interim.
const WINE_AXES: Readonly<Record<WineStyle, readonly StructureAxis[]>> = Object.freeze({
  red:    Object.freeze(WINE_BASE),
  white:  Object.freeze(WINE_BASE),
  rose:   Object.freeze(WINE_BASE),
  spark:  Object.freeze(WINE_SPARK),
  nonalc: Object.freeze(WINE_BASE), // §1a defensive tolerance — disappears when nonalc-as-style is retired
})

// Resolve the full ordered axis set for a (category, style) pair. This is the
// INPUT set (all axes a taster can rate) — a READ surface filters it down to the
// keys actually present in a given rating via `perRatingAxes` (proposal §6d).
//
// Unknown category → wine (the only category today; defaults until others
// exist). Unknown/empty style → base wine set (defensive; covers the legacy
// nonalc style and any not-yet-seeded style without throwing).
export function resolveAxes(category: string | null | undefined, style: string | null | undefined): StructureAxis[] {
  const set = (style && (WINE_AXES as Record<string, readonly StructureAxis[]>)[style]) || WINE_BASE
  // category is reserved for future non-wine sets; only `wine` exists today.
  void category
  return set.map((a) => ({ ...a }))
}

// READ-surface axis array: the axes PRESENT in this rating's flavors map, in
// registry order, filtered from the full resolved set. Absent key → not in the
// array → not drawn (no spoke). Present-and-0 → in the array → drawn as a centre
// point. This is the §6d compute-only rule — no renderer change. `axes` is the
// full set from resolveAxes; `flavors` is the rating's stored map.
//
// Generic over the axis shape so it composes with a web-side colour join too —
// pass `StructureAxis[]` (neutral) or the web `FlItem[]` (colour already joined)
// and get the same shape back, filtered.
export function perRatingAxes<T extends { k: string }>(
  flavors: Record<string, number> | null | undefined,
  axes: T[],
): T[] {
  if (!flavors) return []
  return axes.filter((a) => Object.prototype.hasOwnProperty.call(flavors, a.k))
}

// INPUT-side zero-fill (structure-wheel §5, "the rest persist as explicit 0").
// The fill-track input shows EVERY axis of a style at once, so an untouched axis
// left at its resting position reads as "perceived None", not "not rated". This
// expands a sparse edit map to the full axis set:
//   • ALL axes None (map empty or every value 0) → {} (the empty-rating signal;
//     matches the server's validateFlavors drop-all-or-keep-all + the engagement
//     cascade that keys on flavors = '{}').
//   • ANY axis rated → every resolved axis is present, untouched ones as explicit
//     0. `perRatingAxes` then draws all axes (rated = wedge, None = centre point),
//     never an absent spoke — the "I tasted this, the others were absent" read.
// Only keys in the resolved set are emitted (a stray non-registry key is
// dropped — the migration's keep-set). Pure + shared web↔native; the server
// write boundary applies it too (lib/flavours.ts gateAndFillFlavors), so the
// stored shape is filled-or-empty by construction. Returns a fresh object.
export function fillFlavourZeros(
  flavors: Record<string, number> | null | undefined,
  category: string | null | undefined,
  style: string | null | undefined,
): Record<string, number> {
  const axes = resolveAxes(category, style)
  const src = flavors ?? {}
  let anyRated = false
  for (const a of axes) {
    if ((src[a.k] ?? 0) > 0) {
      anyRated = true
      break
    }
  }
  if (!anyRated) return {}
  const out: Record<string, number> = {}
  for (const a of axes) out[a.k] = src[a.k] ?? 0
  return out
}
