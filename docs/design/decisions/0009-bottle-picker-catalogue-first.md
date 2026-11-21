# ADR 0009 — Every bottle is picked from the catalogue, inline in the form

**Status:** Accepted · 2026-11-21 · mobile (catalogue model change, build step 7).
**Context:** since the catalogue model change every new bottle is a catalogue
wine: picked (`productId` + optional `vintageId`) or created with the add
(`create`), never typed free text (`docs/dev/proposals/wine-catalog-model-change.md`
§ 0.2, § 7; README API table: session wines POST, `/api/checkins`, the two
catalogue searches). The app's Add / Edit Impression, Check In and the check-in
edit had free-text Name / Vintage / Producer / Type / Variety / Region / Country.
The web's `components/wine/CatalogPicker.tsx` is the behaviour reference, not
the UI. Every app caller is signed in (the tabs are guarded, no guest token
exists), so the app always offers creating; only the kill switch takes it away.

## Decisions (Simon, 2026-11-21, one interview)

- **Inline, search-first, in the form** (ADR-0008's precedent: a search in its
  own sheet was too much weight). Producer first (the server requires it: the
  wine search takes a `producerId`, for capacity), then that producer's wines,
  then the year. Each step opens right under the previous one; once chosen the
  steps fold into ONE summary (name + year, producer) with **Change**.
- **Bottle first**: the picker opens Add Impression and Check In; the photo,
  About, Process and the Purchase Link follow under it.
- **A wine that isn't there opens in place**: "+ New Producer …" / "+ New Wine
  …" open the new wine's fields right there (colour, Sparkling, year with NV,
  alcohol %, and under More: grapes, region, country). Saving the impression
  adds it to the catalogue in the same request.
- **Colour and Sparkling are two things** (Simon: "sparkling isnt really a
  type"): Red | White | Rosé are buttons in a row, Sparkling is a separate
  tick. A sparkling rosé is both; Sparkling alone (colour unknown) is valid.
  One of the two is required. **Alcohol-free is not a choice**: it follows from
  the alcohol % (≤ 0.5 %, spec § 0.2).
- **Ticks are inline tick chips**: Sparkling at the end of the colour row, NV
  right beside the year field. Ticking NV empties and disables the year and
  sends a real `year: null` (ruled 2026-07-26 for the web's checkbox). The ⓘ
  beside NV is an **info popover** (the `IntensityScaleInfo` shell): never call
  it a bubble (bubbles are sparkling).
- **The year of a picked wine is ONE field** (Simon's idea): a typed year the
  wine already has is that year; any other is added (the server's add-a-year
  branch links an existing exact year itself, never a fuzzy match). Empty =
  year unknown. The wine's known years are NOT shown. After typing, one line
  says what will happen: "2019 is in the catalogue." / "2019 is added on
  save." (NV: "Non-vintage is in the catalogue." / "Non-vintage is added on
  save."); nothing while empty. (Ruled after the review's proposals; the first
  draft read "is already listed." / "will be added.")
- **Alcohol % sits beside the year**, empty, number keyboard: on a new wine,
  and on a picked wine only while the typed year will be added (an existing
  entry is never edited from here, spec § 3).
- **Alcohol-free shows in the details only**: the impression's details carry
  an Alcohol row, "13.5 %", or "Alcohol-Free · 0.5 %" at 0.5 % or less (the
  value always shown). No tag on line-up rows or feed cards. Never on a bottle
  that is still hidden (the server sends no abv there).
- **Origin and variety are the catalogue's**: a picked wine's region, country
  and grapes are read from its entry (the details' Origin / Variety rows); they
  are set only while adding a new wine. The bottle keeps its own About,
  Process and Purchase Link (Add More Details).
- **The photo is its own call after the add**: if the bottle lands and the
  photo fails, the screen STAYS with the photo and Try Again; leaving keeps the
  bottle without it.
- **A refused save** (the heart: "Too many saves. Try again in …", or "This
  bottle isn't in the catalogue yet" in the release-day window before the
  conversion links every old bottle) shows the iPhone alert with the server's
  sentence and the heart springs back.
- **Switched off** (`CATALOG_PUBLIC_ENABLED=false`): the search answers with
  "Adding bottles is unavailable right now." right under the producer field.
  No check when the screen opens.

## Rules that follow

- 🔒 Nothing links until the person picks: never the top search hit.
- 🔒 A choice that may have landed (a 2xx, or a lost answer) is FROZEN: a retry
  re-sends the same `id` with the same choice, never an edited `create` (the
  web's `ChosenWine` rule).
- A post's save on someone else's post identifies the bottle by the row's key
  (`ratingId`), since a still-hidden bottle there carries no wine id (Moment
  Visibility step 1a).
