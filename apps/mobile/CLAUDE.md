# apps/mobile — native app (Expo / React Native)

Local rules for the native app workspace. Root CLAUDE.md still applies. Design
source of truth: the Vero handoff in `.local/design/` (gitignored — ask Simon
if missing); proposals: `docs/dev/proposals/mobile-app/`.

## Toolchain facts (SDK 56 — verify against versioned docs, not memory)

- **Expo SDK 56, Expo Router v7 (`~56.x` — version-matched to the SDK).** The
  router no longer depends on `@react-navigation/*` packages — it VENDORS them.
  Classic JS tabs (custom tab bars) come from **`expo-router/js-tabs`**
  (`BottomTabBarProps` etc.); `NativeTabs` renders the OS tab bar and cannot do
  the Vero floating pill. Read https://docs.expo.dev/versions/v56.0.0/ before
  trusting recalled API shapes.
- **New Architecture is mandatory** (SDK 55 dropped Legacy). Native libs must be
  installed at the SDK-pinned versions. ⚠️ `npx expo install` needs
  `api.expo.dev`, which this sandbox's network policy blocks — same pins are in
  `node_modules/expo/bundledNativeModules.json`; read the version there and
  `npm install -w mobile pkg@<pin>`.
- **Custom dev client, tracked iOS project** (no Expo Go, no EAS): `ios/` is
  checked in so a fresh clone can open `ios/Verre.xcworkspace` in Xcode.
  `Pods/` stays gitignored; run `cd ios && pod install` after cloning or when
  native dependencies change. Android remains CNG/generated for now.
  `npx expo run:ios` on the Mac is still useful, but it may auto-prebuild and
  rewrite tracked `ios/` files — review those diffs before committing. Do not
  use `expo prebuild --clean` casually; it deletes the authoritative native
  project and regenerates it. Simulator needs no Apple account; a physical
  device needs a free Apple ID (7-day expiry) until the paid program. The Linux
  sandbox cannot build iOS and cannot run `hermesc` — for a bundle smoke test
  use `npx expo export --platform ios --no-bytecode`.
- **Monorepo**: npm workspace member; Metro auto-detects workspaces (SDK 52+)
  and resolves `@verre/core`'s raw-TS `exports` (package-exports on by default
  since SDK 53). No metro.config.js exists — don't add one just to "fix"
  resolution, and never set `unstable_enablePackageExports: false`.
- **React is pinned EXACTLY (`19.2.3`) in BOTH package.jsons — root web app
  included.** RN's bundled `react-native-renderer` demands the exact same react
  version at runtime (its loose `^` peer range is a lie); a second react
  version anywhere also forces npm to nest the expo subtree under
  `apps/mobile/node_modules`, where the root-hoisted `@expo/router-server`
  can't resolve `expo-router` (the typed-routes crash). When bumping react:
  bump both pins together to the version RN's release ships its renderer for.
- ⚠️ **NEVER run `npm audit fix --force` in this repo.** It "fixes" advisories
  by jumping ranges in either direction — observed downgrading `next` 15→9 and
  `expo` 56→46, wrecking the whole tree. Recovery: `git checkout --` the
  package manifests, delete `node_modules` + `package-lock.json`, `npm install`.
- ⚠️ **Adding a dep: install, then run a ROOT `npm install`.** A bare
  `npm install -w mobile <pkg>` does a workspace-scoped resolve that can EVICT
  the hoisted shared `expo`/`react-native` out of root `node_modules` (the tell
  is "removed N packages"). The Podfile then fails with `Cannot find module
  'expo/package.json'` and the JS won't resolve. Fix: a full `npm install` from
  the repo root re-resolves the whole workspace tree. (Hit twice during the
  image-viewer swap.)
- ⚠️ **`react-native-gesture-image-viewer` is PATCHED via `patch-package`**
  (`patches/react-native-gesture-image-viewer+<version>.patch`, auto-applied by
  the root `postinstall`). The patch adds what the library doesn't expose as
  props: double-tap `.maxDelay(300)/.maxDuration(300)` (the un-tuned default
  needed near-impossibly-fast taps) and `withDecay` momentum on zoomed-pan
  release + `cancelAnimation` on re-grab (upstream stopped dead on let go). The
  patch filename is **version-pinned** — bumping the library makes patch-package
  warn loudly and the patch must be regenerated (`npx patch-package
  react-native-gesture-image-viewer` after re-applying the edits to
  `lib/module/useGestureViewer.js`), or upstreamed as a PR (the proper fix is
  configurable props). It powers `components/ui/FullscreenImage.tsx` and is the
  intended base for the future multi-image feed gallery.

## Auth (Better Auth client)

- **Version lockstep is mandatory**: `better-auth`, `@better-auth/expo`, and
  `@better-auth/core` are pinned to the SAME exact version as the server's
  root pin (root `package.json` also carries an `overrides` entry for core).
  Bumping any of them = bumping all, server included → re-run the CI gates.
- The server side of the Expo integration is a **vendored bridge** in
  `lib/betterAuth.ts` (the real `@better-auth/expo` package can't resolve at
  the repo root next to web's zod 3 — see the plugins comment there). When
  social sign-in (step 6) lands, that bridge is replaced by the real plugin.
- `authClient` baseURL must include the full basePath (`…/api/auth/native`).
  Session cookie lives in SecureStore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, never
  `requireAuthentication` — the SDK reads it on every request).
- Sign-up is a **two-step flow** (signUp then signIn) because the server sets
  `autoSignIn: false` for enumeration posture — don't "fix" it.
- All Verre API calls go through **`src/lib/apiFetch.ts`** (cookie +
  `X-Verre-Client` header + the 426 update-required handshake + an
  AbortController timeout, default 12s — RN fetch has none). Never bare
  `fetch` against the backend.

## Server state (TanStack Query, hardened per proposal 02 §4)

