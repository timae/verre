# 08 — Mobile feed

**Status**: Phase-1 **checkpoint 1 BUILT** on `feature/mobile-feed` (commit `6be1320`, 2026-07-06) — feed list + session glass card + backend payload extension, typecheck/lint/bundle-export green, device-iterated. **NOT merged, NOT pushed.** Remaining Phase-1: the full impression detail screen (checkpoint 2 — `feed/impression/[id].tsx` is a placeholder) + "Had it too". Part of the [mobile-app meta-proposal](README.md). The `/api/feed` backend was already shipped (see [docs/dev/social-feed.md](../../social-feed.md)); this adds a native client + one additive payload field-set (§3, done) + the detail screen.

Design source: the 03·12 exploration in `.local/design/vero-feed.js` (`sessG`/`gpanelInner`/`impSheet`/`gFull`) + the `## Feed` decisions in `.local/design/CLAUDE.md`. Simon picked **03·12 ("linked · glass")** with deviations from the mock, recorded in §2 + §2b (as-built).

**As-built files** (`apps/mobile/src/`): `app/(tabs)/feed/index.tsx` (list) · `app/(tabs)/feed/impression/[id].tsx` (detail, PLACEHOLDER) · `components/feed/SessionFeedCard.tsx` · `components/feed/StandaloneFeedCard.tsx` · `lib/api/feed.ts` (fetcher + wire types) · `lib/feedAspect.ts` (IG framing) · `lib/feedFitMode.ts` (dev toggle) · `lib/flavourAxes.ts`. Backend: `lib/feedTypes.ts` + `lib/sessionFeedWines.ts`.

---

## 1. What already exists (don't rebuild it)

**Backend — consume as-is, zero changes for Phase 1:**
- `GET /api/feed` — network resolution (self + follows + tasting buddies), cursor pagination (`PAGE = 20`), block/mute/profile-visibility filtering, per-item `liked` + `viewerFollowsAuthor` flags. Returns a **discriminated** payload: `type: 'checkin'` (standalone) vs `type: 'session'` (aggregate).
- `POST|DELETE /api/feed-items/:id/like` — like toggle.
- Wire types are already framework-neutral in `lib/feedTypes.ts` (`SessionFeedPayload`, `SessionFeedWine`) — the native client mirrors these the way `src/lib/api/sessions.ts` already mirrors `lib/sessionState.ts`.
- Server-side blind redaction is baked into `loadSessionFeedWines`: a redacted wine ships `_blind: true` with blanked identity fields. The client renders it as a mystery slot exactly like the line-up already does — **the client never re-derives the blind predicate** (root CLAUDE.md cross-cutting rule).

**Client primitives — reuse, per `apps/mobile/CLAUDE.md` catalog:**
- `FullscreenImage` (`ui/FullscreenImage.tsx`) — pinch/zoom/dismiss viewer. Its `data[]` prop is already documented as "the seam for the future multi-image feed gallery." This is the fullscreen target from the detail page (§3).
- `StarScore`, `FlavourWheel` (label-free minis + labelled big), `Avatar`, `Thumb`, `Icon` (`heart` + `heart-fill` both exist), `VText`, `Button`.
- `GLASS_FILL`, `HERO_RATIO`, `HERO_SCRIM`, `usePhoneTokens`, `TAB_BAR_CLEARANCE` (`lib/layout.ts`).
- Query hardening (`lib/query.tsx`) + `apiFetch` (cookie + `X-Verre-Client` + 426 handshake + timeout). Never bare `fetch`.

**Net-new client work** (the actual scope): a feed fetcher + wire types, the session glass card, the double-tap-to-like gesture, and **one new read-only detail screen** (§3).

---

## 2. The card — 03·12 "linked · glass," with Simon's deviations

The session-aggregate card renders per the 03·12 anatomy (`sessG` in `vero-feed.js`): plain header (`avatar · "<name> shared a moment" · place · time · ⋯`), an **edge-to-edge square photo carousel** with a glass panel riding it (name/vintage · score+word · mini wheel, **switches per photo**), a dot strip, the icon action row (like + "Was there too" + group-score chip), the likes line, the caption.

**Three deviations from the 03·12 mock (Simon, 2026-07-06):**

