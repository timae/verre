# apps/mobile — native app (Expo / React Native)

Local rules for the native app workspace. Root CLAUDE.md still applies. Design
source of truth: the Vero handoff in `.local/design/` (gitignored — ask Simon
if missing); proposals: `docs/dev/proposals/mobile-app/`.

## Toolchain facts (SDK 58 — verify against versioned docs, not memory)

- **Expo SDK 58, Expo Router `~58.x` (version-matched to the SDK), RN 0.88,
  React 19.3.** The router no longer depends on `@react-navigation/*` packages —
  it VENDORS them. Classic JS tabs (custom tab bars) come from
  **`expo-router/js-tabs`**; `NativeTabs` renders the OS tab bar and cannot do
  the Vero floating pill. Read https://docs.expo.dev/versions/v58.0.0/ before
  trusting recalled API shapes. Router-58 contracts the app depends on:
  `BottomTabBarProps` is `{ state, descriptors, emitter, navigateToTab, insets }`
  (no `navigation`) — `PillTabBar` emits `tabPress` via `emitter.emit` and
  navigates with `navigateToTab(route.key)` (the KEY — a route NAME only warns
  in dev and silently does nothing in release); a layout's cold-start route is
  `unstable_settings = { anchor }` (`initialRouteName` is deprecated and only
  warns); `Stack.Protected` guarded screens now render a redirect instead of
  unmounting (target: `redirectTo`, else the layout's anchor if unguarded,
  else the first unguarded child in sorted order); `freezeOnBlur` is
  always off (visited tab scenes stay mounted AND unfrozen — polls must gate on
  focus themselves, see `useSessionPoll`). 🔒 **A guard's default redirect
  targets the first unguarded sibling by GROUP href** ("/(tabs)" / "/(auth)"),
  and a group href only resolves if the group has an `index` leaf — `(tabs)`
  has none, so "/(tabs)" is `+not-found` ("Nothing here" after sign-in and on
  every signed-in cold start, device pass 2026-11-05). The `(auth)` guard in
  `src/app/_layout.tsx` therefore carries `redirectTo="/moments"`; keep it
  on any guard whose fallback would be `(tabs)`. Verify a redirect target the
  same way: `getStateFromPath(href, config)` must resolve to a leaf (the probe
  in the SDK 58 plan page runs the real router against `src/app`).
- **RN 0.88 ships the STRICT TypeScript API by default** (`types_generated`;
  SDK 56 was on the legacy types). Components are functions, not classes, so
  `useRef<View>` is a type error. Convention: type refs with the exported
  instance types — `useRef<ViewInstance>(null)`, `TextInputInstance`,
  `ScrollViewInstance` (`import { View, type ViewInstance } from 'react-native'`);
  `FlatList` is still a class and keeps `useRef<FlatList<T>>`. Strict list
  props reject `null` (`ListFooterComponent={cond ? <X/> : undefined}`). Do
  NOT reach for the `react-native-legacy-deep-imports` tsconfig condition — it
  only defers the same edit.
- **react-native-gesture-handler 3.x: the app stays on the BUILDER API
  (`Gesture.Pan()` + `GestureDetector`), which GH 3 marks `@deprecated` but
  still routes through its legacy detector** (no extra host view; nothing
  enforces the deprecation — tsc and the root ESLint config both ignore it).
  The hook API (`usePanGesture` …) is a SEPARATE, whole-app migration PR:
  relations (`simultaneousWithExternalGesture` etc.) cannot be set between
  hook-based and builder-based gestures, and `@gorhom/bottom-sheet` +
  `react-native-gesture-image-viewer` are builder-based. Never mix the two
  APIs in one relation.
- **New Architecture is mandatory** (SDK 55 dropped Legacy). Native libs must be
  installed at the SDK-pinned versions. ⚠️ `npx expo install` needs
  `api.expo.dev`, which this sandbox's network policy blocks — same pins are in
  `node_modules/expo/bundledNativeModules.json`: read the version there, edit
  `package.json` by hand, then run ONE root `npm install` (see the eviction
  trap below). Verify with `CI=1 EXPO_OFFLINE=1 npx expo install --check` from
  `apps/mobile` (works offline against the bundled map). ⚠️ An SDK bump that
  replaces hoisted `react-native`/`reanimated`/`worklets` can leave the OLD
  copy at root `node_modules` (kept as a peer-satisfying node from the stale
  lockfile) with the NEW one nested under `apps/mobile/node_modules` — the
  tell is `apps/mobile/node_modules` holding more than `@better-auth`,
  `better-call`, `typescript`, `zod`. `npm dedupe` does not fix it; delete
  `package-lock.json` + every `node_modules` and reinstall from the manifests.