- `src/lib/query.tsx` owns the QueryClient + the native poll hardening:
  `AppState → focusManager` (only `'active'` counts, debounced 300ms —
  `'inactive'` fires for control-center/app-switcher and is NOT background),
  `NetInfo → onlineManager`, and `useIsOnline()` for reconnecting affordances.
- Session fetchers + wire types live in `src/lib/api/sessions.ts`
  (`ApiError.kind` maps 404 / `X-Vr-Auth: invalid|removed` / 403-banned / 429).
  Wire types mirror `lib/sessionState.ts` + `wineToWire` — keep in sync.
- The line-up screen polls `GET /api/session/:code/state` at 5s with
  per-section graceful degradation, and MUST `POST /visit` first (the state
  route 401s for non-participants).

## Native-chrome vs brand-custom (locked design ruling, 2026-06-12)

Every design-handoff element carries one of two tags (recorded in
`.local/design/CLAUDE.md` "Native-chrome vs brand-custom"; tagging is
per-element on mixed screens; ask when unsure):

- **native-chrome** — the mock is an INTENT reference; implementation uses the
  real OS component (iOS/Android diverge deliberately — this IS the O5 split
  axis). Spec covers content/copy + tint tokens (bg + label colors held to the
  theme); gesture physics and exact paddings belong to the OS. Applies to:
  bottom nav, sheet SHELLS (presentation/dismiss/scrim — contents stay
  brand-custom), switches, context menus, alerts, pickers/dropdowns, date
  pickers, search, share, large-title bars.
