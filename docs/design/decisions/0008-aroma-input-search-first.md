# ADR 0008 — Aroma input is search-first with a four-picker browse sheet

**Status:** Accepted · 2026-07-10 · mobile (PR #77, `feature/aroma-input`).
**Context:** the aroma descriptor layer (`docs/dev/proposals/aroma/aroma-layer.md`)
needed its native input on the impression screen. The Vero handoff explored
many picker variants (`.local/Vero handoff files.zip` → `vero-aroma-input.js`);
Simon ruled the handoff is a VISUAL reference only — taxonomy/tech semantics
come from `@verre/core` and the proposal. Implementation lives in
`apps/mobile/src/components/scoring/aroma/` (see the catalog entry in
`apps/mobile/CLAUDE.md`).

## Decisions (Simon, 2026-07-10 — one interactive design session, ~15 rounds)

- **Variant: 02e·11 "search-first"** (the handoff's S variant). An inline
  Aromas section on the impression screen: selected chips → [browse button |
  search field] → suggestions. No separate screen, no input sheet — search
  is inline; a dedicated search SHEET was built and rejected as "too much
  added weight".
- **The browse sheet ships ALL FOUR picker variants** (Map H3 / Rings W4 /
  Rail D / Canvas H2) behind a segmented control — deliberately, for
  on-device feel-testing; one gets ruled after device time. The tab switcher
  IS the deliverable, not exploration scaffolding. (Rail shipped first;
  Rings/Map/Canvas follow on the same branch.)
- **Add flow**: tapping a suggestion FOCUSES it (deep family tint); a stable
  refine row below the results — fixed-width (108pt) modifier dropdown
  (Compare-toolbar select anatomy: centered label wears the pick, chevron
  pinned right, accent fill when set) + glyph-only Pronounced toggle chip +
  a fixed two-line-height "Add <aroma>" button. Nothing pops in/out or
  resizes while searching; an exact already-added match greys the button to
  "Added" (no Update semantics). One-tap instant add was tried and rejected
  (killed the modifier step).
- **Pronounced** (the `p` flag): word is **"Pronounced"** — never "leading
  note" in copy; explanations may say "stands out". Its mark is the
  **double-chevron glyph** (`Icon name="pronounced"`, reusable) on CONTROLS,
  and a **family-ink border** on chips — chips never carry the glyph or any
  tick. Set via the toggle or double-tap on a chip/result (tap/double
  discriminator; popup opens on a ~280ms delayed single so the double
  survives). Explainer ⓘ panel names when to use it ("when an aroma clearly
  stands out from the rest").
- **Chip anatomy**: every aroma badge is family-tinted fill (palette `aroma`
  block via `useAromaColors`), NO dots, NO ticks, NO border except
  pronounced; words read "Aroma, modifier" ("Strawberry, jammy") with the
  modifier in a lighter weight; labels sentence-case. Compact height
  (4.5pt vertical padding + transparent 1.5 border for layout stability).
- **Chip order (display-only)**: pronounced first, then family clusters in
  taxonomy order, insertion within a family — matches the specced
  read-surface grouping. The stored array keeps insertion order. Rule-driven
  movement on add is fine; eviction hacks ("newest stays visible") are not.
- **Add feedback**: light-impact haptic + an accent-veil LIGHT-UP on the
  landed chip (motion tokens); when the ordering files the add into the
  "+N more" overflow, the pill flashes instead. A cap-rejected add gives a
  warning haptic + "Limit reached" hint (a rejection message, not a counter
  — the spec bans a live counter).
- **Refine on chips**: tap → anchored popup (AnchoredMenu shell, ~280pt,
  placed by the chip) with modifier badges + Pronounced; × on the chip
  removes. The bottom "Your Aromas" sheet exists ONLY for the "+N more"
  overflow (cap-aware sizing past ~12 selections).
- **Keyboard**: focusing the search field scrolls the block the MINIMAL
  shift above the keyboard (real keyboard height + surface-math block size);
  a spacer below the section guarantees scroll range. The OS inset alone
  only bottom-aligns the field.
- **Search behaviour**: the app-wide forgiving-search ruling applies (fuzzy
  lives in core `searchAromas` so web inherits it); results are transient
  picker state — added/pronounced marks never show there, only focus tint +
  pending-pronounced border during the add process.
- Copy: section hint is "What do you perceive? Add any aromas you find."
  ("perceive", not "smell" — people mix up smell/taste with aromatics).

## Rejected along the way

Search-in-a-sheet (weight); one-tap instant add (lost modifiers); label+
switch Pronounced (too wide); word-only short synonyms for Pronounced
("Key"/"Lead"/"Bold" — not clear enough); glyph inside chips; ticks/dots on
badges; "Update" button semantics; newest-visible chip eviction.

## Addendum — armed search result keeps its colours (Simon, 2026-07-12)

Supersedes the "focus tint" line above for the search results: the ARMED
(focused) result no longer flips to the solid family fill — it keeps its
RESTING colours (fill + readableSolid words), and the armed signal is every
OTHER result MUTING (the rail's faint tint) while a pick is armed. This is
the pickers' contextual focus vocabulary (hexStage: armed cell unchanged,
siblings pale) applied to chips — normal state, armed state, and the read
surfaces all share one badge colouring; nothing self-mutates. The
pending-Pronounced border preview on the armed result is unchanged.

Explored and rejected for the armed state along the way (dev-gallery rounds,
same day): the solid flip (jarring, and invisible on 'solid'-bumped
families), a deeper 0.45 tint (no headroom on FAMILY_BOOST-bumped families),
an ink pull into the fill (hue-muddying — "ugly colors"), bold words (too
subtle at 13.5pt), ink-coloured words (family words read better). A leading
round-mark dot (ListPicker's armed vocabulary) remains in the dev gallery as
an optional composable, not shipped. The gallery keeps three comparison
modes (Ruled / old Solid / Map) under the "Aroma badges" section.