1. **No fullscreen-from-feed.** The 03·12 mock opened a fullscreen photo viewer on photo-tap (`gFull`/`gimg` handler). **Deleted.** In the feed, a single tap on the photo does nothing navigational (it's the double-tap-like target, see #3). Fullscreen is reachable only from the detail page's hero (§3).
2. **Glass panel opens a FULL PAGE, not a bottom sheet.** The 03·12 mock's panel-tap opened `impSheet` (a bottom sheet). **Replaced** by a pushed full-screen route (§3). Tapping **anywhere on the glass panel** (name, score, or mini-wheel — one target, the whole `fpg-panel`) pushes the detail page for the currently-shown impression. The `impSheet` bottom sheet and its swipe/`gLand` re-sync machinery are **not built**.
3. **Double-tap the photo to like** (Instagram convention, Simon 2026-07-06 — net-new, not in the mock). See #3 below.

### Card gesture model (load-bearing — two gestures on one photo)

The carousel photo carries **two** discrete recognizers that must compose without fighting the horizontal carousel swipe:
- **Single tap** → nothing. (Reserved; no fullscreen from feed.)
- **Double tap** → toggle like ON (Instagram semantics: double-tap **likes**, it does not unlike — a second double-tap is a no-op if already liked; unliking is the explicit heart button only). Fires the like mutation + a **heart-burst** animation over the photo (a brief scaled `heart-fill`, center of the photo, fade+scale out). Haptic light-impact on the like.

Compose with `react-native-gesture-handler` the same way the app already does elsewhere: the carousel is a horizontal scroll; the double-tap is a `Gesture.Tap().numberOfTaps(2)` on the image, and a single-tap recognizer (`.numberOfTaps(1)`) must be declared so the double-tap doesn't wait-fail into it — but since single-tap is a no-op, the cleaner path is a lone double-tap recognizer that yields to the scroll's pan. **The glass panel is a separate Pressable OUTSIDE the photo's gesture area** (it sits below the photo in `fp2-bottom`), so panel-tap→detail never contends with the photo's double-tap. Verify on device that a horizontal carousel swipe is never misread as a tap (the `FullscreenImage` in-file notes the thresholded-pan-vs-tap composition that the image-viewer library already solved — mirror that discipline).

**Optimistic like** writes the `['feed', ...]` cache the same way the reveal/hide mutations write the session cache (`apps/mobile/CLAUDE.md` blind-reveal §): `cancelQueries` before `setQueryData`, `invalidateQueries` on error (never a frozen-snapshot restore — a poll may have advanced the cache mid-flight). The like count is block-pair-adjusted server-side; the client just reflects `liked` + `likeCount` from the response and does the optimistic +1/−1 locally.

### Standalone check-in cards — DEFERRED to Phase 2 (§5)

03·12 is a **session** spec — the glass panel + carousel exist because a session has N impressions to page through. A standalone check-in is **one** impression + **one** photo; the glass mechanism doesn't map onto it, and Simon has explicitly flagged the current standalone card as bad UX ("crammy under the pic, you barely see what it's about, no path to detail"). **Phase 1 does not redesign the standalone card.** It renders standalone items in a minimal, correct-but-plain form (or omits them from the first cut — decide at build time, see §5). The standalone-card redesign is its own small design round, unblocked by Phase 1 (once the detail page exists, the standalone card's detail path is free — it routes to the same page with a single impression).

---

## 2b. As-built card behaviour (device-iterated, 2026-07-06) — SUPERSEDES §2 where they differ

Decisions made iterating the card on a real device this session. Where §2 and §2b conflict, **§2b wins** (it's later + device-verified).

**Photo aspect — IG-style framing (`lib/feedAspect.ts`).** §2's "edge-to-edge square carousel" is superseded: the feed doesn't carry image dimensions, and forcing a square cropped portraits (Simon's "cutting images in height"). The model:
- **Frame band** = `h/w ∈ [3/4 (4:3 landscape) … 4/3 (3:4 portrait)]` — the phone-camera default aspect (4:3 sensor held either way), so a **standard phone photo fills the frame whole, no crop, in either orientation**. Only unusual shapes are affected (a >3:4 tall screenshot crops to 3:4; a >4:3 wide shot crops/bars to 4:3). *(We briefly used a 4:5 tall cap; reverted to 3:4 because 4:5 cropped the common 3:4 phone portrait ~6% — Simon.)*
- **Carousel frame rule**: the **tallest photo wins**, clamped to the band → the frame is always ≥ every slide, so a shorter (landscape) slide never pillarboxes. An all-landscape moment gets a landscape (≈4:3) frame; a portrait-containing moment gets up to a 3:4 frame.
- **Dimensions are measured via `expo-image`'s `onLoad`** (`e.source.width/height`), NOT `RNImage.getSize` — getSize did a *separate* fetch that failed silently against MinIO, leaving every photo on the cover fallback (the whole aspect system silently didn't work until this was fixed). Frame settles from a 4:5 default while images resolve.
- **Fit within the frame — CROP is the chosen default (Simon), `bars` is the alternative.** A dev toggle (`lib/feedFitMode.ts`, exposed in the dev gallery's "Feed photo fit" section) flips between:
  - `'crop'` — every photo `cover`-fills the frame (crops the overflow, no bars). **Simon's pick.** A photo that matches the frame isn't cropped (cover on an exact match is a no-op) — so crop only bites the *minority orientation in a mixed moment*.
  - `'bars'` — a photo shorter than the frame `contain`s with **tint letterbox bars** (`surfaceSunk`, "alternate background tint"); a photo *taller* than the frame still crops (we **never pillarbox** — Simon: "rather crop, like Insta").
  - ⚠️ **Delete this toggle before ship** (hardcode crop, remove `feedFitMode.ts` + the dev-gallery section).

**Panel travels with the photo.** §2 had the glass panel as a static overlay swapping content on scroll-end; Simon: it must **slide with the photo**. So the panel lives INSIDE each carousel slide (`WineSlide`), not as one overlay. The dot strip + heart-burst stay static overlays.

**Overscroll shows flat tint, not background.** Pulling past the carousel ends reveals the carousel container's `surfaceSunk` background (matching the letterbox tint), **sitting flat — no shadow** (Simon rejected the lifted-shadow version; RN ScrollViews clip child shadows anyway).

**Glass panel content (as-built, `GlassPanelInner`):** name + `- vintage` + producer·type + **★ score (bigger — no score WORD**, Simon cut "Really good"/"Good") + mini wheel + a **`chevron-right`** disclosure glyph (the design's `.fpg-chev` = `i-back` rotated 180° — NOT the `more`/⋯ icon, which was the initial mistake). The year is **same colour as the name**, one weight lighter (medium vs semibold), one size smaller — consistent across both cards.

**Feed-list extras:** tapping the Feed tab while on Feed **scrolls to top** (`useScrollToTop` from `expo-router`, wired to the FlatList ref).

---

## 3. The full impression page — NEW read-only screen (not 02e)

**Decision (Simon, 2026-07-06): build a NEW feed detail screen, do not reuse 02e.** Rationale: 02e (`impression/[wineId].tsx`, 1155 lines) is a **write** interface — it carries `ScoreInput`, `FlavourInput`, the rate-commit flow, the host reveal/hide controls, the live `/state` poll, and the wine-editing machinery. The feed detail is a **read** surface: someone else's impression, no editing, no live poll. Reusing 02e would mean threading a read-only mode through all of that. Cleaner to build a focused read screen. **It must speak the same design language** — same hero + collapsing-title pattern, same rating-block layout, same `FullscreenImage` hero-tap — reusing the same primitives, just without the write controls.

**Layout** (echoes the 02e read surface + the 03·13 detail-sheet content):
- **Photo as hero** (full-bleed, `HERO_RATIO`, `HERO_SCRIM`, runs under the status bar). This is the collapsing-hero pattern — read `docs/design/patterns/collapsing-hero-sticky-subheaders.md` FIRST (Dynamic Overlay recipe; ~5 approaches that fail). Same as the line-up cover + 02e already do.
- **Tap the hero → `FullscreenImage`** (the zoomable viewer), "same handling as on an impression" (Simon). If the impression has multiple photos, `FullscreenImage`'s `data[]` seam carries them.
- **Below the hero**: name + vintage, producer · type, ★ score + score word, the **labelled** big `FlavourWheel` (size ~182 per 03·13 round 4), "Tastes like" top-flavour chips, the taste note, and the "About this impression" block (Origin · Variety · Process rows + "Where to buy" accent link — 02e's read table, reused). All read-only.
- Actions: Crave + "Had it too" (the 03·12 sheet's actions). "Had it too" opens the quick check-in flow (deferred with standalone work if it's not trivially wired — flag at build).

**Swipe between impressions (Simon: yes).** The page pages horizontally across the session's impressions with **dots at the top** showing position, matching the 03·12 sheet/viewer swipe behaviour. Entry lands on the impression whose glass panel was tapped. (No feed-carousel re-sync needed — that was the mock's sheet-over-card `gLand` dance; here the feed card is left behind when you push the page. On pop, the feed card's carousel is wherever the user left it — acceptable, verify it doesn't feel wrong.)

**Data source — DECIDED: extend the feed payload (2026-07-06).** The detail page needs the About-table fields (Origin = `region`+`country` · Variety = `grape` · Process = `vinification` · the `description` block · Where-to-buy = `purchaseUrl`). `SessionFeedWine` already carries `grape`; the delta is **4 short scalar fields** (`region`, `country`, `vinification`, `description`, `purchaseUrl`) already on the `wines` row. Add them to `SessionFeedWine` + the `loadSessionFeedWines` `select`, passing them through the SAME `redacted ? {…null…} : {…}` fork that already blanks `name`/`producer` — so a blind-unrevealed wine's metadata stays `null` by construction and the `_blind` invariant stays in the one helper (root CLAUDE.md cross-cutting rule). ~5-line change; no new endpoint, no second round-trip, the detail screen is a pure client render off data the feed already delivered.

**Why not a lazy per-impression fetch (the earlier draft's option a):** it isn't needed, and it introduced a false problem. **Wine metadata is NOT session-gated.** The feed already serves wine identity (name/producer/vintage) to viewers who share no session with the author — the whole feed audience is follows + tasting-buddies + (for a `null` viewer) the public. The *only* gate on wine data anywhere is the **blind-redaction predicate** (`redacted` in `loadSessionFeedWines`), which is "blind-and-unrevealed," not "not a member." A revealed / non-blind wine's identity is already fully exposed to the network; the metadata fields extend exactly that same non-gated exposure. (Precedent that wine reads aren't session-scoped: `GET /api/me/bookmarks/[wineId]` reads a wine by id alone, and `wines.sessionId` is nullable — a wine outlives its session.) So there is no membership-gate to solve and no `/state`-401 risk — that concern in the first draft was a misread of the model. **Phase 1's only backend touch is these additive fields.**

---

## 4. Build plan — Phase 1

**Checkpoint 1 — DONE** (commit `6be1320`, device-iterated; see §2b for as-built card behaviour):
1. ✅ **Feed fetcher + wire types** (`src/lib/api/feed.ts`) — `useInfiniteQuery` over `GET /api/feed`, cursor paging, `ApiError` mapping, like mutation.
2. ✅ **Feed list screen** (`(tabs)/feed/index.tsx` — `feed.tsx` became a `feed/` STACK so the detail pushes within the tab) — `FlatList`, pull-to-refresh, infinite scroll, focus-refetch, empty/error states, tab-repress scroll-to-top.
3. ✅ **Session glass card** (`components/feed/SessionFeedCard.tsx`) — 03·12 anatomy, but see §2b (IG framing, panel-slides-with-photo, crop default, flat overscroll tint, chevron, no score word).
4. ✅ **Double-tap-to-like + heart-burst**, optimistic like.
5. ✅ **Backend: extend `SessionFeedWine` + `loadSessionFeedWines`** with `region`/`country`/`vinification`/`description`/`purchaseUrl`, guarded by the existing redaction fork. Verified end-to-end vs real Postgres.

**Checkpoint 2 — REMAINING:**
6. ⬜ **Full impression detail screen** (`feed/impression/[id].tsx` — currently a PLACEHOLDER; §3) — pure client render off the extended payload. Photo hero + rating below + swipe between the moment's impressions + tap-hero→`FullscreenImage`. Read the collapsing-hero pattern doc FIRST.
7. ⬜ **"Had it too"** wiring (card action row + detail page) — `POST /api/checkins` with `copyFromCheckinId`.
8. ⬜ **Standalone card** — minimal render exists (`StandaloneFeedCard.tsx`); real redesign is Phase 2 (§5).
9. ⬜ **Delete the `feedFitMode` dev toggle** — hardcode `crop`, remove `lib/feedFitMode.ts` + the dev-gallery section (§2b).

**Known-hard, budget for it:** the collapsing hero (read the pattern doc), the full-bleed `contentInsetAdjustmentBehavior` trap (`apps/mobile/CLAUDE.md` scoring §: the zero-size `<View collapsable={false}>` dead-end — applies to any edge-to-edge screen, "feed hero cards" is called out by name), and the two-gesture composition on the carousel photo.

**Reviewer gate** (root CLAUDE.md): this spans >3 files + a new shared primitive (the feed card) + a new screen + a schema-adjacent payload change → spawn a reviewer before pushing, briefed to read `apps/mobile/CLAUDE.md` + `docs/design/` + the collapsing-hero pattern. Since step 5 touches the feed payload, also brief on `docs/dev/social-feed.md` + the profile-visibility/blind invariants (confirm the added fields flow through the redaction fork and never leak on a blind-unrevealed wine).

---

## 5. Phase 2 — standalone check-in card (its own design round)

Not scoped here beyond the constraint that it exists and Phase 1 unblocks it. The open question is purely the **card face** (what a single-impression check-in looks like in the feed — glass panel? wheel? cleaner caption block?), because the **detail path is free** once §3 ships (a standalone routes to the same detail page, single impression, no swipe). Treat as a fresh design decision against `vero-feed.js` (the photoless-post + single-check-in explorations) when Phase 1 is on-device and judgeable.

---

## 5a. Feed actions — Like + Had-it-too in Phase 1; Crave deferred (2026-07-06)

**Like** (double-tap + heart) and **Had it too** (`POST /api/checkins` with `copyFromCheckinId`) ship in Phase 1. Both have working, non-membership-gated backend paths.

**Crave (bookmark) is DEFERRED to its own pass** — it turned out to need a schema change, and there's nowhere to land the data yet:
- The existing bookmark POST (`/api/session/:code/wines/:id/bookmark`) **requires session membership** (deliberate anti-enumeration, stated in the route) — a feed viewer isn't a member, so there is no working Crave-from-feed path today. (The DELETE is already `wineId`-keyed + membership-free, so the two are asymmetric.)
- Simon's ruling: a craving is about the **impression**, and it should remember its **source** (whose impression, their notes, date, later their photos) with the source **tombstoning** if the post/session is deleted. That provenance lives on a specific **`rating`** (author/notes/ratedAt/images), NOT on the wine (a shared catalog row — two people rating it collapse to one `wineId`) and NOT on the session. Today `bookmarks` is `(userId, wineId)` — it structurally can't remember *whose* impression you craved.
- The right model (for the deferred pass): a nullable **`sourceRatingId`** on `bookmarks` (FK → `ratings`, `onDelete: SetNull` = tombstone), captured at Crave time from the feed's (author, wine) pair; the Cravings list reads provenance from it, falling back to the wine-based render when null. One column + one migration + a new non-membership Crave endpoint keyed on the wine (visibility-checked via the feed network, not raw enumeration).
- **Also deferred with it: the mobile Cravings list itself** — it doesn't exist on mobile yet, and the web one is deprecated design. Capturing craving-provenance is pointless until there's a list to render it. So Crave (button + endpoint + schema + list) is one coherent follow-up, not split across passes.

## 6. Deferred / out of scope

- **Crave (bookmark) with source-provenance** — §5a. Needs `bookmarks.sourceRatingId` + a non-membership Crave endpoint + the (nonexistent) mobile Cravings list. Its own branch/migration/review.
- **Multi-image feed gallery** (IG-style, the `FullscreenImage` `data[]` seam) — only relevant once impressions/check-ins carry multiple photos in the feed payload. Base library is patched and ready (`apps/mobile/CLAUDE.md`); the gallery component is unbuilt.
- **Profiles (`/u/<id>`) + history + compare-from-feed** — separate breadth surfaces, not this doc.
- **Push / realtime feed** — the feed is a pull surface; no realtime requirement. Poll-on-focus via the existing query hardening is enough.
