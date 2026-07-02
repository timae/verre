# ADR 0005 — Compare (02d) interaction model: in-screen tab, rail-only selection, person-row detail

**Status:** Accepted · 2026-07-02 · mobile (web Compare stays frozen until the
redesign).

## Context

The 02d build surfaced a cluster of interaction decisions the mockups left
open or that Simon ruled differently on seeing the first build: how the
Compare tab relates to the line-up, which people-selector variant ships
(02d·3 A vs 02d·4 B), what tapping a person row does, and how the consensus
teaser is computed and worded. All ruled by Simon on 2026-07-02, across the
build-review rounds. The full behaviour spec with formulas lives in
`docs/dev/proposals/structure-wheel.md` §7 — this ADR records the decisions
and their why; don't restate §7 here.

## Decision

- **Compare is an IN-SCREEN tab swap, not a route.** Everything above the tab
  strip (plain bar or cover hero, incl. the photo) stays identical; only the
  content below the tabs swaps. No back-to-line-up affordance exists. The Add
  pill and the reveal strip are line-up furniture and hide on Compare.
- **People-selector = 02d·4 variant B, the avatar rail**, adapted from the
  mock's subset-selection to **hide/unhide semantics**, and it is the ONLY
  select/deselect surface. Selected chips wear the accent active state,
  deselected dim; the All chip TOGGLES select-all/deselect-all (deselecting
  one person drops All, the rest stay). The rail is sticky under the title
  bar exactly like the reveal strip (they share the hero's overlay slot —
  strip is line-up-only, rail compare-only) and fades softly at its left clip
  edge. The lead chip opens the "Compare who?" picker sheet (Everyone / Just
  me / Me + friends presets — friends = mutual follows via
  `GET /api/me/friends`). Variant A (pill + sheet) and direction C rejected.
- **Deselected people vanish from the cards entirely** — rows, charts,
  Show-all sheet — and the card header (group ★ + consensus) and the ranking
  recompute over the selection (the mock's selAccItem semantics).
- **Person rows are per-person DETAIL views, not toggles**: tapping a name
  swaps the card's chart to that person's flavour wheel (no score under the
  wheel — it already shows on their row; an empty wheel renders when they
  lack structure detail so the card height stays put). Axis drill-in and
  person detail are mutually exclusive.
- **Cards are multi-open and all collapsed by default.** Opening a card never
  closes or moves another; closing is a deliberate tap; content unfolds
  downward from a fixed card top.
- **Chart mode keys on the STRUCTURE-ENGAGED taster count** (1 profile →
  that person's wheel + "Structure detail from NAME only." hint · 2–4 →
  overlaid radar · 5+ → C1b), never on the score headcount — a "group" chart
  must never be drawn from one person's data. With 1–4 profiles the
  structure-givers sort to the top of the score list so the dot colours pair
  with the polygons.
- **Consensus vocabulary**: In harmony · Mostly agreed · Mixed feelings ·
  **Polarizing** — computed from the blended disagreement score (§7: 0.6
  score-gap + 0.4 structure-gap, gaps = 2×MAD). A consensus is a GROUP
  signal: one rated score → no line at all (no score-word substitute). The
  compare row is producer-only (no type/variety). A "camps" overlay (tight
  majority + small dissent, e.g. "Odd one out") was discussed and PARKED.

## Consequences

- The rail's hidden set is screen state: it survives tab switches, resets on
  leaving the session, and is pruned against the live roster (kicked raters
  can't ghost-dim the All chip). Card open/detail state resets on a tab swap
  (unmount) — flagged, not ruled.
- Person-series colours derive from the theme palette's structure ramp in
  hue-spread order (`usePersonColors()`), assigned by roster position —
  best-effort stable until selection identity gets a durable home in the
  follow-up selector work.
- Charts scale uniformly to the measured card width (the design's
  `.radar { max-width:100% }`); axis labels carry oversized invisible hit
  targets on both group charts.
