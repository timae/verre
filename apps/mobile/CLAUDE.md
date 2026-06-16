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
- **Custom dev client, local prebuild** (no Expo Go, no EAS): `npx expo run:ios`
  on the Mac (auto-prebuilds; `ios/` is gitignored — CNG). Simulator needs no
  Apple account; a physical device needs a free Apple ID (7-day expiry) until
  the paid program. The Linux sandbox cannot build iOS and cannot run `hermesc`
  — for a bundle smoke test use `npx expo export --platform ios --no-bytecode`.
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

Consequence for this app: the bottom nav IS `NativeTabs`
(`expo-router/unstable-native-tabs`, swapped in milestone 2 — PillTabBar is
gone). Tint-only knobs from theme tokens: `tintColor`=accent,
`backgroundColor`=surface, label/icon colors; SF Symbols for icons (OS
iconography is part of the native-chrome ruling). The undecided 4th slot is a
tappable "Soon" tab (`(tabs)/soon.tsx`) until explore-vs-notifications is
decided. `TAB_BAR_CLEARANCE` (now in `src/lib/layout.ts`) is breathing room
only — the react-native-screens tab host auto-insets content. Sheets, menus,
alerts, pickers: reach for the native primitive first when those screens land.

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
- **Tab bar hiding**: `NativeTabs` host prop `hidden` (pathname-keyed in
  `(tabs)/_layout.tsx`) — 02e hides the bar (footer action bar replaces the
  nav per design). Do NOT use the per-trigger `hidden` (that's the
  unnavigable-tab trap from M2).
- **Haptics** (`expo-haptics`): selection tick per 0.25 step while dragging,
  light impact on commit. No-ops in the Simulator — verify on device.