- **Custom dev client, tracked iOS project** (no Expo Go, no EAS): `ios/` is
  checked in so a fresh clone can open `ios/Verre.xcworkspace` in Xcode.
  `Pods/` stays gitignored; run `cd ios && pod install` after cloning or when
  native dependencies change. Android remains CNG/generated for now.
  ⚠️ **Expo CLI 58 prebuild is CLEAN BY DEFAULT**: a plain
  `npx expo prebuild --platform ios` deletes `ios/` and regenerates it from the
  SDK template + config plugins (`--no-clean` keeps the existing project).
  Regeneration is the sanctioned way to take an SDK's native-template changes;
  afterwards re-apply the ONE hand edit (`Verre.xcscheme` LaunchAction
  `buildConfiguration = "Release"`), then grep `project.pbxproj` for an EMPTY
  `DEVELOPMENT_TEAM` before committing (device builds write the Apple Team
  ID into it; `project.pbxproj` + `Podfile.lock` are kept
  `git update-index --skip-worktree` on dev machines for that reason — lift
  it before a prebuild so the regenerated files are reviewable, re-set it
  after committing), and diff the regenerated `Info.plist` / `.xcscheme`
  against the template rather than trusting them: a prebuild over an
  existing project has duplicated `CFBundleURLSchemes` entries, and the
  template ships a `TestableReference` to a test target this project does
  not have plus `MARKETING_VERSION = 1.0` (the app's version lives in
  `app.json` → `Info.plist`). `UIViewControllerBasedStatusBarAppearance`
  is `true` since SDK 58 (template value; the SDK 56 project had `false`)
  and must STAY true: apps built with the iOS 27 SDK can't use the
  app-level status-bar API that `false` relies on. 🔒 Consequence: on iOS
  the JS `<StatusBar>` element is never consulted — react-native-screens
  swizzles every view controller's status-bar query and forwards it to the
  topmost screen, and a screen with no explicit style reports `auto` (the
  PHONE's appearance, not the app theme → black glyphs on the dark theme,
  device pass 2026-11-05). The style is therefore a SCREEN OPTION:
  `statusBarStyle` on the root Stack's `screenOptions` in
  `src/app/_layout.tsx`, derived from the theme; deeper screens without
  their own style inherit it. A screen that needs a different style sets
  its own `statusBarStyle` option, never a `<StatusBar>` element — the
  DEEPEST screen with the trait set wins (RNS `findChildVCForConfigAndTrait`
  walks down to the top screen of every nested stack), so a pushed screen
  without one falls back to the root's themed style by itself. The
  photo-hero screens (welcome, session line-up, impression) do this via
  `<Stack.Screen options={{ statusBarStyle }}>` (Codex review, 2026-11-06:
  their `<StatusBar style="light">` elements had silently stopped working —
  dark glyphs over the photo on the light theme). They keep the element too,
  for Android only, where expo-status-bar still drives the bar and is
  last-mounted-wins. 🔒 A screen presented as a MODAL (`presentation:
  'transparentModal'`, the feed's impression detail) is skipped by that walk
  (`includingModals:NO`, RNS doesn't set the capture flag), so its own
  status-bar options are never honoured — the root-level screen's traits
  answer while it is up. 🔒 The fullscreen photo viewers (`ui/FullscreenImage`,
  `feed/FullscreenGallery`) present their RN `Modal` **overFullScreen**: a
  fullScreen cross-dissolve presented from that transparent-modal detail hid
  the detail for the whole fade and the feed list showed through (device,
  2026-11-06). Under overFullScreen UIKit never asks the modal's controller
  for the status bar, so hiding it is the ROOT Stack's `statusBarHidden`
  trait, driven by `lib/fullscreenViewer` (`useReportFullscreenViewer` in the
  viewers, `useFullscreenViewerOpen` in `_layout.tsx`), AND the nearest
  screen's trait, which the same hook sets with `navigation.setOptions` and
  RESTORES in its cleanup — a `fullScreenModal` host (feed edit details) is
  asked by UIKit directly, so the root trait never reaches it, and a
  `<Stack.Screen>` element would not do: expo-router's `Screen` only calls
  `setOptions` and leaves the override behind on unmount, so a host that
  drops the photo while the viewer is open would strand the bar hidden
  (Codex, 2026-11-06). The gallery keys the hook on `visible &&
  pages.length > 0`, since it renders no Modal without a photo-bearing page.
  The viewers' static `<StatusBar hidden />` is the Android path only. Do not switch them back to
  fullScreen: RN 0.88's modal controller then answers for the bar itself and
  captures the pre-modal state, which needs the `onShow` dance this replaced.
  Everything else
  in `ios/` (permission copy, URL scheme, icon, `RNS_GAMMA_ENABLED`,
  `Podfile.properties.json`, the splash storyboard + `SplashScreenLogo`
  imageset) derives from `app.json` + plugins. ⚠️ The splash plugin only
  writes the storyboard's dark background INSIDE its image step: an
  `expo-splash-screen` config without an iOS `image` leaves the template's
  white `systemBackgroundColor` (seen 2026-11-05). The splash is therefore
  configured platform-neutrally — dark `#1a1815` + the 76 pt icon on BOTH
  platforms (Simon's ruling, 2026-11-05) — so the plugin owns the storyboard;
  don't move the image back under `android` only.
  `npx expo run:ios` on the Mac may also rewrite tracked `ios/` files — review
  those diffs before committing. Simulator needs no Apple account; a physical
  device needs a free Apple ID (7-day expiry) until the paid program. The Linux
  sandbox cannot build iOS and cannot run `hermesc` — for a bundle smoke test
  use `npx expo export --platform ios --no-bytecode`.
- **Xcode 27 + the UIKit scene life cycle.** The iOS 27 SDK requires a
  scene-based life cycle; since the SDK 58 prebuild `ios/Verre/` carries
  `SceneDelegate.swift` (`ExpoAppSceneDelegate`) + a
  `UIApplicationSceneManifest` in `Info.plist`, and `AppDelegate.swift` no
  longer creates the window or overrides the Linking / Universal-Links
  callbacks — the scene delegate forwards URLs. Cold-start deep links and URL-open-while-running are
  therefore device-pass items after ANY native-template change. Expo CLI 58
  knows Xcode 27's DeviceHub. Build with Xcode 27 only; Xcode 26 was a one-off
  workaround for SDK 56. Xcode 27 rejects deployment targets below iOS 15, and
  `react_native_post_install` raises the pod targets but NOT the pods'
  resource-bundle targets (RNCAsyncStorage resources 13.4, RNSVG filters 12.4 →
  `xcodebuild exited with error code 65`). The SDK 58 `pod install` went
  through on Xcode 27 without a workaround; if the build ever trips on it,
  add to the Podfile's `post_install`, after `react_native_post_install`,
  a loop over `installer.pods_project.targets` that raises each
  configuration's `IPHONEOS_DEPLOYMENT_TARGET` below
  `podfile_properties['ios.deploymentTarget']` to that value — and treat it
  as a tracked hand edit to re-apply after every prebuild.
- ⚠️ **iOS 26 flipped the back-gesture default to FULL-SCREEN swipe.**
  react-native-screens' `fullScreenSwipeEnabled` defaults to true on iOS ≥ 26
  (the native `interactiveContentPopGestureRecognizer`) — a right-swipe
  ANYWHERE pops the screen and `gestureResponseDistance` no longer protects
  drag surfaces (verified in RNS 4.25.2 source, `isFullScreenSwipeEffectivelyEnabled`).
  Every Stack layout therefore sets `fullScreenGestureEnabled: false`
  (Simon's edge-only ruling, 2026-07-12); keep it on any NEW Stack layout, and
  drag-heavy screens still add `gestureResponseDistance: { start: 15 }` for
  the edge recognizer.
- ⚠️ **Reanimated static flag `IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS: true`**
  (`package.json` → `reanimated.staticFeatureFlags`; the pod reads
  `<installation_root>/../package.json` and the canonical Podfile is
  `apps/mobile/ios/Podfile`, so it lives HERE, not repo root — a STALE,
  gitignored `/ios` at the repo root (June 2026 prebuild artifact, lowercase
  `verre.xcodeproj`) has misled a review into thinking otherwise; never build
  from it, and delete it when convenient. Takes effect on `pod install` +
  native rebuild). It puts per-frame animated updates of an
  ALLOWLISTED prop set (`transform`, `opacity`, colors, border radii — see
  `ReanimatedModuleProxy.cpp`) on a synchronous UI-thread fast path. Two
  invariants: (1) the fast path is ALL-OR-NOTHING per view — a `useAnimatedStyle`
  worklet on a hot view must return ONLY allowlisted keys (even a static
  `left: 0` in the returned object demotes the whole view); (2) reanimated's
  own `ENABLE_SHARED_ELEMENT_TRANSITIONS` flag DISABLES this path entirely —
  never enable it; (3) since reanimated 4.7 the path is ALSO gated on
  `USE_ANIMATION_BACKEND` being false (its default) — leave that flag alone.
  🔒 **A React commit sees only reanimated's FLUSHED registry.** The commit
  hook overlays the registry's last flushed values on every React commit,
  while values a worklet writes in the same frame sit in a batch until the
  next UI frame. So "re-render the tree in a new order and have the worklet
  zero the stale transforms in the same commit" is a RACE between that
  flush and the commit (reanimated 4.7, device pass 2026-11-06: the
  reorder sometimes painted the new order wearing the frozen drag
  transforms and sprang back ~250 ms later). Any hand-off from
  UI-thread transforms to a React re-render must not depend on that order:
  `DraggableRows` keys its rows on the render generation so a reorder
  MOUNTS FRESH views (no registry entries to overlay). Confirmed on device
  2026-11-06. Two wrong guesses came before the real cause, both tested on
  device, don't repeat them: `FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS:
  false` (no effect) and `DISABLE_COMMIT_PAUSING_MECHANISM: true` (changed
  the odds only); neither is set — reanimated runs its defaults apart from
  the sync-props flag above. The flag is GLOBAL: hit-testing runs against shadow-tree
  geometry, so a view mid-animation can briefly receive touches at its
  pre-frame position — device-check drag surfaces (PillTabBar lens,
  DraggableRows, pickers) after reanimated bumps. Motivation: the feed
  detail's transform-only hero clone (proposal 09 §Snappiness pass).
  **`pointerEvents` is NOT allowlisted.** The feed detail physically confirmed
  that animating it on the same content/bar views as opacity/transform causes a
  post-settle background-only flash on device (not Simulator). Keep hit-test
  gates on those hot views in plain React state: block during open/dismiss,
  enable at open settle, and re-enable after a cancelled dismiss.
- **Monorepo**: npm workspace member; Metro auto-detects workspaces (SDK 52+)
  and resolves `@verre/core`'s raw-TS `exports` (package-exports on by default
  since SDK 53). No metro.config.js exists — don't add one just to "fix"
  resolution, and never set `unstable_enablePackageExports: false`.
- **React is pinned EXACTLY (`19.3.0`) in BOTH package.jsons — root web app
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
  release + `cancelAnimation` on re-grab (upstream stopped dead on let go). On
  2.6.0 the glide REPLACES the zoomed pan's `startPanInertia` call in its
  `onEnd`: upstream's own `panInertia` is left disabled (a different
  deceleration curve; adopting it is a design decision), and the clamp uses
  upstream's `getTranslationBounds`, the same bounds the drag uses. (2.3.2's
  patch also replaced the `InteractionManager` initial-scroll deferral, which
  crashed on RN 0.88; upstream 2.6.0 ships its own `scheduleInitialScroll`,
  so that hunk is gone.) 3.x is a paging-API rewrite, not a bump. The
  patch filename is **version-pinned** — bumping the library makes patch-package
  warn loudly and the patch must be regenerated (`npx patch-package
  react-native-gesture-image-viewer` after re-applying the edits to
  `lib/module/useGestureViewer.js`), or upstreamed as a PR (the proper fix is
  configurable props). It powers `components/ui/FullscreenImage.tsx` (single
  image, tap dismisses) and `components/feed/FullscreenGallery.tsx` (the feed
  detail's cross-impression gallery: glass panel rides the bottom, tap
  TOGGLES the info per the design's `gFull`, closing lands the pager — a
  deliberate behavioural fork, keep both).

## Auth (Better Auth client)

- **Version lockstep is mandatory**: `better-auth`, `@better-auth/expo`, and
  `@better-auth/core` are pinned to the SAME exact version as the server's
  root pin (root `package.json` also carries an `overrides` entry for core).
  Bumping any of them = bumping all, server included → re-run the CI gates.
- The server side of the Expo integration is a **vendored bridge** in
  `lib/betterAuth.ts` (vendored when the real `@better-auth/expo` couldn't
  resolve at the repo root next to web's zod 3; the root is on zod 4 now, and
  the swap waits for social sign-in, which needs the rest of the plugin — see
  the plugins comment there).
- `authClient` baseURL must include the full basePath (`…/api/auth/native`).
  Session cookie lives in SecureStore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, never
  `requireAuthentication` — the SDK reads it on every request).
- 🔒 **Reinstall guard = install-scoped Keychain keys** (`src/lib/secureStorage.ts`,
  proposal 06 §2): iOS keeps Keychain items when the app is deleted, and
  native sessions last a year, so a reinstall would otherwise open signed in
  as the previous person. Every SecureStore key the SDK uses is prefixed with
  an install id kept in AsyncStorage (`verre.installId`, inside the app
  container, deleted with the app). A reinstall gets a new id and never reads
  the previous install's items: online or offline, whatever the Keychain does
  with a delete, whatever chunk keys the SDK wrote. An update or an Offload
  keeps the container, so the session survives. There is NO boot step: no
  marker, no wipe, no ordering rule for `RootNavigator`. Rules: the storage
  passed to `expoClient` must stay `secureStorage` (the SDK 1.7.18 calls only
  its async pair; the sync pair THROWS so a future SDK that reads
  synchronously fails loudly — re-check on every Better Auth bump); never
  call `AsyncStorage.clear()` or remove `verre.installId` (that signs the user
  out, by design: it fails closed); 🔒 auth state is only ever stored under
  the DURABLE id: while it can't be read (or, on a fresh install, written),
  reads find nothing and writes are refused (no throwaway namespace — a
  sign-in + sign-out there would leave the real session to be restored on
  the next healthy launch), and every storage call retries, so a recovery
  mid-launch moves straight onto the real namespace. The stored id is never
  overwritten. The
  previous install's server session is revoked in the background by
  `src/lib/previousInstall.ts` (started from `RootLayout`): an unscoped
  Keychain pointer (`verre_install`) names the install that wrote it, the
  revoke is a PLAIN `fetch` to `/sign-out` that never touches Better Auth's
  client state, and until the server answers it stays recorded
  (`verre.retiringInstall`) and the next launch retries. A pre-scoping install
  (unprefixed keys, dev devices only) is retired the same way, so it signs
  out once. Since expo-secure-store 58.0.0 a refused delete REJECTS (it used
  to be discarded); nothing depends on deletes any more.
- 🔒 **Sign-out races** (`src/lib/authGate.ts`): ORDERING (`@better-auth/expo`
  1.7): the client restores its session atom ONCE from `verre_session_data`,
  inside the init hook of the first get-session (before `customFetchImpl`),
  and keeps a restored session `isPending` until the heartbeat answers, so
  `_layout.tsx` counts a restored session as known (`cachedSession`) and a
  signed-in cold launch paints from the cache as it did on 1.6. The gate
  keeps an auth generation (a sign-out bumps when it STARTS, a
  session-cookie-setting response bumps on arrival) and discards a response
  from an older generation, so a slow anonymous heartbeat can't sign a fresh
  login out — checked AFTER the body is buffered, because Expo's fetch
  resolves at the headers and better-fetch writes state only after awaiting
  the body. Two fetch plugins in authClient.ts bracket `expoClient` in the
  `plugins` array (better-fetch runs hooks in plugin order) and must stay on
  their side of it: AHEAD, every request is stamped with the generation
  BEFORE the Expo client's init awaits the cookie read, and a sign-out bumps
  it first (that init clears the atom before the request leaves);
  `customFetchImpl` drops a request whose stamp went stale before sending it;
  BEHIND, a get-session is checked once more after the Expo client's awaited
  Keychain writes, just before the SDK applies it to the atom (a sign-out
  started during those writes would otherwise be undone and, offline, stay
  undone). The generation only catches requests built BEFORE a sign-out; a
  heartbeat built after it starts can still read the old cookie, so the
  signed-out latch (`cookieWithheld`): from a sign-out's start until a
  response sets a NEW session cookie, no request except a sign-out carries
  the session cookie, in `customFetchImpl`'s gate and in `apiFetch` alike,
  checked after the async cookie read. `authClient.getCookie()` is async
  since 1.7 — await it. Never add a BA request path that bypasses
  `customFetchImpl`.
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
- 🔒 **The cache is cleared when the signed-in user changes** (sign-out, a
  revoked session): `RootNavigator` (`app/_layout.tsx`) calls
  `clearViewerCache()` (`lib/query.tsx`), because the client is a process
  singleton and nearly every key (feeds, profiles, moments) is
  viewer-dependent without carrying the viewer in the key. It bumps a viewer
  EPOCH: any `setQueryData` that runs after an await (an optimistic rollback)
  must check `viewerCacheEpoch()` and skip if it moved, or a late write
  recreates the previous viewer's data in the cleared cache (`setQueriesData`
  can't recreate a removed entry, so it needn't). After a write, CANCEL before
  refetching or invalidating: TanStack reuses an in-flight FIRST load (no data
  yet) instead of restarting it (`lib/feedCache.ts` `cancelThenRefetch`).
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
decided. ⚠️ The pill sits `TAB_BAR_BOTTOM` (21pt) above the PHYSICAL screen
edge, over the home indicator, not the safe area (2026-11-10, ADR-0006
addendum). `TAB_BAR_CLEARANCE` (`src/lib/layout.ts`, derived from it, 103) is
REAL clearance: the pill is an absolute overlay, nothing auto-insets for it, so
every scrolling tab screen pads `TAB_BAR_CLEARANCE` ALONE. Never add
`insets.bottom` to it (CI-gated by `check-mobile-design-tokens`). Sheets, menus,
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
- **Dropping in a native OS component** (a `@react-native-community` picker, the
  native stack back-gesture, any UIKit-backed control) that looks wrong on a dark
  theme or whose gesture fights the app → read
  `docs/design/patterns/native-component-theming-gotchas.md`. Covers the
  `themeVariant={theme.scheme}` picker-legibility fix and the
  `gestureResponseDistance` edge-back-vs-slider fix.

**Existing shared primitives (the canonical things — reuse these).** Paths below
are relative to `apps/mobile/src/components/` (e.g. `ui/VText.tsx` =
`apps/mobile/src/components/ui/VText.tsx`); `lib/` paths are `apps/mobile/src/lib/`.
- **Text**: `VText` (`ui/VText.tsx`) — themed Text w/ `variant` + `color` token. Every label starts here. For capped/fixed-format or compact surfaces, pass `surface="compactList" | "carousel" | "badge" | "score" | "code" | ...`; do not write inline `maxFontSizeMultiplier`. ⛔ **Inline `fontSize`/`lineHeight` on text is a VIOLATION, not a tweak** — sizes come from the `variant` type-scale tokens (weight/`fontFamily` and color overrides are fine; `letterSpacing` where a ruled look needs it). The rule was guidance-only and drifted (2026-07 audit: the aroma sheet family accumulated 26 literals at 10–12.5, every one on a VText, each copied from its neighbor — AND `surface="badge"` on prose froze it under Dynamic Type). Mapping: content/prose → `small` (or `body`); metadata sublines → `caption`; mini section labels → `label` when the source text is uppercase, else `caption`+semibold; counters/numerals may keep `surface="badge"`. Sanctioned exceptions (SVG canvases, badge/pill anatomy, `code`/`carousel`/score surfaces, chrome with load-bearing metrics, mock-pixel hero blocks) are NAMED in `scripts/check-mobile-design-tokens.mjs` `ALLOW_FONTSIZE` — the gate FAILS on any literal outside that list; adding a file = claiming one of those categories, in a comment, expecting challenge.
- **Button**: `Button` (`ui/Button.tsx`) — `primary/positive/secondary/tertiary/danger`, `sm/md/lg`, `bar`, `block`, `loading`+`loadingTitle`, `critical` (tertiary only: a red text action; `danger` is the FILLED red one). Any real button. It owns the Dynamic Type `button` surface; don't recreate fixed-height text buttons.
- **Icon**: `Icon` (`ui/Icon.tsx`) — the vendored 24×24 SVG set (`IconName` union). All iconography. Add new glyphs here, never inline an SVG.
- **Text input**: `TextField` (`ui/TextField.tsx`) single-line; `NotesField` (`moments/momentForm.tsx`) multiline; `SheetSearchField` (`ui/SheetSearchField.tsx`) is the ONE compact search pill used by compare, People/Invite, recents, AromaInput, and Aroma Details — never import a generic search control from a feature component. `TextField` owns the `formControl` Dynamic Type surface and deliberately omits `lineHeight` on single-line `TextInput` so iOS centers entered glyphs correctly. A single-line `TextField` always sends an explicit paragraph style (`lineBreakModeIOS="tail"`; not the paragraph default, word wrapping, which likely caused the July wrap-on-blur bug) and `letterSpacing: 0`: a DEFENSIVE workaround for a placeholder seen ~14pt low and clipped, intermittently, gone after a relaunch (2026-11-09). Hypothesis, UNVERIFIED on device: Fabric recycles native text fields on iOS and UIKit keeps an attribute RN leaves unset from the previous field (e.g. `ScoreInput`'s lineHeight 48 would give that offset). Keep the two defaults; drop the hypothesis if a repro ever shows otherwise. Pass `surface="code"` for fixed-format codes. **Error state**: `error="msg"` = red border + inline message; `invalid` (boolean) = red border ONLY (for a form-level summary that carries the copy). Both set `aria-invalid`. `DateField` (`moments/momentForm.tsx`) mirrors this with an `error?: boolean` border flag + a `placeholder` prop (a REQUIRED date field passes e.g. "Tap to set" so the empty state doesn't read "Optional"). (A shared `<TextArea>` is a pending extraction — see below.)
- **Bottom sheet**: `Sheet` (`ui/Sheet.tsx`) — the gorhom shell (themed bg/handle/backdrop + tab-bar-hide). All sheets. 🔒 Every SCREEN that renders one (incl. `OptionSheet` / `CountrySheet`) wraps itself in `BottomSheetModalProvider`: there is no root provider (`app/_layout.tsx`), and a screen without one crashes the moment it mounts ("'BottomSheetModalInternalContext' cannot be null", Settings → Privacy, device pass 2026-11-11). tsc and `expo export` can't catch it. ⚠️ Two load-bearing gorhom facts baked into the shell + consumers: (1) the BACKDROP renders as a no-zIndex sibling BEFORE the sheet container, so the shell z-indexes backdrop (99) + container (100) — without that, a screen's zIndexed absolute overlays (hero bar, sticky tab/rail overlays, reconnecting bar) paint OVER the dim layer (`containerStyle` alone does NOT reach the backdrop — a fix that "looks right" but isn't); (2) sizing is two-mode: dynamic fit-to-content (`maxDynamicContentSize`, plain-View rows — a `BottomSheetScrollView` measures 0 under dynamic sizing) while content fits, or fixed-snap + `BottomSheetScrollView` when it can't (rows past the cap CLIP unreachably under dynamic sizing). The compare sheets (`CompareBody.tsx`) show the cap-aware mode switch + the search height-lock recipe; (3) 🔒 **sheet-scroll invariant: NEVER wrap a `BottomSheetScrollView` in a `BottomSheetView`** — BottomSheetView's mount effect re-registers the sheet's scrollable as `type: VIEW` (child effects run first, so it always wins), which sends content drags into the sheet's over-drag branch and pins the list to offset 0: the sheet "isn't scrollable" on device (found via the 100-taster stress seed, 2026-07-17 — latent in EVERY scroll-mode sheet; only surfaces with content long enough to scroll). In fixed-snap scroll mode wrap with a plain `View` (dual-mode sheets: `const Wrap = scrolls ? View : BottomSheetView` — dynamic fit-to-content still needs BottomSheetView's measurement).
- **Segmented pill switcher**: `Segmented` (`ui/Segmented.tsx`) — the rounded `theme.bg` track with a `theme.surface` pill on the active segment. Two metric sets: default (full-width flex-1 segments — the BrowseSheet picker switcher + the aroma detail sheet's 3d tabs) and `compact` (content-sized mini twin — the ListPicker look switcher). ALL pill-track tab switching routes through this; the dev gallery's knobPill copies are lab code and stay local. Screen-level chrome stays `SessionTabs` (underline) / `PillTabBar` (bottom nav) — this is the IN-SHEET / in-panel pattern.
- **Anchored dropdown menu**: `ui/AnchoredMenu.tsx` — `AnchoredMenu` (the `.ir-menu` panel: Modal shell + surface card + `elevation.menu` shadow + dur1 fade/4px-rise + flip-up-near-bottom, `{top,bottom}` anchor), `MenuItem` (icon/label row, `tone`/`disabled`/`active`), `MenuSeparator`, `AnchorButton` (measure-self ⋯ trigger). ALL ⋯ dropdowns route through this. (Anchor to a ROW not the button → keep a manual `rowRef.measureInWindow` like PeopleSheet's PersonRow.)
- **Query-failure UI**: `ui/ConnectionState.tsx` — `ErrorState` (full-screen + retry), `ConnectionBanner`, `ReconnectingBar`, `connectionView()`. All poll/error affordances.
- **Terminal centered message**: `CenteredMessage` (`ui/ConnectionState.tsx`) — `title` + optional `body`, vertically centered, NO retry (the no-button sibling of `ErrorState`). For dead-end states a refetch can't fix ("this impression is gone", "you can't edit this"); pass `pending` to blank the copy while a query resolves. Caller owns the bar above it. Reuse instead of re-rolling the flex-center block.
- **QR**: `QrCode` (`ui/QrCode.tsx`).
- **Score READ**: `StarScore` (`scoring/StarScore.tsx`) — the one-star + value (`★ 4.25`). Never inline a star.
- **Score WRITE**: `ScoreInput` (`scoring/ScoreInput.tsx`) — wide slider + editable number + word (gesture+haptics). The editable score numeral uses the `score` Dynamic Type surface, not the generic badge/code surfaces.
- **Structure wheel (READ)**: `StructureWheel` (`scoring/StructureWheel.tsx`) — renamed from FlavourWheel 2026-07-11 (Simon; the axes ARE structure intensities).
- **Group charts (02d Compare)**: `ComparisonWheel` (`scoring/ComparisonWheel.tsx`, the C1b min→max band wheel, wedge tap → drill-in) + `RadarOverlay` (`scoring/RadarOverlay.tsx`, ≤4-taster overlaid radar). Geometry from `@verre/core` (`comparisonWheelGeometry`/`radarOverlayGeometry`); aggregation from `aggregateFlavourAxes` (client-side per the §7 ruling — no server aggregate). Person-series colours via `usePersonColors()` (`theme/flavourColors.ts` — derived from the palette base ramp, stable roster-index assignment). ⚠️ The labelled charts' natural canvas (size 232 + 2×58 pad = 348pt) is WIDER than a small phone's content column — every host must measure its width (`onLayout`) and pass `maxWidth` (all three wheels + `StructureWheel` take it; it scales the whole SVG uniformly, the design's `.radar { max-width:100% }`).
- **Session-screen chrome (line-up 02b + compare 02d)**: `SessionTabs` (`moments/SessionTabs.tsx` — the .vtabs strip, CONTROLLED: Compare is an **in-screen tab swap** per Simon's 2026-07-02 ruling — everything above the tabs (bar or cover hero) stays, no route change, no back-to-line-up; the Add pill + reveal strip are line-up furniture and hide on Compare), `CompareBody`/`CompareToolbar`/`ComparePickerSheet`/`buildComparePeople` (`moments/CompareBody.tsx` — the whole 02d compare surface; **the behaviour spec-of-record is `docs/dev/proposals/structure-wheel.md` §7 + ADR-0005 — read those before touching it**. Headlines: multi-open collapsed-by-default cards; cards render in LINE-UP order by default with a toolbar sort menu (line-up / highest / lowest rated / most / least agreement / most ratings) + an impression search (name/producer/vintage/grape/type/region/country — NOT link/vinification/description); the picker sheet is the ONLY select/deselect surface since the toolbar superseded the 02d·4 avatar-chip rail (Simon 2026-07-03; screen-owned hidden set; deselected people vanish from cards, header recomputes; toolbar sticky like the reveal strip — plain: `stickyHeaderIndices`, hero: the strip overlay slot, where it renders TWICE — search value must stay screen state); chart mode keys on the STRUCTURE-ENGAGED taster count; person rows are per-person DETAIL views, not toggles; axis drill-in from C1b wedges or radar labels; Show-all sheet), `SessionMenu`/`SessionMenuButton`/`useBlindForEveryoneToggle` (`moments/SessionMenu.tsx` — the ⋯ menu (People/Share/Settings) + the optimistic blind-for-all mutation; the Blind-for-all ROW lives in the line-up's eye menu since ADR-0007, not here), `SessionFatalView` (`moments/SessionFatalView.tsx` — gone/removed/banned/invalid terminal states).
- **Session poll bootstrap**: `useSessionPoll(code)` (`lib/useSessionPoll.ts`) — visit → `/state` poll → per-section `lastRef` merge (keyed on code+identity, checked synchronously) + fatal/removed handling. ANY new screen reading the shared `/state` poll uses this hook (the impression detail still carries its own pre-hook copy of the merge — migrate when next touched).
- **Structure WRITE**: `StructureInput` (`scoring/StructureInput.tsx`, renamed from FlavourInput 2026-07-11) — the per-axis fill-track grid (whole 0–5 steps, gesture+haptics, VoiceOver-adjustable); axes from `resolveAxes`, colour from the active theme via `useFlavourColors()` (`theme/flavourColors.ts`). ⭐Fill = the BADGE TINT `mix(colour, surface, 0.72)` + plain ink label, NO halo (Simon's ruling 2026-07-11 — a sanctioned deviation from the mock's solid .filltrack fill; matches the wheel's wedge wash formula). ALL structure-intensity input.
- **Rating block (WRITE)**: `RatingSection` (`scoring/RatingSection.tsx`) — THE score · note · structure (ⓘ intensity reference) · aromas section, shared VERBATIM by the moment impression screen (02e) and the standalone check-in rate stage (Simon 2026-07-12: one component so a future ordering/copy/behaviour change lands on both; the impression's anatomy — Score → Your Note → Structure → Aromas — is the spec). Structure is ALWAYS OPEN (Simon 2026-07-17 — supersedes the adaptive fold + its engagement-seeded open flag). Fully controlled: screens own every value; pairs with `useAromaSearchScroll` (`scoring/aroma/useAromaSearchScroll.ts`), the shared screen-side keyboard-fit hook (screen provides scrollRef + a scrollY-tracking onScroll). Don't hand-compose these widgets on a new rating surface.
- **Feed-post edit (2026-07-17)**: owner-only ⋯ on both feed cards (`feed/FeedCardMenu.tsx` — AnchorButton + AnchoredMenu; the list screen passes `onEdit` only for the viewer's own posts, session cards target the ACTIVE carousel slide's wine id) + the detail menu's Edit row → `feed/edit/[id]` (`?wine=` for session kind). ONE screen, two variants: session = prefilled `RatingSection` only; standalone = the tappable impression SQUARE (photo · name · producer → pushes `feed/edit/details`, the create stage-1 field anatomy seeded from `lib/checkinEdit.ts` — the module edit store; photo edit adds the unchanged/replaced/removed tri-state) above the rating block. Save PATCHes `/api/checkins/:id` (`patchCheckin` / `patchSessionRating` in `lib/api/feed.ts`) and maps the echo into EVERY `['feed', …]` cache IN PLACE (`lib/feedCache.ts` — never invalidate); a reaped session rating (`feedItemDeleted`) refetches in place instead. Tab pill hides on `/feed/edit*` like the create stages. DELETE (2026-07-18): the same ⋯ menus (cards + detail) carry a danger row — standalone “Delete” = `deleteCheckin` (`DELETE /api/checkins/:id`, standalone-only server-side, S3 reclaimed); session “Delete Rating” = the empty-PATCH reap on the ACTIVE slide's wine (post survives unless that emptied it). Both confirm via the house native `Alert.alert` destructive pattern, NAMING the target (blind wines use the card alias “Wine N”); on success the item/wine is dropped from every feed cache IMMEDIATELY (`updateFeedCaches` → awaited in-place `refetchFeedCaches` — leaving the card actionable until a refetch landed let a second delete 404, a Codex catch), and the detail pops straight to the feed (`closeDetail`, no reversed presentation — the card underneath is gone) whenever the POST went away. ⚠️ The edit screens are declared `presentation: 'fullScreenModal'` in the feed stack (BOTH stages): a default card push from the transparentModal detail gets presented modally by UIKit — the partial pageSheet look Simon rejected (2026-07-18).
- **Compare aromas (02d, §8/§9)**: `AromaCompareStrip` + `AromaDetailSheet` (`moments/`) over the ONE per-card `buildCompareAromaModel` from `moments/aromaCompareView.ts` — 🔒 CompareBody builds the model only while that card/detail sheet is open, memoized by `compareAromaInputSignature`, and passes it to every compare-aroma surface; never let a renderer re-derive consensus/contributors itself. Unknown-only historical aroma ids do not admit a dead card (`hasResolvableAroma`). Aggregate counts + contributor identities share core `aromaAncestorChain`; the model derives ONE `pronouncedIds` set consumed by strip + sheet. **The Aroma Bun and the consensus-TREE render are REMOVED from production (Simon 2026-07-19)** — `model.bun`/`consensusBunNotes` + the viz geometry remain dev-gallery lab material only. Every derivation is pure + pinned in `.local/test-env/scripts/aroma-aggregate-units.ts` (steps 37b–40): mode fork, `detailPillColors` (per-theme contrast ladder — clay = solid rung), `packStrip` (measured widths, always-present tail — deliberately separate from `packChips`, see its comment), the Overview/pyramid/fingerprint derivations below. Strip width keys include id + live count + pronounced state; an open popover remeasures its trigger after renders so poll reflow cannot strand it. `AromaDetailSheet` is a FIXED 85% scroll sheet across every tab — never dynamic-size it per tab. Tab order is ALWAYS Overview / People / All Aromas (fallback keeps the Overview tab — rail parity, Simon 2026-07-19); switching tabs must not move the sheet. The detail sheet contains: **Overview** (the 2026-07-19 scientific-review + Simon-rounds redesign — spec below) / **All Aromas** (the Top-10 true-triangle PYRAMID above a toolbar with the compact Mentions/Family switch on the LEFT and the standard `SheetSearchField` filling the RIGHT of the SAME ROW—the app-wide toolbar order; Mentions = one FLAT occurrence-ranked field of exact canonical `AromaChip` pairs, so modifiers remain inside the badge exactly like impression detail; Family = the SAME badges grouped under a family dot/header, ranked by each family's summed literal family/subfamily/leaf mentions, with occurrence-ranked badges inside; taxonomy order only breaks ties; every badge count is distinct tasters for that exact pair; no base-heading/modifier-tally analytics) / **People** (search matches BOTH names and aroma vocabulary, including a family query such as Fruity matching descendant picks; within every matching person, matching badges move FIRST and nonmatches use the same `muted` paling as AromaInput search; established Moments/Compare row anatomy with comfort-scaled 40pt Avatar + name + exact `AromaReadChips`, roster order, two-line collapse; "+N more" PUSHES the established full-badge read sheet titled in Title Case: "`<Name> Perceived N Aromas`"). `AromaBadgePopover` is the ONE ruled Badge-Extension shell: Tier-2, All-Aromas badges, and People badges all reuse it; it renders OUTSIDE the gorhom sheet tree so opening it can never alter sheet measurement. A People badge says "Also perceived by" and excludes its row owner; the rejected duplicate inline "Perceived by" block under All Aromas stays removed. People also shows `aromaTasteSummary`: weighted taxonomy Dice (family 1, subfamily 2, leaf 3, explicit modifier 1; Pronounced excluded), producing Most alike / Most different / Closest to group / Most individual from THREE aroma respondents up (fewer → the panel is suppressed: with two, every stat names the same pair — Simon 2026-07-17); compute it only while the sheet is mounted, never in every card poll. Scores are UNITLESS 0–100 (no % sign — Dice×100 is not a percentage of anything nameable; scientific review 2026-07-19); the person extremes draw only from respondents with ≥2 picks when ≥2 qualify (`eligibleGroup` — a one-pick respondent mechanically scores low; the ranking sheet ranks eligibleGroup for closest/individual so row #1 matches the card, with a footer naming excluded singles), and every extreme carries a tie count (`*Ties` fields) — the cards show "N tied" instead of silently crowning one equal, and the ranking sheet accents every row tied with the leader. Every stat card TAPS THROUGH (Simon 2026-07-17) to a pushed 70% ranking sheet (`TasteDetailSheet` — sheet-over-sheet is the ruled navigation; an in-sheet drill was rejected as illegible): top/bottom 8 pairs or people with scores, #1 expanded, single tap-to-swap expansion; expanded pairs show the `tasteSharedEvidence` chips (SHARED = exact picks + same-leaf, RELATED = subfamily/family territory not covered by a finer shared node), expanded people show their closest matches; a footer names the cut (`Top 8 of N pairs`). `summary.pairs`/`summary.group` are the complete stable-sorted rankings; `aromaTasteSummary` is computed ONCE at the CARD (CompareBody), gated on a sheet needing it, and passed to both sheets. 🔒 The ranking sheet MOUNTS AT THE CARD as the detail sheet's SIBLING (screen-level sheet anatomy), never inside the conditionally-mounted AromaDetailSheet — the first cut nested it there and closing it stranded the detail sheet presented-but-closed on device (invisible, blocked reopening, flickered on unmount). All Aromas and People each own a `compareSelectionReducer` + search state (the Overview has neither — its taps are popovers): switching views preserves that tab's focus for return but never carries muting/highlighting into another tab. Within a tab, selection is single-select aroma XOR participant and retap clears; aroma identity remains the THREE-WAY `AromaRef` because popovers/routes still distinguish node = subsumed, base = literal-all-modifiers, pair = exact. All Aromas taps are pair refs. 🔒 The Overview is NOT a selection surface: fingerprint segments, bar segments, and Also-mentioned chips anchor a contributors POPOVER on tap (`openBar`), with a SOURCE-MATCHED connector — bar tap clones a flat square colour bar, fingerprint tap a pill segment, pyramid tap the EXACT facet polygon WITH its label lines; only the Also-mentioned chips (real badges) keep the badge connector. A strip-popover "+N more branches" focusId opens the sheet on All Aromas with the node's supporting picks highlighted (there is no node-focus in the Overview — a below-floor head has no row). 🔒 `peopleFilter` is separate navigation context, set by popover routes and cleared only by Show All ✕; search filters within that context and selecting a person never clears it. Active tab + filter + each tab-local selection are validity-derived every render; tab changes reset only the shared scroll viewport. The "+ Aroma Details" pill remains the local `AromaDetailPill`. Consensus defaults are frozen in core (primary > n/2 · peak ≥ ⅓); **pronounced is a SUPPORTER-majority** (`pronouncedCount*2 > supporterCount`, floor 2 — scientific-review fix 2026-07-19: non-perceivers are missing evidence, not negative intensity votes). **The Overview page** (top to bottom): "N tasters noted aromas" caption · the family FINGERPRINT strip (`familyFingerprint` — PEOPLE-weighted: distinct family supporters per segment, mention totals only as tie-break + the popover's "· M mentions" detail line (scientific review round 2, 2026-07-19 — a people strip provably can't outrank a family that has no bar); segments FADE into neighbours via expo-linear-gradient, tappable, deliberately unlabelled, NO numbers ever) · one CHART BLOCK per agreed head clearing `overviewHeadFloor` = max(2, ⌈n/3⌉) (label line + a bar whose filled region is PARTITIONED by contributing aromas — `headBarSegments`, each supporter attributed to their deepest supporting pick, Σ = head count; discrete per-taster cells at n ≤ `OVERVIEW_DOT_MAX`=10 with "k of n" labels, continuous fill + whole-% above; ONE flat family colour, NO tints, square corners, no separator before the unfilled remainder; in-bar labels fit-gated) · an Also-mentioned tail (uncovered bases, tappable chips, "All Aromas ›" jump; label flips to MENTIONED when no rows) · the multi-select disclosure caption. Fallback mode = fingerprint + tail, no bars. The pyramid: `topAromaPyramid` (1/2/3/4 tiers over the top-10 exact pairs) drawn by `pyramidLayout` (true triangle, weighted apex band, food-pyramid vertical cuts) with `wrapPyramidLabel` slope-aware word-wrap; a11y + popover titles carry the exact (aroma, modifier) pair. As-built record: `docs/dev/proposals/aroma/aroma-layer.md` §8.
- **Aroma READ**: `AromaReadChips` (`scoring/aroma/AromaReadChips.tsx`) — read-only grouped chips (displayOrder + AromaChip) for someone's stored selections; feed impression detail now, further native read surfaces reuse it. The `lead` word prop was REMOVED (fixes round 2026-07-13 — the feed detail carries a section title instead). Pass `collapse` for the rating page's overflow behaviour: two lines via the shared width packer (`packChips`/`ChipMeasurePass`/`MoreChipsPill` in `parts.tsx`, also used by `SelectedChipsRow`), tail behind the SAME "+N more" pill that opens a read-only bottom sheet — pass `overflowSheetStack="push"` when hosted inside another sheet, and `overflowPillOnSurface` when the row itself sits on a sheet's `surface` so the pill swaps only its fill to `bg` instead of disappearing surface-on-surface. Optional `onPressAroma(selection, rect)` adds anchored read-side inspection without changing the canonical badge. ⭐Read badges are COMPACT: `AromaReadChips` passes `vPad 0` (inner padding 0 + the inherited 23pt label line via `badgeVMetrics`; Simon 2026-07-13) to every chip + pill it renders — write surfaces keep the 4.5 default; don't override per call site. The WEB has its own twin (`components/ui/AromaReadChips.tsx`, PR D — no shared RN/web layer). No input, no refine — mutations only through AromaInput.
- **Aroma input (descriptor layer, PR B)**: `scoring/aroma/` — `AromaInput` (the 02e·11 search-first section on the impression screen: chips + search field + the INLINE CanvasPicker right under it — a live query swaps the canvas for the suggestions + refine row, an empty query brings it back (Simon 2026-07-17 — supersedes the browse button + BrowseSheet entry point); controlled `AromaSelection[]`, local-until-commit), `parts.tsx` (`AromaChip` — THE aroma badge everywhere: the design's `.badge` anatomy per Simon's 2026-07-10 ruling — family-tint fill + `readableSolid` words (the 100% palette colour where it clears 3:1 on the fill, pulled toward ink ONLY past that — supersedes the earlier bare-solid-words + tintedInk iterations); `focused`/'solid'-bumped fills = SOLID family fill + `inkOn`-picked label — ⚠️ but an ARMED SEARCH RESULT no longer uses it (Simon 2026-07-12, ADR-0008 addendum): armed keeps its RESTING colours and the OTHER results mute (`muted`) — contextual focus, chips never self-recolour; `focused` remains the picker-cell/solid vocabulary; Pronounced border = `readableBorder` (readable, floored at 45% colour share so clay never reads white), the label ink on solid fills; fills route through `aromaTint.ts` `aromaFillRatio` + words/borders through `readableSolid`/`readableBorder` — keep all three on any new family-tinted surface; genuinely weak palette values are still the PALETTE's to fix (punch-list printed by aroma-pickers-units.ts); `ModifierRail`, `PronouncedRow`, `ModifierPopup` anchored refine, `useAromaOps` — every mutation re-gated + pair-precise, `canonicalPair` — re-target after promoted rewrites, `useTapOrDouble`, `usePendingAdd` — the pickers' armed modifier+Pronounced pair committed as one add, `RefineAddRow`/`ModifierSelectButton`/`PronouncedToggle` — THE shared refine row (search block + Map/Canvas/Rings inline + List via the sheet footer), `CapHint`, `AromaCrumbs` — the drill breadcrumb shared by Rail/Canvas/List), `SelectionSheet` ("+N more" overflow, cap-aware sizing), `BrowseSheet` (NO production entry point since the inline-canvas ruling — kept as the five-picker lab: segmented control, Map/Rings/Rail/Canvas/List; added-badges strip w/ refine popup; ONE always-enabled scroll (gorhom latches scrollEnabled from first render — no per-variant toggle), content-pan on so pull-down works, stage pans win by activating first), `RailPicker`, `RingsPicker` (W4, the mock's OVERSIZED-CROP geometry — the crop IS the design; NO fisheye: even wedges always, ONE static layout per commit for wedges+labels so turning is pure rotation; full pick name reads in the passive HUB as plain wrapped text, never TextPath; Add/refine = the shared RefineAddRow below the stage; every gesture end snaps synchronously to a detent, taps = real Gesture.Tap raced with the pan; labels fit-or-hide inside the visible window. ⚠️ rnsvg TextPath + animatedProps on its referenced Path is BROKEN on device — text draws along mount-time geometry and end-clips; never reintroduce), `MapPicker` (3-level zoom; territories = recursive balanced cuts — families + groups guaranteed CONNECTED and compact; live pinch-between-levels w/ focal-point scale + re-base; momentum pan) + `CanvasPicker` over `hexStage.tsx` (shared axial-hex SVG stage: pannable clamped translate w/ withDecay momentum — pan DISABLED when the cluster fits so the sheet keeps its drags (edge-fade affordance was tried and REJECTED on device — don't reintroduce); per-cell a11y button+selected state; strict flat family fills; armed cell = search-focus treatment: grow + others mute; Canvas sizes its stage TO the cluster (capped) so small combs don't float in empty bands; the PURE lattice/syllable-wrap/clamp math lives in `hexMath.ts` and the Map's territory cuts in `mapLayout.ts` — both node-importable, regression-driven by `.local/test-env/scripts/aroma-pickers-units.ts`; per-theme fill strength in `aromaTint.ts` — clay boosts the family-colour share, see the badge note below), `ListPicker` (drill list with a Tinted/Plain/Cards look switcher — Tinted = badge anatomy rows, Plain = People-sheet rows w/ hairline separators, Cards = the SetGroup/SetNav settings anatomy; family colour stays as dot/mark + armed tint on the non-tinted looks; round mark = any-tier arm; its refine row is PINNED to the sheet bottom via the Sheet's gorhom `footerComponent`). **Design spec-of-record: `docs/design/decisions/0008-aroma-input-search-first.md`** (variant pick, chip anatomy, Pronounced glyph/border split, ordering, add feedback, keyboard scroll) + `docs/dev/proposals/aroma/aroma-layer.md` (data semantics). Icons: `grid`, `pronounced` (reusable "standout" mark). `Button` gained `titleLines`; `SheetSearchField` gained `onFocus`/`onBlur`.
- **Role chip / badges**: `RoleChip` + `BadgePill` (`moments/RoleChip.tsx`) — host/cohost/provider text pill and the shared small badge primitive. Use `BadgePill` for People/settings role tags instead of reimplementing badge centering, line-height, or tone math.
- **Settings kit**: `settingsParts.tsx` — `ReadCard`, `SetGroup` (`flush` = no bottom margin, for the You settings pages; it draws the hairline BETWEEN its rows, `.setnav + .setnav`, and rows draw none: a line on the first row doubled the card's border, fixed 2026-11-11), `SetNav` (+ `subtitle`, `value`, `leading` node in the icon's place, `accent` = label + icon in the accent (beside `critical` red), `trailing` node or `'none'` in the chevron's place (a row with a trailing NODE is not one accessible element, so its button stays reachable), `busy` = a spinner there while the row stays one busy button; `icon` optional), `GlassButton` (over-cover round glass; `bottom` anchors it bottom-right), `SettingsFooter` (sticky Discard|Save), `ToggleRow` (switch + PRO badge + reason; the moment settings' `.trow`), `SettingsScreenFallback` (bar + spinner or retryable `ErrorState`; `errorTitle`). You settings pages (04·4): `SetPage` (`.yo-setbody`: bar + sections 26 apart, pill clearance, keyboard-aware; a sticky-footer page passes `footer` + `bottomPad`, like Change Password), `SetSection` (`.yo-sgrp`: uppercase label + content), `SetSwitch` (`.yo-stog`: a switch row inside a group; `soon` locks it), `MeCard` (`.yo-mecard`). `SelectField` gained `disabled`; give it an `accessibilityLabel` that carries the value (`Type: Wine`), since the label replaces the field's text for VoiceOver.
- **Theme preview**: `ThemePreviewProvider` (`theme/index.tsx`) re-themes a subtree (`theme` AND `themeKey`; the real `choice`/`setChoice` pass through). `ThemeSwipePicker` (`settings/ThemeSwipePicker.tsx`) is the design's 01 swipe-to-theme, reusable for onboarding (caller supplies the header + `onUse` / `onUseInSystem`; `ThemeProvider` keeps the light/dark `systemThemes` pair).
- **Sign-out confirm**: `lib/signOutConfirm.ts` `confirmSignOut(who, setBusy)` — THE sign-out (Settings → Sign Out, Account → This Device): names the account, goes through Better Auth. Don't hand-roll another.
- **Error copy**: `lib/errorCopy.ts` `errorText` (a failed write's alert body: a 401 → `SIGNED_OUT_TEXT` "You’re signed out. Sign in again." (ruled 2026-11-11), any other 4xx → the server's copy, else the connection line) + `sentence`. Don't re-declare them per screen.
- **Form widgets + image pipeline**: `momentForm.tsx` — `Disclosure`, `DateField`, `NotesField`, `SelectField`, `FieldGroup` (`.field-group`: the 600 small label over a control that has none of its own: SelectField, the create category trigger, the bringer field), `OptionSheet` (the short check-list picker sheet), `CountrySheet` (fixed-snap searchable country picker — deliberately NOT an OptionSheet, see its comment), `fitCover`/`pickCover`/`pickPhoto` (+ `pickPhotoOrRemove(label)`: the same iOS ActionSheet with a destructive Remove row), `NotesField` `maxLength`, `MAX_COVER_BYTES`/`MAX_WINE_IMAGE_BYTES` (⚠️ per-SURFACE caps: session wine images cap LOWER than covers via sanitizeImage 1.5MB — but the standalone check-in photo goes through the lib/s3 pipeline and uses `MAX_COVER_BYTES`; see the notes in add.tsx + feed/check-in/).
- **Post list**: `FeedList` (`feed/FeedList.tsx`) — THE list of posts (paging, drain, focus/pull refresh, cards, like, owner edit/delete) for the Feed tab AND every profile. Never build a second one; see § You profile. Header-screen props: `fullBleed` (never-inset + the RNS dead-end; key the list on it), `refreshOffset` / `refreshTint`, `inert` (rows + footer at 0.35, no touches, scroll stays), `bottomInset` (≥ `TAB_BAR_CLEARANCE`), `scrollHandle` (`scrollToOffset`, in the list AND the error layout); its error state renders the header inside a scroll view.
- **Profile**: `ProfileScreen` / `ProfileHeader` / `PhotoTiles` / `TileCoverSheet` / `ProfileEditParts` (`LongPressable`, `InlineField`, `EditBar`) / `coverGeometry` (`profile/`) — see § You profile.
- **Header**: `VBar` (`VBar.tsx`) — the in-flow variant-B bar (back + left title + right slot). All pushed in-flow screens; `back={false}` for a tab root; `titleShown` turns the title into a SCROLL title (fades in once content scrolls under the bar), `titleLeading` puts a node before it.
- **Bar title**: `BarTitle` + `useBarTitleProgress` (`VBar.tsx`) — THE bar title (subhead 600, `topBar` surface, ink or white on a photo; fade + 4pt rise over dur-2 off a 0→1 `Animated.Value`). VBar, the moment cover bar and the rate-impression bar all render through it; a bar whose background fades with the title (the moment cover bar) drives both from the same `useBarTitleProgress` value. Never restate the title style or the fade in a new bar.
- **Bottom nav**: `PillTabBar` (`PillTabBar.tsx`) — the floating-pill tab bar (`.tabbar-float`, ADR-0006) with the drag-lens (hold ≈180ms → a real Liquid Glass lens rides the bar; release commits; landing on the current tab is NOT input). Rendered via the tabs layout's `tabBar` prop; absolute overlay at `TAB_BAR_BOTTOM` (21pt from the physical screen edge): content clears it with `TAB_BAR_CLEARANCE` alone, never `+ insets.bottom`. ⚠️ The glass layering in that file is LOAD-BEARING physics learned over a day of device checks — read the in-file header + ADR-0006 and re-run the dev-gallery GLASS LABS (`/you/dev-gallery`) before touching any glass property. Don't add per-screen nav bars.
- **Avatar**: `ui/Avatar.tsx` — person circle (image→initials→`anon` user-glyph cascade; a photo that fails, or hasn't loaded within 1.2s (an unreachable host only errors after iOS's ~60s timeout), shows the initials drawn UNDER it; keyed on the URL); props `size`, `host` (accent tint), `anon`, `ring` (the overlap-stack 2px bg border + image inset), `badge` (overlay node, e.g. the "+" invite badge), `initialsSize`. ALL person circles.
- **Thumb**: `ui/Thumb.tsx` — square cover/wine thumbnail with the glass-glyph placeholder; props `uri`, `size`, `radius`. ALL cover/wine thumbs (wrap + overlay for the line-up hidden-from-guests badge).
- **Sheets (domain)**: `PeopleSheet`, `InviteSheet` (`moments/`).
- **Drag-to-reorder rows**: `DraggableRows` (`moments/DraggableRows.tsx`) — long-press lift + sibling springs + edge auto-scroll + haptics over NON-virtualized mapped rows in a `Reanimated.ScrollView` (hand-rolled: reorder libs need to own a FlatList or can't be device-verified on reanimated 4). Used by both line-up layouts; needs the host scroll's `AnimatedRef` + offset + a maxScroll SharedValue. `enabled` gates drag, `denied` answers a hold with a warning haptic (sort/search active). ⚠️ Worklet closure-capture ordering is load-bearing (consts before gesture builders — the PillTabBar crash class).
- **Shared screen constants + Dynamic Type surfaces (`lib/layout.ts`)**: `GUTTER`(22), `FOOT_CLEARANCE`/`FOOT_CLEARANCE_IR`, `TAB_BAR_BOTTOM`/`TAB_BAR_CLEARANCE` (pill offset + the content padding derived from it; the clearance is used alone), `HERO_RATIO` (shared by BOTH heroes — same height), `GLASS_FILL` (the over-photo glass fill), `HERO_SCRIM` (the hero-photo gradient), `PROFILE_SCRIM` (+ stops, the profile cover), `heroBarHeight` (a photo hero's collapsed bar: the moment's and the profile's), and `FONT_SURFACES` / `phone.surface(...)`. Import constants; don't re-declare. Use `phone.surface(name)` for scalable container math and `VText surface="..."` / `{...surface.textProps}` for matching text caps. `formControl` intentionally stays uncapped because field height math tracks editable text scale. **Comfort scaling (list rows breathe on big phones)**: `phone.grow(base)` grows a structural dimension by `ROW_COMFORT_RATIO` (56/46 ≈ 1.22 — the `recentThumb` ratio) with device comfort; `phone.lerp(a,b)` for the paired gap/padding. EVERY list row (wine, moment, person) uses this so they scale the SAME way — thumbs/avatars via `grow`, gap/padding via `lerp` — don't hardcode a flat size on a new list row. Chart canvases, sheet-snap math, borders, and icon-in-control sizes stay FLAT (load-bearing). ⛔ **CI-ENFORCED**: `scripts/check-mobile-design-tokens.mjs` (workflow `check-mobile-design-tokens`) FAILS if converged design constants are re-inlined OR an inline `fontSize:` literal appears outside its named-exception allowlist (the Text rule above); `scripts/check-mobile-dynamic-type.mjs` (workflow `check-mobile-dynamic-type`) is a partial static backstop for inline caps, common fixed-height text controls, and TextInput surface props. Device checks still own clipping/overlap truth.
- **Label helpers (`lib/`)**: `initials.ts` (code-point-aware avatar initials — used by `Avatar`), `momentFormat.ts`, `scoreWords.ts`, `locale.ts`, `contrast.ts`. `theme/color.ts` `mix()`/`alpha()` for press-state/tint math (use instead of raw rgba) + `inkOn()` (contrast-picked label ink for a coloured fill — hex cells + solid-fill badges) + `readableSolid()` (family-tinted words: the 100% palette colour where it clears 3:1 on the fill, ink-pulled in 5% steps only past that) + `readableBorder()` (same, floored at 45% colour share so a hairline keeps its hue — clay borders went white without the floor). (An earlier `readableTint` — always ink-tinged — was REMOVED; `readableSolid` supersedes it, byte-identical to the raw palette colour wherever that already reads.)

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
- ✅ **DONE (partial) — `<OptionSheet>` + `<CountrySheet>`** exported from `momentForm.tsx` (extracted when the check-in create became their next consumer); adopted by `add.tsx` (local TypeSheet + CountrySheet deleted) + `feed/check-in/`. `create.CategorySheet` still carries its own copy — migrate when next touched. ⚠️ CountrySheet stays a SEPARATE component, not an OptionSheet variant: it needs a fixed 75% snap + `BottomSheetScrollView` + search (a load-bearing config difference — see its in-file comment).
- ✅ **DONE (partial) — `SelectField` exported from `momentForm`** (moved out of add.tsx; adopted by add + the moments-list filter sheet). Create's category trigger still carries its own inline copy — migrate when next touched.
- **`<ChoiceChips>`** — the hide-lineup timing pills are verbatim in `create.tsx` + `reveal.tsx`.
- ✅ **DONE — `ClampText`** promoted to `components/ui/ClampText.tsx` (the feed impression detail became its second consumer; 02e now imports it). `OvcAbout`'s description block is still a copy — migrate when next touched.
- **Generalize `SettingsFooter` → `<StickyFooter error>`** — create/add re-inline the same absolute bottom bar.
- **`elevationStyle(level)`** — the `elevation.<lvl>.ios` / `.android` shadow spread (shadowColor/Opacity/Radius/Offset + elevation) is written out in 6+ places (AnchoredMenu, the add position picker, MeCard, the theme demo card, …). A helper returning the style object removes it; mechanical.
- **Feed post detail bar title → `BarTitle`** — `feed/[id]/index.tsx` still renders its own title (same type, but it POPS in on `solid` instead of fading, and it is tappable → About). Adopting `BarTitle` (with a press slot) changes that behaviour: a design call, not a refactor.
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
  cascade. The whole rating block renders via the shared `RatingSection`
  (see the component catalog): score → note (no title; the placeholder
  "Say what the stars can't." carries the affordance — the note is the
  taster's public CAPTION, never an aroma-descriptor prompt) → the
  "Structure Profile" fold (`StructureInput`) → `AromaInput`. The save
  boundary normalises via `fillFlavourZeros` and diffs BOTH sides normalised
  so an untouched legacy sparse row is never re-posted; aromas diff
  canonical-to-canonical and stay OMITTED until seeded (omitted-preserves).

## Moment creation (milestone 4, 02a)

- `moments/create.tsx` to the tCreate pixel spec. Rulings: category is
  wine-only v1 (field renders per spec, non-interactive, sends
  `category:'wine'`); **NAME + start date (From) are REQUIRED (Simon,
  2026-07-06 — reverses the earlier "From–To optional" ruling)** — the server
  enforces it for every caller (web/native/anon) and an edit can't clear them
  either (a pre-existing dateless moment must gain a start date before its next
  settings save). End (To) stays optional. The From field still renders EMPTY
  and seeds only on a deliberate tap (the no-prefilled-values input ruling holds
  — we don't force-seed); the submit guard blocks a create/save with no From/name.
  From–To use the OS compact datetime picker (native-chrome; tap seeds a
  default, × clears — the × on From is harmless on create/settings because the
  submit guard re-requires it). No lifespan row: every logged-in create is
  `unlimited` SERVER-side, web and native alike (root CLAUDE.md § Freemium
  split); blind toggle renders disabled + PRO badge for
  non-pro (`GET /api/me/account` → `pro`).
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
- **Reveal UX = DIRECT MANIPULATION on the photo (ADR-0007, Simon 2026-07-04
  — supersedes the earlier two-state resting-strip + reveal-MODE design).**
  For hosts/cohosts the impression photo is the always-live control: hidden →
  translucent GLASS_FILL + eye-off over the whole photo, hint "Double-tap the
  photo to reveal" — first tap ARMS (accent overlay, hint flips to "tap once
  more", 2.5s auto-disarm), second tap reveals; revealed → clear photo with a
  corner eye badge cue, a single tap ANYWHERE on the photo hides INSTANTLY
  (the asymmetry is deliberate: revealing leaks within a poll tick and can't
  be unleaked, hiding is damage control and must stay fastest).
  The blind-for-all masked placeholder is the same arm→confirm target. Row
  copy: "Hidden from guests" + a hint third line; guests' masked rows carry
  "Hidden until the host reveals it" (BOTH strips deleted — host strip AND
  guest quiet strip). Bulk + scope controls live in the **eye menu** on the
  toolbar line under the tabs (count header, Reveal all, Hide all, Blind for
  all — the last MOVED from the session ⋯ menu, which is now identical for
  blind and non-blind). Row-hold stays free for the planned drag-to-reorder.
  Revealed rows hint the way back ("Tap the photo to hide", in the
  caption slot). Toolbar PLACEMENT (Simon): right ABOVE the rows — the old
  strip's spot below the about block — pinning under the tabs on scroll.
  The toolbar is now the full line-up control row: [eye ⌄][sort ⌄][search──]
  — eye menu on the very LEFT (blind host/cohost only), search on the very
  RIGHT, sort between; ALWAYS rendered, no size threshold (Simon). Sort =
  line-up / my highest / my lowest / not-rated-first (VIEWER's scores);
  search = the fuzzy Compare field set. Search/sort NEVER
  renumber rows (.lu-idx and "Impression N" key on the true position via an
  indexById map); reveal counts stay full-list.
  Plain = a Reanimated.ScrollView (left FlatList for drag-to-reorder —
  translated rows + virtualization don't mix; sticky toolbar via ScrollView
  stickyHeaderIndices keyed on `ovc` presence); cover-hero = the strip
  overlay slot. ⭐DRAG-TO-REORDER (host tier, web parity — allowed on blind,
  renumbering is the host's call): long-press a row ≈400ms → lift + drag
  (DraggableRows, see catalog), drop = optimistic permutation of the cached
  wines + POST /wines/reorder (full-permutation-validated server-side).
  Disabled while a sort/search narrows the list — a hold answers with a
  warning haptic; the accent sort icon explains why. Reveal MODE, the Done
  footer, the per-row
  pills, and the reveal-mode tab-bar-hide counter (`pushRevealMode`/
  `popRevealMode` in `lib/sheetVisibility.ts`) are DELETED — don't resurrect
  them from old diffs; sheets are the only in-screen tab-bar-hide reason now.
- **Host framing is HONEST (Simon's ruling): the host is NOT blind on a normal
  blind session** — the server returns their full wines, so host rows show the
  real wine + a `.lu-hidebadge` eye-off on the thumb + a "Hidden from guests"
  tag (resting only). Only blind-for-all masks the host too (then rows are the
  `.lu-masked` placeholder; the strip + pills still control reveal). The
  impression NameBlock copy forks on this: host "Hidden from guests. Reveal to
  show it." vs guest "Revealed when the host or co-host reveals it".
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
  already existed). The photo overlay / corner badge are child `Pressable`s
  inside the row's Pressable — RN's responder system grants the touch to the
  inner control, so a control tap does NOT also fire the row's navigate
  (verified pattern, same as IrBar's sibling controls). A BUSY (disabled)
  control doesn't claim the responder, so a tap during the brief in-flight
  window falls through to the row press — accepted.
- **Known deviation:** the host's photo-hero on the impression has no
  hidden-from-guests badge yet (consequence of the honest-framing deviation;
  the line-up rows DO carry it). Security posture unchanged from the 02b
  review: gating is server-side, client checks are cosmetic, the optimistic
  write can't leak an un-revealed identity.
- **FIXED (was the flagged M3 gap):** the impression detail now uses the same
  `lastRef` per-section merge as the line-up (a `wines:null` degraded poll keeps
  the last good list; the "This impression is gone" terminal requires a PRESENT
  wines section that lacks the wine). Any new screen reading the shared `/state`
  poll must adopt the same merge — never read `state.data?.<section>` directly.

## Navigation: the session sub-tree is MULTI-MOUNTED (proposal 09 §B)

The session screens (`moments/session/[code]/…`) are mounted under THREE tab
stacks: Moments owns the source files; `app/(tabs)/feed/session/[code]/…` and
`app/(tabs)/you/session/[code]/…` mirror them as thin re-exports, so entering
a moment from a post (feed or profile) keeps back-nav on that tab. Likewise
the POST sub-tree (`feed/[id]/…`, `feed/edit/[id]`, `feed/edit/details`,
`feed/u/[id]`) is owned by Feed and mirrored under You. The OPENED POST
(`feed/[id]/`) has its OWN nested Stack (see the next section), so the
sub-trees mount there too. Two rules follow:

- ⚠️ **Never hardcode `/(tabs)/moments/session/...` in a push/replace inside
  the sub-tree** (or in a hook the sub-tree calls) — it would silently hop a
  feed-stack visitor over to the Moments tab. Use `useSessionTab()` +
  `sessionHref()` / `tabHomeHref()` from `lib/sessionStack.ts` (the one place
  allowed to cast a computed pathname to a typed `Href`); the post sub-tree
  uses `feedHref()` / `feedListHref()` from the same file. `useSessionTab()`
  returns a MOUNT (`{ tab, post? }`): every builder takes it, so a caller
  never decides between the tab stack and an opened post's stack itself. Post routes carry
  `?user=<id>` when opened from a profile list: the detail + edit screens read
  THAT list's cache (`feedQueryOptions(user)`), and the "post is gone" exits
  land back on that list. 🔒 `useSessionTab()` reads the owning tab from
  `SessionTabProvider`, which each tab's stack `_layout.tsx` provides — the
  MOUNT location. The global segments are only a fallback: a component that
  first renders in a background tab (a profile's post list mounting once its
  header query resolves after you switched tabs) would otherwise pin the
  focused tab and push onto the wrong stack. A new tab stack must provide it. Entry points that
  genuinely live on one tab (moments home/recents/join/create) keep their
  absolute paths.
- **A new session screen needs its mirror files** under `feed/session/`,
  `you/session/`, `feed/[id]/session/` AND `you/[id]/session/` (four
  one-line re-exports; a new post-sub-tree screen: under `you/`, and on the
  post's stack if it can be opened from a post), and a
  suffix-friendly entry in the tabs layout's bar-hide matcher if it hides the
  pill — the matchers are suffix-based on purpose so they cover every mount;
  `/feed/edit` is the exception, so `/you/edit` sits beside it).
- **The visible native backdrop is intentionally non-interactive for stacked
  Feed session cards.** Closing remains explicit, one level at a time. RNS
  exposes backdrop taps through the same cancellation path as native swipes;
  reliable close-to-impression behavior required version-pinned RNS + Expo
  Router patches and was rejected as too much maintenance (Simon, 2026-07-13).
  Revisit only when the upstream stack exposes a distinct backdrop event.

The feed impression detail (`feed/[id]`, the opened post) is a CONTAINED
TRANSPARENT modal (`containedTransparentModal` = OverCurrentContext since
2026-11-10, so the bottom nav can draw over the screens pushed on its own
stack) that draws its own shared-element open / pull-down close (proposal 09;
source frame handed off via `lib/feedTransition.ts`). Don't give it a native
animation or re-enable its native back gesture — both would pop the route
without reversing the presentation.

### The opened post's own stack (2026-11-09)

`feed/[id]/_layout.tsx` (mirrored `you/[id]/_layout.tsx`, which re-exports
`default` AND `unstable_settings`) is a nested Stack inside that modal:
`index` = the detail; `session/[code]/…` (7 mirrors), `u/[personId]` (its own
wrapper: `id` is taken by the post) and `post/[postId]` (the SAME detail in
CARD MODE) are its children. Anything opened FROM the post (the place line's
moment, the author's avatar + name, a post on a profile opened from there)
pushes onto THIS stack as a real card: swipe-back, no page sheet, no modal on
modal. All of them are siblings, so no route tree nests inside itself.
react-native-screens draws no container background for a stack inside a
transparent presentation, so the feed still shows through while `index` opens.

- 🔒 **The outer route name must stay wholly dynamic (`[id]`, URL
  `/feed/<id>`).** expo-router compares params only for names that are a
  single dynamic segment when it resolves a push into an already-open stack
  (`resolveNavigationDestination` `routesMatch`): under the old
  `impression/[id]`, pushing post B while post A's child was open resolved
  INTO A's stack (and the singular filter even dropped A's index). Verified
  with the in-memory router driver `.local/opened-post-stack/router-sim/`
  (the real expo-router 58 reducer over the real `src/app` tree; rerun it
  after any route-tree change).
- **The mount descriptor** (`lib/sessionStack.ts`): the post's layout
  re-provides `SessionTabProvider` as `{ tab: <enclosing>, post: <id> }`,
  pinned at first render. Every builder takes the mount: `sessionHref`,
  `feedHref('post' | 'profile' | 'edit' | 'edit/details')` and `settingsHref`
  go onto the post's stack when called from inside it (`[id]/edit/[postId]`,
  `[id]/edit/details` and `[id]/settings/…` (the hub + every page) are
  mirrors there; the edit slides
  up with no swipe-back so it reads like the outer full-screen edit);
  `feedListHref` with a post mount = the profile on that stack; `tabHomeHref`
  is the TAB root only (a "mount home" would be the post).
- 🔒 **Nothing may be presented on the OUTER tab stack while a post is open.**
  A native modal (the outer `fullScreenModal` edit) over the contained post
  hung the app (device pass 2026-11-10), and react-native-screens' own
  current-context fallback dismisses only the topmost of two modals removed
  together (Codex). So every screen reachable from inside a post lives on the
  post's stack (Settings hides its Dev Gallery row there, an outer-You push),
  and the post's "post is gone" exits are plain pops on it.
- **The post id comes from the stack, not the detail's params.** An anchored
  `index` (a cold link to a child, or `withAnchor`) gets no params of its own
  (cold anchors copy dynamic params only, so `user` stays on the child), so
  the detail reads `useSessionTab().post`. Such an index reads the network
  feed's cache (no `user`), like a cold link to the post itself: a post that
  isn't in a loaded page shows the existing "This impression is gone" state.
- **Card mode** (`postId` present): the card's one-shot transition source is
  CONSUMED and discarded (left in the store it would animate the next modal
  detail within 1.5 s), no pull-down (`dismissible`), the back ARROW (the
  modal keeps its down chevron), its list is the profile on the post's stack.
  Card visits are FRESH pushes (`FeedList` drops `dangerouslySingular` inside
  a post: singular MOVES an earlier visit to the top, so A → P → B → Q → B
  would lose history); a 700 ms debounce swallows a double tap instead.
- **Deleting the post the stack hangs off closes the whole opened post.**
  The only post that can sit on one stack twice is the owning one (your own
  post A → your profile → A as a card); deleting or emptying it from the
  card, its edit, or the profile list's ⋯ would otherwise uncover the modal's
  pinned copy. `closeOpenedPost` (`lib/sessionStack.ts`) pops the outer `[id]`
  route (one modal, its whole stack with it); any other post-gone exit pops
  just the card (or `dismissTo`s the nested list). 🔒 Every explicit
  deletion also calls `markFeedPostDeleted` (`lib/feedCache.ts`): with the
  bar visible inside a post you can switch tabs and delete the same post
  elsewhere, so every mounted detail of a deleted post drops its pinned copy
  (renders "gone") and closes itself when it regains focus.
- **Landing: the FOCUSED detail owns it.** Landing callbacks are global per
  post, so a card of the same post moves the card under the modal too; the
  modal re-asserts its active slide on every refocus and before a close.
- **Status bar**: under the old OverFullScreen modal nothing on the post's
  stack was asked (the RNS trait walk stops at a presented screen), so a
  photo-hero screen there forwards its style to the ROOT Stack through
  `lib/forwardedStatusBar.ts` (focus-scoped, latest wins, a no-op outside a
  post). The contained modal may be asked by UIKit itself, so every screen
  there ALSO carries the same value as its own option (the post's Stack sets
  the themed default; a screen without one would report `auto`): two
  channels, one value. The line-up and the moment impression
  call `useForwardStatusBarStyle` with the same value as their screen option,
  and the post detail itself forwards white glyphs while its active photo is
  under the bar (fully open, not collapsed, not mid-dismiss; device pass
  2026-11-10: they were dark on the light theme). A NEW photo-hero screen that
  can open from a post must forward too.
- **Android back** on the detail is focus-scoped (`useFocusEffect`): with a
  card on top, back pops that card. Card mode registers none.
- **Delete-moment bounce**: from a moment on a post's stack, back to the
  screen that OPENED the moment (pop the moment and everything above it,
  ruled 2026-11-09); elsewhere the tab root, as before. The pop is TARGETED
  at the settings screen's own stack and counted after the delete resolves:
  an untargeted pop hit whichever tab was in front by then (Codex).
- **Bottom nav**: hidden on the post itself and on a card-mode post
  (`OPENED_POST_PATH` in the tabs layout); a moment or profile pushed on the
  post's stack shows it under the normal rules (ruled 2026-11-10: hiding it
  there confused). It can only draw there because the post is a CONTAINED
  modal: a plain `transparentModal` (OverFullScreen) covers the whole window,
  pill included. The highlighted tab stays the one whose history you are in
  (Feed / You), not Moments.
- **Author tap** on the post: pushes the author's profile on the post's
  stack, or, when the post was opened from that person's own list, CLOSES the
  post back onto it (ruled 2026-11-10: an inert tap read as dead).
- Settings from your own profile opened inside a post is the mirror on the
  post's stack (`settingsHref`), and so are its Help & About + Attributions
  (`legalHref`; the pill is hidden on them, as at the root). A root push from
  inside a post landed behind the presented post (device pass 2026-11-10:
  back came out on You). 🔒 The ROOT `/about` + `/attributions` stay the
  canonical, signed-out-reachable routes (§ About / Attributions); the
  mirrors are extra entry points only.

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
    `MenuItem`'s `accessibilityLabel` ("Edit Impression"/"Delete Impression"),
    so the spoken label still names the object. Don't "restore" the verbose
    visible labels.
- **Capitalization — Title Case for titles + actions; sentence case for prose
  (Simon, 2026-07-06).** House rule, applies to all app-authored copy:
  - **Title Case** — screen/section titles (`VBar` titles, section headers like
    "Recent Moments"), **button** labels (`Button title=`), **menu items**
    (`MenuItem`/`SetNav` labels: "Reveal All", "Delete Moment"), and **form
    field labels** (`TextField label=`: "Moment Name", "Cover Photo"). Standard
    Title Case: capitalize each word EXCEPT minor words (a/an/the · and/or/but ·
    of/to/for/in/on/at/by/with) — UNLESS a minor word is first or last. So
    "Blind for All", "Back to Start", "Remove from Home", "Create a Moment".
    `accessibilityLabel`s mirror their visible label's case ("Edit Impression").
  - **Sentence case (unchanged)** — full-sentence copy: empty-state /
    error / `CenteredMessage` bodies ("Nothing to compare yet", "This impression
    is gone"), hints, toggle captions, and any **link rendered INSIDE running
    text** ("Already have an account? Sign in" — the inline `Sign in`/`Create an
    account` links stay lowercase; a mid-sentence capital reads wrong).
  - **User-entered content is NEVER re-cased** — moment names, wine names,
    producers, notes render verbatim as typed (title-casing would mangle
    "iPhone", "AC/DC", acronyms, apostrophe-S). Only fixed, app-authored strings
    follow the rule above.
- **No em dashes in copy**: the cross-cutting rule is root CLAUDE.md § Coding style;
  here it is CI-gated by `scripts/check-no-em-dash-copy.mjs` (`check-lint.yml`).
- **Destructive confirms always NAME what's being deleted (Simon, 2026-07-18).**
  The alert title carries the target in curly quotes — `Delete “<name>”?`,
  `Delete your rating of “<name>”?` — falling back to the generic form only
  when no name exists. Masked (blind) wines use their line-up alias
  ("Impression N"), never the real identity. Sign-out follows the spirit: the
  message names the signed-in account.
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

## You profile (handoff 04, steps 1 to 3)

As-built 2026-11-09 (plan `.local/you-profile/step1-plan.md`). Your own profile
is the You tab's root; someone else's is `feed/u/[id]` (mirrored `you/u/[id]`),
pushed from a post's author (avatar + name on the feed cards, and on the
opened post, where it pushes `[id]/u/[personId]` on the post's own stack; inert
when the post was opened from that person's list). Tapping yourself on a card pushes the own variant with back; on
that person's own list the tap is a no-op. Step 2 (bio, cover + hero, editing)
is the next subsection.

- **No second feed.** `components/feed/FeedList.tsx` IS the post list for the
  Feed tab and every profile (`userId` → `/api/feed?user=`, cache
  `['feed', 'user', id]`). Post mutations write EVERY `['feed', …]` cache
  through `lib/feedCache.ts` (`updateFeedCaches` = cancel + `setQueriesData`,
  `refetchFeedCaches` = in-place refetch of the mounted lists, `toggleFeedLike`
  with ONE module-wide per-post seq). 🔒 Never `invalidateQueries` a feed
  cache — the like-error path that did is fixed. A post create / edit /
  delete also `invalidateProfileHeader`s the author (counts, average, tile
  photo; a plain query, so invalidation is fine there), and a create drops
  the UNMOUNTED feed caches (`dropUnmountedFeedCaches`) since a popped
  profile list has nowhere to patch the new post in. Landing callbacks
  (`lib/feedTransition.ts`) are a SET per post: one post can be mounted in two
  lists at once.
- **Header** (`components/profile/`): `ProfileScreen` (states ok / private
  `shell` / blocked-by-you / gone / loading / error, the ⋯ menus, the
  relationship actions) · `ProfileHeader` (`ProfileIdentity` row, status
  `BadgePill` = OUR level names, `StarScore` average, friends · followers,
  in-common row, `FollowButton`, `NoticeBox`, `EmptyPosts`) · `PhotoTiles`
  (the `.yo-ptiles` primitive, `TILE_SCRIM`). Data: `lib/api/users.ts`
  (`GET /api/users/:id?view=header`, key `['user-profile', id]`).
- **Inactive** (visible, not tappable): status line, counts, tiles (a tap;
  the own long-press is step 2), in-common row; menu rows Add Friends, Share
  Profile, Invite to a Moment (MenuItem `disabled` → "Soon"). Your own ⋯
  has no Edit Profile row since step 3 (see the step-3 deviations).
- **Relationship writes** (follow / unfollow / mute / block / unblock): an
  optimistic header patch, then the profile AND the network `['feed']` (exact)
  refetch in place. Mute never touches the profile's own post list (mute is a
  network-feed filter). On failure the pre-action header is restored before
  the refetch (which can fail too, offline). Your own ⋯ (→ Settings → Sign
  Out) renders even while your profile fails to load. Unfollow and Block
  confirm via the house native alert
  (Block uses the design's BLOCKSHEET copy); Follow and Mute act at once.
- **Blocked / Muted lists** live in Settings → Privacy since step 3 (the
  only unblock path for a mutual block, and the way back to a muted person
  you don't follow). A block / unblock / mute on a profile invalidates the
  matching list (`act`'s `list` option).
- **Bar title**: once the header name scrolls under the bar, the bar shows
  the 26pt photo + name — plain `VBar` with `titleShown` / `titleLeading`
  (`back={false}` on the tab root); trigger = the measured name bottom via
  `ProfileIdentity onNameBottom` + `FeedList onScrollY`. It is the shared
  `BarTitle` (see the catalog), NOT the mock's body-size title + photo
  scale: that read as a different bar next to a moment's (ruled on device,
  2026-11-09).
- **Deviations (flagged):** name = `heading` bold (mock 26/700, no 26 token);
  the average numeral is StarScore's accent (mock: ink); empty tiles drop the
  mock's 1px outline (no-borders ruling); the own-variant Settings row pushes
  `/you/settings` even from the Feed stack (inside an opened post: the mirror
  on the post's stack, `settingsHref`).

### Step 2 (bio, cover + hero 04·R5i·b, editing), as built 2026-11-10

Plan `.local/you-profile/step2-plan.md` (rulings D1–D9). Server side: root
CLAUDE.md § Session deletion (D8), `docs/dev/avatars.md`, README.

- **Cover hero** (`ProfileHeader` `CoverHero`, cover set): from the screen
  top to the SHEET EDGE (the card's top line) the cover is `HERO_RATIO` of
  the screen HEIGHT, like the moment, impression and opened-post heroes
  (ruled 2026-11-11 on device: the mock's 3:2 of the width sat low under the
  Dynamic Island); the photo runs `SHEET_RISE` further under the sheet (as
  theirs run `radius.xl`), full-bleed under the status bar
  (`FeedList fullBleed`, keyed on cover / no cover so the scroll setup
  remounts). `coverGeometry.ts` ports `notchSvg` (variant b) parametrized by
  width AND photo size: the sheet edge sits `SHEET_RISE` (26) above the cover's
  bottom, the photo's centre ON it (the notch assumes it), the sheet's left
  corner flowing into the photo's 4pt ring. The photo BREATHES:
  `useProfilePhotoSize` = 104 × the title type's comfort growth (30 → 34pt),
  so photo and name stay in proportion (ruled 2026-11-10). The white name
  sits on the cover beside the photo, `fitCoverName` = the mock's `fitName`
  (measured at the base size in a hidden pass, Dynamic Type included):
  keep, else shrink ≤ 4pt, else two lines with line 1 indented to hug the
  ring. Deviation from the mock (ruled 2026-11-11): at each size the break
  points are tried in order (after word 1, 2, …), so a long name moves words
  up to line 1 before shrinking (to 22pt) or truncating. The hidden
  measuring texts are keyed on name + size: a string shared by an old and a
  new name must re-measure, or the name stays invisible after a rename. Soft top corners while the list is pulled
  past its top (the moment cover hero's rule). A TAP on the cover or the
  photo opens it in the house `FullscreenImage` viewer on every profile; on
  your own profile only a LONG-PRESS edits (ruled 2026-11-11).
- **Bar** (`ProfileHeroBar`): glass back (others) + glass ⋯ over the photo →
  solid `theme.bg` + `BarTitle` (26pt photo + name) once the cover name
  passes under the bar (measured, `scrollY ≥ nameBottom − heroBarHeight`),
  both off one `useBarTitleProgress`. Status bar: light over the cover,
  themed once collapsed; `Stack.Screen` option + `useForwardStatusBarStyle`
  (the profile opens on a post's stack too) + expo-status-bar for Android.
  No cover = the step-1 `VBar` layout unchanged.
- **Own-profile editing** (`ProfileScreen` owns the session, `ProfileHeader`
  renders it): long-press (`LongPressable`, 480ms, dur-2 press scale +
  haptic) the name or the bio → BOTH become `InlineField`s in place
  (registered with the outside-tap keyboard dismissal), the pressed one
  focused; the status line + tiles dim (0.35) and the posts go `inert`.
  `EditBar` (Cancel / "Editing Profile" / Done) RIDES the keyboard
  (`useAnimatedKeyboard`, transform only) and drops to the bottom when an
  outside tap closes it (D6). The pill is held hidden for the WHOLE session
  (`pushSheet` / `popSheet` in one effect cleanup: Cancel, Done, blur,
  unmount). The list's bottom padding grows by keyboard + bar and the focused
  field is scrolled above both (measured). Done = ONE `PATCH /api/me/profile`
  of the changed fields, pre-checked with `validateDisplayName` +
  `normalizeBio` (`@verre/core`); errors alert and keep you editing. Losing
  focus cancels. The "Add a profile text" hint starts editing on a TAP too.
- **Photo + cover** (D2, D4, D5): long-press → `pickPhotoOrRemove` (Take
  Photo / Choose from Library / Remove Photo|Cover / Cancel), uploaded at
  once (`POST|DELETE /api/me/avatar`, `/api/me/cover`). Device photos only:
  the design's "From your tastings" grid is dropped.
- **Tile covers** (R5g2, D3): long-press a tile with a photo →
  `TileCoverSheet` (screen-local `BottomSheetModalProvider`, fixed snap,
  `BottomSheetScrollView` grid, footer pinned through gorhom's footer).
  Pre-selected = the shown photo when offered; Use Photo is live only when
  the selection differs from the current pin. Server rules (pin liveness,
  blind-safe picks, the dead-pin clear) live in `lib/profileTiles.ts`.
- **Edit Profile page** (D1, `you/edit-profile.tsx` + mirrors
  `feed/[id]/edit-profile`, `you/[id]/edit-profile`, via
  `profileEditHref(mount)`, reached from Settings → your card): the cover at
  the profile's height and crop (`HERO_RATIO`, ruled 2026-11-11; it was 3:1,
  the mock 3:2) + 96pt photo with glass edit buttons,
  Display Name, Profile Text (`NotesField maxLength 200`), `SettingsFooter`.
  Everything is a DRAFT until Save; Save runs photo → cover → text and stops
  at the first failure (finished steps stay saved). Bar-hide matches
  `/edit-profile` (the mirrors match neither `OPENED_POST_PATH` nor
  `/you/edit`). Router-sim case: `.local/opened-post-stack/router-sim/t12.cjs`.
- **Caches** (`lib/api/profile.ts` `applyOwnProfileChange`): cancel the
  profile read, typed MERGE into the `ok` entry (viewer epoch checked after
  every await), refetch in place; a rename also updates `['my-account']`; a
  name or photo change refetches the mounted feeds IN PLACE and drops the
  unmounted ones (never invalidate a feed cache).
- 🔒 **Your own name is read from `GET /api/me/account`, never Better Auth's
  session copy**, where the app SENDS it (moment create, join:
  `freshOwnName`). BA serves `useSession().data.user.name` from its Redis
  session copy, which only BA's own `updateUser` refreshes; a rename through
  our routes left it stale.
- **Deviations (flagged):** the cover name uses the `title` token at the
  mock's 600 / 1.05 line height; the edit bar uses `surfaceSunk` (not the
  mock's literal keyboard greys) and no top rule; the tile sheet's selected
  ring stays (a selection state, not a card border); the Edit Profile page
  without a cover shows the add affordance on the sunk fill in the cover's
  footprint (the mock always has a cover); the photo breathes (the mock is
  flat 104). Device checks pending: hero + notch + collapse + status bar
  (incl. inside a post), long-press + the keyboard bar (incl. outside-tap
  dismissal), pickers over a post, the name fit at large Dynamic Type, CJK
  composition near the 200 cap.
  `Button` gained `icon` (leading glyph); `VBar` gained `back` /
  `titleShown` / `titleLeading`; `Avatar` gained `tint` (the
  `.yo-rav-ini` initials disc); icons `user-plus`, `block`, `logout`.

### Step 3 (Settings), as built 2026-11-11

Plan `.local/you-profile/step3-plan.md` (rulings P1–P5, Q-A…Q-F, T1–T5).
Server side: README (mutes GET, devices for the app), `app/api/auth/CLAUDE.md`
(native This Device / revoke-all / device label), `docs/dev/mute.md`.

- **Routes**: `you/settings/index.tsx` (hub) + `privacy`, `blocked`, `muted`,
  `account`, `change-email`, `change-password`, `appearance`; every one
  mirrored under `feed/[id]/settings/` and `you/[id]/settings/` (one-line
  re-exports), via `settingsHref(mount, page?)`. The pill hides on
  `change-email` / `change-password` (sticky footer) and `appearance` (own
  buttons); the others keep it. No page may be
  named `details` / `reveal` (the moment settings' pill-hide suffixes).
  Router-sim case: `.local/opened-post-stack/router-sim/t13.cjs`.
- **Hub**: `MeCard` (name from `['my-account']`, photo from your own header)
  → Edit Profile; Account / Privacy / Tasting (Soon); Notifications (Soon) /
  Appearance (value = theme name or "Match System"); Help & About; Dev
  Gallery (not inside a post); Sign Out; `Verre <version> · Build <n>`
  (`APP_VERSION` / `APP_BUILD`, `lib/clientVersion.ts`, from expo-application:
  `app.json`'s buildNumber is stale under EAS remote versioning).
- **Privacy**: Profile Visible To (`SelectField` + `OptionSheet`, the four
  tiers, ruling P1) + Friends of Friends (Followers / Friends only).
  🔒 Every PATCH sends BOTH fields (the server replaces them; the stored FoF
  rides along while its switch is hidden), optimistic, one at a time
  APP-WIDE (two PATCHes can commit in either order, and Privacy can be
  mounted twice, on the You stack and on an opened post's in another tab: a
  mutation `scope` queues saves in tap order and `useIsMutating` disables
  every mounted editor), alerted on failure: a REFUSAL (4xx) reverts, any
  other failure (no answer, a timeout, a 5xx) may have committed, so the
  value is dropped (`resetQueries`) and every editor waits on the server's
  own read before another save. After each PATCH a
  read still in flight is CANCELLED and the cache set to what the server now
  holds before the re-read (a focus refetch that started mid-PATCH carries
  the old tier, and a save made from it would send it back). ⚠️ Known limit,
  DEFERRED TO STEP 4 (ruled 2026-11-11; step 4 adds fields to the same
  PATCH): a PATCH the phone gave up on (12 s) can still be running on the
  server, and the re-read can return the old value before it commits, so a
  second save may land in either order. It needs a multi-second stall
  before the write (the interactive transaction itself is capped near 7 s by
  Prisma's defaults). The fix is a server compare-and-set: the PATCH names
  the value it replaces and is refused (409) when that is stale. Check-Ins Visible To and the two On My
  Profile switches are locked "Soon" (step 4). Blocked / Muted rows: count +
  chevron; "No one" (inert) only after a successful empty fetch; inert while
  loading; tappable on error. Queries `['me', 'visibility' | 'blocks' |
  'mutes']` (`lib/api/settings.ts`).
- **Blocked / Muted** (`components/settings/PeopleListPage.tsx`): initials
  disc + name + tertiary Unblock / Unmute; Unblock confirms, Unmute acts; the
  row leaves on success, then the person's header, the network feed (and,
  for an unblock, YOUR header) refetch in place.
- **Account**: Email (→ Change Email: New Email + Current Password,
  ruled 2026-11-11; the same PATCH as the web, but from an app caller the
  server requires the password and a `z.email()`-valid address (Better
  Auth's sign-in rule); no confirmation mail, there is no email pipeline; a
  save that lands after you left doesn't pop the screen under you, same in
  Change Password), Change Password, the devices in TWO groups
  (ruled 2026-11-11): THIS DEVICE (the server's `isCurrent`, now set for the
  app's own row; "Active now"; its Sign Out, in red (`Button critical`), is the hub's plain logout, the
  same confirm via `lib/signOutConfirm.ts`, no password: ruled 2026-11-11,
  replacing T3's button-less row), then OTHER DEVICES: Disconnect All Other
  Devices, an accent (orange) action row like the per-device Disconnect
  buttons (`SetNav accent`), in its OWN fully rounded card TOUCHING the
  list's card (separate but connected), the list overlapping it by 1 pt so
  the shared edge is one border, not two (ruled, after Telegram's style). Another device's action is
  DISCONNECT (the web panel's word, ruled 2026-11-11); only your own is
  Sign Out (server order, most recently
  active first; Disconnect each). Every row: last active, the country when
  known, and a second line "Signed in <date>" (the web panel's facts; the
  country comes from the sign-in IP, so local LAN sign-ins have none),
  Delete Account. The three password-gated actions prompt with
  `Alert.prompt` (`secure-text`; 🔒 the password goes straight into the JSON
  DELETE body, never logged or kept; an empty one counts as Cancel, so it
  can't spend a `rl:account` attempt). 403 → "That password isn't right.",
  429 → server copy, 404 → already gone (refetch).
  🔒 **Delete Account** (`deleteAccount`, `lib/api/settings.ts`): the server
  revokes the phone's native sessions BEFORE the step that can fail, so any
  failure past the password check ends signed out: 409 / 503 / 500 with our
  JSON body (and a 401: already signed out) → "wasn't deleted" copy (409:
  too many empty moments) +
  `authClient.signOut()`; a timeout, a network error or a status without our
  body → "couldn't confirm" + sign out. 🔒 Both are dropped (no alert, no
  sign-out) if the viewer changed while it ran: a heartbeat can sign the
  phone out mid-delete and someone else sign in, whose session that sign-out
  would revoke. ONE 120 s deadline covers request AND
  body (`apiFetch`'s timer clears at the headers). No in-place retry.
- **Change Password**: Better Auth `changePassword` (keeps THIS device,
  signs out the rest, charges `rl:account`). 🔒 A transport failure / the
  client's abort REJECTS (never `{ error }`) and the change may have landed:
  unknown-outcome copy.
- **Appearance**: `ThemeSwipePicker` over `ThemePreviewProvider`; the page
  paints its own background (the stack's is the APP theme) and sets the
  status bar per previewed theme on both channels (screen option +
  `useForwardStatusBarStyle`) + expo-status-bar. Two buttons per theme
  (ruled 2026-11-11, replacing the mock's Match System button): "Use
  <Theme>" (always this one, pops) and "Use <Theme> When Phone Is in Light /
  Dark Mode" (STAYS on the page so you can set the other kind too; Match
  System with this theme for its kind: the theme context keeps a
  `systemThemes` pair, `verre.theme.system` in AsyncStorage, defaults until
  chosen; `setSystemTheme`). The one in use turns into "✓ In Use" / "✓ Used
  When Phone Is in Light Mode". Back changes nothing. It opens on
  the active theme, scrolled there once laid out (`contentOffset` alone
  wasn't reliable). The transition is a COLOUR WAVE (ruled 2026-11-11):
  nothing moves; every theme is a full layer stacked in page order and
  clipped to the right of its page edge on screen (transforms only, UI
  thread), so a straight vertical edge rides the page boundary under the
  finger and recolours everything it passes; React re-renders only when the
  nearest page changes (status bar, which layer takes touches), never per
  frame (the worm dots animate left/width, off the fast path, smooth on
  device). The caption is
  centred, 34 below the title; the theme's name + dots sit under the demo
  card (centred with it), the foot holds only the two buttons, 12 apart, a
  wrapped label keeping a one-line inset (`LABEL_INSET`) and growing
  upward; every layer centres its demo over the TALLEST foot (one shared,
  measured height), so a wrapped label never shifts the panel between
  themes; the dots are a scroll-driven WORM over the mock's layout (18pt
  pill, 6pt dots, 6 apart everywhere at rest): the slots morph between
  pages (row width constant), the pill's front end runs over the first 65%
  of the swipe and its back end over the last 65%, so it eats the next dot
  but peaks near 25pt, not double (all ruled 2026-11-11). VoiceOver: the theme name is an
  `adjustable` control (swipe up / down pages the themes), the demo card is
  hidden. Demo photo: `assets/images/theme-demo-petnat.jpg`.
- **Device label**: the Better Auth client sends `User-Agent: Verre/<version>
  (<model>; iOS <version>)` (`AUTH_USER_AGENT`, expo-device); the server
  stores "<model> · Verre App" at SIGN-IN only, so older rows read "Unknown
  device" until that phone signs in again. Native modules added: expo-device,
  expo-application (a new dev build: `pod install` on the Mac).
- **Deviations (flagged):** the Privacy switch rows are `SetNav`-based
  (`.yo-stog` inside a group, per the mock) rather than `ToggleRow`; the theme
  demo card + chip drop the mock's 1px border (no-borders ruling); Blocked / Muted are two
  rows (Q-B) where the mock lists people inline; the devices are two groups
  (This Device / Other Devices) where the mock has one list. Your own ⋯ menu drops the
  mock's "Edit profile" row (ruled 2026-11-11): editing lives in Settings →
  your card, the way a moment's does (⋯ → Settings → Moment Details), and
  the two ⋯ menus line up (Add Friends / Share Profile / Settings vs People
  / Share / Settings). Long-press editing on the profile stays (long-press
  comes to moments later).

## About / Attributions (You tab)

`app/about.tsx` is a hub (app version + legal rows; Terms/Privacy land here when
they exist) and `app/attributions.tsx` renders the wine-catalog source
attributions. Both draw their own `VBar`.

🔒 **THEY LIVE AT THE APP ROOT, OUTSIDE `<Stack.Protected>`** (`app/_layout.tsx`),
NOT under `(tabs)/you` — the same placement as `update-required`, for the same
reason: the attributions are a licence obligation and must render for a
signed-out user on first launch, before any account exists. Under `(tabs)` they
were session-gated and unreachable exactly when someone evaluating the app wants
to read them. Entry points: the `(auth)` landing screen when signed out, and
You → ⋯ → Settings → Help & About when signed in. ⚠️ They are outside the tab bar, so they use plain
bottom padding — **no `TAB_BAR_CLEARANCE`** (the pill does not render there).

🔒 **This is a LICENCE-OBLIGATION surface, not a credits screen.** Four rendering
rules are load-bearing and must survive any redesign or refactor:

1. **BOTH links render, each labelled** — `licence.url` ("<SPDX> licence") and
   `sourceUrl` ("Source"). 🔒 They are SEPARATE fields because CC BY requires
   "provide a link to **the license**" and OGL-BC requires a link to the licence;
   a single `url` left LWIN linking a dataset page instead of its licence. The
   licence link is the compliance-relevant one. Opens via `expo-web-browser`.
2. **`licence.text` renders VERBATIM** — no trim, no re-wrap, no normalisation.
   MIT requires its full notice reproduced. ⚠️ The OGL-BC statement contains an
   **EN DASH (U+2013)**, not a hyphen — BC's own page title uses a hyphen while
   the required statement uses an en dash, so a punctuation "cleanup" would
   alter a legally required string.
3. **`verified: false` renders its caveat VISIBLY.** The flag exists so a
   best-guess paraphrase cannot silently become the record; hiding it reproduces
   that failure one layer down.
4. **The bundled-fallback staleness notice must show.** See below.

**The freshness contract (Simon, 2026-07-26) — state it, don't overclaim it.**
⚠️ Never write "immediately" or "always current" about this surface: THREE
deliberate caches sit between an ops edit and a native screen — the server
process-caches the parsed file (so even the web needs a restart), the API sends
`max-age=3600` + `stale-while-revalidate`, and the client holds a LIVE result
fresh for an hour. The accurate statement:

- **Web** reflects the **running server's** snapshot.
- **Online native** refreshes **subject to its client and API caches**, so it can
  briefly show superseded text.
- **A failed fetch** falls back to the **release-time bundle** compiled into the
  binary and links to the server-published web page. (Within one session a
  previously-fetched live value may persist instead — the query cache is
  in-memory with no persister, so a cold launch offline gets the bundle.)

Only a native release changes the bundled snapshot itself. The bundled text still
renders ABOVE the notice, so the licences are never absent; the link is the route
to the newest wording, not a replacement for showing any.

**Why there are two copies of the entries.** The server holds them as deploy
config (`lib/attributions.ts`) so adding a source is an ops change, not a
release (with the offline qualifier above). A native binary cannot read server env, so the app fetches
`GET /api/legal/attributions` (public, unauthenticated — a legal surface must
render for a signed-out user on first launch) and falls back to a bundled
snapshot in `src/lib/api/legal.ts` when offline. `fetchAttributions` NEVER throws
and never returns an empty list; it reports `origin: 'live' | 'bundled'` and the
screen renders a staleness notice for `'bundled'`. 🔒 **Do not "simplify" that
notice away** — two copies of legal text can disagree, and the stale one must
never masquerade as current.

⚠️ **The query sets `networkMode: 'always'` + `refetchOnReconnect: 'always'`, and
both are load-bearing.** TanStack defaults to `networkMode: 'online'` and
`lib/query.tsx` wires NetInfo into `onlineManager`, so by default the query is
PAUSED offline and the fetcher never runs to return its fallback — the screen
spins forever in exactly the case the fallback serves. `'always'` then disables
the default reconnect refetch, hence the second option; it must be the literal
`'always'` and not `true`, because a bundled result is fresh for an hour and
`true` would honour `staleTime` and skip the refetch the notice promises.

⚠️ **Changing either copy means changing both.** `scripts/check-attributions-parity.mjs`
(workflow `check-attributions-parity`) compares every legally-meaningful field
BYTE-FOR-BYTE, asserts no unverified entry ships, and fails if the en dash is
normalised. `scripts/tests/attributions-offline-units.ts` in the same workflow
drives the REAL fetcher against six failure modes and pins the two query options
+ the outside-the-guard placement. Every mutation named above was verified to
fail one of them.

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

## Deferred Android work

The app ships **iOS-first**; a handful of surfaces used an iOS-only native
primitive and left an explicit Android gap to close when Android is tackled. One
place to look before doing Android work:

- **Photo source chooser (camera vs library).** `pickPhoto` in
  `components/moments/momentForm.tsx` shows a native **`ActionSheetIOS`**
  ("Take Photo" / "Choose from Library"), which is iOS-only. On Android it falls
  back to the library picker directly — **no camera option yet**. To close:
  build an Android source-chooser (a brand `AnchoredMenu`, an
  `@expo/ui/jetpack-compose` menu, or a small custom sheet) that offers
  `pickFromCamera` alongside `pickCover`. The camera helper + the byte-cap
  pipeline are already platform-neutral; only the *chooser UI* is iOS-gated.
  Camera permission string is already in `app.json` (`cameraPermission`).
- **Moments-home "Remove from home" context menu.** Uses `@expo/ui/swift-ui`
  `ContextMenu` (iOS-only, see the `@expo/ui` note above). Android needs the
  `@expo/ui/jetpack-compose` equivalent or a fallback long-press affordance.

- **Password re-auth prompts (Settings → Account).** Disconnecting another
  device, Disconnect All Other Devices and Delete Account ask for the
  password through iOS's secure **`Alert.prompt`**, which Android lacks: there
  the per-device Disconnect buttons render disabled, and Disconnect All Other
  Devices and Delete Account are "Soon" rows
  (`CAN_PROMPT` in `app/(tabs)/you/settings/account.tsx`). Change Password is
  a full page and works. To close: a small secure-text sheet (a `TextField`
  with `secureTextEntry` in the house `Sheet`) that resolves the same
  `promptPassword` promise.

- **Bottom nav offset.** The pill sits a fixed 21pt above the physical screen
  edge, ignoring the safe area (`TAB_BAR_BOTTOM`, the iOS 26 floating-bar
  inset). Under Android edge-to-edge with 3-button navigation the system bar is
  about 48dp tall, so the pill would sit under the buttons. To close: take the
  offset from the inset on Android (e.g. `insets.bottom + 14`), which turns
  `TAB_BAR_BOTTOM` / `TAB_BAR_CLEARANCE` into a small hook.

General rule: an iOS-only native primitive must leave a working (if reduced)
Android path AND a line here, so Android is a known punch-list, not a surprise.