- **brand-custom** — the mock is the pixel spec, tokens apply fully, identical
  across platforms: all scoring widgets, buttons, fields (incl. join-code
  auto-format + score slider), cards, chips, avatars, the wine modal, empty
  states. ⚠️ "Pixel spec" is literal: before building a brand-custom screen,
  open its `vero-screens.js` template + the CSS classes it uses and translate
  them class-by-class to RN styles (paddings, type sizes, separators-vs-cards,
  icon paths). Approximating the layout from generic primitives — even with
  correct tokens and copy — got the M2 line-up rejected; deviations must be
  explicit and flagged, never silent simplifications. In-flow screens use the
  shared `VBar` (the design's variant-B bar), not the native stack header.

Consequence for this app: the bottom nav is the **brand `PillTabBar`**
(`components/PillTabBar.tsx` on `expo-router/js-tabs` — **ADR-0006**, which
supersedes ONLY the bottom-nav slice of this ruling: the iOS-26 NativeTabs bar
scrambled in use — label truncation + misalignment after stack returns, themed
colors dropped — all open upstream bugs, see the ADR). The undecided 4th slot
is a tappable "Soon" tab (`(tabs)/soon.tsx`) until explore-vs-notifications is
decided. ⚠️ `TAB_BAR_CLEARANCE` (`src/lib/layout.ts`) is REAL clearance now
(96): the pill is an absolute overlay, nothing auto-insets for it — every
scrolling tab screen pads `insets.bottom + TAB_BAR_CLEARANCE`. Sheets, menus,
alerts, pickers: still reach for the native primitive first — the ruling
stands everywhere but the bottom nav.

## Component catalog + reuse rule (READ BEFORE BUILDING ANY UI)

🔁 **Before you build a visual element, check this catalog and REUSE the existing
primitive. Do NOT re-implement a look that already exists.** The #1 cause of "the
same thing built three different ways" is a session not knowing the canonical
component already exists (an audit on 2026-06-16 found the anchored menu built as
3 panels + 4 anchor buttons, the avatar circle ~6×, the "+Add" pill ~7×). If a
visual pattern appears in 3+ places, extract it into `components/` under a name
that says what it does. Tokens always: `theme.*` colors, `radius`, type scale via
`useTheme()`/`textStyle()`/`VText` — never raw hex (the only sanctioned literals
are the over-photo glass fills + scrim gradients).

Design rationale + decisions live in `docs/design/` (ADRs + patterns); this is
the "what exists / what to reuse" map.

**Build patterns — read the recipe BEFORE building one of these (saves re-walking
dead ends):**
- **A collapsing / immersive-hero screen** (full-bleed photo under the status
  bar + a bar that collapses on scroll + sticky sub-headers under it — the feed
  hero cards, the line-up cover) → read `docs/design/patterns/collapsing-hero-sticky-subheaders.md`
  FIRST. It has the Dynamic Overlay recipe + the 4 approaches that FAIL (cost ~5
  attempts). Bars over scrolling content are opaque — `docs/design/decisions/0003`.

**Existing shared primitives (the canonical things — reuse these).** Paths below
are relative to `apps/mobile/src/components/` (e.g. `ui/VText.tsx` =
`apps/mobile/src/components/ui/VText.tsx`); `lib/` paths are `apps/mobile/src/lib/`.
- **Text**: `VText` (`ui/VText.tsx`) — themed Text w/ `variant` + `color` token. Every label starts here. For capped/fixed-format or compact surfaces, pass `surface="compactList" | "carousel" | "badge" | "score" | "code" | ...`; do not write inline `maxFontSizeMultiplier`.
- **Button**: `Button` (`ui/Button.tsx`) — `primary/positive/secondary/tertiary/danger`, `sm/md/lg`, `bar`, `block`, `loading`+`loadingTitle`. Any real button. It owns the Dynamic Type `button` surface; don't recreate fixed-height text buttons.
- **Icon**: `Icon` (`ui/Icon.tsx`) — the vendored 24×24 SVG set (`IconName` union). All iconography. Add new glyphs here, never inline an SVG.
- **Text input**: `TextField` (`ui/TextField.tsx`) single-line; `NotesField` (`moments/momentForm.tsx`) multiline. `TextField` owns the `formControl` Dynamic Type surface and deliberately omits `lineHeight` on single-line `TextInput` so iOS centers entered glyphs correctly. Pass `surface="code"` for fixed-format codes. (A shared `<TextArea>` is a pending extraction — see below.)
- **Bottom sheet**: `Sheet` (`ui/Sheet.tsx`) — the gorhom shell (themed bg/handle/backdrop + tab-bar-hide). All sheets. ⚠️ Two load-bearing gorhom facts baked into the shell + consumers: (1) the BACKDROP renders as a no-zIndex sibling BEFORE the sheet container, so the shell z-indexes backdrop (99) + container (100) — without that, a screen's zIndexed absolute overlays (hero bar, sticky tab/rail overlays, reconnecting bar) paint OVER the dim layer (`containerStyle` alone does NOT reach the backdrop — a fix that "looks right" but isn't); (2) sizing is two-mode: dynamic fit-to-content (`maxDynamicContentSize`, plain-View rows — a `BottomSheetScrollView` measures 0 under dynamic sizing) while content fits, or fixed-snap + `BottomSheetScrollView` when it can't (rows past the cap CLIP unreachably under dynamic sizing). The compare sheets (`CompareBody.tsx`) show the cap-aware mode switch + the search height-lock recipe.
- **Anchored dropdown menu**: `ui/AnchoredMenu.tsx` — `AnchoredMenu` (the `.ir-menu` panel: Modal shell + surface card + `elevation.menu` shadow + dur1 fade/4px-rise + flip-up-near-bottom, `{top,bottom}` anchor), `MenuItem` (icon/label row, `tone`/`disabled`/`active`), `MenuSeparator`, `AnchorButton` (measure-self ⋯ trigger). ALL ⋯ dropdowns route through this. (Anchor to a ROW not the button → keep a manual `rowRef.measureInWindow` like PeopleSheet's PersonRow.)
- **Query-failure UI**: `ui/ConnectionState.tsx` — `ErrorState` (full-screen + retry), `ConnectionBanner`, `ReconnectingBar`, `connectionView()`. All poll/error affordances.
- **Terminal centered message**: `CenteredMessage` (`ui/ConnectionState.tsx`) — `title` + optional `body`, vertically centered, NO retry (the no-button sibling of `ErrorState`). For dead-end states a refetch can't fix ("this impression is gone", "you can't edit this"); pass `pending` to blank the copy while a query resolves. Caller owns the bar above it. Reuse instead of re-rolling the flex-center block.
- **QR**: `QrCode` (`ui/QrCode.tsx`).
- **Score READ**: `StarScore` (`scoring/StarScore.tsx`) — the one-star + value (`★ 4.25`). Never inline a star.
- **Score WRITE**: `ScoreInput` (`scoring/ScoreInput.tsx`) — wide slider + editable number + word (gesture+haptics). The editable score numeral uses the `score` Dynamic Type surface, not the generic badge/code surfaces.
- **Flavour wheel (READ)**: `FlavourWheel` (`scoring/FlavourWheel.tsx`).
- **Group charts (02d Compare)**: `ComparisonWheel` (`scoring/ComparisonWheel.tsx`, the C1b min→max band wheel, wedge tap → drill-in) + `RadarOverlay` (`scoring/RadarOverlay.tsx`, ≤4-taster overlaid radar). Geometry from `@verre/core` (`comparisonWheelGeometry`/`radarOverlayGeometry`); aggregation from `aggregateFlavourAxes` (client-side per the §7 ruling — no server aggregate). Person-series colours via `usePersonColors()` (`theme/flavourColors.ts` — derived from the palette base ramp, stable roster-index assignment). ⚠️ The labelled charts' natural canvas (size 232 + 2×58 pad = 348pt) is WIDER than a small phone's content column — every host must measure its width (`onLayout`) and pass `maxWidth` (all three wheels + `FlavourWheel` take it; it scales the whole SVG uniformly, the design's `.radar { max-width:100% }`).
- **Session-screen chrome (line-up 02b + compare 02d)**: `SessionTabs` (`moments/SessionTabs.tsx` — the .vtabs strip, CONTROLLED: Compare is an **in-screen tab swap** per Simon's 2026-07-02 ruling — everything above the tabs (bar or cover hero) stays, no route change, no back-to-line-up; the Add pill + reveal strip are line-up furniture and hide on Compare), `CompareBody`/`PeopleRail`/`ComparePickerSheet`/`buildComparePeople` (`moments/CompareBody.tsx` — the whole 02d compare surface; **the behaviour spec-of-record is `docs/dev/proposals/structure-wheel.md` §7 + ADR-0005 — read those before touching it**. Headlines: multi-open collapsed-by-default cards; the DECIDED 02d·4 avatar rail is the ONLY select/deselect surface (screen-owned hidden set; deselected people vanish from cards, header + ranking recompute; rail sticky like the reveal strip — plain: `stickyHeaderIndices`, hero: the strip overlay slot); chart mode keys on the STRUCTURE-ENGAGED taster count; person rows are per-person DETAIL views, not toggles; axis drill-in from C1b wedges or radar labels; Show-all sheet), `SessionMenu`/`SessionMenuButton`/`useBlindForEveryoneToggle` (`moments/SessionMenu.tsx` — the ⋯ menu + the optimistic blind-for-all mutation), `SessionFatalView` (`moments/SessionFatalView.tsx` — gone/removed/banned/invalid terminal states).
- **Session poll bootstrap**: `useSessionPoll(code)` (`lib/useSessionPoll.ts`) — visit → `/state` poll → per-section `lastRef` merge (keyed on code+identity, checked synchronously) + fatal/removed handling. ANY new screen reading the shared `/state` poll uses this hook (the impression detail still carries its own pre-hook copy of the merge — migrate when next touched).
- **Flavour WRITE**: `FlavourInput` (`scoring/FlavourInput.tsx`) — the per-axis fill-track grid (whole 0–5 steps, gesture+haptics, VoiceOver-adjustable); axes from `resolveAxes`, colour from the active theme via `useFlavourColors()` (`theme/flavourColors.ts`). ALL flavour-intensity input.
- **Role chip / badges**: `RoleChip` + `BadgePill` (`moments/RoleChip.tsx`) — host/cohost/provider text pill and the shared small badge primitive. Use `BadgePill` for People/settings role tags instead of reimplementing badge centering, line-height, or tone math.
- **Settings kit**: `settingsParts.tsx` — `ReadCard`, `SetGroup`, `SetNav`, `GlassButton` (over-cover round glass), `SettingsFooter` (sticky Discard|Save), `ToggleRow` (switch + PRO badge + reason).
- **Form widgets + image pipeline**: `momentForm.tsx` — `DateField`, `NotesField`, `fitCover`/`pickCover`, `MAX_COVER_BYTES`/`MAX_WINE_IMAGE_BYTES` (⚠️ wine images cap LOWER than covers — see add-impression notes).
- **Header**: `VBar` (`VBar.tsx`) — the in-flow variant-B bar (back + left title + right slot). All pushed in-flow screens.
- **Bottom nav**: `PillTabBar` (`PillTabBar.tsx`) — the floating-pill tab bar (`.tabbar-float`, ADR-0006) with the drag-lens (hold ≈180ms → a real Liquid Glass lens rides the bar; release commits; landing on the current tab is NOT input). Rendered via the tabs layout's `tabBar` prop; absolute overlay: content clears it with `insets.bottom + TAB_BAR_CLEARANCE`. ⚠️ The glass layering in that file is LOAD-BEARING physics learned over a day of device checks — read the in-file header + ADR-0006 and re-run the dev-gallery GLASS LABS (`/you/dev-gallery`) before touching any glass property. Don't add per-screen nav bars.
- **Avatar**: `ui/Avatar.tsx` — person circle (image→initials→`anon` user-glyph cascade); props `size`, `host` (accent tint), `anon`, `ring` (the overlap-stack 2px bg border + image inset), `badge` (overlay node, e.g. the "+" invite badge), `initialsSize`. ALL person circles.
- **Thumb**: `ui/Thumb.tsx` — square cover/wine thumbnail with the glass-glyph placeholder; props `uri`, `size`, `radius`. ALL cover/wine thumbs (wrap + overlay for the line-up hidden-from-guests badge).
- **Sheets (domain)**: `PeopleSheet`, `InviteSheet` (`moments/`).
- **Shared screen constants + Dynamic Type surfaces (`lib/layout.ts`)**: `GUTTER`(22), `FOOT_CLEARANCE`/`FOOT_CLEARANCE_IR`, `TAB_BAR_CLEARANCE`, `HERO_RATIO` (shared by BOTH heroes — same height), `GLASS_FILL` (the over-photo glass fill), `HERO_SCRIM` (the hero-photo gradient), and `FONT_SURFACES` / `phone.surface(...)`. Import constants; don't re-declare. Use `phone.surface(name)` for scalable container math and `VText surface="..."` / `{...surface.textProps}` for matching text caps. `formControl` intentionally stays uncapped because field height math tracks editable text scale. ⛔ **CI-ENFORCED**: `scripts/check-mobile-design-tokens.mjs` (workflow `check-mobile-design-tokens`) FAILS if converged design constants are re-inlined; `scripts/check-mobile-dynamic-type.mjs` (workflow `check-mobile-dynamic-type`) is a partial static backstop for inline caps, common fixed-height text controls, and TextInput surface props. Device checks still own clipping/overlap truth.
- **Label helpers (`lib/`)**: `initials.ts` (code-point-aware avatar initials — used by `Avatar`), `momentFormat.ts`, `scoreWords.ts`, `locale.ts`, `contrast.ts`. `theme/color.ts` `mix()`/`alpha()` for press-state/tint math (use instead of raw rgba).

**⚠️ Pending extractions — KNOWN drift the audit found (2026-06-16, refined by a
4-reviewer pass). Prefer extracting these when you next touch the area; until
then, copy the EXISTING canonical version named below, don't invent a new one.
Ordered by drift-risk (active divergence + likelihood of a next copy):**
- ✅ **DONE — `<AnchoredMenu>`** (`ui/AnchoredMenu.tsx` + `elevation.menu` token; 3 panels migrated, reviewer-verified). `add.PositionPicker` (`.at-pospop`) — a different control, NOT migrated to AnchoredMenu, but its shadow now uses `elevation.menu` too (so all 4 dropdown shadows are one source, CI-enforced).
- ✅ **DONE — `<Avatar>` + `<Thumb>`** (`ui/Avatar.tsx`, `ui/Thumb.tsx`; all ~6 avatar + 3 thumb sites migrated, reviewer-verified pixel-preserving).
- ✅ **DONE — `GLASS_FILL` + `HERO_SCRIM` + the layout constants** — all in `lib/layout.ts` now: `GLASS_FILL` (the over-photo glass fill, converged 0.42/0.5/0.55 → `0.42` everywhere per Simon — a small intentional visual change, device-verify); `HERO_SCRIM` (converged to the impression hero's gradient `0.25/0.05/0.82`, used on both heroes — likewise device-verify the line-up cover); `HERO_RATIO` (ONE ratio `280/744` for both heroes — Simon's ruling that they be the same height; the cover hero was `248/800`, ~56pt shorter, before); `GUTTER`(22)/`FOOT_CLEARANCE`(120)/`FOOT_CLEARANCE_IR`(130) (the impression keeps a LOCAL `GUTTER = 20` override — don't import the 22). A `<GlassCircleButton>` for the circle subset is still open if wanted, but the fill drift is gone.
- ✅ **DONE — `BadgePill` / role-tag convergence** (`moments/RoleChip.tsx`) — `RoleChip`, `PeopleSheet.Tag`, and `ReadCard` now share the badge primitive and Dynamic Type centering policy. Use `BadgePill` for new small text pills instead of re-encoding `paddingVertical`, `lineHeight`, or `includeFontPadding`.
- **`<CoverPickerField>`** — ⬆ moved up: the dashed photo picker is 3 near-identical copies with ACTIVE copy/glass drift (`create.CoverPicker`, `add.PhotoPicker`, `details.tsx` inline — `details` is even missing the caption the others have; the photo-remove × is `0.55` in two of them). Mechanical extraction into `momentForm.tsx`.
- **`<IconPill>` + `<DashedAddRow>`** — the accent "+pill with glyph" is ~5 filled pills (`NewPill`, `EmptyLineup` add, `PeopleSheet .hv-add`, `InviteSheet` Invite/Share) + 1 collapsing variant (`LineupAddButton`) + 1 dashed full-width row (`AddImpressionRow`) — i.e. 2–3 components, not one. Lower-stakes (off-by-2px pad doesn't read as a bug).
- **`<TextArea>`** beside `TextField` — `momentForm.NotesField` + the impression's private `NoteField` re-encode the same multiline focus trick; the impression should use `NotesField` (expose `minHeight`/`maxHeight` — `maxHeight` already half-exists).
- **`PushGroup`/`PushRow` (moments/index.tsx) → adopt `SetGroup`/`SetNav`** (same carded nav-row primitive, add a trailing-slot/`count`).
- **`<OptionSheet>`** — `create.CategorySheet` ≈ `add.TypeSheet` (same check-list body) — extract for THAT case. ⚠️ Do NOT blindly fold in `add.CountrySheet`: it needs a fixed 75% snap + `BottomSheetScrollView` + search (a load-bearing config difference — see its in-file comment); make it a separate `<SearchableOptionSheet>` if anything.
- **Export `add.SelectField`** from `momentForm` — re-inlined for create's category trigger.
- **`<ChoiceChips>`** — the hide-lineup timing pills are verbatim in `create.tsx` + `reveal.tsx`.
- **Promote `ClampText`** (`impression/[wineId].tsx`) to `components/`; `OvcAbout`'s description block is a copy.
- **Generalize `SettingsFooter` → `<StickyFooter error>`** — create/add re-inline the same absolute bottom bar.
- ✅ **DONE (partial) — `<CenteredMessage>`** built in `ui/ConnectionState.tsx` and adopted in the edit-impression screen (in the primitives list above). **The FatalView copy is now SHARED but still un-migrated**: `SessionFatalView` (`moments/SessionFatalView.tsx`, extracted from index.tsx for Compare) still hand-rolls the flex-center layout because `<CenteredMessage>` has no button/footer slot — extend CenteredMessage with a footer slot, then adopt it there. Still open: decide whether it also covers the icon-circle empty-state family (`EmptyLineup`); `LockCard` is a distinct designed surface, exclude it.
- **Shared layout constants** — `GUTTER` (`=22`, the intentional `20` in `impression/[wineId].tsx` is a documented override), `FOOT_CLEARANCE`, are re-declared per-file ~8× / ~5×. Move to `lib/layout.ts` (alongside `TAB_BAR_CLEARANCE`) so the one intentional override is visible.
- Also noted: `DateField` (`momentForm.tsx`) hand-rolls its OWN `Modal`+scrim bottom-sheet (not `ui/Sheet`) to host the OS date picker — justified, but reuse IT if you need a native-picker-in-a-sheet rather than rolling a third.

(This catalog is **mobile-only**. The web app is slated for a later redesign, so
it gets no investment now — don't mine `components/` for patterns or treat it as a
reference for the app; the app's design lives here + in `docs/design/`.)

## Scoring input (milestone 3)

- **Native-first input ruling (Simon, 2026-06-12)**: use the OS input
  machinery, never port the web's gesture-mimicry JS. Drag-vs-scroll intent =
  gesture-handler `activeOffsetX(±6)` / `failOffsetY(±8)` (what the web's 6px
  SLOP dance imitates); editable score number = native decimal-pad
  `TextInput`; VoiceOver = `adjustable` role with increment/decrement
  actions. **Exception (Simon, 2026-06-12): the 02e ⋯ menu is the BRAND
  `.ir-menu` anchored dropdown, not a native action sheet** — a per-element
  flip of the native-chrome "context menus" tag; alerts/sheets stay native. Only pure value policy comes from
  `@verre/core` `scoringInput.ts` (`snapScore`, `scoreFromFraction`,
  `stepScore`, flavour level fns) — it must stay behavior-equal to the web's
  inline copies (web stays untouched until its redesign; the 03 §2a
  convergence precondition is rescinded).
- `GestureHandlerRootView` wraps the root layout — gestures fail silently
  without it.
- ⚠️ **Full-bleed scroll content vs react-native-screens**: a pushed RNSScreen
  (and the tabs host) force-flips the FIRST descendant-chain ScrollView's
  `contentInsetAdjustmentBehavior` from `never` back to `automatic`
  (`RNSScreen.mm` → `RNSScrollViewHelper.mm`, override on by default) — iOS
  then top-insets the content and a full-bleed hero starts below the status
  bar. Fix: a zero-size `<View collapsable={false}>` as the first sibling
  dead-ends the `subviews[0]` walk (see 02e). `collapsable={false}` is
  load-bearing — Fabric flattens layout-only views out of the native
  hierarchy, and a flattened dead-end never exists for the finder to hit.
  Applies to any future edge-to-edge screen (feed hero cards). The per-tab
  `disableAutomaticContentInsets` would flip the whole tab — don't.
- **Tab bar hiding**: the tabs layout computes one `hidden` boolean (pathname
  list + sheet/reveal signal + keyboard) and simply doesn't render the
  `PillTabBar` — the pill is an absolute overlay, so hide/show never resizes
  scenes. 02e hides the bar (footer action bar replaces the nav per design).
- **Haptics** (`expo-haptics`): selection tick per 0.25 step while dragging,
  light impact on commit. No-ops in the Simulator — verify on device.
- **New native modules (M3)**: `expo-haptics`, `expo-linear-gradient`
  (hero scrim); **(M4)**: `expo-image-picker` (cover photo; config plugin
  carries the photosPermission copy in app.json),
  `@react-native-community/datetimepicker` (02a From–To, no plugin),
  `expo-blur` (was the .ir-foot glass — ⚠️ that blur was later REMOVED when
  collapsed/in-flow bars went solid-opaque per ADR-0003; the module is still in
  package.json but currently has NO importer in src/ — verify before relying on
  it, and consider dropping it if nothing reintroduces a blur); **(02s carousel)**:
  `@expo/ui` (ships WITH the SDK,
  pinned `~56.0.17` — declared in package.json so an expo-router bump can't
  silently drop the transitive) — all pinned from `bundledNativeModules.json`;
  re-run `npx expo run:ios` after pulling.
- **`@expo/ui` SwiftUI primitives (iOS-only)**: the Moments-home carousel
  "Remove from home" uses the native `ContextMenu` from `@expo/ui/swift-ui`
  (long-press → OS lift + dim + tap-away; the OS suspends the strip, so it
  can't desync over the looping/re-parking carousel — this replaced a
  hand-rolled `measureInWindow`+dim-`Modal` overlay that did desync). Two
  load-bearing rules when using ANY `@expo/ui/swift-ui` component:
  (1) it MUST be mounted under a `<Host>` (else the runtime throws "a SwiftUI
  view … is being mounted inside a standard UIView"); (2) RN content placed
  inside the SwiftUI tree (e.g. a brand-custom card as a `ContextMenu.Trigger`
  or `.Preview`) MUST be wrapped in `<RNHostView matchContents>` — without
  `matchContents` on BOTH the Host and the RNHostView the lifted/preview view
  renders oversized (SwiftUI proposes a huge frame when it can't infer the RN
  content's size). `.Items` are SwiftUI `Button`s (`role="destructive"` for the
  red item, `systemImage` is an SF Symbol). Carousel clones (no stable
  identity) skip the menu. **Android is deferred** — `swift-ui` is iOS-only;
  Android needs the `@expo/ui/jetpack-compose` equivalent (or a fallback)
  before this screen ships there. See memory note on the decision (zeego
  rejected as a 15-month-stale wrapper; `@expo/ui` is first-party).
- **External links** open via `expo-web-browser` (in-app sheet), never
  `Linking.openURL` — except OS-app hand-offs (the Map line opens Maps).
- **Rate flow** (`moments/session/[code]/impression/[wineId]`): local-until-
  commit like the web Rate pane — the POST fires on Save & next/finish (and
  Previous, a flagged deviation to avoid silent edit loss). "Clear my rating"
  is local too; an empty save triggers the server's engagement-deletion
  cascade. Flavour intensities are edited via `FlavourInput` (the fill-track
  grid — see the component catalog) inside "Add tasting detail"; the save
  boundary normalises via `fillFlavourZeros` and diffs BOTH sides normalised
  so an untouched legacy sparse row is never re-posted.

## Moment creation (milestone 4, 02a)

- `moments/create.tsx` to the tCreate pixel spec. Rulings: category is
  wine-only v1 (field renders per spec, non-interactive, sends
  `category:'wine'`); From–To optional via the OS compact datetime picker
  (native-chrome; tap seeds a default, × clears); no lifespan row — native
  creates default to `unlimited` SERVER-side (`resolveUser` `authSource`,
  unspoofable; see root CLAUDE.md freemium note); blind toggle renders
  disabled + PRO badge for non-pro (`GET /api/me/account` → `pro`).
- Cover photo: `expo-image-picker` base64 → data URL in the create POST
  (server runs the avatar-grade image pipeline). Keep `quality` low enough
  to stay under the server's 2MB decoded cap; the client pre-checks the
  data URL at 2.6MB.
- Covers surface from `MySessionRow.cover_photo_url` (02s live cards 56px +
  recents 46px thumbs).

## Blind reveal/hide (02b — host reveals impressions from guests)

Built on `feature/mobile-create` (committed `bea0758`; awaiting Simon's Simulator
check — no new native modules). Surfaces: the line-up + the impression detail.
Server contract is UNCHANGED and predates this work — four host/cohost-gated
endpoints: `POST|DELETE /api/session/:code/wines/:id/reveal` (reveal/hide one),
`POST …/wines/reveal-all`, `POST …/wines/hide-all`. Client fns of the same
names in `src/lib/api/sessions.ts`.

- **Reveal state = `!!wine.revealedAt` is the SINGLE source of truth for the
  PILL/BAR LABEL** (Reveal vs Hide). The host sees the full wine (incl.
  `revealedAt`) even under blind-for-all the moment it's revealed (`redactWine`
  returns the full row when `revealed`); an UNrevealed wine under blind-for-all
  comes back `_blind:true` with NO `revealedAt`. **But the masked PLACEHOLDER
  renders off `_blind` ALONE — see the dedicated rule below, NOT `_blind &&
  !revealedAt`** (that combination briefly surfaced the server's "Wine N" stub on
  a blind-for-all reveal; the placeholder must stay until the poll clears
  `_blind`). So: label keys on `revealedAt`; placeholder keys on `_blind`.
- **Two-state host UX (Simon's ruling — full design, NOT web parity).** The web
  shows per-row reveal/hide inline always; mobile has a resting view + a
  dedicated reveal MODE (design `tBlindHost`→`tReveal` / `tBlindAll`→
  `tBlindManage`). Resting: the strip shows "N of M hidden from guests" /
  "Hidden from everyone" (blind-for-all) / "All revealed…" + a **Reveal** that
  enters mode. Mode: the strip shows a count chip + **Hide all** / **Reveal
  all**, each row's score/Rate slot swaps to a per-row **Reveal/Hide pill**
  (`.lu-pill-reveal` accent fill / `.lu-pill-hide` outline), and a sticky
  **Done** footer exits. Guests (and providers — they can't reveal, server
  rejects) always get the quiet "Blind tasting · host reveals" strip, never the
  host variants.
  - ⚠️ **The controls always STAY — "reveal all" is not "finished".** Hide all
    AND Reveal all are BOTH live in mode regardless of state (only the transient
    in-flight `busy` disables them); the resting **Reveal** button is ALWAYS
    rendered (even when everything's revealed) so Done never traps the host out
    of the controls. (First build wrongly disabled the buttons by state + hid the
    resting Reveal when nothing was hidden → Done was a one-way door. Fixed.)
  - **Tabs + strip are STICKY in BOTH resting and reveal mode** (Simon's ruling
    — the mock only stickies the mode strip). Two layouts, same end result
    (inline above the line-up, pin under the title bar on scroll):
    - **Plain (no cover):** fixed `VBar`, so native sticky works — tabs are a
      fixed View above the FlatList; the strip is a **sticky FlatList cell**
      (`STRIP_CELL` sentinel at `data[0]`, wine `index` offset by 1) with
      `stickyHeaderIndices={[1]}`. ⚠️ `[1]` not `[0]` — a `ListHeaderComponent`
      (the ovc) shifts sticky indices by +1.
    - **Cover-hero:** the floating bar means native sticky can't pin under it →
      the **Dynamic Overlay pattern**. INLINE order is **photo → tabs → about →
      strip → rows** (tabs UNDER the photo, ABOVE the about; strip separate,
      below the about — NOT one block). 📖 **The full recipe + the dead ends live
      in `docs/design/patterns/collapsing-hero-sticky-subheaders.md` — read it
      before touching this or building a new hero screen.** Impl: `CoverHeroLineup`.
  - **Collapse is MEASURED** (`scrollY ≥ titleBottom − BAR_H`, `titleBottom` via
    `onLayout`), not a magic constant — a proportional-height hero mis-fires
    otherwise. `BAR_H`/`PIN_Y` math + the seam fix: see the pattern doc.
  - **Collapsed/in-flow bars are SOLID OPAQUE, no bottom rule** — the cover-hero
    `HeroTopBar`, the impression `FloatHead` (collapsed), and the impression
    `FootBar`, all flat `theme.bg`, BlurView removed. Pre-collapse over-photo
    stays transparent. Rationale: `docs/design/decisions/0003-collapsed-bars-opaque.md`.
- **Host framing is HONEST (Simon's ruling): the host is NOT blind on a normal
  blind session** — the server returns their full wines, so host rows show the
  real wine + a `.lu-hidebadge` eye-off on the thumb + a "Hidden from guests"
  tag (resting only). Only blind-for-all masks the host too (then rows are the
  `.lu-masked` placeholder; the strip + pills still control reveal). The
  impression NameBlock copy forks on this: host "Hidden from guests — reveal to
  show it" vs guest "Revealed when the host or co-host reveals it".
  - **A masked impression is always the NO-PHOTO NameBlock — the mock's
    `irScreen('blindhost')` masked PHOTO hero (`.ir-hero-mask` tile over a
    full-bleed image) is intentionally NOT implemented.** `hasPhoto = !blind &&
    !!imageUrl`, so any `_blind` wine (guest, or blind-for-all host) uses the
    dark name block, not a masked hero. This follows from the honest-framing
    ruling (on normal blind the host sees the real photo; a masked wine has no
    image to show anyway) and keeps a single masked surface. `.ir-hero-mask` has
    no RN counterpart by design. (Recorded per design-review ask.)
  - **`masked`/`blind` render off `_blind` ALONE, never `&& !revealedAt`.** A
    `_blind` wine is the server's redaction STUB (name "Wine N", blank fields);
    under blind-for-all the host's reveal stamps `revealedAt` optimistically but
    the real fields arrive only on the next poll (which clears `_blind`). Keying
    the placeholder on `_blind` alone keeps the stub hidden in that window; the
    pill/bar label uses `revealedToGuests` so it flips to "Hide" immediately, and
    the impression body shows a transitional "Revealing…" so it doesn't say
    "reveal to show it" while the bar says "Hide". (Earlier `_blind && !revealedAt`
    surfaced the literal "Wine N" stub for ~5s — a review catch.)
- **Reveal mode hides the OS tab bar via a SECOND ref-counted signal**, not the
  pathname-keyed `hidden` list (reveal mode is screen STATE, not a route).
  `src/lib/sheetVisibility.ts` now exports `pushRevealMode`/`popRevealMode` +
  `useTabBarOverlayHidden()` (ORs the sheet count and the reveal-mode count);
  `(tabs)/_layout.tsx` consumes the combined signal. The Done footer replaces
  the nav (design ruling "in-flow footer actions replace the nav"). Reveal mode
  is bound to MOUNT (not focus) — `router.push` to an impression keeps the
  line-up mounted, so the override correctly persists and `router.back()` resumes
  the mode; a genuine unmount or a non-blind/role-loss poll fires the pop.
- **Optimistic reveal/hide** stamps/clears `revealedAt` ONLY (never fabricates
  identity fields — a masked wine stays masked until the poll) and writes the
  shared `['session-state', code, myIdentityId]` cache both screens read. The
  impression bar control and the line-up stay in sync through that one key.
  ⚠️ **`await queryClient.cancelQueries({ queryKey })` BEFORE the optimistic
  `setQueryData`** or an in-flight 5s poll resolves afterwards and clobbers it
  (the classic TanStack race — flicker). On error: `invalidateQueries` (refetch
  truth), NOT a frozen-snapshot restore (a poll may have advanced the cache
  mid-flight). The pre-existing `toggleBlindForEveryone` still uses the
  snapshot-restore pattern — flagged, not fixed here.
- **New `eye` icon** in `Icon.tsx` (the open-eye `i-eye` design path; `eyeoff`
  already existed). The per-row pill is a child `Pressable` inside the row's
  Pressable — RN's responder system grants the touch to the inner pill, so a pill
  tap does NOT also fire the row's navigate (verified pattern, same as IrBar's
  sibling controls).
- **Flagged deviations (Simon to confirm at review):** (1) tabs+strip are sticky
  in BOTH modes AND the cover-hero tabs now stick (mock stickies only the mode
  strip; the cover tabs were a prior "not sticky" deviation) — Simon's rulings,
  recorded above; (2) the `.vfoot-rev` Done footer is a SOLID bar (+ top rule)
  not the mock's `background:none` — RN rows scroll UNDER an absolute footer, so
  a transparent one would bleed; (3) the "All revealed" resting copy is new (the
  static mock has no nothing-hidden state); (4) the host's photo-hero on the
  impression has no hidden-from-guests badge yet (consequence of the
  honest-framing deviation; the line-up rows DO carry it). DEVICE-CHECK residuals
  (overlay approach, not architecture): the overscroll rubber-band feel at the
  very top of the cover-hero, and confirming no sub-frame jitter at the overlay's
  opacity swap on a low-end Android — both tuning, neither can resurrect the
  earlier collapse/double-title/half-stick bugs. Security review: CLEAN — gating
  is server-side, the client checks are cosmetic, the optimistic write can't leak
  an un-revealed identity.
- **FIXED (was the flagged M3 gap):** the impression detail now uses the same
  `lastRef` per-section merge as the line-up (a `wines:null` degraded poll keeps
  the last good list; the "This impression is gone" terminal requires a PRESENT
  wines section that lacks the wine). Any new screen reading the shared `/state`
  poll must adopt the same merge — never read `state.data?.<section>` directly.

## Theme / design

- `src/theme/vero-tokens.js` is a **verbatim vendored copy** of
  `.local/design/vero-tokens.js` — never edit values in place; re-vendor.
  Components reference theme tokens via `useTheme()`/`textStyle()` — never raw
  hex (same rule as web's `components/CLAUDE.md`).
- UI copy comes from the handoff and is **final** ("Moment", "Impression",
  exact button labels). Code identifiers stay `session`/`wine`. On any
  role/permission conflict with the design, the shipped backend model wins.
  - **Sanctioned deviation (Simon, 2026-06-28):** the 02e impression ⋯ menu
    rows ship as terse **"Edit" / "Delete"** (handoff specs "Edit impression" /
    "Delete impression" in `vero-screens.js` — overridden to match the line-up
    menu's terse style). The object context is preserved for VoiceOver via
    `MenuItem`'s `accessibilityLabel` ("Edit impression"/"Delete impression"),
    so the spoken label still names the object. Don't "restore" the verbose
    visible labels.
- App display name is **Verre** ("Vero" was the design codename — appears only
  in the design files and the tokens filename).

## Release placeholders (freeze before first TestFlight upload)

- Bundle id + URL scheme: `io.verre.app` (placeholder, in `app.json`).
- `version` in `app.json` feeds the `X-Verre-Client` header
  (`src/lib/clientVersion.ts`). When EAS Update/OTA ever lands: report the OTA
  update id in the header's third slot AND pin `runtimeVersion` to the
  fingerprint policy first (proposal 04 §3a / 06 §6).
- ⛔ **Never commit the EAS `projectId`.** `eas build` writes `extra.eas.projectId`
  into `app.json` LOCALLY on first run — it's an infra identifier linking this
  PUBLIC repo to an EAS account, and an AI-executed commit will sweep the modified
  `app.json` in without realizing what the line is. Discard that change; do not
  commit it. EAS resolves the project from `app.json` `slug` (`verre`) + the
  logged-in account without the id. **CI-ENFORCED**: `scripts/check-no-eas-projectid.mjs`
  (workflow `check-no-eas-projectid`) FAILS the build if app.json carries a
  `projectId` — safe-by-construction, not safe-by-discipline.

## TestFlight release workflow

- TestFlight builds use EAS, not the local `expo run:ios` dev-client flow.
  Local device runs are for smoke testing the native project and Metro bundle;
  App Store Connect receives an EAS production archive.
- Before the first upload, replace the placeholder bundle id if needed and
  create the matching app record in App Store Connect. Keep `app.json`
  `ios.bundleIdentifier` and `scheme` aligned with the chosen id.
- The EAS production/preview profiles provide `EXPO_PUBLIC_API_URL` and
  `EXPO_PUBLIC_WEB_URL` for the backend/web origins. These values are embedded
  at build time, so set them to the intended production host in EAS env,
  `.env.local`, or the build profile before archiving; do not commit private or
  staging hostnames in docs.
- First-time setup:
  1. `cd apps/mobile`
  2. `npx eas-cli login`
  3. `npx eas-cli build:configure`
  4. `npx eas-cli credentials -p ios` and let EAS create/manage the App Store
     distribution certificate and provisioning profile for the bundle id.
- Build and submit:
  1. `npm run typecheck -w mobile`
  2. `npx expo export --platform ios --no-bytecode`
  3. `npx eas-cli build --platform ios --profile production`
  4. `npx eas-cli submit --platform ios --profile production --latest`
- App Store Connect still needs the usual app metadata, screenshots, privacy
  answers, export-compliance confirmation, and TestFlight beta review details.
  `ITSAppUsesNonExemptEncryption=false` is already set in `app.json`.

## Dev workflow

- Backend URL: Simulator uses `http://localhost:3000`; a physical device needs
  the Mac's LAN IP via `EXPO_PUBLIC_API_URL` (e.g.
  `EXPO_PUBLIC_API_URL=http://192.168.1.x:3000 npx expo start`).
- **Env** lives in `apps/mobile/.env.local` (gitignored; `.env.example` is the
  committed template). `EXPO_PUBLIC_*` vars are **inlined into the bundle at
  build/export time**, not read at runtime — change one ⇒ rebuild/restart Metro.
  - `EXPO_PUBLIC_WEB_URL` — public web origin for shareable links (the
    `/join/<code>` invite URL, built in `src/lib/config.ts` `WEB_BASE`). Falls
    back through `app.json` `extra.webBaseUrl` → `API_BASE`, so local-deployment
    links resolve against the same backend with no override. Set it to the real
    domain for prod/TestFlight builds. (Deviation from the design mock, which
    shows `vero.app/j/<code>`: the real web route is `/join/<code>`, no `/j/`.)
- Typecheck: `npm run typecheck -w mobile`. Root `tsconfig.json` excludes
  `apps/` — the app typechecks with its own config only.