- **New native modules (M3)**: `expo-haptics`, `expo-linear-gradient`
  (hero scrim); **(M4)**: `expo-image-picker` (cover photo; config plugin
  carries the photosPermission copy in app.json),
  `@react-native-community/datetimepicker` (02a From–To, no plugin),
  `expo-blur` (the .ir-foot glass — the .vfoot Create bar is spec'd as a
  plain gradient, no blur); **(02s carousel)**: `@expo/ui` (ships WITH the SDK,
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
  cascade. Existing flavour chip data passes through saves untouched until
  the fill-track input lands (palette-gated — see the flavour-colours brief).

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

Built on `feature/mobile-create` (not yet committed; awaiting Simon's Simulator
check — no new native modules). Surfaces: the line-up + the impression detail.
Server contract is UNCHANGED and predates this work — four host/cohost-gated
endpoints: `POST|DELETE /api/session/:code/wines/:id/reveal` (reveal/hide one),
`POST …/wines/reveal-all`, `POST …/wines/hide-all`. Client fns of the same
names in `src/lib/api/sessions.ts`.

- **Reveal state = `!!wine.revealedAt`, the SINGLE source of truth in every
  case.** The host sees the full wine (incl. `revealedAt`) even under
  blind-for-all the moment it's revealed (`redactWine` returns the full row when
  `revealed`); an UNrevealed wine under blind-for-all comes back `_blind:true`
  with NO `revealedAt`. So a revealed wine ALWAYS carries `revealedAt`, and
  `_blind` true ⟺ not revealed. **`masked` must be `_blind && !revealedAt`** —
  a just-revealed blind-for-all wine is still `_blind` locally until the next
  poll brings the un-redacted fields, and rendering the placeholder then would
  contradict its own "Hide" pill. Reveal always wins (mirrors `wineRedaction.ts`).
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
    — the mock only stickies the mode strip). They sit inline above the line-up
    (below the ovc about block) and pin under the title bar once scrolled past —
    true `position:sticky; top:0`. **Two different impls per layout** (they must
    behave identically):
    - **Plain (no cover):** the title bar is a fixed non-overlapping `VBar`, so
      native sticky works. The tabs are a fixed View above the FlatList; the
      strip is a **sticky FlatList cell** — `STRIP_CELL` sentinel prepended to
      `data` (so wine `index` is offset by 1) + `stickyHeaderIndices={[1]}`.
      ⚠️ It's `[1]`, NOT `[0]`: a `ListHeaderComponent` (the ovc) shifts the
      indices by +1 (`stickyOffset = header ? 1 : 0` in RN's VirtualizedList).
      `ovc` stays the `ListHeaderComponent` and scrolls away.
    - **Cover-hero:** the title bar FLOATS (absolute) over the photo, so native
      sticky pins at offset 0 — *behind* the bar. Use the **Dynamic Overlay
      pattern** (community best-practice, verified by review + web research):
      one `Reanimated.ScrollView`, INLINE order **photo → tabs → about → strip →
      rows** (the design `.hero-sticky` puts tabs UNDER the photo, ABOVE the
      about block; the strip is separate, below the about — they are NOT one
      block, NOT adjacent). The inline copies are the at-rest UI + the flow
      spacers. Then **TWO** absolute `Reanimated.View` copies tracking `scrollY`
      (`useScrollOffset`): the **tabs** clamp at the bar bottom (`PIN_Y`); the
      **strip** STACKS under the pinned tabs (`floor = PIN_Y + tabsH`). Each is
      `translateY = clamp(top − scrollY, floor, top)`, gated `opacity`/
      `pointerEvents` on its own `tabsStuck`/`stripStuck` flag (flips at the same
      inequality its overlay clamps on → seamless swap). `tabsTop`/`tabsH`/
      `stripTop` measured via `onLayout` on **direct children of the scroll
      content** (= content-space Y; no coordinate bug). DEAD ENDS REJECTED: one
      combined tabs+strip block (moved the tabs BELOW the about — wrong order,
      the bug Simon caught); a fixed header region (pins permanently above the
      about); native `stickyHeaderIndices` under the floating bar (pins behind
      it; iOS `contentInset` to offset is a no-op on Android + two sticky cells
      diverged + collapse mis-fired + double title). See the big comment on
      `CoverHeroLineup`.
  - **Collapse is MEASURED, not a magic scroll constant.** The floating bar goes
    solid when the on-photo title's bottom scrolls under the bar bottom
    (`scrollY ≥ titleBottom − BAR_H`, `titleBottom` via `onLayout`) — like the
    impression hero. The old hardcoded `HERO_COLLAPSE_Y = 150` mis-fired on the
    proportional-height hero (collapsed too early → the on-photo title AND the
    bar title both showed). `BAR_H = heroBarHeight(insets.top) = insets.top + 34
    + 6` — does NOT add the bar's 1px rule (the border is drawn inside the box by
    the stretched bg layer, so it doesn't add to height; adding it pinned the
    sticky 1px low → a hairline seam). Overlays pin at `PIN_Y = BAR_H − 1` (1px
    overlap under the bar) as belt-and-suspenders against sub-pixel rounding.
  - **The collapsed title bars are SOLID OPAQUE with NO bottom rule** (Simon's
    rulings, deviating from the mock's 86%-translucent blur + box-shadow): the
    cover-hero `HeroTopBar`, the impression `FloatHead` collapsed state, and the
    impression bottom action bar (`FootBar`) are all flat `theme.bg`, BlurView
    removed (both `expo-blur` imports dropped). Pre-collapse over-the-photo
    states stay fully transparent (the immersive look is unchanged).
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
- **Known PRE-EXISTING gap (not this feature; M3 impression screen):** the
  impression detail reads `state.data?.wines` directly with no per-section
  graceful degradation, so a partial `/state` poll returning `wines:null` (the
  route isolates a failed section to null + 200) briefly flashes "This impression
  is gone" for a wine that still exists — and strands the host mid-reveal. The
  line-up guards this with its `lastRef` per-section merge; the impression screen
  should adopt the same. Out of scope for reveal/hide; flagged for a follow-up.

## Theme / design

- `src/theme/vero-tokens.js` is a **verbatim vendored copy** of
  `.local/design/vero-tokens.js` — never edit values in place; re-vendor.
  Components reference theme tokens via `useTheme()`/`textStyle()` — never raw
  hex (same rule as web's `components/CLAUDE.md`).
- UI copy comes from the handoff and is **final** ("Moment", "Impression",
  exact button labels). Code identifiers stay `session`/`wine`. On any
  role/permission conflict with the design, the shipped backend model wins.
- App display name is **Verre** ("Vero" was the design codename — appears only
  in the design files and the tokens filename).

## Release placeholders (freeze before first TestFlight upload)

- Bundle id + URL scheme: `io.verre.app` (placeholder, in `app.json`).
- `version` in `app.json` feeds the `X-Verre-Client` header
  (`src/lib/clientVersion.ts`). When EAS Update/OTA ever lands: report the OTA
  update id in the header's third slot AND pin `runtimeVersion` to the
  fingerprint policy first (proposal 04 §3a / 06 §6).

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
