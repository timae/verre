# ADR 0010 — One search field for the bottle picker

**Status:** Accepted · 2026-11-21 · mobile (catalogue model change, build step 7b).
**Supersedes:** ADR-0009's "producer first" (the first step of the picker). Everything
else in ADR-0009 stands (the year as one field, a wine that isn't there opening in
place, colour + Sparkling, NV, alcohol %, the freeze rule, the refusals).
**Context:** the producer-first picker searched producer names only, and the whole
query was one trigram bag where no word was required: "christoph pichler" listed 20
producers named Christoph… and no Pichler; "pichler kellerberg" tied Rheinberg
Kellerei with Pichler-Krutzler (step 7b findings, dev DB with the full catalogue).
People type what is on the label, in any order: the producer, the wine, the region,
the year. Server side: `GET …/catalog/search?kind=bottle` (README; `lib/catalogSearch.ts`
`searchBottles`).

## Decisions (Simon, 2026-11-21: rulings 1 to 9, then the build)

- **One field**, label "Wine", placeholder "Search wines" (the catalogue is wines;
  the not-only-wines rule covers line-up, impression and blind copy). It takes the
  producer, the wine's name, its region and a year, in any order.
- **Every typed word must match** (in the producer, the wine's name or its region),
  the last word as the start of a word, small typos forgiven. Words like "Weingut",
  "Domaine", "Château" are optional: typed, they lift the producer that has them;
  not typed, they are not needed. Nothing fits → an empty list with "Add Wine to
  Catalogue".
- **One row per wine**: the wine's name, its producer under it, and the typed year
  at the end of the row when one was typed. A tap picks the wine.
- **The typed year is carried**: a wine that lacks it still shows; picking it fills
  the year field with that year, and the line under it says what will happen
  ("2019 is in the catalogue." / "2019 is added on save.", ADR-0009). Never another
  year in its place. A wine whose own name holds the number ("Cuvée 2000") carries
  no year. "NV" typed in the field is only a hint for the order, never the NV tick.
- **"Add Wine to Catalogue"** (ruled 2026-11-21: not "+ New Wine") appears only
  after the search has answered for exactly what is typed (never while it is still
  waiting, after a failure or "Too many searches"); it opens the producer field
  (the same every-word search), then that producer's wines ("Add Wine “name”" for
  one that isn't listed), then the new wine's fields (ADR-0009). The producer field
  starts EMPTY (the one field's text mixes producer and wine words, and every word
  must match); "Back to Search" returns to the one field.
- **"Add Producer “name”"** (ruled 2026-11-21) appears only when the producer search
  found nothing, or when none of the producers it found has exactly the typed name
  (as the catalogue compares names: accents, case and "ß" / "ss" aside, decided by
  the server): a new "Marx" stays addable while "Weingut Marx" exists, but typing
  "Weingut Marx" (or "Weingut Strass" for "Weingut Straß") offers only the listed
  one.
- **While the next answer is awaited**, the previous rows stay on screen but dimmed
  and not tappable (no jumping list, never a stale pick).
- **The lines under the field**: "More wines match. Type more to narrow the list."
  when the server stopped early; "Too many words. Try a shorter search." over 16
  words or 200 characters (refused, never cut); the refusals of ADR-0009 ("Too many
  searches. Wait a moment.", "Adding bottles is unavailable right now.").
- **Edit ("Change")** uses the same picker. On a bottle hidden from the editor
  (Blind for Everyone), picking a wine with a typed year it lacks would add a year,
  which the server refuses ("Reveal this bottle before you add a new wine for it.",
  `CREATE_HIDDEN`), as a typed year always was.
- **App only**: the web keeps producer → wine → year (its producer field gets the
  every-word rule, its screens do not change).

## Rules that follow

- 🔒 Nothing links until the person taps a row: never the top hit.
- 🔒 Each search field's state is `lib/bottleSearch.ts`: a request generation, not
  the text, decides which answer is current; "Add Wine to Catalogue" and "Add
  Producer" only after a successful answer for it.

## Addendum 2026-11-22 (Simon, first look on the phone)

- **Back steps through the picker first.** Once "Add Wine to Catalogue", "Add
  Producer" or "Add Wine" was tapped, or a wine picked, the screen's back (the
  bar's arrow, the edge swipe, Android's back) goes one step back inside the
  picker: a new wine's fields → that producer's wines (for a new producer: the
  producer search) → the producer search → the one search field with its text;
  a picked wine → the list again; an edit's search → the bottle as it was. Only
  from the first step does back leave the page. ("i cannot navigate back as soon
  as i clicked add wine or add producer.")
- **NV and Sparkling have no check glyph.** They stay toggles of their own
  (ADR-0009), drawn like every other choice chip: on = the fill. ("why is there
  a tick in front of NV and Sparkling? that is not how it works.")
- **A vintage year ends at the current year** (it was next year): a vintage is
  the harvest year.- **Exact first, then wider** (Simon: "we are looking most confident first and then
  widen up?"). Wines holding the words as typed come first. When they are fewer than
  five, the search also tries typo fixes for the words it took as real ("picher" is
  the start of "Picherie": La Picherie first, then the Pichlers), and among typo
  fixes the more common correction comes first.
- **Close matches from three words** ("if there is a word or two too much"): when no
  wine holds every word and three or more real words were typed (fillers like
  "Weingut" don't count), the wines holding all but one are shown under the line
  "No wine has every word. These come closest." ("pichler kellerberg magnum": the
  Kellerberg wines). Two words stay strict: "christoph pichler" still finds nothing.- **The catalogue's alcohol shows beside the year, not editable** ("just show it there
  where the fill is. it is just not an editable field."): a picked wine shows its
  alcohol in the Alcohol % slot as a read-only field: a typed year's own value, and
  nothing when that year has none (the wine's figure is one number for every year, so
  it never stands in for a year's: "why does it fall back to 13%?"); the wine's while
  no year is typed. Only a year that is added gets the editable field. An entry's
  missing alcohol is not filled from here.- **The form waits for the bottle** ("the add photo should only show when an impression is
  selected"): on Add Impression and Check In the photo and the bottle's own fields appear
  once a bottle is chosen (picked, or a new one being added), and the fields (Process,
  Description, Purchase Link) are plain, no "Add More Details" fold.
- **Add rows look like the line-up's Add Impression**: "Add Wine to Catalogue", "Add
  Producer “…”" and "Add Wine “…”" are the same dashed full-width row (`DashedAddRow`).
- **Sparkling is a switch of its own** under the colours ("it is not clear, that it is
  settable in combination with the colours"): "Sparkling", "With any colour, or on its
  own."
- **The same wine twice is asked, not refused** ("we should at least warn about it"):
  saving the same wine in the same year (or both without a year) as a bottle already in
  the line-up asks "Already in the Line-Up" with Add Again / Cancel; another year of the
  wine (a vertical) doesn't ask. Only bottles the person can see count, so a hidden blind
  bottle never triggers it.
- **"Add Wine to Catalogue" is real pages** ("that swipe back and back button behave
  differently is bad UX"; built 2026-11-22, supersedes the step-back above): Producer →
  the producer's wines (titled with its name) → New Wine with "Use" in the bar, pushed on
  the screen's own stack, so the arrow and the swipe go back alike, one page at a time. A
  wine tapped on its producer's page comes back to the form picked, its year set there; a
  new wine comes back folded ("New wine", Edit reopens it, Remove drops it). Codex
  weighed a sheet with its own stack (one component, no route files) and recommended the
  pages: the sheet's stack breaks on Android and would make the picker its own navigator.- **Picking a wine opens its details on a screen of their own** ("when clicking on a wine
  you get to the screen where you can edit the year, add photo, process, description etc.
  why is this not a new screen? back just goes onto the line up screen again."): Add
  Impression and Check In open on the search; a pick (there, on a producer's wines page,
  or "Use" on New Wine) pushes the details screen on top (the bottle fixed at the top,
  its year and alcohol, the photo, Brought By, "Add More Details", Save). Back goes one
  page at a time (details → that page → … → the search); Save leaves the whole flow back
  to the line-up. Editing keeps its form first: Change opens the search as a page and a
  pick comes back with its year. The "Add More Details" fold is back ("i think we put the
  process / description / purchace links behind the details thingy again"), which
  reverses the plain fields above.- **The photo field has no line under "Add Photo"** on Add Impression, Check In and the
  check-in edit ("Dont like the optional. also dont like the label or pour"; then "it is
  not capture the moment. an impression is not a moment.").
- **The year's line is green with a tick**: "2019 is in the catalogue." / "2019 is added on
  save." in the positive colour with the check glyph (the username's "Available").- **Sparkling sits on the colours' line, at its right end** ("why a new line. Just put it on
  the same line like color, on the very right side"): the title "Sparkling" over a switch,
  like "Colour" over its chips, no description. This replaces the separate switch row
  above.

