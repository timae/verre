# ADR 0011 — The moment impression opens like a post, as a layer inside the line-up

**Status:** Accepted · 2026-11-25 (rulings) · built 2026-11-26 · mobile (tasting-feedback build 2).
**Supersedes:** nothing (no earlier ADR covers how the impression is presented;
0003 to 0010 checked). ADR-0003 (opaque bars) still applies to the page's bars
and footer.
**Context:** Simon: "I would like to change the impression detail to the similar
feel like opening a post. so you should be able to swipe down to close. and edge
swipe should navigate between the impressions (with corresponding visuals)." Until
then the impression was a pushed route (`session/[code]/impression/[wineId]`, on
six stack mounts) and Previous / Next replaced it with a sibling route. Build 1
(rating auto-save, `docs/dev/rating-saves.md`) is the foundation: every leave is a
merge save; Clear My Rating deletes, and since 2026-11-26 so does a merge that
empties the stored rating (the server decides; below).

## Decisions (Simon, 2026-11-25 interview)

- **A layer inside the line-up screen**, not a route (chosen over an own route +
  stack after the estimate: about half the work). The line-up holds the open
  wine and renders the impression as its last child. **Edit Impression** and
  **View Profile** (Brought By's preview) stay ordinary pushes on whatever stack
  hosts the line-up, so they open on top and Back returns to the impression. No
  modal inside a post's modal.
- **Open = like an impression opens from the profile's Impressions list**: it
  grows out of the tapped row as a container transform (the row's face drawn on
  the container while it fades, the raised tone, the vertical reveal window) and
  folds back into the row on close. No photo flight. No frame (missing, clipped,
  late) = the plain fade, bounded: it never waits.
- **Pull-down closes from anywhere while the page is at its top**, except a drag
  that starts on the aroma canvas (Simon saw and picked this exception; as built
  the canvas's hex stage, where the pull fails before it activates: the crumbs
  and the refine row around it still pull).
- **Edge swipe pages** between impressions, the neighbour following the finger,
  in line-up order (`wines`), whatever sort or search the line-up shows.
- **First and last**: "Nothing, like the post": no page change; the left edge
  never closes (pull-down does). A rubber band is visual feedback only.
- **Previous · Next** run the same slide; **Finish** closes the layer like the
  close button.
- **Closing lands on the current row**: the line-up scrolls to it and the layer
  folds into it; a row a search filters out takes the fade.
- **The states the old screen handled**: the open bottle leaving the line-up
  (deleted, a hidden line-up) closes the layer with the fade (it was "This
  impression is gone"); Delete Impression closes it; a fatal moment is the
  line-up's own view (the layer goes).
- **Don't touch the post.** Its motion is COPIED into impression-only hooks; moving
  the post onto them is a separate decision. The look-in's bottle page is
  unchanged.

## Rules that follow (as built)

- 🔒 **One transition guard** (build 1's `createTransitionGuard`) owned by the
  layer, shared by paging, Finish and every close (the close button, Android Back
  after the sheet dismissal, a committed pull-down): acquire, capture the
  outgoing page (stored on the phone, never waiting for the server), move only
  then, once, and only if that page is still the active one; a storage failure
  keeps a page change on the page, while a close always leaves (Back always
  leaves; the footer error or the after-leave alert reports it). The page's
  text fields are captured first (every departure waits for their native edit
  to end, bounded). An edge swipe captures when the layer GRANTS it (just after
  it activates; a refused swipe moves nothing), a pull-down during the drag
  once that capture is in, so the write is normally done by the time the finger
  lifts; a pending one holds the position until it settles. While the guard is
  held the outgoing page takes no touch and no VoiceOver action, and a page
  change that stays, or a cancelled gesture, keeps it until the page is back at
  rest (Codex review and recheck 2026-11-26).
- **A page change reserves its two pages**: from the grant until the slide
  landed or returned, exactly the source and the destination render, by wine id,
  whatever a poll does to the line-up; a slide commits only when its own spring
  finished and the destination is still there, else it returns to the source.
- **Pages are live** (the active one ±1, keyed by wine id, one translated row;
  `lib/impressionLayerCore.ts`), each with its own autosave hook and `active`
  flag. An inactive page takes no touches, no VoiceOver focus and no new writes.
  A slide moves the row; the active page changes only after it landed, so no
  mounted page moves in a React commit (the reanimated flush rule,
  `apps/mobile/CLAUDE.md`).
- **The edge strips are 15 pt** (`EDGE_STRIP`), the old back zone's width: the
  structure tracks start about 20 pt in and a wider zone kept popping by accident.
  Widen only if the phone shows the score slider and the tracks still take their
  drags. The line-up's native back swipe is off while the layer is open.
- **The bar's close control is the post's down chevron**, labelled "Close"
  (Simon, 2026-11-26): the same glyph and size as the opened post's bar (the
  back glyph rotated); the layer closes like the post, so it no longer shows a
  back arrow.
- **Gesture feel, simulator pass (Simon, 2026-11-26)**: "can't really close it
  by pulling down", "edge swiping feels hard". The pull-down is now the post's
  recognizer exactly (automatic activation after 8 pt), attached like the
  post's (on the scroll view, so a pull starts on the page's content, not on the
  bar or the footer), plus one early fail for a touch on the hex stage. The
  cause of the dead pull was a page wrapper that React Native flattened away:
  blocking its touches at the pull's start created its view and moved the page,
  which cancelled the touch; it is kept as a real view now. The edge swipe starts after 5 pt sideways and
  fails only on 30 pt of vertical drift, and the page follows the finger from
  the first frame: the swipe takes the row on the UI thread and JS confirms it
  (a refused swipe springs back). The strips stay 15 pt. A close, a button page
  change or a pull that takes the row from a swipe sends a displaced row home in
  the same UI step, and a landed slide gives the guard back only after the new
  page's rest is published (Codex review 2026-11-26). A second finger fails the
  pull before it activates, as the hex stage does.
- **Leaving an emptied page deletes the rating, decided by the server** (Simon,
  2026-11-26: "0 should store 0, so that means delete rating"; the server
  decides, not the app). The page holds an emptied draft while it is open and
  while a gesture is only granted; the committed departure (a page change, a
  close, Finish, Back, the background, a blur, the unmount) sends it as an
  ordinary merge, and the server reaps the rating when the merged result over
  the stored row is empty. A cancelled edge swipe or pull-down sends nothing
  (the layer drains twice: a preparation at the grant, the final drain once the
  departure is committed). Superseded the same day's first build, where the app
  sent a Clear itself (Codex review: a cancelled gesture, a degraded poll or an
  unloaded stored edit could each delete).
- **The pill** is hidden while the layer is open AND the line-up is focused (the
  footer replaces the nav), so a profile pushed over the layer shows it.
- **Motion** stays on the transform / opacity allowlist; hit-testing is React
  state; every leg is `springs.enter` / `springs.release`.
