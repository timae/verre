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
  `buildConfiguration = "Release"`) and keep the Apple Team ID in
  `DEVELOPMENT_TEAM`. The Team ID is TRACKED on purpose (ruled 2026-11-11:
  it isn't a secret, it ships in every signed app and was already public),
  so `project.pbxproj` and `Podfile.lock` are committed as `pod install` and
  Xcode write them; no skip-worktree, no scrubbing. If a second developer
  with another Apple team ever builds, switch to a placeholder
  (`DEVELOPMENT_TEAM = "$(VERRE_DEVELOPMENT_TEAM)"` + a gitignored xcconfig
  outside `ios/`, re-applied by a config plugin): don't just empty it, since
  Expo CLI's signing check reads the raw project value and an empty one
  makes `expo run:ios --device` write a team back. Then diff the regenerated `Info.plist` / `.xcscheme`
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
  photo-hero screens (welcome, session line-up; the moment impression, a
  layer since build 2, through its line-up's option) do this via
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
- Sign-up sends a `username` and is **one step** since usernames
  (`docs/dev/proposals/usernames.md` § 9, § 19): `/sign-up/email` returns the
  session (cookie + token) itself, so `sign-up.tsx` makes ONE call (a
  follow-up sign-in would add a second device row) and maps the honest
  answers per field: 422 `EMAIL_TAKEN` / `USERNAME_TAKEN` /
  `EMAIL_AND_USERNAME_TAKEN` (both lines at once), 400 `INVALID_USERNAME`.
  The client types the field through `inferAdditionalFields` (types only, no
  fetch hooks). `user.username` on every auth response is fresh; `null` = not
  chosen yet. 🔒 Password AutoFill: the EMAIL keeps
  `textContentType="username"`; the Username field never claims it
  (`UsernameField`).
- 🔒 **The choose-your-username screen** (`app/choose-username.tsx`): a third
  guarded route group in `_layout.tsx`, the only open one while
  `needsUsername` (`lib/bootGate.ts`) holds: a SERVER-CONFIRMED null
  (`sessionConfirmed`: settled, no refetch in flight, no error; Better Auth
  clears `error` when a refetch STARTS), latched for the launch. Never from the cached
  session alone (it can predate a name chosen on the web; offline the person
  would be stuck). With three groups every closed guard passes an explicit
  `redirectTo` (the router's default is the first unguarded sibling, which is
  no longer right in every state): don't drop them.
- All Verre API calls go through **`src/lib/apiFetch.ts`** (cookie +
  `X-Verre-Client` header + the 426 update-required handshake + an
  AbortController timeout, default 12s — RN fetch has none). Never bare
  `fetch` against the backend.

## Server state (TanStack Query, hardened per proposal 02 §4)

- `src/lib/query.tsx` owns the QueryClient + the native poll hardening:
  `AppState → focusManager` (only `'active'` counts, debounced 300ms —
  `'inactive'` fires for control-center/app-switcher and is NOT background),
  `NetInfo → onlineManager`, and `useIsOnline()` for reconnecting affordances.
- 🔒 **User ids are PUBLIC ids, opaque strings** (`docs/dev/proposals/public-user-ids.md` § 6): `session.user.id`, every profile / people / feed / session id (`u:<publicId>`). Validate route params with `normalizePublicUserId` (`@verre/core`), never `Number(...)`; post, wine and bookmark ids stay numbers. 🔒 **The boot rule** (`lib/bootGate.ts`, pure, units `scripts/tests/boot-gate-units.ts`): a cached Better Auth session whose `user.id` isn't a public id is STALE (written before the server's switch) and counts as not yet known: no route group mounts on it, the cache-clear effect sees null, the layout retries get-session through `useSession().refetch()` only while nothing is in flight (refetch cancels the request in flight), and a 426 that arrives meanwhile renders `UpdateRequiredView` in place of the neutral screen (no navigator exists to route into; `lib/updateGate.ts` exposes the pending body).
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
- **Gradient (scrims, fades, colour bands)**: `Gradient` (`ui/Gradient.tsx`), a linear gradient from `colors` (+ optional `locations`; top to bottom, `direction="right"` left to right; other View props passed through), drawn by React Native's own `backgroundImage: linear-gradient(...)` (a `CAGradientLayer` the GPU draws: no CPU painting, even when React Native re-creates it on a layout change; border radius clips it). Every gradient outside an SVG uses it (SVG canvases keep react-native-svg's own `LinearGradient`). Never `'transparent'` as a stop: iOS swaps a transparent-black stop for the PREVIOUS colour at alpha 0, so a leading one fades through black; use the neighbour colour at alpha 0 (create's glow). ⛔ `expo-linear-gradient` is REMOVED (2026-11-17) and must not come back: it painted in software on the main thread, twice per paint and again on every size or prop change, which was most of the 0.1.5 You-tab nav lag (Instruments, 2026-11-16).
- **Text input**: `TextField` (`ui/TextField.tsx`) single-line; `NotesField` (`moments/momentForm.tsx`) multiline; `SheetSearchField` (`ui/SheetSearchField.tsx`) is the ONE compact search pill used by compare, People/Invite, recents, AromaInput, and Aroma Details — never import a generic search control from a feature component. `TextField` owns the `formControl` Dynamic Type surface and deliberately omits `lineHeight` on single-line `TextInput` so iOS centers entered glyphs correctly. A single-line `TextField` always sends an explicit paragraph style (`lineBreakModeIOS="tail"`; not the paragraph default, word wrapping, which likely caused the July wrap-on-blur bug) and `letterSpacing: 0`: a DEFENSIVE workaround for a placeholder seen ~14pt low and clipped, intermittently, gone after a relaunch (2026-11-09). Hypothesis, UNVERIFIED on device: Fabric recycles native text fields on iOS and UIKit keeps an attribute RN leaves unset from the previous field (e.g. `ScoreInput`'s lineHeight 48 would give that offset). Keep the two defaults; drop the hypothesis if a repro ever shows otherwise. Pass `surface="code"` for fixed-format codes. **Error state**: `error="msg"` = red border + inline message; `invalid` (boolean) = red border ONLY (for a form-level summary that carries the copy). Both set `aria-invalid`. `DateField` (`moments/momentForm.tsx`) mirrors this with an `error?: boolean` border flag + a `placeholder` prop (a REQUIRED date field passes e.g. "Tap to set" so the empty state doesn't read "Optional"). (A shared `<TextArea>` is a pending extraction — see below.)
- **Bottom sheet**: `Sheet` (`ui/Sheet.tsx`) — the gorhom shell (themed bg/handle/backdrop + tab-bar-hide, only while the sheet's SCREEN is focused: a sheet left open under a pushed screen doesn't hide the bar there, 2026-11-15). All sheets. 🔒 Every SCREEN that renders one (incl. `OptionSheet` / `CountrySheet`) wraps itself in `BottomSheetModalProvider`: there is no root provider (`app/_layout.tsx`), and a screen without one crashes the moment it mounts ("'BottomSheetModalInternalContext' cannot be null", Settings → Privacy, device pass 2026-11-11). tsc and `expo export` can't catch it. ⚠️ Two load-bearing gorhom facts baked into the shell + consumers: (1) the BACKDROP renders as a no-zIndex sibling BEFORE the sheet container, so the shell z-indexes backdrop (99) + container (100) — without that, a screen's zIndexed absolute overlays (hero bar, sticky tab/rail overlays, reconnecting bar) paint OVER the dim layer (`containerStyle` alone does NOT reach the backdrop — a fix that "looks right" but isn't); (2) sizing is two-mode: dynamic fit-to-content (`maxDynamicContentSize`, plain-View rows — a `BottomSheetScrollView` measures 0 under dynamic sizing) while content fits, or fixed-snap + `BottomSheetScrollView` when it can't (rows past the cap CLIP unreachably under dynamic sizing). The compare sheets (`CompareBody.tsx`) show the cap-aware mode switch + the search height-lock recipe; (3) 🔒 **sheet-scroll invariant: NEVER wrap a `BottomSheetScrollView` in a `BottomSheetView`** — BottomSheetView's mount effect re-registers the sheet's scrollable as `type: VIEW` (child effects run first, so it always wins), which sends content drags into the sheet's over-drag branch and pins the list to offset 0: the sheet "isn't scrollable" on device (found via the 100-taster stress seed, 2026-07-17 — latent in EVERY scroll-mode sheet; only surfaces with content long enough to scroll). In fixed-snap scroll mode wrap with a plain `View` (dual-mode sheets: `const Wrap = scrolls ? View : BottomSheetView` — dynamic fit-to-content still needs BottomSheetView's measurement); (4) 🔒 **a sheet's content renders at the BottomSheetModalProvider's PORTAL HOST** (`@gorhom/portal` renders the nodes there), so a context provided BETWEEN that provider and the `<Sheet>` is NOT visible to components inside the sheet: read it where the `<Sheet>` is rendered and pass values down, or re-provide it around the sheet's content (`PersonPreviewBridge`; Codex 2026-11-15). Contexts above the screen's provider (the stack's `SessionTabProvider`, the query client) are fine.
- **Segmented pill switcher**: `Segmented` (`ui/Segmented.tsx`) — the rounded `theme.bg` track with a `theme.surface` pill on the active segment. Two metric sets: default (full-width flex-1 segments — the BrowseSheet picker switcher + the aroma detail sheet's 3d tabs) and `compact` (content-sized mini twin — the ListPicker look switcher). ALL pill-track tab switching routes through this; the dev gallery's knobPill copies are lab code and stay local. Screen-level chrome stays `SessionTabs` (underline) / `PillTabBar` (bottom nav) — this is the IN-SHEET / in-panel pattern.
- **Anchored dropdown menu**: `ui/AnchoredMenu.tsx` — `AnchoredMenu` (the `.ir-menu` panel: Modal shell + surface card + `elevation.menu` shadow + dur1 fade/4px-rise + flip-up-near-bottom, `{top,bottom}` anchor), `MenuItem` (icon/label row, `tone`/`disabled`/`active`), `MenuSeparator`, `AnchorButton` (measure-self ⋯ trigger). ALL ⋯ dropdowns route through this. OPT-IN `onClosed`: runs once the menu's Modal has actually gone (iOS `onDismiss`, on EVERY close), for a row that presents a native view controller (the share sheet); only when passed does the Modal stay mounted (`visible` follows `anchor`); a menu without it renders exactly as before. Record the action in a ref from the row and run + clear it in `onClosed` (ProfileScreen's Share Profile). (Anchor to a ROW not the button → keep a manual `rowRef.measureInWindow` like PeopleSheet's PersonRow.)
- **Query-failure UI**: `ui/ConnectionState.tsx` — `ErrorState` (full-screen + retry), `ConnectionBanner`, `ReconnectingBar`, `connectionView()`. All poll/error affordances.
- **Terminal centered message**: `CenteredMessage` (`ui/ConnectionState.tsx`) — `title` + optional `body`, vertically centered, NO retry (the no-button sibling of `ErrorState`). For dead-end states a refetch can't fix ("this impression is gone", "you can't edit this"); pass `pending` to blank the copy while a query resolves. Caller owns the bar above it. Reuse instead of re-rolling the flex-center block.
- **QR**: `QrCode` (`ui/QrCode.tsx`).
- **No status-bar band**: `NoTopEdgeFade` (`ui/NoTopEdgeFade.tsx`) — wraps a full-bleed scroll view so iOS 26 draws no edge band under the status bar (§ Scoring input, the full-bleed note).
- **Info popover**: `InfoTip` (`ui/InfoTip.tsx`) — the small ink-soft ⓘ (`AnchorButton icon="info"`) opening the anchored panel with a few lines of `small` text: NV's explanation (`NvInfo`), Moment Privacy's "Who Can See This Moment" (via `SetTitle info`). A richer reference (the 0–5 intensity scale) stays `IntensityScaleInfo`.
- **Score READ**: `StarScore` (`scoring/StarScore.tsx`) — the one-star + value (`★ 4.25`). Never inline a star.
- **Score WRITE**: `ScoreInput` (`scoring/ScoreInput.tsx`) — wide slider + editable number + word (gesture+haptics). The editable score numeral uses the `score` Dynamic Type surface, not the generic badge/code surfaces.
- **Structure wheel (READ)**: `StructureWheel` (`scoring/StructureWheel.tsx`) — renamed from FlavourWheel 2026-07-11 (Simon; the axes ARE structure intensities).
- **Group charts (02d Compare)**: `ComparisonWheel` (`scoring/ComparisonWheel.tsx`, the C1b min→max band wheel, wedge tap → drill-in) + `RadarOverlay` (`scoring/RadarOverlay.tsx`, ≤4-taster overlaid radar). Geometry from `@verre/core` (`comparisonWheelGeometry`/`radarOverlayGeometry`); aggregation from `aggregateFlavourAxes` (client-side per the §7 ruling — no server aggregate). Person-series colours via `usePersonColors()` (`theme/flavourColors.ts` — derived from the palette base ramp, stable roster-index assignment). ⚠️ The labelled charts' natural canvas (size 232 + 2×58 pad = 348pt) is WIDER than a small phone's content column — every host must measure its width (`onLayout`) and pass `maxWidth` (all three wheels + `StructureWheel` take it; it scales the whole SVG uniformly, the design's `.radar { max-width:100% }`).
- **Tab strip**: `TabStrip` (`ui/TabStrip.tsx`) — THE screen-level `.vtabs` underline strip, controlled, centred; `fit` shrinks the labels instead of overflowing (People's three counted tabs at large Dynamic Type). `SessionTabs` is a thin wrapper over it (same props + metrics as before).
- **Session-screen chrome (line-up 02b + compare 02d)**: `SessionTabs` (`moments/SessionTabs.tsx` — the .vtabs strip (a `TabStrip` wrapper), CONTROLLED: Compare is an **in-screen tab swap** per Simon's 2026-07-02 ruling — everything above the tabs (bar or cover hero) stays, no route change, no back-to-line-up; the Add pill + reveal strip are line-up furniture and hide on Compare), `CompareBody`/`CompareToolbar`/`ComparePickerSheet`/`buildComparePeople` (`moments/CompareBody.tsx` — the whole 02d compare surface; **the behaviour spec-of-record is `docs/dev/proposals/structure-wheel.md` §7 + ADR-0005 — read those before touching it**. Headlines: multi-open collapsed-by-default cards; cards render in LINE-UP order by default with a toolbar sort menu (line-up / highest / lowest rated / most / least agreement / most ratings) + an impression search (name/producer/vintage/grape/type/region/country — NOT link/vinification/description); the picker sheet is the ONLY select/deselect surface since the toolbar superseded the 02d·4 avatar-chip rail (Simon 2026-07-03; screen-owned hidden set; deselected people vanish from cards, header recomputes; toolbar sticky like the reveal strip — plain: `stickyHeaderIndices`, hero: the strip overlay slot, where it renders TWICE — search value must stay screen state); chart mode keys on the STRUCTURE-ENGAGED taster count; person rows are per-person DETAIL views, not toggles; axis drill-in from C1b wedges or radar labels; Show-all sheet), `SessionMenu`/`SessionMenuButton`/`useBlindForEveryoneToggle` (`moments/SessionMenu.tsx` — the ⋯ menu (People/Share/Settings) + the optimistic blind-for-all mutation; the Blind-for-all ROW lives in the line-up's eye menu since ADR-0007, not here), `SessionFatalView` (`moments/SessionFatalView.tsx` — gone/removed/banned/invalid terminal states).
- **Session poll bootstrap**: `useSessionPoll(code)` (`lib/useSessionPoll.ts`) — visit → `/state` poll → per-section `lastRef` merge (keyed on code+identity, checked synchronously) + fatal/removed handling. ANY new screen reading the shared `/state` poll uses this hook. The moment impression reads the line-up's (it is a layer inside it since build 2, no poll of its own).
- **Structure WRITE**: `StructureInput` (`scoring/StructureInput.tsx`, renamed from FlavourInput 2026-07-11) — the per-axis fill-track grid (whole 0–5 steps, gesture+haptics, VoiceOver-adjustable); axes from `resolveAxes`, colour from the active theme via `useFlavourColors()` (`theme/flavourColors.ts`). ⭐Fill = the BADGE TINT `mix(colour, surface, 0.72)` + plain ink label, NO halo (Simon's ruling 2026-07-11 — a sanctioned deviation from the mock's solid .filltrack fill; matches the wheel's wedge wash formula). ALL structure-intensity input. `range` = the filter's from–to tracks, SAME grid + tracks, one render path (§ Impression filters). The ⓘ 0–5 scale beside a structure help line = `IntensityScaleInfo` (`scoring/IntensityScaleInfo.tsx`; rating + the filter).
- **Rating block (WRITE)**: `RatingSection` (`scoring/RatingSection.tsx`) — THE score · note · structure (ⓘ intensity reference) · aromas section, shared VERBATIM by the moment impression (02e, a page of the impression layer) and the standalone check-in rate stage (Simon 2026-07-12: one component so a future ordering/copy/behaviour change lands on both; the impression's anatomy — Score → Your Note → Structure → Aromas — is the spec). Structure is ALWAYS OPEN (Simon 2026-07-17 — supersedes the adaptive fold + its engagement-seeded open flag). Fully controlled: screens own every value; pairs with `useAromaSearchScroll` (`scoring/aroma/useAromaSearchScroll.ts`), the shared screen-side keyboard-fit hook (screen provides scrollRef + a scrollY-tracking onScroll). Don't hand-compose these widgets on a new rating surface.
- **Feed-post edit (2026-07-17)**: owner-only ⋯ on both feed cards (`feed/FeedCardMenu.tsx` — AnchorButton + AnchoredMenu; the list screen passes `onEdit` only for the viewer's own posts, session cards target the ACTIVE carousel slide's wine id) + the detail menu's Edit row → `feed/edit/[id]` (`?wine=` for session kind). ONE screen, two variants: session = prefilled `RatingSection` only; standalone = the tappable impression SQUARE (photo · name · producer → pushes `feed/edit/details`, the create stage-1 field anatomy seeded from `lib/checkinEdit.ts` — the module edit store, one entry PER EDIT SCREEN (its key travels to the details screen as `edit`, since 2026-11-24: a look-in link can open a second edit on top); photo edit adds the unchanged/replaced/removed tri-state) above the rating block. Save PATCHes `/api/checkins/:id` (`patchCheckin` / `patchSessionRating` in `lib/api/feed.ts`) and maps the echo into EVERY `['feed', …]` cache IN PLACE (`lib/feedCache.ts` — never invalidate); a reaped session rating (`feedItemDeleted`) refetches in place instead. Tab pill hides on `/feed/edit*` like the create stages. DELETE (2026-07-18): the same ⋯ menus (cards + detail) carry a danger row — standalone “Delete” = `deleteCheckin` (`DELETE /api/checkins/:id`, standalone-only server-side, S3 reclaimed); session “Delete Rating” = the empty-PATCH reap on the ACTIVE slide's wine (post survives unless that emptied it). Both confirm via the house native `Alert.alert` destructive pattern, NAMING the target (blind wines use the card alias “Wine N”); on success the item/wine is dropped from every feed cache IMMEDIATELY (`updateFeedCaches` → awaited in-place `refetchFeedCaches` — leaving the card actionable until a refetch landed let a second delete 404, a Codex catch), and the detail pops straight to the feed (`closeDetail`, no reversed presentation — the card underneath is gone) whenever the POST went away. The edit screens are ordinary PUSHES with swipe-back, like Edit Impression (ruled 2026-11-24), on the tab stacks AND on an opened post's stack. They were `fullScreenModal` from 2026-07-18 (a card push from the old transparentModal detail got presented as a pageSheet); the detail now opens the edit on its own stack, so nothing pushes the outer edit from a modal any more. Swipe-back drops unsaved changes without asking, as Back always did.
- **Compare aromas (02d, §8/§9)**: `AromaCompareStrip` + `AromaDetailSheet` (`moments/`) over the ONE per-card `buildCompareAromaModel` from `moments/aromaCompareView.ts` — 🔒 CompareBody builds the model only while that card/detail sheet is open, memoized by `compareAromaInputSignature`, and passes it to every compare-aroma surface; never let a renderer re-derive consensus/contributors itself. Unknown-only historical aroma ids do not admit a dead card (`hasResolvableAroma`). Aggregate counts + contributor identities share core `aromaAncestorChain`; the model derives ONE `pronouncedIds` set consumed by strip + sheet. **The Aroma Bun and the consensus-TREE render are REMOVED from production (Simon 2026-07-19)** — `model.bun`/`consensusBunNotes` + the viz geometry remain dev-gallery lab material only. Every derivation is pure + pinned in `.local/test-env/scripts/aroma-aggregate-units.ts` (steps 37b–40): mode fork, `detailPillColors` (per-theme contrast ladder — clay = solid rung), `packStrip` (measured widths, always-present tail — deliberately separate from `packChips`, see its comment), the Overview/pyramid/fingerprint derivations below. Strip width keys include id + live count + pronounced state; an open popover remeasures its trigger after renders so poll reflow cannot strand it. `AromaDetailSheet` is a FIXED 85% scroll sheet across every tab — never dynamic-size it per tab. Tab order is ALWAYS Overview / People / All Aromas (fallback keeps the Overview tab — rail parity, Simon 2026-07-19); switching tabs must not move the sheet. The detail sheet contains: **Overview** (the 2026-07-19 scientific-review + Simon-rounds redesign — spec below) / **All Aromas** (the Top-10 true-triangle PYRAMID above a toolbar with the compact Mentions/Family switch on the LEFT and the standard `SheetSearchField` filling the RIGHT of the SAME ROW—the app-wide toolbar order; Mentions = one FLAT occurrence-ranked field of exact canonical `AromaChip` pairs, so modifiers remain inside the badge exactly like impression detail; Family = the SAME badges grouped under a family dot/header, ranked by each family's summed literal family/subfamily/leaf mentions, with occurrence-ranked badges inside; taxonomy order only breaks ties; every badge count is distinct tasters for that exact pair; no base-heading/modifier-tally analytics) / **People** (search matches BOTH names and aroma vocabulary, including a family query such as Fruity matching descendant picks; within every matching person, matching badges move FIRST and nonmatches use the same `muted` paling as AromaInput search; established Moments/Compare row anatomy with comfort-scaled 40pt Avatar (centred on the row, ruled 2026-11-15; a tap opens the person preview) + name + exact `AromaReadChips`, roster order, two-line collapse; "+N more" PUSHES the established full-badge read sheet titled in Title Case: "`<Name> Perceived N Aromas`"). `AromaBadgePopover` is the ONE ruled Badge-Extension shell: Tier-2, All-Aromas badges, and People badges all reuse it; it renders OUTSIDE the gorhom sheet tree so opening it can never alter sheet measurement. A People badge says "Also perceived by" and excludes its row owner; the rejected duplicate inline "Perceived by" block under All Aromas stays removed. People also shows `aromaTasteSummary`: weighted taxonomy Dice (family 1, subfamily 2, leaf 3, explicit modifier 1; Pronounced excluded), producing Most alike / Most different / Closest to group / Most individual from THREE aroma respondents up (fewer → the panel is suppressed: with two, every stat names the same pair — Simon 2026-07-17); compute it only while the sheet is mounted, never in every card poll. Scores are UNITLESS 0–100 (no % sign — Dice×100 is not a percentage of anything nameable; scientific review 2026-07-19); the person extremes draw only from respondents with ≥2 picks when ≥2 qualify (`eligibleGroup` — a one-pick respondent mechanically scores low; the ranking sheet ranks eligibleGroup for closest/individual so row #1 matches the card, with a footer naming excluded singles), and every extreme carries a tie count (`*Ties` fields) — the cards show "N tied" instead of silently crowning one equal, and the ranking sheet accents every row tied with the leader. Every stat card TAPS THROUGH (Simon 2026-07-17) to a pushed 70% ranking sheet (`TasteDetailSheet` — sheet-over-sheet is the ruled navigation; an in-sheet drill was rejected as illegible): top/bottom 8 pairs or people with scores, #1 expanded, single tap-to-swap expansion; expanded pairs show the `tasteSharedEvidence` chips (SHARED = exact picks + same-leaf, RELATED = subfamily/family territory not covered by a finer shared node), expanded people show their closest matches; a footer names the cut (`Top 8 of N pairs`). `summary.pairs`/`summary.group` are the complete stable-sorted rankings; `aromaTasteSummary` is computed ONCE at the CARD (CompareBody), gated on a sheet needing it, and passed to both sheets. 🔒 The ranking sheet MOUNTS AT THE CARD as the detail sheet's SIBLING (screen-level sheet anatomy), never inside the conditionally-mounted AromaDetailSheet — the first cut nested it there and closing it stranded the detail sheet presented-but-closed on device (invisible, blocked reopening, flickered on unmount). All Aromas and People each own a `compareSelectionReducer` + search state (the Overview has neither — its taps are popovers): switching views preserves that tab's focus for return but never carries muting/highlighting into another tab. Within a tab, selection is single-select aroma XOR participant and retap clears; aroma identity remains the THREE-WAY `AromaRef` because popovers/routes still distinguish node = subsumed, base = literal-all-modifiers, pair = exact. All Aromas taps are pair refs. 🔒 The Overview is NOT a selection surface: fingerprint segments, bar segments, and Also-mentioned chips anchor a contributors POPOVER on tap (`openBar`), with a SOURCE-MATCHED connector — bar tap clones a flat square colour bar, fingerprint tap a pill segment, pyramid tap the EXACT facet polygon WITH its label lines; only the Also-mentioned chips (real badges) keep the badge connector. A strip-popover "+N more branches" focusId opens the sheet on All Aromas with the node's supporting picks highlighted (there is no node-focus in the Overview — a below-floor head has no row). 🔒 `peopleFilter` is separate navigation context, set by popover routes and cleared only by Show All ✕; search filters within that context and selecting a person never clears it. Active tab + filter + each tab-local selection are validity-derived every render; tab changes reset only the shared scroll viewport. The "+ Aroma Details" pill remains the local `AromaDetailPill`. Consensus defaults are frozen in core (primary > n/2 · peak ≥ ⅓); **pronounced is a SUPPORTER-majority** (`pronouncedCount*2 > supporterCount`, floor 2 — scientific-review fix 2026-07-19: non-perceivers are missing evidence, not negative intensity votes). **The Overview page** (top to bottom): "N tasters noted aromas" caption · the family FINGERPRINT strip (`familyFingerprint` — PEOPLE-weighted: distinct family supporters per segment, mention totals only as tie-break + the popover's "· M mentions" detail line (scientific review round 2, 2026-07-19 — a people strip provably can't outrank a family that has no bar); segments FADE into neighbours via `ui/Gradient`, tappable, deliberately unlabelled, NO numbers ever) · one CHART BLOCK per agreed head clearing `overviewHeadFloor` = max(2, ⌈n/3⌉) (label line + a bar whose filled region is PARTITIONED by contributing aromas — `headBarSegments`, each supporter attributed to their deepest supporting pick, Σ = head count; discrete per-taster cells at n ≤ `OVERVIEW_DOT_MAX`=10 with "k of n" labels, continuous fill + whole-% above; ONE flat family colour, NO tints, square corners, no separator before the unfilled remainder; in-bar labels fit-gated) · an Also-mentioned tail (uncovered bases, tappable chips, "All Aromas ›" jump; label flips to MENTIONED when no rows) · the multi-select disclosure caption. Fallback mode = fingerprint + tail, no bars. The pyramid: `topAromaPyramid` (1/2/3/4 tiers over the top-10 exact pairs) drawn by `pyramidLayout` (true triangle, weighted apex band, food-pyramid vertical cuts) with `wrapPyramidLabel` slope-aware word-wrap; a11y + popover titles carry the exact (aroma, modifier) pair. As-built record: `docs/dev/proposals/aroma/aroma-layer.md` §8.
- **Aroma READ**: `AromaReadChips` (`scoring/aroma/AromaReadChips.tsx`) — read-only grouped chips (displayOrder + AromaChip) for someone's stored selections; feed impression detail now, further native read surfaces reuse it. The `lead` word prop was REMOVED (fixes round 2026-07-13 — the feed detail carries a section title instead). Pass `collapse` for the rating page's overflow behaviour: two lines via the shared width packer (`packChips`/`ChipMeasurePass`/`MoreChipsPill` in `parts.tsx`, also used by `SelectedChipsRow`), tail behind the SAME "+N more" pill that opens a read-only bottom sheet — pass `overflowSheetStack="push"` when hosted inside another sheet, and `overflowPillOnSurface` when the row itself sits on a sheet's `surface` so the pill swaps only its fill to `bg` instead of disappearing surface-on-surface. Optional `onPressAroma(selection, rect)` adds anchored read-side inspection without changing the canonical badge. ⭐Read badges are COMPACT: `AromaReadChips` passes `vPad 0` (inner padding 0 + the inherited 23pt label line via `badgeVMetrics`; Simon 2026-07-13) to every chip + pill it renders — write surfaces keep the 4.5 default; don't override per call site. The WEB has its own twin (`components/ui/AromaReadChips.tsx`, PR D — no shared RN/web layer). No input, no refine — mutations only through AromaInput.
- **Aroma input (descriptor layer, PR B)**: `scoring/aroma/` — `AromaInput` (the 02e·11 search-first section on the impression screen: chips + search field + the INLINE CanvasPicker right under it — a live query swaps the canvas for the suggestions + refine row, an empty query brings it back (Simon 2026-07-17 — supersedes the browse button + BrowseSheet entry point); controlled `AromaSelection[]`, local-until-commit; `bare` + `limitText` + `overflowSheet` host it inside another sheet: Filter for Aromas), `parts.tsx` (`AromaChip` — THE aroma badge everywhere: the design's `.badge` anatomy per Simon's 2026-07-10 ruling — family-tint fill + `readableSolid` words (the 100% palette colour where it clears 3:1 on the fill, pulled toward ink ONLY past that — supersedes the earlier bare-solid-words + tintedInk iterations); `focused`/'solid'-bumped fills = SOLID family fill + `inkOn`-picked label — ⚠️ but an ARMED SEARCH RESULT no longer uses it (Simon 2026-07-12, ADR-0008 addendum): armed keeps its RESTING colours and the OTHER results mute (`muted`) — contextual focus, chips never self-recolour; `focused` remains the picker-cell/solid vocabulary; Pronounced border = `readableBorder` (readable, floored at 45% colour share so clay never reads white), the label ink on solid fills; fills route through `aromaTint.ts` `aromaFillRatio` + words/borders through `readableSolid`/`readableBorder` — keep all three on any new family-tinted surface; genuinely weak palette values are still the PALETTE's to fix (punch-list printed by aroma-pickers-units.ts); `ModifierRail`, `PronouncedRow`, `ModifierPopup` anchored refine, `useAromaOps` — every mutation re-gated + pair-precise, `canonicalPair` — re-target after promoted rewrites, `useTapOrDouble`, `usePendingAdd` — the pickers' armed modifier+Pronounced pair committed as one add, `RefineAddRow`/`ModifierSelectButton`/`PronouncedToggle` — THE shared refine row (search block + Map/Canvas/Rings inline + List via the sheet footer), `CapHint`, `AromaCrumbs` — the drill breadcrumb shared by Rail/Canvas/List), `SelectionSheet` ("+N more" overflow, cap-aware sizing), `BrowseSheet` (NO production entry point since the inline-canvas ruling — kept as the five-picker lab: segmented control, Map/Rings/Rail/Canvas/List; added-badges strip w/ refine popup; ONE always-enabled scroll (gorhom latches scrollEnabled from first render — no per-variant toggle), content-pan on so pull-down works, stage pans win by activating first), `RailPicker`, `RingsPicker` (W4, the mock's OVERSIZED-CROP geometry — the crop IS the design; NO fisheye: even wedges always, ONE static layout per commit for wedges+labels so turning is pure rotation; full pick name reads in the passive HUB as plain wrapped text, never TextPath; Add/refine = the shared RefineAddRow below the stage; every gesture end snaps synchronously to a detent, taps = real Gesture.Tap raced with the pan; labels fit-or-hide inside the visible window. ⚠️ rnsvg TextPath + animatedProps on its referenced Path is BROKEN on device — text draws along mount-time geometry and end-clips; never reintroduce), `MapPicker` (3-level zoom; territories = recursive balanced cuts — families + groups guaranteed CONNECTED and compact; live pinch-between-levels w/ focal-point scale + re-base; momentum pan) + `CanvasPicker` over `hexStage.tsx` (shared axial-hex SVG stage: pannable clamped translate w/ withDecay momentum — pan DISABLED when the cluster fits so the sheet keeps its drags (edge-fade affordance was tried and REJECTED on device — don't reintroduce); per-cell a11y button+selected state; strict flat family fills; armed cell = search-focus treatment: grow + others mute; Canvas sizes its stage TO the cluster (capped) so small combs don't float in empty bands; the PURE lattice/syllable-wrap/clamp math lives in `hexMath.ts` and the Map's territory cuts in `mapLayout.ts` — both node-importable, regression-driven by `.local/test-env/scripts/aroma-pickers-units.ts`; per-theme fill strength in `aromaTint.ts` — clay boosts the family-colour share, see the badge note below), `ListPicker` (drill list with a Tinted/Plain/Cards look switcher — Tinted = badge anatomy rows, Plain = People-sheet rows w/ hairline separators, Cards = the SetGroup/SetNav settings anatomy; family colour stays as dot/mark + armed tint on the non-tinted looks; round mark = any-tier arm; its refine row is PINNED to the sheet bottom via the Sheet's gorhom `footerComponent`). **Design spec-of-record: `docs/design/decisions/0008-aroma-input-search-first.md`** (variant pick, chip anatomy, Pronounced glyph/border split, ordering, add feedback, keyboard scroll) + `docs/dev/proposals/aroma/aroma-layer.md` (data semantics). Icons: `grid`, `pronounced` (reusable "standout" mark). `Button` gained `titleLines`; `SheetSearchField` gained `onFocus`/`onBlur` (and `autoFocus` since 2026-11-12, for a pane opened by tapping a search pseudo-field: Add Friends, the invite sheet's field).
- **Role chip / badges**: `RoleChip` + `BadgePill` (`moments/RoleChip.tsx`) — host/cohost/provider text pill and the shared small badge primitive. Use `BadgePill` for People/settings role tags instead of reimplementing badge centering, line-height, or tone math.
- **Settings kit**: `settingsParts.tsx` — `ReadCard`, `SetGroup` (`flush` = no bottom margin, for the You settings pages; it draws the hairline BETWEEN its rows, `.setnav + .setnav`, and rows draw none: a line on the first row doubled the card's border, fixed 2026-11-11), `SetNav` (+ `bare` = the cardless settings standard: no card padding / press fill (a dim), label `body` regular (an `action` row MEDIUM, like the rows' trailing `rowAction` buttons: Remove All Other Devices, Delete Account), value `body`, ~12 between rows, `flush` = none above (Privacy-style pages, Account since 2026-11-11), `subtitle` (the helper size, `small`, since 2026-11-11), `value`, `leading` node in the icon's place, `accent` = label + icon in the accent (beside `critical` red), `trailing` node or `'none'` in the chevron's place (a row with a trailing NODE is not one accessible element, so its button stays reachable), `busy` = a spinner there while the row stays one busy button; `small` = a `bare` row at the helper size (`small` text, icon 15, half the gap above) for a link under a line of `small` text, Moment Privacy's Change Account Privacy; `icon` optional), `GlassButton` (over-cover round glass; `bottom` anchors it bottom-right), `SettingsFooter` (sticky Discard|Save), `ToggleRow` (THE switch row, moment settings + You Privacy: ruled 2026-11-11, label `body` REGULAR, helper `small` (13) ink-soft right under it (no margin), reason = `SetNote`, rows ~12 apart (`ROW_GAP`), the OFF track a NEUTRAL ink at 18% (`alpha(theme.ink, 0.18)` as `trackColor.false` + `ios_backgroundColor`; iOS's default grey vanished on Apricot, an accent-tinted one read as "half on"), the helper pulled up (`HELPER_PULL` -4: ~18 baseline to baseline), the switch inset `CHEVRON_TIP_INSET` (6) so it ends where a chevron's visible tip ends (ruled 2026-11-11); 🔒 the switch carries `alignSelf: 'center'` (React Native's iOS `Switch` composes a default `alignSelf: 'flex-start'` under any style, which beat the row's `alignItems` and pinned every switch to its title line until 2026-11-25: give EVERY `Switch` an explicit `alignSelf`); `subtitle` optional, `flush` = no top padding (first row under a `SetTitle`), `busy` = only the switch is inert while a save is in flight, `disabled` also fades the text), `ToggleCard` (a LIST's filter switch about what you share with someone, the mock's `.yo-commonrow`: a WARM card (`accentTint` fill, no edge) + `ToggleRow` at the `.setnav` padding (11 below: the row adds 2), its title the INACTIVE TAB's look, semibold `inkSoft` (`ToggleRow strong` + `titleColor` = `readableSolid(inkSoft, ink, flatten(accentTint, bg))`: inkSoft, pulled toward ink only under 3:1, Clay / Mauve), the helper line likewise at 4.5:1 (`subtitleColor`, `readableSolid(…, 4.5)`; Clay's own ink tops out at 3.36 on the tint); no `disabled` (the faint ink would vanish on the tint); someone's People "Only People You Know" and Impressions "Show 23 tastes you share"; ruled 2026-11-13, Settings' own switch rows stay cardless), `SetTitle` (a settings section title: `bodyLg` 600, -0.01em, 6 above its first row; not the uppercase label; `info` = an `InfoTip` ⓘ right after it), `ChoiceRow` (a cardless choice row: label `body` regular, value `body` ink-soft, chevron 18 ink-faint; at least a switch row's height (`SWITCH_ROW_MIN` 31, a floor: ruled 2026-11-25, a one-line row between switch rows read squeezed); opens a sheet or a page; no `onPress` = an inert value row, no chevron; `helper` = a line under the label; `dropdown` = it opens a choices sheet, chevron DOWN (a page: right); `icon` = a leading glyph), `PersonRow` (a cardless person row: 36 initials disc + name + a trailing button; Blocked / Muted), `SetNote` (`small` 500 accent: a locked reason, "Limited by …"), `SettingsScreenFallback` (bar + spinner or retryable `ErrorState`; `errorTitle`). You settings pages (04·4): `SetPage` (`.yo-setbody`: bar + sections 26 apart (`gap`; a page of `SetTitle` sections passes 32, the design's space above a section title), pill clearance, keyboard-aware; a sticky-footer page passes `footer` + `bottomPad`, like Change Password; `offline` = `failedReads(...queries)`: the "Can't reach server" strip under the bar), `SetSection` (`.yo-sgrp`: uppercase label + content), `MeCard` (`.yo-mecard`). `SelectField` gained `disabled`; give it an `accessibilityLabel` that carries the value (`Type: Wine`), since the label replaces the field's text for VoiceOver.
- **Theme preview**: `ThemePreviewProvider` (`theme/index.tsx`) re-themes a subtree (`theme` AND `themeKey`; the real `choice`/`setChoice` pass through). `ThemeSwipePicker` (`settings/ThemeSwipePicker.tsx`) is the design's 01 swipe-to-theme, reusable for onboarding (caller supplies the header + `onUse` / `onUseInSystem`; `ThemeProvider` keeps the light/dark `systemThemes` pair).
- **Sign-out confirm**: `lib/signOutConfirm.ts` `confirmSignOut(who, setBusy)` — THE sign-out (Settings → Sign Out, Account → This Device): names the account, goes through Better Auth. Don't hand-roll another.
- **Error copy**: `lib/errorCopy.ts` `errorText` (a failed write's alert body: a 401 → `SIGNED_OUT_TEXT` "You’re signed out. Sign in again." (ruled 2026-11-11), any other 4xx → the server's copy, else the connection line) + `sentence`. Don't re-declare them per screen.
- **Form widgets + image pipeline**: `momentForm.tsx` — `Disclosure`, `DateField` (its sheet is `DatePickerSheet`, exported 2026-11-14: the OS inline picker in the content-sized sheet, controlled; the moment's date in place opens it directly), `NotesField`, `SelectField`, `FieldGroup` (`.field-group`: the 600 small label over a control that has none of its own: SelectField, the create category trigger, the bringer field), `OptionSheet` (the short check-list picker sheet; an option may be `disabled`: faint label, announced disabled, no press, with an optional per-option `hint` (`small`) saying why, kept readable), `CountrySheet` (fixed-snap searchable country picker — deliberately NOT an OptionSheet, see its comment), `fitCover`/`pickCover`/`pickPhoto` (+ `pickPhotoOrRemove(label)`: the same iOS ActionSheet with a destructive Remove row), `NotesField` `maxLength`, `MAX_COVER_BYTES`/`MAX_WINE_IMAGE_BYTES` (⚠️ per-SURFACE caps: session wine images cap LOWER than covers via sanitizeImage 1.5MB — but the standalone check-in photo goes through the lib/s3 pipeline and uses `MAX_COVER_BYTES`; see the notes in add.tsx + feed/check-in/).
- **Bottle picker** (ADR-0009, ADR-0010; catalogue model change steps 7 and 7b): `BottlePicker` (`catalog/BottlePicker.tsx`, its parts `catalog/pickerParts.tsx`, its "Add Wine to Catalogue" pages `catalog/CatalogPages.tsx`) — THE way a bottle gets its identity, on Add / Edit Impression, Check In and the check-in edit: inline, ONE field first (ADR-0010: producer, wine, region and year in any order, `kind=bottle`; every typed word must match; rows = the wine, its producer under it, the typed year at the end; a tap picks it and fills the year field with that year), then the year. Nothing fits → "Add Wine to Catalogue" (its own pages, below): the producer field (the same every-word search; "Add Producer “name”" only when nothing is found or no found producer has exactly that name, by the SERVER's `exact` verdict: `offersAddProducer`, never a client-side fold), that producer's wines (`kind=product`, "Add Wine “name”"), and a wine that isn't there opens its fields in place (Red | White | Rosé, with Sparkling on the SAME line at its right end, a title and a switch under it like the colours' (ruled 2026-11-22: not a fourth chip, not a row of its own; the switch styled as `ToggleRow`'s), the year + NV, alcohol %, More: grapes, region, country). Its add rows ("Add Wine to Catalogue", "Add Producer “…”", "Add Wine “…”") are `DashedAddRow`s. 🔒 ADDING is SCREENS (ruled 2026-11-22: "when clicking on a wine you get to the screen where you can edit the year … why is this not a new screen?"): Add Impression and Check In open on the SEARCH (`catalog/BottleSearch.tsx` `AddSearchScreen`, an 'add' flow), a pick there or on a producer's wines page or a new wine's "Use" pushes the DETAILS screen on top (`session/[code]/add-wine` beside every Add Impression, `check-in/wine` beside every Check In; `pickedHref` in `lib/sessionStack.ts`): the bottle fixed at the top (a picked wine's year and alcohol set there), the photo, Brought By, the position, the "Add More Details" fold (Process, Description, Purchase Link; the fold is back, ruled the same day), Save; back is one page; Save / the rate stage's post leave the whole flow (`popsPast` over the stack's route names, `lib/pickerFlow.ts`); a save that may have landed is HELD on the flow so a details screen opened again resumes its choice and id (Check In: the draft store, cleared when the search opens). EDITING keeps the form first: Change pushes the search as a page (`SearchPage`, a 'change' flow), a pick comes back with its year. Router-sim `t20.cjs` (84 checks); Add Impression asks "Already in the Line-Up" (Add Again / Cancel) before saving the same wine in the same year as a bottle already there (`lineupDuplicate`: only bottles whose entry the viewer sees, so never a hidden one). The catalogue's alcohol shows READ-ONLY in the Alcohol % slot beside a picked wine's year (ruled 2026-11-22: a typed year's OWN alcohol, nothing when it has none, never the wine's in its place; the wine's while no year is typed; `shownAbv`, from the year lookup); only a NEW year gets the editable field. 🔒 Every search field's state is the pure controller `lib/bottleSearch.ts` (a request GENERATION identifies the current search, never its text; "Add Wine to Catalogue" only after a successful answer for it, never on `tooLong`; stale rows shown but not selectable; a `close` answer (no wine holds every word, these hold all but one) carries the line "No wine has every word. These come closest." above its rows (`closeNote`), "Add Wine to Catalogue" still under them; units `scripts/tests/bottle-search-units.ts`), and `lib/api/catalog.ts` returns the whole envelope (`more`, `tooLong`). It reports a `PickerState` to the form (`unchanged` / `none` / `pending` / `error` / `ok`); the rules are pure in `lib/catalogChoice.ts` (the pick / create bodies, `linkBody`, the year's fate: a typed year the wine has is that year, any other is added; `writeOutcome` for the freeze rule), units `scripts/tests/catalog-choice-units.ts`. 🔒 Nothing links until the person picks. 🔒 "Add Wine to Catalogue" is REAL PAGES (ruled 2026-11-22: the bar's back and the edge swipe must go back alike; Codex chose pages on the host's own stack over a sheet with its own stack, which breaks on Android): Producer → the producer's wines (titled with its name) → New Wine ("Use" in the bar), shared components in `catalog/CatalogPages.tsx`, the parts both use in `catalog/pickerParts.tsx`, the handoff in `lib/pickerFlow.ts` (one key per invocation in the params, the result taken ONCE by the host on focus, a dead flow reads "This isn't available any more", a finish pops the mounted pages: `router.dismiss(depth)`; nothing written to the catalogue there: the host's save sends it). A wine tapped on its producer's page comes back picked (its year set inline); a new wine comes back folded (Edit reopens New Wine, Remove drops it). Route files are one-line re-exports BESIDE each host: `catalog/{producer,wines,new}` on every tab stack and every opened-post stack, and INSIDE the check-in edit details' boundary on a tab stack (`edit/details/_layout.tsx` + `catalog/…`: there the details are a `fullScreenModal`, and a card pushed above a modal lands behind it); `catalogHref(mount, inDetails, page, key)` in `lib/sessionStack.ts`; the pill hides on `/catalog/…`. The screen's back is never intercepted (`check-vintage-wiring.mjs` forbids `usePreventRemove` in the picker). Router-sim case `t19.cjs` (181 checks over every host and stack). A NEW host of the picker needs the three page files beside it on its stack. 🔒 A save that MAY have landed (a 2xx, or no definite answer) freezes the choice (`frozen`): a retry re-sends the same client id (`lib/clientId.ts`, from the native UUID generator) with the same choice, never an edited `create`; an EDIT whose re-link creates is never re-sent (close + "couldn't confirm"). The NV tick chip beside every year field is pinned by `scripts/check-vintage-wiring.mjs` (an app `TextField` labelled or shaped like a year needs its `<ChoiceChip tick label="NV">` and `editable={!…}`). Searches in `lib/api/catalog.ts` (a 404 = the kill switch: "Adding bottles is unavailable right now."). The details' Alcohol / Origin / Variety rows read `lib/bottleFacts.ts` (the entry first).
- **Choice pill**: `ChoiceChip` (`ui/ChoiceChip.tsx`) — the `.hlchip` pill (on = accent fill, off = page fill + rule outline); `tick` = a toggle of its own (Sparkling, NV): the same look, announced as a checkbox, no check glyph (ruled 2026-11-22). The reveal timings (Moment Create + Moment Setup) and the picker's colours use it.
- **Post list**: `FeedList` (`feed/FeedList.tsx`) — THE list of posts (paging, drain, focus/pull refresh, cards, like, owner edit/delete) for the Feed tab AND every profile. Never build a second one; see § You profile. Header-screen props: `fullBleed` (never-inset + the RNS dead-end; key the list on it), `refreshOffset` / `refreshTint`, `inert` (rows + footer at 0.35, no touches, scroll stays), `bottomInset` (≥ `TAB_BAR_CLEARANCE`), `scrollHandle` (`scrollToOffset`, in the list AND the error layout), `postsHidden` (a node that REPLACES the posts under the header whatever the cache holds: no spinner, error state or paging; the list stays mounted so the header + hero scroll stay); its error state renders the header inside a scroll view.
- **In-place editing**: `ui/InPlaceEdit.tsx` (moved out of `profile/ProfileEditParts.tsx` 2026-11-14, when a moment's top became its second user) — `LongPressable` (`fill`: the child fills a box sized by its parent; `swapsOut`, § Extras step), `InlineField` (`url` = the link keyboard, `textProps` = the replaced text's Dynamic Type cap), `EditBar` (`title`, `center` replaces the centre, `doneLabel`), `editTouchHandlers` + `markNoShake` (the outside-tap shake). Your profile and a moment's top (§ Moment editing in place); a new in-place edit reuses these, never a copy. 🔒 The KEYBOARD RULE's one exception (`lib/keyboardDismiss.ts`, 2026-11-25): `EditBar` publishes its measured ROW height, and a touch inside the docked bar's band (from the keyboard's top minus `KEYBOARD_GAP`, one row high, compared with the touch in screen space) keeps the keyboard up; every other outside touch still dismisses with unchanged timing; iOS only (the touch's runtime `screenY`, read through a narrow check: the installed type omits it); Android keeps the plain dismissal until a common coordinate is verified. Cancel / Done dismiss explicitly (Done when its save starts).
- **Profile**: `ProfileScreen` / `ProfileHeader` / `PhotoTiles` / `TileCoverSheet` / `coverGeometry` (`profile/`) — see § You profile. `PhotoTiles` takes 0–3 tiles: the ones shown share the row at the three-up 4:5 height (a hidden sizer row, no measuring), none → no row; `editable` adds a glass pen (Edit Profile's tiles).
- **Header**: `VBar` (`VBar.tsx`) — the in-flow variant-B bar (back + left title + right slot). All pushed in-flow screens; `back={false}` for a tab root; `titleShown` turns the title into a SCROLL title (fades in once content scrolls under the bar), `titleLeading` puts a node before it; `titleSlot` replaces the title (a moment host's held title, then its field).
- **Bar title**: `BarTitle` + `useBarTitleProgress` (`VBar.tsx`) — THE bar title (subhead 600, `topBar` surface, ink or white on a photo; fade + 4pt rise over dur-2 off a 0→1 `Animated.Value`). VBar, the moment cover bar and the rate-impression bar all render through it; a bar whose background fades with the title (the moment cover bar) drives both from the same `useBarTitleProgress` value. Never restate the title style or the fade in a new bar.
- **Bottom nav**: `PillTabBar` (`PillTabBar.tsx`) — the floating-pill tab bar (`.tabbar-float`, ADR-0006) with the drag-lens (hold ≈180ms → a real Liquid Glass lens rides the bar; release commits; landing on the current tab is NOT input). Rendered via the tabs layout's `tabBar` prop; absolute overlay at `TAB_BAR_BOTTOM` (21pt from the physical screen edge): content clears it with `TAB_BAR_CLEARANCE` alone, never `+ insets.bottom`. ⚠️ The glass layering in that file is LOAD-BEARING physics learned over a day of device checks — read the in-file header + ADR-0006 and re-run the dev-gallery GLASS LABS (`/you/dev-gallery`) before touching any glass property. Don't add per-screen nav bars.
- **Avatar**: `ui/Avatar.tsx` — person circle (image→initials→`anon` user-glyph cascade; a photo that fails, or hasn't loaded within 1.2s (an unreachable host only errors after iOS's ~60s timeout), shows the initials drawn UNDER it; keyed on the URL); props `size`, `host` (accent tint), `anon`, `ring` (the overlap-stack 2px bg border + image inset), `badge` (overlay node, e.g. the "+" invite badge), `initialsSize`. ALL person circles.
- **Thumb**: `ui/Thumb.tsx` — square cover/wine thumbnail with the glass-glyph placeholder; props `uri`, `size`, `radius`. ALL cover/wine thumbs (wrap + overlay for the line-up hidden-from-guests badge).
- **Username**: `UsernameLine` (`ui/UsernameLine.tsx`, THE `@name` line: regular, `inkSoft`, its own line under the name, cut at the end, nothing for someone without one; `suffix` for "@lena · Follows you") and `UsernameField` (`ui/UsernameField.tsx`, THE input: the `@` in front, lowercase as typed, the broken rule after a 500 ms pause, `availability` for the live "Available" / taken check on signed-in screens, `error` for a submit's answer, `hint` for a quiet line; `useUsernameCheck` is its hook; the profile's in-place handle is an `InlineField username` + that hook, its feedback in the edit bar). A username CHANGE always goes through `lib/usernameSave.ts` `saveUsername` (the PUT, the caches, a refusal mapped to `field` / `locked` / `other`; Edit Profile and the in-place edit); copy + the bar's line order in `lib/usernameCopy.ts` (`usernameBarLine`). Where the line shows is RULED (§ You profile, Usernames): never add it to a feed card, a People list or anything inside a moment (the one exception: the person preview a tap opens there, which IS the scan card, ruled 2026-11-15). `FriendRow`, Settings' `PersonRow` and `MeCard` take `username`.
- **Sheets (domain)**: `PeopleSheet`, `InviteSheet` (`moments/`), `AddFriendsSheet` (`people/`, see § You profile, People step).
- **Sheet person parts** (extracted from `InviteSheet` when Add Friends became their second consumer; every slot defaults to the invite sheet's output): `QuickAddChip` (`ui/QuickAddChip.tsx`, `.ish-chip`: avatar + "+" badge + first name; `done` = ✓ and inert), `FriendRow` (`ui/FriendRow.tsx`, `.fr-row`: avatar · name + line · trailing, hairlines between rows; defaults "Friend" + Joined / Invite; `subtitle`, `trailing`, `onPress`) + `FriendRowBadge` (`.fr-in`, the positive ✓ status chip) + `FriendRowButton` (`.fr-btn`, the accent pill, `plus`, `busy`), `ShareFooterButton` (`ui/ShareFooterButton.tsx`, `.ish-sharebtn`).
- **People rows**: `PeopleRow` (`people/PeopleRow.tsx`, `.sh-row.yo-prow`: the 44pt photo grown like every list row, 600 name, the D2 line (`personLine`), one `FollowButton`; no separators) — a person on a People list. Settings' cardless `PersonRow` (Blocked / Muted) stays separate.
- **Toolbar standard**: the 36pt outlined pill `ToolButton` (`ui/ToolButton.tsx`: the Moments tab's Recent / Upcoming filter pill, ruled 2026-11-14 for every list over the mock's round `.yo-tbtn`, so a filter shows HOW MANY are on: rule outline, surface fill, glyph 16; `active` = accent glyph, `count` > 0 = the accent number after it; `onPress` gets its window frame for a menu under it) + the 36pt `SheetSearchField`. Recent / Upcoming, the profile lists and People's code button use it (D12, the mock's 46pt was ruled out); `CompareToolbar` still carries its own chip-metric copy.
- **Profile list parts** (`profile/lists/ListParts.tsx`, the lists step): `ToolRow` (`ToolButton`(s) + search), `groupByMonth` / `MonthHeader` (`.yo-month`, device-local month, the year when not this year, never repeated across a page break), `ListRow` (`.sh-row` on the RecentRow anatomy: Thumb grown, name + vintage, meta, a right column, optional chevron / `below`), `ScoreColumn` (`.yo-right`: their score + "You ★ 4.25"), `ListNote`. `ImpressionFilters.tsx`: Filter Impressions + Filter for Aromas / Structure (§ Impression filters). `useListRefresh` (pull to refresh with the 600 ms floor, refetch on refocus) and `useOpenListPost` (open a post from a list, D9) beside them. 🔒 **A post's rows key on `ratingId`, never the wine id** (Moment Visibility step 1a): a blind row of someone else's post carries NO `id` (and an Impressions row no `wineId`), so list keys, the detail's collapse / title maps and every "find this row" on a post that may be someone else's use `ratingId`; only your own post's Edit / Delete Rating read `id` (always there on your own post: the write needs it, and `FeedList`'s Delete Rating still finds and drops its row by the wine id the card menu hands it). `useOpenListPost` takes an explicit target (`lib/listPost.ts` `listPostIndex`: the post row's rating, Impressions `{ ratingId: row.id }`, Cravings `{ ratingId: row.ratingId }` (the rating the score and post come from, step 7)); matching an absent id against an absent id would open the first blind row. Units `scripts/tests/list-post-units.ts`.
- **Moments filter**: `MomentFilters.tsx` (`moments/`) — THE moments filter sheet + multi-pickers (`MomentFilterSheet`, `MultiPickSheet`, `useMomentFilterOptions(owner?)`, `toMomentParams`, `momentFilterCount`; the sheet pieces `FilterTitle` (the title + the applied filters as chips under it: ✕ clears, a body with `onEdit` opens that facet's picker, else it is a plain label; no Clear All, Reset does it; `dateChipLabel` for the dates; the row is ALWAYS one chip line tall, "No filters" in `inkFaint` while none is on, chips past the width scroll sideways to the sheet edges, so the sheet never changes height: ruled 2026-11-14, the first chip made it jump) / `FilterChip` / `FilterLabel` / `FilterDates` / `FilterFooter`, also used by Filter Impressions), moved out of Recent / Upcoming moments (lists plan D14). Every moments list uses it; `role` names whose role the facet reads. 🔁 The applied chips live INSIDE the sheet since 2026-11-14 (device pass: a cleaner list; the filter pill's count says a filter is on): never put them back under a list's tool row.
- **Score range**: `ScoreRange` (`scoring/ScoreRange.tsx`) — the two-dot 0.25–5 quarter-step range (the impressions filter, Q7): nearer dot takes the drag / tap, dots meet but never cross, ScoreInput's haptics + thumb, each dot VoiceOver-adjustable; `rangeLabel` ("Any" / "★ 4.0" / "★ 3.5 – 5.0").
- **Dashed add row**: `DashedAddRow` (`ui/DashedAddRow.tsx`) — the full-width accent dashed "+ label" row: the line-up's Add Impression and the bottle picker's add rows. Never a third copy.
- **Accent pill**: `IconPill` (`ui/IconPill.tsx`) — `.hv-add` with a glyph (the lists' "+ Check In" / "+ New", People's "+ Add"). The older copies (Feed's CheckInPill, Moments home NewPill) migrate when next touched.
- **Drag-to-reorder rows**: `DraggableRows` (`moments/DraggableRows.tsx`) — long-press lift + sibling springs + edge auto-scroll + haptics over NON-virtualized mapped rows in a `Reanimated.ScrollView` (hand-rolled: reorder libs need to own a FlatList or can't be device-verified on reanimated 4). Used by both line-up layouts; needs the host scroll's `AnimatedRef` + offset + a maxScroll SharedValue. `enabled` gates drag, `denied` answers a hold with a warning haptic (sort/search active). ⚠️ Worklet closure-capture ordering is load-bearing (consts before gesture builders — the PillTabBar crash class).
- **Shared screen constants + Dynamic Type surfaces (`lib/layout.ts`)**: `GUTTER`(22), `FOOT_CLEARANCE`/`FOOT_CLEARANCE_IR`, `TAB_BAR_BOTTOM`/`TAB_BAR_CLEARANCE` (pill offset + the content padding derived from it; the clearance is used alone), `HERO_RATIO` (shared by BOTH heroes — same height), `GLASS_FILL` (the over-photo glass fill), `HERO_SCRIM` (the hero-photo gradient), `PROFILE_SCRIM` (+ stops, the profile cover), `heroBarHeight` (a photo hero's collapsed bar: the moment's and the profile's), and `FONT_SURFACES` / `phone.surface(...)`. Import constants; don't re-declare. Use `phone.surface(name)` for scalable container math and `VText surface="..."` / `{...surface.textProps}` for matching text caps. `formControl` intentionally stays uncapped because field height math tracks editable text scale. **Comfort scaling (list rows breathe on big phones)**: `phone.grow(base)` grows a structural dimension by `ROW_COMFORT_RATIO` (56/46 ≈ 1.22 — the `recentThumb` ratio) with device comfort; `phone.lerp(a,b)` for the paired gap/padding. EVERY list row (wine, moment, person) uses this so they scale the SAME way — thumbs/avatars via `grow`, gap/padding via `lerp` — don't hardcode a flat size on a new list row. Chart canvases, sheet-snap math, borders, and icon-in-control sizes stay FLAT (load-bearing). ⛔ **CI-ENFORCED**: `scripts/check-mobile-design-tokens.mjs` (workflow `check-mobile-design-tokens`) FAILS if converged design constants are re-inlined OR an inline `fontSize:` literal appears outside its named-exception allowlist (the Text rule above); `scripts/check-mobile-dynamic-type.mjs` (workflow `check-mobile-dynamic-type`) is a partial static backstop for inline caps, common fixed-height text controls, and TextInput surface props. Device checks still own clipping/overlap truth.
- **Relationship writes**: `lib/relationship.ts` `relate(queryClient, id, op)` — THE follow / unfollow / mute / block / unblock for every surface (profile, People bar + rows, Add Friends chips / rows / scan result): per-person BLOCKING in-flight store (`usePersonBusy(id)`, `useSyncExternalStore`), optimistic patch of the person's header + every people / search / tasted-with entry, field-level revert, the refetched header reconciles their rows, one coalesced trailing refresh. `confirmUnfollow(person, onConfirm)` = the D7 alert. Never hand-roll a follow write.
- **Impression layer motion** (`moments/impressionLayerMotion.tsx`, build 2, ADR-0011): COPIES of the opened post's container transform (`useLayerMotion` + `useLayerStyles`: the row's face, the raised tone, the settle bg, the content ramps; the row geometry as SHARED values so the layer can close into another row or into the fade), an always-mounted `RevealWindow` (identity in fade mode: switching it on would remount the pages) and `usePullDownClose` (the post's pan + native scroll composition; the release goes to the owner, which takes its transition guard first). The post itself is NOT on them (ruled "Don't touch the post"; moving it is a separate decision). The pager / landing / transition math is pure in `lib/impressionLayerCore.ts`. Only the moment impression layer uses them (§ The impression layer).
- **Rating auto-save + outbox**: `useImpressionAutosave` (`lib/useImpressionAutosave.ts`, over the pure `lib/impressionAutosaveCore.ts`) — ONE impression page's draft + setters, `drain()` (a departure: resolves once the edits are PERSISTED on the phone, false only when storage failed or didn't settle in 2 s), `clearBaseline()` (take it when the Clear confirm OPENS) + `clearRating(token)` + `clearPending`, `discardPending()`, `savedState` ('saved' | 'local' | 'cleared-local' | 'error' | null), `error`; no router or route params inside (the impression layer mounts one per PAGE, build 2; in: `code`, `wineId`, the kind, `active` (the layer's active page), `focused` (the line-up's focus, false once a close starts), the LAYER's one transition guard `createTransitionGuard`, the alert label). 🔒 `discardPending()` is the terminal-outcome call: BARE (the bottle gone from a present line-up, a confirmed removal) it ends the page's work, stages the unsettled draft into the entry and KEEPS the stored entry, which the server's 404 / 403 / removed answer then drops; `discardPending({ confirmed: true })` deletes the entry at once and is ONLY for Delete Impression's success. The owner + runner + answer table are pure in `lib/rateOutboxCore.ts` and bound in `lib/rateOutbox.ts` (`rateOutbox`, `useOwnRatingsOverlay`, `setRateOutboxViewer`, called by the root layout). 🔒 `lib/rateOutbox.ts` is the ONLY AsyncStorage holder of user content: one entry per viewer (PUBLIC id) × moment × wine (`verre.rateOutbox.v1|…`), in the app container; `clearViewerCache()` retires only its in-memory work (timers, waiters, Clear generations, remembered answers, through `onViewerCacheClear`), the stored entries stay for their viewer and go out at that viewer's next sign-in; entries not EDITED for 90 days (`editedAt`, never a backoff or hydration write) are removed unsent at launch (every viewer's); after a failed launch read each key is read and merged before its first write. An op leaves only once the entry carrying it is on disk; the version check (`baseVersion`, 409 `stale`) makes every re-send safe. An entry's base is the snapshot LATCHED at the draft's first edit (with its offline provenance), never the one at staging time; a Clear with no entry goes out on the baseline its confirm opened on (or this phone's own later acknowledged save). "Clear My Rating" is greyed until the rating is known (`baselineReady`), and a Delete after a foreign rebase since the confirm opened asks again. The snapshot and every base take only a `/state` section fetched under the CURRENT, confirmed auth generation (the binding stamps each fetch's start; the outbox's own reads are stamped at dispatch). 🔒 Every body carries `viewer` (`u:<publicId>`, the entry's own), and nothing is sent or a `/state` read taken as a base until get-session confirms the credential's owner for the current auth generation (a mismatch holds the queue); a 409 `wrongViewer` stops the runner like a 401 `invalid`, everything kept. The gate is checked again after the write-ahead and in `beforeSend` (a close cancels locally, the op stays). Units `scripts/tests/rate-outbox-units.ts` (`check-vintage-units.yml`). Contract of record: `docs/dev/rating-saves.md`.
- **Small helpers**: `usePushGuard()` (`lib/usePushGuard.ts`, a 700 ms double-tap guard for pushes that must keep their history, People / profile chains), `shareProfile` / `profileShareLink` / `profileShareLabel` (`lib/shareProfile.ts`: what people SHARE and read is `/@name`, the id link while someone has no username) and `profileLink` (the QR: the PUBLIC id, it survives a rename; lowercase through `profilePath`, `@verre/core`), `matchesPerson` (`lib/search.ts`: a person against an on-phone search, the name forgivingly or the username as the server's search reads it, `@…` = the username only), `parseVerreCode` (`lib/scanCode.ts`, pure; `/u/<publicId>` → `profile`, an OLD `/u/<digits>` QR → `profile-legacy` (shows "This code isn’t available.", no request); units `scripts/tests/scan-code-units.ts`), `useMeId()` / `meIdOf()` (`lib/meId.ts`: your own PUBLIC id or null; never `Number(...)` a user id), `joinByCode` / `joinErrorText` (`lib/joinByCode.ts`, the join shared by Moments home and Scan), `useVerreScanner` + `ScanResult` (`people/scan.tsx`: THE scanner and the scanned-code view, Add Friends + Moments home; never a second scanner subscription).
- **Person preview**: `PersonPreview` (`people/PersonPreview.tsx`) — THE short card of a person before their profile (04·12d): photo, name, `@name · Follows you`, friends in common, View Profile + Follow / Follow Back (Following / Friends is a real button since 2026-11-24: the profile's `confirmUnfollow`, then `relate`); private = no photo; someone you blocked = "You blocked Mara." + Unblock alone. The scan result's person AND a person tapped inside a moment (`PersonPreviewProvider` / `usePersonPreview`, `moments/PersonPreviewSheet.tsx`: one sheet per moment screen, § Person preview in moments). `PreviewSpinner` / `PreviewMessage` beside it. Never a second copy.
- **Block look**: `lib/blockLook.ts` `blockLook(id, myId, meta.viewerBlocksOut, meta.viewerBlocksIn)` → `'self' | 'normal' | 'blocked-by-me' | 'guest'`, the web's matrix (docs/dev/block.md): someone who blocked you, one way or mutual, is drawn as a GUEST (user glyph, regular weight, ink-soft, "Unregistered", no Friend, not tappable); someone you blocked carries "· Blocked". 🔒 EVERY in-moment person render goes through it (People sheet, the impression's Brought By, the Compare picker, the add / edit bringer field + picker), or a guest in one place is a registered person in another. Never test `id.startsWith('a:')` for the anonymous look on a person render. `opensPreview(look)`: whether a tap opens the person preview ('normal' / 'blocked-by-me' only, so a blocker taps exactly like a guest). Units `scripts/tests/block-look-units.ts` (`check-vintage-units.yml`).
- **Label helpers (`lib/`)**: `initials.ts` (code-point-aware avatar initials — used by `Avatar`; `firstName` too), `momentFormat.ts`, `scoreWords.ts`, `locale.ts`, `contrast.ts`. `theme/color.ts` `mix()`/`alpha()` for press-state/tint math (use instead of raw rgba) + `inkOn()` (contrast-picked label ink for a coloured fill — hex cells + solid-fill badges) + `readableSolid()` (family-tinted words: the 100% palette colour where it clears 3:1 on the fill, ink-pulled in 5% steps only past that) + `readableBorder()` (same, floored at 45% colour share so a hairline keeps its hue — clay borders went white without the floor) + `flatten()` (a translucent `rgba()` token as it looks over an OPAQUE base: the contrast helpers read hex / `rgb()` only and take an rgba as NaN, which silently pulled a title to plain ink; the ONE such helper, the aroma compare re-exports it as `flattenRgbaOver`). `readableSolid(…, min)` takes a higher bar for small regular text (4.5). (An earlier `readableTint` — always ink-tinged — was REMOVED; `readableSolid` supersedes it, byte-identical to the raw palette colour wherever that already reads.)

**⚠️ Pending extractions — KNOWN drift the audit found (2026-06-16, refined by a
4-reviewer pass). Prefer extracting these when you next touch the area; until
then, copy the EXISTING canonical version named below, don't invent a new one.
Ordered by drift-risk (active divergence + likelihood of a next copy):**
- ✅ **DONE — `<AnchoredMenu>`** (`ui/AnchoredMenu.tsx` + `elevation.menu` token; 3 panels migrated, reviewer-verified). `add.PositionPicker` (`.at-pospop`) — a different control, NOT migrated to AnchoredMenu, but its shadow now uses `elevation.menu` too (so all 4 dropdown shadows are one source, CI-enforced).
- ✅ **DONE — `<Avatar>` + `<Thumb>`** (`ui/Avatar.tsx`, `ui/Thumb.tsx`; all ~6 avatar + 3 thumb sites migrated, reviewer-verified pixel-preserving).
- ✅ **DONE — `GLASS_FILL` + `HERO_SCRIM` + the layout constants** — all in `lib/layout.ts` now: `GLASS_FILL` (the over-photo glass fill, converged 0.42/0.5/0.55 → `0.42` everywhere per Simon — a small intentional visual change, device-verify); `HERO_SCRIM` (converged to the impression hero's gradient `0.25/0.05/0.82`, used on both heroes — likewise device-verify the line-up cover); `HERO_RATIO` (ONE ratio `280/744` for both heroes — Simon's ruling that they be the same height; the cover hero was `248/800`, ~56pt shorter, before); `GUTTER`(22)/`FOOT_CLEARANCE`(120)/`FOOT_CLEARANCE_IR`(130) (the impression keeps a LOCAL `GUTTER = 20` override — don't import the 22). A `<GlassCircleButton>` for the circle subset is still open if wanted, but the fill drift is gone.
- ✅ **DONE — `BadgePill` / role-tag convergence** (`moments/RoleChip.tsx`) — `RoleChip`, `PeopleSheet.Tag`, and `ReadCard` now share the badge primitive and Dynamic Type centering policy. Use `BadgePill` for new small text pills instead of re-encoding `paddingVertical`, `lineHeight`, or `includeFontPadding`.
- **`<CoverPickerField>`** — ⬆ moved up: the dashed photo picker is 3 near-identical copies with ACTIVE copy/glass drift (`create.CoverPicker`, `add.PhotoPicker`, `details.tsx` inline — `details` is even missing the caption the others have; the photo-remove × is `0.55` in two of them). Mechanical extraction into `momentForm.tsx`.
- **`<IconPill>` (EXISTS, `ui/IconPill.tsx`: the lists + People's Add)** — still open: migrating the remaining copies of the accent "+pill with glyph", which is ~5 filled pills (`NewPill`, `EmptyLineup` add, `PeopleSheet .hv-add`, `InviteSheet` Invite/Share) + 1 collapsing variant (`LineupAddButton`). Lower-stakes (off-by-2px pad doesn't read as a bug). ✅ The dashed full-width row is `DashedAddRow` (done 2026-11-22).
- **`<TextArea>`** beside `TextField` — `momentForm.NotesField` + the impression's private `NoteField` re-encode the same multiline focus trick; the impression should use `NotesField` (expose `minHeight`/`maxHeight` — `maxHeight` already half-exists).
- **`PushGroup`/`PushRow` (moments/index.tsx) → adopt `SetGroup`/`SetNav`** (same carded nav-row primitive, add a trailing-slot/`count`).
- ✅ **DONE (partial) — `<OptionSheet>` + `<CountrySheet>`** exported from `momentForm.tsx` (extracted when the check-in create became their next consumer); adopted by `add.tsx` (local TypeSheet + CountrySheet deleted) + `feed/check-in/`. `create.CategorySheet` still carries its own copy — migrate when next touched. ⚠️ CountrySheet stays a SEPARATE component, not an OptionSheet variant: it needs a fixed 75% snap + `BottomSheetScrollView` + search (a load-bearing config difference — see its in-file comment).
- ✅ **DONE (partial) — `SelectField` exported from `momentForm`** (moved out of add.tsx; adopted by add + the moments-list filter sheet). Create's category trigger still carries its own inline copy — migrate when next touched.
- ✅ **DONE — `<ChoiceChip>`** (`ui/ChoiceChip.tsx`, catalogue model change step 7): the hide-lineup timing pills of `create.tsx` + `reveal.tsx` and the bottle picker's colours / ticks.
- ✅ **DONE — `ClampText`** promoted to `components/ui/ClampText.tsx` (the feed impression detail became its second consumer; 02e now imports it). `OvcAbout`'s description block is still a copy — migrate when next touched.
- **Generalize `SettingsFooter` → `<StickyFooter error>`** — create/add re-inline the same absolute bottom bar.
- **`elevationStyle(level)`** — the `elevation.<lvl>.ios` / `.android` shadow spread (shadowColor/Opacity/Radius/Offset + elevation) is written out in 6+ places (AnchoredMenu, the add position picker, MeCard, the theme demo card, …). A helper returning the style object removes it; mechanical.
- **Feed post detail bar title → `BarTitle`** — `feed/[id]/index.tsx` still renders its own title (same type, but it POPS in on `solid` instead of fading, and it is tappable → About). Adopting `BarTitle` (with a press slot) changes that behaviour: a design call, not a refactor.
- ✅ **DONE (partial) — `<CenteredMessage>`** built in `ui/ConnectionState.tsx` and adopted in the edit-impression screen (in the primitives list above). **The FatalView copy is now SHARED but still un-migrated**: `SessionFatalView` (`moments/SessionFatalView.tsx`, extracted from index.tsx for Compare) still hand-rolls the flex-center layout because `<CenteredMessage>` has no button/footer slot — extend CenteredMessage with a footer slot, then adopt it there. Still open: decide whether it also covers the icon-circle empty-state family (`EmptyLineup`); `LockCard` is a distinct designed surface, exclude it.
- **Shared layout constants** — `GUTTER` (`=22`, the intentional `20` in `moments/ImpressionPage.tsx` + `ImpressionParts.tsx` is a documented override), `FOOT_CLEARANCE`, are re-declared per-file ~8× / ~5×. Move to `lib/layout.ts` (alongside `TAB_BAR_CLEARANCE`) so the one intentional override is visible.
- Also noted: `DateField` (`momentForm.tsx`) hand-rolls its OWN `Modal`+scrim bottom-sheet (not `ui/Sheet`) to host the OS date picker — justified, and since 2026-11-14 it is `DatePickerSheet`: reuse IT if you need a native-picker-in-a-sheet rather than rolling a third.

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
  dead-ends the `subviews[0]` walk (see the cover line-up, `CoverHeroLineup`, and the opened post; the impression's pages no longer need it, § The impression layer). `collapsable={false}` is
  load-bearing — Fabric flattens layout-only views out of the native
  hierarchy, and a flattened dead-end never exists for the finder to hit.
  Applies to any future edge-to-edge screen (feed hero cards). The per-tab
  `disableAutomaticContentInsets` would flip the whole tab — don't.
- 🔒 **Every full-bleed scroll view is wrapped in `NoTopEdgeFade`**
  (`components/ui/NoTopEdgeFade.tsx`, device pass 2026-11-24): iOS 26's
  automatic scroll-edge effect drew a band the status bar's height, the photo
  blurred and washed toward the page colour, behind the white clock, on every
  theme. UIKit has no colour for it (only on / off), so it is hidden at the top
  and our own dark scrim shows. It is react-native-screens' `ScrollViewMarker`
  (`react-native-screens/experimental`; our Podfile sets `RNS_GAMMA_ENABLED=1`):
  the screen option `scrollEdgeEffects` can NOT reach these scroll views (it
  walks only `subviews[0]` from the screen, which our dead-end stops; RNS
  #4369 / #5249 answer "use the marker"). The marker takes ONE direct native
  child, the scroll view, mounted with it: put it OUTSIDE any
  `GestureDetector` (a native scroll gesture must stay on the scroll view).
  Wrapped today: the opened post (pager + page), the moment cover layout (and
  the look-in), the moment impression's pages (both branches), the look-in's bottle
  page, a profile with a cover (`FeedList fullBleed`, `enabled`), the welcome
  screen. A NEW screen with `contentInsetAdjustmentBehavior="never"` gets it too.
- ⚠️ **Long lists set `removeClippedSubviews`** (iOS default off; Android's is
  on). An iOS FlatList keeps every mounted row's native views attached, and
  when its screen enters or leaves a navigation transition iOS works through
  all of them on the main thread (~300 ms for 20 posts in a dev build: the
  0.1.5 You-tab lag, measured 2026-11-16). So every long FlatList sets it, and
  so does a horizontal carousel `ScrollView` inside a row (`SessionFeedCard`);
  the clip keeps 44 pt around the visible rect. Always as
  `removeClippedSubviews={!useScreenReaderEnabled()}` (`lib/screenReader.ts`,
  live): a detached row leaves the accessibility tree, so VoiceOver swiping
  would stop at the last attached row (React Native switches it on a mounted
  view both ways). `FeedList` also sets
  `strictMode` (cells re-render only when their item, `renderItem` or
  `extraData` changes, so `renderItem`'s deps must stay complete).
- **Tab bar hiding**: the tabs layout computes one `hidden` boolean (pathname
  list + sheet/reveal signal + keyboard) and simply doesn't render the
  `PillTabBar` — the pill is an absolute overlay, so hide/show never resizes
  scenes. 02e hides the bar (footer action bar replaces the nav per design):
  the impression layer holds the sheet count while open and its line-up is
  focused (§ The impression layer).
- **Haptics** (`expo-haptics`): selection tick per 0.25 step while dragging,
  light impact on commit. No-ops in the Simulator — verify on device.
- **New native modules (M3)**: `expo-haptics`, `expo-linear-gradient`
  (hero scrim; removed 2026-11-17 for `ui/Gradient`); **(M4)**: `expo-image-picker` (cover photo; config plugin
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
- **Rate flow** (the moment impression: a LAYER inside the line-up since
  build 2, ADR-0011, `moments/ImpressionLayer.tsx` + one `ImpressionPage` per
  page; no route, see § The impression layer below): AUTO-SAVE
  (tasting-feedback build 1, ruled 2026-11-25; the web Rate pane keeps its
  explicit save). The rating saves itself about 1 s after the input SETTLES
  (one trailing timer, re-armed by every edit) and on every leave (the close
  button, a pull-down, Finish, a page change, a tab switch or a push on top,
  the app to the background: the layer's stable focus cleanup + ONE AppState
  listener while it is open and its line-up focused), as MERGE saves of the
  CHANGED fields only (`merge: true`, docs/dev/rating-saves.md), through the
  outbox (`useImpressionAutosave` → `lib/rateOutbox.ts`, see the catalog).
  Offline the saves wait on the phone ("Saved on this phone") and go out by
  themselves, also after the app was closed. Previous · Next (Finish on the
  last; independent first / last, so a one-bottle moment has Previous
  disabled AND Finish) MOVE ON AT ONCE once the edits are stored on the
  phone, never waiting for the server (they stay only when storing fails);
  ONE synchronous transition guard per LAYER, shared by paging, Finish and
  every close. "Saved" sits in the FOOTER
  BAR above the buttons (the bar sits behind the keyboard and never changes
  height: "Saved" stays until the next change, an error until the next good
  save; nothing while the first attempt is on the wire). 🔒 ONLY "Clear My
  Rating" deletes, after the house confirm "Delete your rating of “X”?"
  (Cancel / Delete; X = the line-up alias for a hidden bottle), recorded as
  ONE intent before the `AnchoredMenu` closes and shown from its `onClosed`;
  emptying every field by hand and leaving keeps the stored rating (a merge
  never reaps). A definitive failure after leaving is ONE alert ("Rating Not
  Saved"). `discardPending()` only on a terminal outcome (bare: the bottle
  gone from a PRESENT line-up, a confirmed removal; `{ confirmed: true }`: a
  successful Delete Impression, see the catalog); a 429 / 503, a gone moment or
  a degraded poll close the layer and keep the entry.
  The draft seeds per field: the entry's edits, then the own-rating SNAPSHOT
  (the owner's remembered answer, else your row in the CURRENT `/state` cache
  value), never the poll's retained view; RELATIVE edits (a structure axis,
  an aroma add, VoiceOver's score step via `ScoreInput onStep`) stay inert
  until that snapshot exists; the note keeps its raw text while focused
  (`NotesField onFocusChange`). The line-up's OWN rows and its sort by your
  score read your ratings as stored on the phone (`useOwnRatingsOverlay`);
  Compare and what other tasters see keep the server's state until the phone
  syncs (ruled). The whole rating block renders via the shared `RatingSection`
  (see the component catalog): score → note (no title; the placeholder
  "Say what the stars can't." carries the affordance — the note is the
  taster's public CAPTION, never an aroma-descriptor prompt) → the
  "Structure Profile" fold (`StructureInput`) → `AromaInput`. Outgoing
  values are normalised (`fillFlavourZeros`, the aroma gate, `scrub` for the
  note's comparison) and a field equal to its seed is never staged, so an
  untouched legacy sparse row is never re-posted; aromas are sent only when
  edited. Not the check-in rate stage, not the feed post edit.

## The impression layer (build 2, built 2026-11-26)

ADR-0011 (Simon's rulings 2026-11-25: "the similar feel like opening a post").
The line-up screen (`moments/session/[code]/index.tsx`) holds the open wine
and renders `ImpressionLayer` as its LAST child, outside the in-place edit's
touch handlers; there is no impression route on any of the six mounts any more
(`lib/sessionStack.ts` has no `'impression/[wineId]'`, the tabs layout no
`/impression/` matcher). Edit Impression and View Profile stay ordinary pushes
on the stack hosting the line-up: Back returns to the open layer.

- **Pieces**: `components/moments/ImpressionLayer.tsx` (presentation, pager,
  edge strips, the guard, Android Back, AppState / blur capture, status bar),
  `ImpressionPage.tsx` (one page: the old screen's body, bars, footer, ⋯ menu,
  its own autosave hook and pull-down), `impressionLayerMotion.tsx` (COPIES of
  the post's container transform, reveal window and pull-down: the post is
  untouched, moving it onto these is a separate decision), the pure
  `lib/impressionLayerCore.ts` (the pager math, the landing math, the
  transitions; units `scripts/tests/impression-pager-units.ts` +
  `impression-layer-units.ts`, `check-vintage-units.yml`), and
  `scoring/aroma/canvasTouch.tsx` (the canvas exception, below).
- **Open / close**: a row tap measures the row (`LuRow registerHandle`: a
  measurable handle keyed by wine id with an inert face, the profile list's
  `RowHandle` pattern; both layouts) and the layer GROWS out of it (the post's
  kind `'row'`: the face on the raised tone, the vertical reveal window, no
  photo flight); a frame that is missing, late (120 ms belt) or not wholly
  visible (`frameVisible`: under the pinned toolbar, above the SCREEN's bottom:
  a row behind the pill is still wholly visible) = the plain fade. Closing lands on the CURRENT row:
  the layout scrolls it into view under the opaque layer (`LineupScrollApi`,
  instant, clamped, its target the band above `TAB_BAR_CLEARANCE`; the cover
  hero installs its own via `scrollApiRef`), then
  the layer folds into it; a row a search hides, the Compare tab or a locked
  line-up = the fade. The landing is prepared after the open settles and after
  every page change, so a pull-down finds it in place; every late measure is
  guarded (a newer request, another page, an unmount). A tap's open is void
  once a fatal result, a blur or an unmount bumped its sequence, and it is
  rechecked after the measure (`rowOpenable`: focused, not fatal, the row
  still shown on the line-up tab), so it never mounts over a fatal view.
- **Pages**: the active wine ±1 in LINE-UP order (`wines`), keyed by wine id,
  at `left: slot * width` in one translated row; the slot moves only after a
  slide landed, so no mounted page moves in a React commit (§ Toolchain, the
  flushed-registry rule). Neighbours mount one frame after the open settled
  (never in the commit that makes the page interactive). Pages are
  `React.memo`'d (the layer's `controls` and `useLayerMotion`'s object are
  stable; the poll's structural sharing keeps `wine` / `meta`). An inactive
  page: `pointerEvents="none"`, hidden from VoiceOver, its hook `active` false
  (no new writes); it rests at its top again (the post's ruling). A wine that
  left a PRESENT line-up keeps its page (last seen) for the forced close.
  🔒 A page change in flight RESERVES its source and destination
  (`pagerWindow(…, reserved)`: exactly those two pages, by wine id, whatever a
  poll does meanwhile; a destination that left the line-up keeps its own last
  seen copy, never another wine under its key), from the grant until the slide
  landed or returned. While it moves, the outgoing page's hook is not VISIBLE
  (`focused` false), so a definitive failure then is the one-shot alert, not a
  footer sliding off screen.
- 🔒 **One transition guard** (build 1's `createTransitionGuard`, owned by the
  layer, passed to every page's hook): `createLayerTransitions` acquires it and
  CAPTURES the outgoing page (its `drain`) before anything moves, holds edits
  while the drain runs, moves once only if the same page is still active, the
  layer live and the destination still its neighbour; a storage failure keeps
  a PAGE CHANGE on the page, but a CLOSE always leaves (Back always leaves: the
  draft is staged in memory, the footer error or the after-leave alert says it
  wasn't stored). 🔒 Every departure first JOINS the active page's ONE text
  capture (`createInputCapture`, owned by the page): `ScoreInput`'s number and
  `NotesField` report when their native edit starts and when it ENDED
  (`lib/fieldCapture.ts`; a no-op without the page's provider). 🔒 The end is
  `onEndEditing`, NEVER `onBlur`: React Native sends both, in opposite orders
  (iOS end-editing then blur, Android blur then end-editing), and only
  end-editing carries the FINAL text, so the field applies `nativeEvent.text`
  through its own setter first (the score: `commitDraft(text)`, never the
  `draft` state, through the SAME conversion as its live keystrokes,
  `lib/scoreDraft.ts` `scoreFromDraft`: an erased number is 0 in both; the
  note: only when it differs from its last change), then
  reports (`fieldEndEditing`); blur is the focus UI's; the unmount and the belt
  are the fallbacks; the slider's draft abandon still wins. The capture resolves once none is
  open, bounded by `CAPTURE_BELT_MS` (300). React Native's focused-input record
  can't tell: it is cleared at the blur REQUEST, and the root's outside-touch
  dismissal requests it on the touch-down, before a button's `onPress`; the
  last keystrokes, an IME commit and the end-editing commit arrive after it,
  and an edit that arrives under the guard is dropped. While the guard is held
  the outgoing page takes no touch and no VoiceOver action (`pointerEvents=
  "none"` + hidden from accessibility, React state from the guard's `onHeld`),
  until the destination is active or the page is back at rest. Previous / Next
  / Finish / the close button / Android Back begin after the capture and end at
  once; an edge swipe begins when GRANTED (below); a pull-down begins DURING
  the drag, once the capture is in (`createPullClose`), both held in place
  while a drain is pending. 🔒 A 'stay' and a cancelled gesture KEEP the guard
  (`returning`) until the row is back at rest: ONE tokenized return
  (`returnToSource`, or the pull's spring back), then `abandon()` releases the
  guard, the reservation and the visibility gate together. A slide commits
  only when ITS spring finished (a token per spring) and the destination is
  still there and the layer live (`slideOutcome`), else it returns. Gone /
  Delete Impression = `force()`: no capture, the fade.
- **Edge strips**: two RNGH pans on the viewport, `hitSlop({ left: 0, width:
  15 })` / `({ right: 0, width: 15 })`, `activeOffsetX(±10)`, `failOffsetX(∓10)`,
  `failOffsetY(±12)`; the row follows 1:1 up to a page, a rubber band at the
  first / last (no page change, the left edge never closes); release past 35 %
  or a 600 pt/s flick pages (`releaseTarget`). 🔒 The worklet writes the row
  only for the swipe JS GRANTED (`createEdgeRuns`: 'page' took the guard and
  the reservation, 'band' = first / last with nothing in flight; a 'refused'
  swipe writes nothing; a release that beats the grant is replayed by it; a
  button page change or a close revokes a running swipe). ONE run at a time:
  a swipe that starts while another is pending or granted (a second finger on
  the opposite edge) is refused at `start`, and each recognizer keeps its OWN
  run id (`edgeRunL` / `edgeRunR`), so neither can erase the other's. The keyboard is
  dismissed on activation. The line-up's native back swipe is off while open
  (`gestureEnabled: !layerOpen`, RNS gates its edge recognizer on it).
- **Pull-down**: the post's pan + `Gesture.Native()` composed per page (the
  native gesture on the scroll view, the pan on the PAGE ROOT, so a pull may
  start on the bar or the footer too: "from ANYWHERE while the page is at its
  top"; the photo page's `FloatHead` and its bar row are `box-none` while
  transparent, so touches between the controls reach the hero; Back / ⋯ still
  tap), the scroll offset a SHARED value (`useScrollOffset`), `bounces={!atTop}`,
  touches blocked by React-state `pointerEvents` during the open / close (never
  by changing `enabled`: that cancels a running pan). While a pull displaces
  the page it is not VISIBLE and hidden from VoiceOver (`displaced`), restored
  when it has sprung back open. 🔒 MANUAL activation: a
  pull that may not close FAILS before it activates (`onTouchesDown` /
  `onTouchesMove`): the touch went down below the scroll top, or on the aroma
  canvas's HEX STAGE (`CanvasTouchZone` around `HexStage` in `CanvasPicker`, by
  POSITION: a UI-thread `measure` of the stage at touch-down, vertical only; the
  crumbs and the refine row stay pull-eligible; no-op without the page's
  provider). A marker gesture's own touch flag lost the race to the canvas's
  pan, which cancels it (Codex review 2026-11-26). Once a close runs (a forced
  one included, `motion.closing`) a pull neither moves the layer nor springs it
  back open.
- **Edge swipe during a transition** (a slide, a close, a drain): the swipe
  is refused and never writes the row (it would cut the running slide).
- **Pill**: `pushSheet` held while the layer is open AND the line-up focused
  (`useIsFocused`), so a profile pushed over the layer shows it.
- **Back / VoiceOver**: `accessibilityViewIsModal` on the layer, the covered
  line-up `pointerEvents="none"` + hidden from accessibility; ONE focus-scoped
  Android `BackHandler` beneath the line-up's `BottomSheetModalProvider`:
  `useBottomSheetModal().dismiss()` first (true = a sheet was closed), else
  the close.
- **Status bar**: the active page reports its style; the line-up uses it as
  its own option + `useForwardStatusBarStyle` while the layer is fully open.
- **Providers**: the line-up's `BottomSheetModalProvider` and
  `PersonPreviewProvider` (no second one); the sheets present at its portal
  host, above the layer.
- **No RNS dead-end** in the page: its scroll view is not in the screen's
  first-descendant chain (the layer is the last child). `NoTopEdgeFade` stays
  on both branches.
- ⚠️ **Device pass** (only the phone can prove): the morning list in
  `.local/tasting-feedback/overnight-log.md` (open from both layouts, the
  pull-down and the canvas exception, edge swipes near the score slider and the
  structure tracks, first / last, a page change saving, Edit / View Profile on
  top and Back with the pill, landing after paging, a search hiding the row,
  a deleted impression, inside a moment opened from a post, VoiceOver).

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
- **FIXED (was the flagged M3 gap):** the impression reads the line-up's own
  `useSessionPoll` since build 2 (it is a layer inside the line-up), so the same
  `lastRef` per-section merge applies (a `wines:null` degraded poll keeps the
  last good list; the layer closes for a gone bottle only on a PRESENT wines
  section that lacks it). Any new screen reading the shared `/state` poll must
  adopt the same merge — never read `state.data?.<section>` directly.

## Moment editing in place (built 2026-11-14)

Simon: "edit with tap and hold like on the profile", the design unchanged.
`components/moments/MomentEdit.tsx` (`useMomentEdit`, `MomentEditBar`,
`MomentCoverName`, `MomentBarName`) on the profile's pieces (`ui/InPlaceEdit.tsx`);
the line-up screen owns the session, `OvcAbout` renders its lines.

- **Who**: host + cohosts (`isHostViewer`, the server's `isHostByIdentity`); for anyone else nothing holds. Moment Details stays the full form.
- **Holds**: the name (on the cover; in the bar without one, `VBar titleSlot`), the address, the event link, the description → EVERY detail on screen becomes a field in place, the held one focused (all `swapsOut`). The date line is the same element in and out of the edit (nothing swaps): a hold starts the edit and opens the date picker (`DatePickerSheet`), with an end time first Change Start / Change End / Remove End Time. The cover: a tap opens it, a hold changes it AT ONCE (Take Photo / Choose from Library / Remove Cover, spinner on the cover; not while editing), like the profile's. The link field shows the URL (the line reads "Event Link"). An EMPTY description shows its hosts the bio's prompt (ruled 2026-11-14): a pencil + "Touch and hold to add a description" in `inkFaint`, touch and hold only, becoming the (focused) description field. The description takes NEW LINES: Return writes one (`InlineField newlines`), the bar's Done saves; every other field's Return is Done (the server's `scrub` keeps `\n`).
- **Add Fields** (Simon's idea): empty details stay hidden while editing; the bar's centre is "Add Fields" (none left: "Editing Moment"), which turns into the iPhone's own WHEEL (`@expo/ui` SwiftUI `Picker`, `pickerStyle('wheel')`: up / down, the OS's clicks and snapping; native-chrome pickers ruling). While it is open Cancel leaves the wheel and Done reads "Add". Offers: Cover Photo (no cover yet: shown at once as the hero, uploaded with Done, Cancel drops it), Start Date (a dateless old moment) or End Time, Address, Event Link, Description. The date and the details are Line-up furniture (the about block): on Compare only the cover is offered. Tapping Add Fields, the wheel and its Cancel KEEP the keyboard up (ruled 2026-11-25: "lock the keyboard in place when somebody navigates this bar"; a touch in the docked edit bar is the outside-tap rule's one exception, `lib/keyboardDismiss.ts`); Cancel and Done still close it (Done when its save starts, after validation: a validation alert keeps it up); Add focuses the new field. Off iOS (deferred) a tap steps through the list.
- **Save**: Done = ONE settings PATCH of what changed against the values the edit STARTED from (a cohost's change to a detail you didn't touch survives; dates compared as times), Moment Details' rules (name + start date required, end ≥ start). The echo (`updateMomentSettings` returns the server's `meta`) is merged into the poll's cache before the edit ends (no flash of the old text), a new cover prefetched first (≤ 1.5 s); then `['session-state', code]` + `['my-sessions']` refetch. Viewer epoch checked after every await. Errors alert and keep the edit.
- **The rest of the screen**: the profile's rules, in place (never a remount, the people foot's photos included): tabs, toolbars, rows, Compare, the bar's Add + ⋯ and the people foot dim (0.35) and take no touches; a tap there shakes the bar; Back and the date line never shake; the pill is hidden for the whole edit; the list pads for keyboard + bar and the focused field is scrolled above them (each layout installs its scroll). Leaving the screen, or losing the host role, cancels.
- ⚠️ **Device pass** (only the phone can prove): the wheel in the bar (size, clicks, dark themes), holds on every line in both layouts (no stranded first Done), the cover hold + spinner, an Add Fields cover turning the plain layout into the hero mid-edit, the date sheet from a hold, fields above the keyboard on the cover layout (the description sits low).

## Navigation: the session sub-tree is MULTI-MOUNTED (proposal 09 §B)

The session screens (`moments/session/[code]/…`) are mounted under THREE tab
stacks: Moments owns the source files; `app/(tabs)/feed/session/[code]/…` and
`app/(tabs)/you/session/[code]/…` mirror them as thin re-exports, so entering
a moment from a post (feed or profile) keeps back-nav on that tab. Likewise
the POST sub-tree (`feed/[id]/…`, `feed/edit/[id]`, `feed/edit/details`,
`feed/u/[id]`, the profile lists, People, palate / status, check-in) is owned by Feed and
mirrored under You AND Moments (Moments since 2026-11-15: a person opened
inside a moment, so Back returns to the moment; the Moments stack's layout
carries Feed's `[id]` + edit screen options and an `index` anchor). The OPENED POST
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
  MOUNT location. The global segments are only the ROOT fallback
  (`SessionTabRootProvider` around the root Stack, for root pages like About):
  read from them, a component that first renders in a background tab (a
  profile's post list mounting once its header query resolves after you
  switched tabs) would pin the focused tab and push onto the wrong stack. A
  new tab stack must provide it. `useSessionTab()` itself never subscribes to
  route state (it did, and re-rendered every caller on every navigation;
  removed 2026-11-17). Entry points that
  genuinely live on one tab (moments home/recents/join/create) keep their
  absolute paths.
- **The moment impression has NO route** since build 2 (ADR-0011): it is a
  layer inside the line-up (§ The impression layer); `edit-impression/[wineId]`
  keeps its six mounts.
- **A new session screen needs its mirror files** under `feed/session/`,
  `you/session/`, `feed/[id]/session/`, `you/[id]/session/` AND
  `moments/[id]/session/` (five one-line re-exports, the last since the person
  preview; a new post-sub-tree screen: under `you/`, and on the
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
  mirrors there; the edit is an ordinary push with swipe-back since
  2026-11-24, like the outer one);
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
  channels, one value. The line-up (with the impression layer's active page's
  style while the layer is fully open) calls `useForwardStatusBarStyle` with the
  same value as its screen option,
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
  (`src/lib/clientVersion.ts`). 🔒 The version lives in THREE tracked files
  and moves together: `app.json` `version`, `MARKETING_VERSION` (both
  configurations) in `ios/Verre.xcodeproj/project.pbxproj`, and
  `CFBundleShortVersionString` in `ios/Verre/Info.plist` (precedent 941c7bf),
  so TestFlight and the device show the same number. The SERVER also carries
  an iOS floor in code (`lib/clientVersion.ts` `CODE_FLOOR_IOS`, 0.1.5 since
  public user ids), gated on every `/api` call: a dev build below it gets the
  update screen against a server at or past that commit. When EAS Update/OTA
  ever lands: report the OTA update id in the header's third slot AND pin
  `runtimeVersion` to the fingerprint policy first (proposal 04 §3a / 06 §6).
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

## You profile (handoff 04, steps 1 to 4)

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
- **Inactive** (visible, not tappable): menu row Invite to a Moment (MenuItem `disabled` →
  "Soon"). The counts, the in-common row, Add Friends and Share Profile are
  live since the People step (below); the status line opens its placeholder
  pages since 2026-11-14 (§ Extras step). Your own ⋯ has no Edit Profile row
  since step 3 (see the step-3 deviations).
- **Relationship writes** (follow / unfollow / mute / block / unblock) go
  through `lib/relationship.ts` `relate` since the People step (the catalog
  entry): an optimistic patch of the header and every list row of that
  person, then the header (cancelled, then fetched) and the network
  `['feed']` (exact) refetch in place. Mute never touches the profile's own
  post list (mute is a network-feed filter). On failure only that person's
  changed fields are put back, before the refetch (which can fail too,
  offline). Your own ⋯ (→ Settings → Sign Out) renders even while your
  profile fails to load. Unfollow (D7 copy, `confirmUnfollow`) and Block
  confirm via the house native alert (Block uses the design's BLOCKSHEET
  copy); Follow and Mute act at once.
- **Blocked / Muted lists** live in Settings → Privacy since step 3 (the
  only unblock path for a mutual block, and the way back to a muted person
  you don't follow). A block / unblock / mute invalidates the matching list
  (inside `relate`).
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
  sits on the cover beside the photo, `fitProfileName` = the mock's `fitName`
  (measured at the base size in a hidden pass, Dynamic Type included):
  keep, else shrink ≤ 4pt, else two lines with line 1 indented to hug the
  ring. Deviation from the mock (ruled 2026-11-11): at each size the break
  points are tried in order (after word 1, 2, …), so a long name moves words
  up to line 1 before shrinking (to 22pt) or truncating. Second deviation
  (ruled 2026-11-12): WITHOUT a cover the name (`PlainName`, the mock's
  one-line `.yo-ncname`) gets the same fit in its column beside the photo,
  no ring indent (the column is straight), floor = 22/30 of its size. The hidden
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
  haptic) the name or the bio → BOTH become `InlineField`s in place, at the
  hold (`swapsOut`, § Extras step: a view swapped out under the finger
  strands the responder) (registered with the outside-tap keyboard dismissal), the pressed one
  focused; the status line + tiles dim (0.35) and the posts go `inert`; so
  does the ⋯ menu (dimmed + inert, both bars; device pass 2026-11-13). A TAP
  outside the fields and the edit bar shakes the bar with the warning haptic
  and a VoiceOver announcement (it is still open; ruled 2026-11-13;
  `editTouchHandlers`, ALWAYS on the screen's root: a never-claiming capture
  + the bubbling move / end; only a real tap shakes: one finger, within 10pt
  over the whole touch, under 500 ms; the edit bar and Back mark themselves
  `markNoShake`, a field is the keyboard registry's).
  `EditBar` (Cancel / "Editing Profile" / Done) RIDES the keyboard
  (`useAnimatedKeyboard`, transform only) and drops to the bottom when an
  outside tap closes it (D6). It floats 6pt above the keyboard (or the home
  indicator) with ROUNDED corners like iOS 26's keyboard (ruled 2026-11-12;
  `KEYBOARD_RADIUS` 26 is an estimate, no API exposes the keyboard's: tune on
  device); its reported height includes the gap. The pill is held hidden for the WHOLE session
  (`pushSheet` / `popSheet` in one effect cleanup: Cancel, Done, blur,
  unmount). The list's bottom padding grows by keyboard + bar and the focused
  field is scrolled above both (measured). Done = ONE `PATCH /api/me/profile`
  of the changed fields, pre-checked with `validateDisplayName` +
  `normalizeBio` (`@verre/core`); errors alert and keep you editing. Losing
  focus cancels. Own + empty bio: a pencil + "Touch and hold to add a bio"
  in the placeholder grey `inkFaint` (ruled 2026-11-12, so it reads as a
  prompt; only on your own profile), touch and hold only, as it says (ruled
  2026-11-13; a tap used to start it too); the
  field's placeholder is "Add a bio". 🔤 The copy says "Bio" everywhere
  (ruled 2026-11-12, a sanctioned deviation from the handoff's "profile
  text": the word people know; the code was already `bio`).
- **Photo + cover** (D2, D4, D5): long-press → `pickPhotoOrRemove` (Take
  Photo / Choose from Library / Remove Photo|Cover / Cancel), uploaded at
  once (`POST|DELETE /api/me/avatar`, `/api/me/cover`). Device photos only:
  the design's "From your tastings" grid is dropped.
- **Tile covers** (R5g2, D3): long-press a tile (any tile of yours, an empty
  one too since 2026-11-12) → `TileCoverSheet` (screen-local
  `BottomSheetModalProvider`, fixed snap, `BottomSheetScrollView` grid,
  footer pinned through gorhom's footer). Pre-selected = the shown photo when
  offered; Use Photo is live only when the selection differs from the current
  pin. YOUR OWN PHOTO (ruled 2026-11-12): the first cell, Add Photo, opens
  Take Photo / Choose from Library (`pickPhoto`); the result joins the grid
  selected, and Use Photo uploads + pins it (`POST /api/me/profile/tiles/<tile>`;
  nothing is uploaded before, so Cancel leaves nothing). "Always Show the
  Newest" (ruled 2026-11-14, not in the mock): a switch under the subtitle,
  part of the selection like a photo (the footer then reads "Use Newest" and
  PATCHes `null`); on = nothing selected (it starts on for an automatic
  tile: the header's `pinned` false AND no pool pin, since a chosen photo
  hidden again still shows on the tile but the pool can't offer it),
  selecting a photo turns it off, turning it off goes back to the pin.
  The tile then OWNS
  that photo: reclaimed when replaced, re-pinned, set back to automatic, or
  the account goes (`docs/dev/avatars.md` § Tile photos). Server rules (pin
  liveness, blind-safe picks, the dead-pin clear, own uploads) live in
  `lib/profileTiles.ts`.
- **Edit Profile page** (D1, `you/edit-profile.tsx` + mirrors
  `feed/[id]/edit-profile`, `you/[id]/edit-profile`, via
  `profileEditHref(mount)`, reached from Settings → your card): the cover at
  the profile's height and crop (`HERO_RATIO`, ruled 2026-11-11; it was 3:1,
  the mock 3:2) + 96pt photo with glass edit buttons,
  Name, Username (see § Usernames below), Bio (`NotesField maxLength 200`), `SettingsFooter`.
  Everything is a DRAFT until Save; Save runs username → photo → cover → text
  and stops at the first failure (finished steps stay saved). Bar-hide matches
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
  `Button` gained `icon` (leading glyph; `iconSize` overrides its 16 / 18pt); `VBar` gained `back` /
  `titleShown` / `titleLeading`; `Avatar` gained `tint` (the
  `.yo-rav-ini` initials disc); icons `user-plus`, `block`, `logout`.

### Step 3 (Settings), as built 2026-11-11

Plan `.local/you-profile/step3-plan.md` (rulings P1–P5, Q-A…Q-F, T1–T5).
Server side: README (mutes GET, devices for the app), `app/api/auth/CLAUDE.md`
(native This Device / revoke-all / device label), `docs/dev/mute.md`.

- 🔒 **Every settings push is `dangerouslySingular`** (hub rows, Account,
  Privacy → Blocked / Muted, Help & About → Attributions, Edit Profile):
  react-native-screens 4.30 no longer sinks touches during a push on iOS 26,
  so a double tap opened the page twice (device pass 2026-11-11; the same
  fix as the moments list). EXCEPT the profile ⋯ → Settings entry: a plain
  push (the menu closes on the first tap, so it can't double-push), because
  from the Feed tab it lands on the You stack (`/you/settings`), where
  singular would pull an open Settings forward over a deeper page (review
  2026-11-11).
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
  (Step 4 replaced the "every PATCH sends BOTH fields" rule with the
  compare-and-set below.) Optimistic, one at a time
  APP-WIDE (two PATCHes can commit in either order, and Privacy can be
  mounted twice, on the You stack and on an opened post's in another tab: a
  mutation `scope` queues saves in tap order and `useIsMutating` disables
  every mounted editor), alerted on failure: a REFUSAL (4xx) reverts, any
  other failure (no answer, a timeout, a 5xx) may have committed, so the
  value is dropped (`resetQueries`) and every editor waits on the server's
  own read before another save. After each PATCH a
  read still in flight is CANCELLED and the cache set to what the server now
  holds before the re-read (a focus refetch that started mid-PATCH carries
  the old tier, and a save made from it would send it back). The step-3
  known limit (a PATCH the phone gave up on, still running on the server,
  landing after the re-read) is CLOSED by step 4's compare-and-set: that
  PATCH's `expected` no longer matches, so it is refused (409) instead of
  overwriting. Blocked / Muted rows: count +
  chevron; "No one" + chevron after a successful empty fetch (it opens the
  empty list, ruled 2026-11-11); inert while loading; tappable on error. Queries `['me', 'visibility' | 'blocks' |
  'mutes']` (`lib/api/settings.ts`).
- **Blocked / Muted** (`components/settings/PeopleListPage.tsx`): initials
  disc + name + tertiary Unblock / Unmute; Unblock confirms, Unmute acts; the
  row leaves on success, then the person's header, the network feed (and,
  for an unblock, YOUR header) refetch in place.
- **Account** (since 2026-11-11 on the cardless settings standard, as
  Privacy: `SetTitle` sections "Email and Password" / "This Device" / "Other
  Devices", `SetNav bare` rows; per the 2026-11-11 design proposition
  (`.local/Screenshot 2026-11-11 at 21-15-50 Vero handoff files.png`):
  glyphs mail / key / phone · tablet · laptop; ONE detail line ("Active now";
  others "Switzerland · 15 min ago", "< 5 min ago" when fresh; the sign-in date dropped, ruled
  2026-11-11); other devices' action is REMOVE (ruled,
  replacing "Disconnect" below), this device's Sign Out stays red; buttons
  15pt MEDIUM (`Button size md rowAction`: a row's trailing action, calmer
  than the semibold default; the Blocked / Muted lists' Unblock / Unmute
  too); a long value (the email) truncates in the MIDDLE with max 55% width; "Remove All Other Devices" is the LAST accent row
  of Other Devices (the touching-cards layout below is superseded); Delete
  Account alone at the end): Email (→ Change Email: New Email + Current Password,
  ruled 2026-11-11; the same PATCH as the web, but from an app caller the
  server requires the password and a `z.email()`-valid address (Better
  Auth's sign-in rule); no confirmation mail, there is no email pipeline; a
  save that lands after you left doesn't pop the screen under you, same in
  Change Password), Change Password, the devices in TWO groups
  (ruled 2026-11-11): THIS DEVICE (the server's `isCurrent`, now set for the
  app's own row; "Active now"; its Sign Out, in red (`Button critical`), is the hub's plain logout, the
  same confirm via `lib/signOutConfirm.ts`, no password: ruled 2026-11-11,
  replacing T3's button-less row), then OTHER DEVICES (server order, most
  recently active first; each with REMOVE, then Remove All Other Devices
  last: see the step-4 restyle at the top of this bullet, which superseded
  the step-3 touching cards, the "Disconnect" wording and the second
  "Signed in" line). The detail line: the country when known (from the
  sign-in IP, so local LAN sign-ins have none) and last active on the web
  panel's 5-minute scale ("< 5 min ago", 5-minute steps, hours, days, the
  date), then Delete Account. The three password-gated actions prompt with
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
- **Deviations (flagged):** the Privacy switch rows are `ToggleRow`s (the
  moment settings' style, no card) since step 4, ruled on device 2026-11-11
  over the mock's `.yo-stog` group; the theme
  demo card + chip drop the mock's 1px border (no-borders ruling); Blocked / Muted are two
  rows (Q-B) where the mock lists people inline; the devices are two groups
  (This Device / Other Devices) where the mock has one list. Your own ⋯ menu drops the
  mock's "Edit profile" row (ruled 2026-11-11): editing lives in Settings →
  your card, the way a moment's does (⋯ → Settings → Moment Details), and
  the two ⋯ menus line up (Add Friends / Share Profile / Settings vs People
  / Share / Settings). Long-press editing on the profile stays (long-press
  comes to moments later).

### Step 4 (privacy that changes what others see), as built 2026-11-11

Plan `.local/you-profile/step4-plan.md` (rulings Q1–Q10, D1–D13). Server
side: `docs/dev/profile-visibility.md` (post audience, the switches, the
compare-and-set, the census gate), README.

- **Privacy layout** (ruled on device 2026-11-11, from the design
  screenshot `.local/Screenshot 2026-11-11 at 19-44-32 Vero handoff files.png`):
  four `SetTitle` sections (`bodyLg` 600, NOT the uppercase label), rows
  without cards. **Account Visibility**: `ChoiceRow` "Visible To" (value +
  chevron → the tier sheet "Account Visible To"), then for Followers /
  Friends the extended-circle switch, named by the tier: "Include Followers
  of Followers" ("Also people who follow your followers") / "Include Friends
  of Friends" ("Also people your friends are friends with") (ruled; the
  server's circle follows the tier too, `docs/dev/profile-visibility.md`).
  **Post Visibility** ("posts" in
  every copy line of this feature, never "check-ins"; the wire name stays
  `checkinVisibility`): switch "Same as Account" ("Turn off to
  share posts with fewer people"; on = the server's null). Turning it off
  OPENS the sheet "Posts Visible To"; nothing saves until a pick, closing
  leaves it on. Then `ChoiceRow` "Visible To" (Verre Users / Followers /
  Friends / Only Me). In the sheet: a choice BROADER than the account is
  greyed "Change your account visibility first"; the SAME tier is greyed
  "Same as account visibility", unless the extended circle is on, then it is
  choosable with "Without friends of friends" / "Without followers of
  followers" by tier (also the row's helper); Only
  Me never is greyed. 🔒 No contradiction and never wider (design flagged a
  contradiction; the review found the first rule could WIDEN, both ruled /
  fixed 2026-11-11; `@verre/core` `postAudience.ts`, the SERVER's write
  applies the same rule): a choice whose audience EQUALS
  the account's IS Same as Account (null). Without the extended circle that
  is any choice as wide as the account or wider; WITH the circle on only
  Verre Users (an explicit tier never includes the circle, so Followers under
  Friends + circle is narrower, NOT the same). That exact collapse runs on
  every save and on display. On an ACCOUNT change (the tier or the circle
  actually changes), a choice still wider than the account while the circle
  is on CLAMPS to the account's tier (only narrows); an unrelated save (a
  Show switch, the same tier picked again) never touches the choice. Every
  save is `applyVisibilityChanges(expected, changes)`: it starts from what
  the page SHOWS (`canonicalPostAudience(expected)`), so a stored value
  displayed as Same as Account stays on when another field changes; the raw
  `expected` stays the compare-and-set base (review 2026-11-11). Pinned
  against the server's `canViewPosts` for every state × viewer × change in
  `scripts/tests/you-profile-integration.mts` § 15 (with a negative
  control). Copy rule (ruled): plain English in sentences ("your account
  visibility"), never a setting's label mid-sentence. **On My Profile**:
  Show Cravings ("Others can see what you crave"), Show Moments ("Others can
  see the moments you joined", NEW, Q5), Show My Locations ("Places on your
  posts"). Title Case everywhere (the screenshot's sentence case lost to the
  app rule, ruled). **People** (ruled): two `ChoiceRow`s WITH their glyphs (block, eye-off;
  re-added by the owner over the design note that they break the label edge),
  the count or "No one" with a right chevron (both open their list); the
  Visible To rows are dropdowns (chevron down); their pages are cardless `PersonRow` lists. Spacing (the
  design): 32 above a section title (`SetPage gap`), 6 under it, ~12 between
  rows; ~100 extra bottom padding so the last row scrolls clear of the pill.
- 🔒 **Every save is a compare-and-set** (`patchVisibility(expected,
  changes)`, `lib/api/settings.ts`): `expected` = the visibility cache READ
  AT TAP TIME (`queryClient.getQueryData`, never the render closure),
  `changes` = only the field tapped (a tier change also carries the stored
  `fofEnabled`, for a pre-compare-and-set server mid-deploy). A synchronous
  `queryClient.isMutating({ mutationKey: SAVE_KEY }) > 0` guard first
  (query-core marks the mutation pending before its first await, so a
  second tap in the same frame is dropped; the render-time `saving` can't
  see it). 200 → the cache = `current`; 409 → the cache = the server's
  `current` + "Settings Changed" / "Your privacy settings changed while
  saving. This is what’s saved now." (copy to confirm at the device pass).
  Refusals and failures as step 3 (4xx revert; non-4xx `resetQueries` +
  lock). The queue, the `useIsMutating` lock and the epoch checks stay.
- **Someone else's profile**: a tile the owner hides is ABSENT from
  `tiles` (types: every key optional); `PhotoTiles` shares the row among
  the tiles left at the three-up height (two → halves, one → a wide
  banner, none → no row; Q6 / Q10). When `checkinsAudience` is present
  (their Check-Ins Visible To hides the posts from you), the Q3 line
  ("Follow Lena to see posts" / "Become friends with Lena to see posts";
  Only Me, and Verre Users (web only), "No posts found", the SAME line a
  profile with no posts shows, so Only Me isn't named (the missing
  Impressions tile still shows posts are hidden); no pronouns; ruled
  2026-11-11) is
  `FeedList`'s `postsHidden` (`EmptyPosts`), REPLACING the posts whatever
  the cache holds. Follow / unfollow (`relate`) also refetch
  `['feed', 'user', id]` IN PLACE (`refetchUserFeed`, never invalidate):
  they can flip what the list shows while the profile stays visible. Your
  own profile never changes.
- **Like**: an unlike of a post now hidden from you answers without a
  count; `toggleFeedLike` keeps the optimistic count then (`count?`).
- ⚠️ A step-3 dev build crashes on an absent tile key: install the step-4
  build before opening a profile with a hidden tile.
- **Deviations (flagged):** Show Moments is new (not in the mock); the
  "Appear in “in common”" row stays dropped (step 3); hidden tiles
  disappear and the rest share the row (the mock always shows three).

### People step (People + Add Friends + Scan), as built 2026-11-12

Plan `.local/you-profile/people-plan.md` (rulings D1–D12). Server side:
`lib/peopleSql.ts` (`blockScrub`, the `together` predicate,
`momentsTogether`, `friendsInCommon`), `viewableProfiles`
(`lib/profileVisibility.ts`), `docs/dev/block.md` + `docs/dev/profile-visibility.md`,
README; suite § 16.

- **Routes**: `feed/people/[id]` (the screen, `PeopleScreen` in
  `components/people/`) + `you/people/[id]` (re-export); on an opened post's
  stack `feed/[id]/people/[personId]` (its own wrapper: `id` is the post) +
  the You mirror. `feedHref(mount, 'people', { id, tab, known })`; `tab` /
  `known` only seed the screen. Router sim case
  `.local/opened-post-stack/router-sim/t14.cjs`.
- **Taps (D10)**: the header's "N friends" → People on Friends, "N
  followers" → Followers (both profiles, `ok` only; dimmed and inert while
  you edit your name or bio, or the push's blur would drop the draft); the
  in-common row → their People, Friends, "Only People You Know" on. Plain
  pushes with `usePushGuard` (A → B → A keeps its history; no singular).
- **People screen**: bar "People" + (yours) the "+ Add" pill / (theirs) your
  `FollowButton` to them; `TabStrip fit` with counts from the header
  (`compactCount`); tool row (yours: code button + search; theirs: search,
  then the `ToggleCard` "Only People You Know" / "Friends and people you
  follow · N", N = the first page's `knownCount`, the header's in-common count
  before it loads); `PeopleRow`s; one `useInfiniteQuery` per (id, tab, known,
  q), search debounced 250 ms from 2 characters; "Friends = you follow each
  other." under your own lists. States: per-tab empty ("No friends yet." /
  "No followers yet." / "Not following anyone yet."; theirs "No one here
  yet."), "No matches.", "No one you know here yet.", a 404 mid-visit →
  `CenteredMessage` "These people aren’t available", a failed load →
  `ErrorState`. An unfollow that went through takes the row off every list
  your follow put them on (your Friends + Following, anyone's "Only People
  You Know", searches included; `relate(…, viewerId)` → `dropUnfollowed`);
  Followers keep it as Follow Back. No undo row: the confirm is the guard
  (ruled 2026-11-12, reversing the plan's stay-until-you-leave row).
- **Row line (D2)**: "N moments together" › "N friends in common" › none (no
  relationship words, no follow dates); your own row: no line, no button.
- **Unfollow (D7)**: `confirmUnfollow`: friends (`isFollowing && followsYou`)
  → "Remove Mara as Friend?" / "You’ll stop following Mara. Mara still follows
  you, so you can follow back anytime." [Remove Friend]; else "Unfollow
  Mara?" [Unfollow]. The profile, the People bar and People rows. Follow /
  Follow Back act at once, with the iOS success haptic as the button flips
  (every follow goes through `relate`; ruled 2026-11-12). The private (shell) profile now gets `followsYou`
  (Follow Back there too); its line is "Hugo’s profile is private." (ruled
  2026-11-12; the shell never says the tier).
- **Add Friends** (`AddFriendsSheet`, no route; your ⋯, People's + Add and
  code button): the QR of `${WEB_BASE}/u/<publicId>`, your name + photo UNDER it
  (ruled 2026-11-12; the mock has them above), then your `@name` and the link as shared (`host/@name`; "Scan to follow me on Verre" only while you have no username; § Usernames), the tasted-with chips (`GET /api/me/tasted-with`,
  a SNAPSHOT while the sheet is open: a followed chip keeps its ✓, inert),
  the search pseudo-field → the 85% search pane, keyboard up at once (as the
  invite sheet's field; its Browse chip opens without) (RESULTS + PEOPLE YOU TASTED
  WITH on `FriendRow`, Done closes; the search never lists you, the server
  leaves you out before its limit of ten), "Share Profile Link" ("<Name> on
  Verre"). Your card works when your profile failed to load (session id, the
  account's name, initials). Any push out of it closes the sheet FIRST.
- **Scan (D8)**: one module, `components/people/scan.tsx` (`useVerreScanner`
  + `ScanResult`), used by Add Friends (its result pane) and Moments home
  (ruled 2026-11-12: the join block's button is a filled "Scan" + QR glyph
  while the code field is empty and turns into Join once you type, outlined
  and disabled until the code is complete, then filled like Scan (ruled
  2026-11-15); the result shows in a sheet). View Profile / "Hosted by" push on the caller's own stack:
  Moments home's onto the Moments stack, which mounts the profile sub-tree
  since 2026-11-15 (before, they opened on the Feed tab, and `ScanResult`
  read the root navigation state to avoid Feed's outer stack above an open
  post: that lookup is gone with the cross-tab push; router-sim t18
  replaces t15). `CameraView.launchScanner({ barcodeTypes: ['qr'],
  isHighlightingEnabled: true })` (VisionKit; deployment target 16.4, so it
  is always there on iOS): permission first (`useCameraPermissions({ get:
  false })`; denied → "Camera Access Needed" + Open Settings), a rejection
  after that = "Scanning isn’t available on this iPhone." The event is ONE
  app-wide `onModernBarcodeScanned`: each sheet subscribes only while open,
  and only the sheet whose Scan tap is the latest (module `scanOwner`) and
  that is armed takes a code; `parseVerreCode` decides (exact origin,
  `/u/<publicId>` (or a legacy `/u/<digits>`) or `/join/<code>`). A Verre code: the iOS SUCCESS haptic, disarm,
  `dismissScanner()`, the result pane. Anything else (ruled 2026-11-12): the
  ERROR haptic and the alert "Not a Verre Code" OVER THE LIVE SCANNER, which
  stays open (RN alerts present in their own window); expo-camera reports a
  code continuously while it is in view (`didUpdate`), so nothing is taken
  while the alert is up and that payload is ignored for the rest of the scan.
  A scan whose sheet closed during the permission prompt / settle wait never
  launches (nobody would listen). The header button is a filled "Scan" with
  the QR glyph (`Button iconSize` 20, ruled 2026-11-12), disabled on the result pane, and a relaunch
  waits 700 ms after the last dismiss (`dismissScanner` resolves when the
  dismiss STARTS, and expo-camera stops whatever scanner is current when the
  old one finishes). Result: a person (`PersonPreview`: photo, name, "N
  friends in common", View Profile + Follow / Follow Back), private (name +
  the same buttons), "You blocked Mara." + Unblock (since 2026-11-15, Unblock
  alone), "This code isn’t available.", "This is
  your code.", or a MOMENT PREVIEW (ruled 2026-11-12; `GET
  /api/session/:code/preview`, its own never-reset budgets): cover,
  name, "Hosted by <name>" (tappable: their profile), when and where (the
  line-up's about lines), no code; Join (`joinByCode`, then the moment on
  this stack), or Open Moment when you're in it; a ban → "You can't join this
  moment.", none → "This code isn’t available." A block pair never stops it
  (a block never stops a join); the host is then a plain name, no link. A
  join that finishes after you left (a host tap, the sheet swiped away) does
  not push the moment.
- **Native module**: `expo-camera@~58.0.14` (plugin: the shared camera string
  "Verre uses your camera to take photos for your moments and impressions,
  and to scan Verre codes." in BOTH it and expo-image-picker, no microphone,
  `recordAudioAndroid: false`; `barcodeScannerEnabled` left on, Android's
  scanner needs it; Podfile.lock gains ExpoCamera + ExpoCameraBarcodeScanning,
  which vendors ZXingObjC as an embedded framework, not a pod of its own).
  A new dev build (`pod install` on the Mac).
- ⚠️ A dev build from before the People step crashes on EVERY profile, the
  You root included, AND on Moments home (the screen the app opens on):
  `ProfileScreen` and the Moments home join block import the scan module,
  which imports expo-camera at module level. Install the new build first.
  TestFlight is unaffected: every TestFlight binary is a fresh EAS build
  (expo-camera included) and the app has no over-the-air updates; if OTA
  updates are ever added, this needs a runtime-version bump.
- **Deviations (flagged)**: tool row 36pt (D12, the mock's 46); People rows
  have no hairlines between them (the mock's `.sh-row` border-top; RecentRow
  has none, per the plan); `parseVerreCode` is one anchored match, not the
  plan's `new URL()` (React Native's URL is a regex shim with no validation,
  so it would behave differently on the phone than in the unit test); the
  People tabs are centred like the moment's (one strip); the QR sits flat on the
  sheet (the invite sheet's ruling, no code-card panel); the search pane has
  a back chevron as well as Done; sheet rows show Friends / Following as an
  inert ✓ status (unfollow lives on People rows and the profile); the scan
  is the iPhone's own scanner, no frame / hint / "My code" (D8); the Scan
  pill is a filled "Scan" with the QR glyph at 20pt (`Button iconSize`;
  the mock: outlined + a 17pt glyph, which didn't read as a button; ruled
  2026-11-12); a scanned moment
  shows a preview (the mock: "Join a Moment" + the code).

### Lists step (Impressions / Moments / Cravings), as built 2026-11-13

Plan `.local/you-profile/lists-plan.md` (rulings Q1–Q8, D1–D14). Server: `lib/outsideView.ts` (the outside-a-moment rule, root CLAUDE.md), `lib/profileLists.ts` + `lib/profileListRoute.ts`, `lib/momentFacets.ts`, `lib/cravingsCursor.ts`, `docs/dev/profile-visibility.md`; suite § 19 + `scripts/tests/outside-view-matrix.mts`.

- **Routes**: `feed/impressions/[id]`, `feed/moments/[id]`, `feed/cravings/[id]` (+ You re-exports); on an opened post's stack `feed/[id]/<kind>/[personId]` (own wrappers: `id` is the post) + the You mirrors. `feedHref(mount, 'impressions' | 'moments' | 'cravings', { id })`. A profile TILE tap pushes its list (`PhotoTiles` `onPress`: own tiles through `LongPressable`, long-press still edits; someone's a Pressable; inert while you edit). Router sim `.local/opened-post-stack/router-sim/t16.cjs`.
- **Discoveries** (`DiscoveriesScreen`, ruled 2026-11-13): the three lists are ONE page, every route above renders it with that kind as its first tab. Bar "Discoveries" with the owner's 26pt photo before the title (the mock's pushBar `.yo-tav`, only with a photo, like the profile's bar; People's bar carries it too) and the open tab's button on the right; under it People's `TabStrip` (`fit`) Impressions · Moments · Cravings WITHOUT counts, an in-screen switch (no navigation). Tabs = the tiles this viewer sees (an absent key = hidden; the tapped one always; one tab → no strip). Each list is a PANE (`ImpressionsPane` / `MomentsPane` / `CravingsPane`, in the old screen files) that mounts on its first visit and stays mounted (`display: 'none'`) while you are on the page, so its search, filters and scroll survive a switch.
- **Impressions** (`ImpressionsPane`): every rating through their post visibility, newest POST first (`hadAt`), month headers. Sort (ruled 2026-11-14) next to the filter: Newest First (default) / Oldest First / Highest Rated / Lowest Rated (`AnchoredMenu`, Cravings' recipe; unrated last in both score sorts, a tie newest first); month headers for the date sorts only. `?sort=` on the route, the cursor binds the sort (`lib/impressionsCursor.ts`; suite § 19). Its bar button (yours, not on a post's stack) "+ Check In" = the Feed's two stages on THIS stack (`checkinHref(mount)`, `you/check-in` mirrors; the draft store is keyed by tab). Filter sheet "Filter Impressions" (`ImpressionFilters.tsx`): Date · Category (Any / Wine chips, like Filter Moments) · Score (`ScoreRange`) · Aromas · Structure (§ Impression filters). Someone's: `ToggleCard` "Show 23 tastes you share" (ruled 2026-11-13: warm, something you share with the person, no "only", no helper line, SENTENCE case (it reads as a sentence; an exception to the Title Case of switch titles); no card until the first page brings a count above 0 (never while loading, after a failure, with their posts hidden or the list gone) unless it is on, "1 taste" in the singular, and no number while a search or filter also narrows the list (the count is unfiltered); `commonCount`, blind rows never count) and "You ★ x" under their score. A blind row: "Blind Impression", its moment name as the line, no photo.
- **A row without a post you may open** (Moment Visibility step 3, T14) opens its impression PAGE instead (§ Moment Visibility step 3 below); before step 3 such a row was inert.
- **Opening a post (D9)**: a row with a `postId` → `useOpenListPost`: 🔒 `fetchInfiniteQuery(feedItemQueryOptions(owner, postId))` (never `fetchQuery`), the viewer epoch AND the tap's generation after every await (🔒 leaving the screen, unmounting or the pane going hidden on Discoveries bumps it, so a slow fetch never opens the post or alerts over wherever you went; Codex review), an EXACT wine match for the index (a standalone = 0), then the push with `source: 'item'`, and the post GROWS out of the tapped row as a CONTAINER TRANSFORM (Material motion; `lib/feedTransition.ts` kind `'row'`, Simon 2026-11-13, replacing an invisible bg-coloured band): `ListRow` hands a `RowHandle` (`measure` + `face`, a static transparent copy of the row), the hook measures AFTER the fetch (a scroll meanwhile can't leave a stale frame), and the detail runs its one `progress` inside a REVEAL WINDOW, a full-width band whose top and bottom go from the row's to the screen's (VERTICAL only, ruled 2026-11-13; `RevealWindow`: a screen-sized `overflow: hidden` clip translated + Y-scaled onto the band, its content counter-transformed so only the clip moves). In it: the raised `surface` tone (in by `ROW_TONE_IN`, see-through at 0 so nothing pops at either end), the row's face riding the band's top edge while it fades (`ROW_FACE_OUT`), the post's bg easing in over the tone (`ROW_BG`), the content on the usual ramps. Transform / opacity only (the sync-props allowlist); 🔒 the worklets capture numbers only (`rowOn` / `rowY` / `rowH`), never the source object, which holds a React element. Back, Android back and the pull-down fold it back into the row. On an opened post's stack it stays the plain card push (no measure), and a row gone by then falls back to the fade; a miss alerts "This impression isn’t available." and refetches the list in place. The detail and its edit read ONLY that item query with `source: 'item'` (`lib/useFeedPost.ts`; the edit details reads the edit store, no feed cache); the edit's "post is gone" exit pops back to the list (`closePost`), not to a profile. The author tap on such a post PUSHES their profile (the screen underneath is the list, not the profile).
- **Moments** (`MomentsPane`): yours = `/api/me/sessions` with `tense` omitted + `limit` (key `['my-sessions', 'all', …]`, so every my-sessions invalidation reaches it) and "+ New" (create on this stack, `momentCreateHref(mount)`, `feed/moments/create` + `you/moments/create` mirrors; create lands in the new moment there); someone's = `/api/users/:id/moments`: the moments you share and, with `MOMENT_LOOKIN_ENABLED` on, the LOOK-IN rows without a `code` (keyed `m:<momentId>`, a tap opens the look-in; Moment Visibility step 2, § Moment Visibility below), then "Mara joined 12 other moments." (only with no search / filter, once every shared row is loaded). Rows: cover, name, when · where (the set date, the moment's address), the role chip (yours / THEIRS), chevron; tap → the moment on this stack. The shared filter (D14): role reads THEIR role on theirs ("Mara’s Role"), hosts = You + them + your friends.
- **Cravings** (`CravingsPane`): sort button → `AnchoredMenu` (Recently Saved / Highest Rated; the latter always on yours, on someone's only while a score shows), search. 🔒 No heart (Q6): YOUR row's long-press is the native lift menu (`@expo/ui` `ContextMenu`, no Preview: iOS lifts the row) with the red "Remove from Cravings" (the lifted row gets 12pt of page background each side, `LIFT_PAD`, device pass 2026-11-13): the row leaves your Cravings lists at once (cancel, then `setQueriesData`), then DELETE `/api/me/bookmarks/:key`, then `['bookmarks']` + your header. A failure alerts, and the list refetches in place. Tap = the list owner's post of it (D9), else inert.
- **Caches (D12)**: `['profile-list', kind, id, params]`, refreshed IN PLACE (`refetchProfileLists`, `lib/feedCache.ts`; `invalidateProfileHeader` calls it for that person), every list refetches on refocus; the in-moment Crave and rate only MARK your header stale (`markProfileHeaderStale`: your profile refetches it when in front again), since a room on one Wi-Fi shares the per-IP `rl:profile` budget.
- **Edit Profile**: "Profile Tiles" = the tiles AS ON YOUR PROFILE (`PhotoTiles`, `editable`: a small glass pen top-right on each; ruled 2026-11-13, replacing settings rows; "12 Impressions, chosen cover" / "… automatic cover" as the VoiceOver label), one TAP opening the tile's `TileCoverSheet`, which saves on its own "Use Photo" (not part of the page's draft).
- **Deviations (flagged)**: the passport card, "saved from whom", the Places sorts and Invite are later (no backend); someone's Moments drop the "Only Moments We Shared" switch (the shared rows carry a "You were there" line since Moment Visibility step 2, R7); the tool row is 36pt (D12); category is chips, not the mock's select; the score range label keeps the house ".0" ("★ 3.5 – 5.0", mock "★ 3.5 – 5"); Edit Profile's tiles (not in the mock: the profile's own tiles with a pen); no hairlines between rows (like RecentRow / People).
- ⚠️ **Device pass** (only the phone can prove): the Cravings lift menu while scrolling and after a removal (no fixed row height: @expo/ui 58's `RNHostView` follows the RN child's bounds, the carousel's fixed height was for 56's over-fill); taps, sheets, the score range; an old post's UNFOLD from its row and the fold back (back, pull-down, Android back) from Impressions and from Cravings (a lifted Cravings row too; prefetch, then the page it opens on); Recent / Upcoming moments' filter unchanged after the extraction (TestFlight).

### Impression filters (aromas + structure, 04·6d/6e/6f), as built 2026-11-14

Rulings in the session interview (no plan doc; memory has them). Server: `lib/profileLists.ts` (`structureSql` / `aromaSql`), the route's `st` / `ar` / `armode` (README), the match rule `packages/core/src/aroma/filter.ts` (units `scripts/tests/aroma-filter-units.ts`, `check-aroma-units.yml`); suite § 22.

- **Filter Impressions** gains AROMAS and STRUCTURE the Filter Moments way: a `SelectField` row with a summary ("Apricot (dried) and Lemon", "Sweetness: Faint – Medium") opening its own sheet on top (`push`, layer 1), one `FilterTitle` chip per facet (body = open that sheet, ✕ = clear it). Under the Aromas row, once 2+ aromas are picked, `Segmented` "All of These | Any of These" (ruled: the person chooses; default All; the summary joins with "and" / "or"). Picks and drags apply as you make them; the list follows 300 ms later (`ImpFilterUpdate` `debounce`, like the score drag), everything else at once.
- **Filter for Aromas** = the rating's `AromaInput` (`bare`: no heading / ⓘ; refine with modifiers + Pronounced, ruled), in a 90% fixed sheet with `BottomSheetScrollView` + `useAromaSearchScroll` and a pinned Done (gorhom footer); its "+N more" sheet pushes on layer 2. 🔒 Each pick is read BROAD by the server (ruled): the node and everything under it (Fruity finds every subfamily and leaf; never upward), no modifier = any modifier, a modifier = only it, Pronounced = only marked ones, the refine passes down, a promoted leaf counts for its base (Grape finds raisin).
- **Filter for Structure** = THE rating `StructureInput` with `range` (ruled: one shared component, "a small adaption"): ONE render path: the rating's grid (two columns from 380pt), tracks and level policy, name + fill, a SET track adds its range as numbers at the right end ("1 – 3", one step "2"; words don't fit two columns; an unset track stays plain; the help line carries the rating's ⓘ scale, `IntensityScaleInfo`; ruled 2026-11-15), each holding a from–to. Drag (ruled 2026-11-15, after the first cut redrew the range on every drag): a touch on the fill, or 10pt beside it, grabs the NEARER end, which follows the finger (pulled past the other end, the range flips around it); a touch elsewhere draws a new range from there; tap = that one step, tap a one-step range = clear (so "tap twice" always clears). None = the far-left sliver as in rating (no extra cell); VoiceOver: up / down moves the upper end, named actions Raise / Lower Lower End + Clear. Axes = the wine set WITH Bubbles (it only finds ratings of a wine that is sparkling NOW: the post's wheel draws the current style's axes, and a re-typed session wine keeps its ratings' bubbles value; core `stylesWithAxis`). Reset + Done pinned. An unrated axis (absent key) never matches; a None (stored 0) does.
- 🔒 On someone else's list these two filters only match rows WITH A POST (their structure and aromas show on the post, never on the row; a post-less rating stays in the unfiltered list).
- ⚠️ **Device pass** (only the phone can prove): drags on the range tracks inside the sheet's scroll (horizontal vs scroll vs sheet pull), the canvas pan + search keyboard fit in the aroma sheet, the three-deep sheets (filter → aromas → "+N more"), Filter Impressions' height on a small phone at large text (it grew by two rows + the switch), VoiceOver on a range track.

### Extras step, as built 2026-11-14

Rulings in the session interview (no plan doc; memory has them). Moment sort was DROPPED (only dates; the filter's dates do it better).

- **Status line** (`ProfileHeader` `StatLine`, the mock's taps): yours = the pill → Status, the ★ average → Palate; someone's = the pill or the average → their Palate. Always TWO buttons, each with its own press fade (device pass 2026-11-14: one fade over the whole line read as one button); no handlers while you edit. Both pages are PLACEHOLDERS (`components/profile/ComingLater.tsx`, the mock's `.yo-soon` under a bar with the owner's 26pt photo, the column CENTRED both ways in what you see between the bar and the floating tab bar (`paddingBottom: TAB_BAR_CLEARANCE`; centred on the whole area it sat low), the pill centred over the text; ruled on device 2026-11-14 over the mock's 80pt top padding): Status = your pill, "Status, Points and Badges" + the mock's line; Palate = "Your Palate" / "Mara’s Palate" (no pronouns for someone else). Routes `feed/status` + `feed/palate/[id]`, on a post's stack `feed/[id]/status` + `feed/[id]/palate/[personId]`, the You mirrors; `feedHref(mount, 'status' | 'palate')`. Router sim `t17.cjs`.
- **Settings offline strip**: `SetPage` `offline` = `failedReads(...queries)` (a retry of every failed read, or null): the app's `ConnectionBanner` under the bar, tap retries, the rows stay usable. On the hub, Privacy, Account, Change Email and the Blocked / Muted pages (`PeopleListPage`; its no-data failure keeps the full `ErrorState`). Appearance and Change Password read nothing.
- **Tool rows** = the outlined pill (§ Toolbar standard), the filter with its count; the applied-filter chips moved INTO the filter sheets (Filter Moments on every moments list, and now Filter Impressions too: date, category, score; `FilterTitle`, § Moments filter); Impressions sort (§ Lists step); the tile switch (§ Tile covers).
- 🔒 **A long-press that REPLACES the pressed view** (`LongPressable swapsOut`: the name and the bio, which become inputs). RN 0.88 (`enableNativeEventTargetEventDispatching`, on by default) drops a touch's end when its target view is gone, so swapping the view out under a held finger leaves the responder stuck on the removed view and the next touch is negotiated from the common ancestor down: it never reaches its button and skips every capture handler below that ancestor (device pass 2026-11-14: the first Done after a long-press was swallowed AND shook the bar, since the edit bar's `markNoShake` never ran). So the hold is gesture-handler's `LongPress` (480 ms) around the Pressable: when it fires it CANCELS React Native's touch while the view still exists (`cancelsJSResponder`, on by default), and the swap waits until the Pressable's `onPressOut` has seen that touch end, whichever reaches JS first (`pressed` / `held`, reset at every press-out: nothing carries over between touches; a hold for a touch the Pressable never held swaps at once, nothing of ours to strand). The edit still starts at the hold (ruled 2026-11-14; a first fix that started it on release was rejected). The Pressable stays so the touch can't fall through to a pressable around it (the cover's long-press holds the cover name). Any new long-press that swaps its own view out needs the same.
- The edit bar's shake is quicker (60 ms swings, left-right twice, 240 ms; ruled 2026-11-14: the first cut read too soft).
- 🔒 **Entering or leaving an edit must not REMOUNT anything with a photo** (device pass 2026-11-14: the cover, the photo, the tiles and the posts flickered on the hold and on Done, each one reloading its image). Make it inert IN PLACE, never by switching element types: `LongPressable disabled` keeps its Pressable (disabled, `accessible={false}` so its children stay reachable), `PhotoTiles dimmed` disables each tile and keeps its handlers (a disabled Pressable takes neither a touch nor a VoiceOver activation, which covers the draft-dropping push), and `FeedList inert` wraps every card in the same View either way (`collapsable={false}`, so it is one view natively too; also hidden from VoiceOver while inert). A plain View in a Pressable's place, a handler that comes and goes in front of a `? <Pressable> : <View>` branch, or a wrapper added only while inert all remount the subtree.

### Usernames (the UI half), as built 2026-11-14

Spec `docs/dev/proposals/usernames.md` (§ 19 = this build and its rulings). No moment surface changed: the server sends no username inside a moment.

- 🔒 **Where `@name` shows (ruled 2026-11-14).** SHOWS: the profile header (own and others', the private and blocked views: name + username only), search / Add Friends results (name, `@name`, the context line), the scan result (name, `@name · Follows you`, friends in common), the share card, Settings' You card, Edit Profile, Blocked / Muted rows, the invite sheet's friend rows, the scanned moment's host, the person preview a tap opens inside a moment (the scan card itself; ruled 2026-11-15). NAME ONLY: the feed (post header, "with …"), the People lists (Friends / Followers / Following, also while searching: ruled, although their search matches usernames), the docked bar title, moment participants / roles / "brought by" / line-up / compare, impression and moment author lines, the cravings "from …" label. Rule of thumb: finding or confirming someone you may not know shows it; reading people you know doesn't. Someone without a username: no `@` line anywhere.
- **Profile header** (`ProfileHeader`, `coverGeometry.ts`; the design spec of 2026-11-14 = `COVER_SPEC` / `PLAIN_SPEC`). With a username the identity block is placed by BASELINES, and every line's left edge keeps a fixed gap to the photo's ROUND edge at its own height (`curveLeft`), so the block follows the circle. Numbers are for the 104pt photo and scale with it; baseline distances also grow with the text scale.
  - **Cover**: name 30 semibold white; handle 13 medium, white 78%, soft shadow (0 1 8, black 25%), one line. Handle baseline 8.5 above the sheet edge (the pill's top is 8.5 below it), name baseline 19.3 above the handle's. Gaps to the photo's edge: name 13 (the spec's 11.5, tuned on device 2026-11-14), handle 12.5 (the handle still sits a little right of the name). A second name line goes ABOVE (it stops `photo / 4` left of the widest point: above the photo's top the circle no longer bounds it).
  - **No cover**: name 26 bold ink (26/30 of the `title` token), ONE line (shrinks to the floor, then "…": the design's one line, where the layout before usernames wrapped); handle 13 regular soft ink. Cap top of the name 8 below the photo's top, name → handle 21.3 (baselines), handle baseline → pill top 11.5, pill → friends line 4; name, handle and friends line 15 from the photo's edge, the pill 12.5 (the spec's 15, tuned on device 2026-11-14: its filled box read far), so the pill and the friends line tuck back under the curve. The blocked and private views (name + handle only) centre the two lines on the photo.
  - 🔒 `BaselineRow` is how a baseline is placed: a zero-width strut beside the text in an `alignItems: 'baseline'` row, so the baseline sits exactly the strut's height under the row's top whatever the platform's line box does. Don't position these lines by a text box's top or bottom.
  - Someone WITHOUT a username keeps the layout from before (`StraightIdentity`, the bottom-anchored cover name; `fitProfileName` without `anchor`, pinned against the pre-usernames fit over a grid). The bar title still triggers on the NAME's bottom. While you edit in place the handle is an input too (since 2026-11-14, below); the name's input sits on the name's baseline AND takes the one-line name's shift along the curve (`anchoredIndent`, the one helper both use: without it the input sat a few points right of the name, device pass 2026-11-14; pinned in `username-ui-units.ts`).
- **The moment preview's host** (`scan.tsx`): `@name` is the preview's own `hostUsername` (the one username a moment route sends: `app/api/CLAUDE.md` § Usernames); a guest host, a block pair or a host who has not chosen shows the name alone. No profile read (a first version made one per scan and spent the shared per-address `rl:profile` budget).
- **A scanned `/@name` link** resolves through `getProfileByUsername` (its answer seeds the id's header cache), then everything runs on the public id. 🔒 No route and no lasting cache is keyed on a username: the one lookup query (`['profile-by-username', name]`) has `gcTime: 0`, and its answer reaches the id's header cache only as that query's `initialData` (written into an EMPTY entry only, so it can never overwrite a newer header, e.g. after a follow or block).
- **Share**: the QR stays `profileLink(id)`; the card shows your name, `@name` and the link as shared (`host/@name`, no scheme); the share sheet sends `/@name`.
- **Edit Profile**: `UsernameField` with `availability` and `current`; its own `PUT /api/me/username`, saved FIRST (the one step someone else can refuse). A locked field never holds a changed draft (it resets to the current name, also on a 409 `quota`), so the rest of the page stays saveable. The limit is quiet until the last two changes (`lib/usernameCopy.ts` `usernameQuotaLine`, units `scripts/tests/username-ui-units.ts`); none left = read-only with the date. After a change: the own-profile cache, `['my-account']`, `['me', 'username']`, and the session refetched.
- **In place on your profile (ruled 2026-11-14)**: long-press the name, the handle or the bio and the handle becomes an `InlineField username` on its own baseline and curve (`ProfileHandle`: the `@` in front, lowercase as typed; the cover's text shadow drops while typing). Edit Profile's rules, with the feedback in the EDIT BAR, whose centre the line REPLACES ("Editing Profile" otherwise; `usernameBarLine`): a refusal (red; it greys Done until the text changes), "Checking availability…" while a changed name waits for its answer, typing included (`useUsernameCheck` `pending` + `checking`; not read out; device pass 2026-11-14: dropping back to "Editing Profile" on every keystroke confused), "Available" (with the changes left at the last two: "Available. 2 changes left for now."), the changes left alone while the field is in use, the date once none are left (the handle then stays read-only and dimmed, a tap shows the date, never a shake). Done saves the username FIRST (`saveUsername`), stops on a refusal (shown in the bar; name and bio stay in the edit), then the name / bio PATCH; a PATCH failure after a saved username says so (the draft takes the saved, trimmed form first). 🔒 The viewer epoch is checked between the two steps and before any alert, like Edit Profile's steps. While Done is greyed, Return keeps the field focused (`InlineField keepFocus`). The limit is read up front (`['me', 'username']`, enabled on your own profile) so a spent one is known before the edit starts. VoiceOver hears each new line.
- ✅ **Device pass PASSED (2026-11-14)**; re-run when this area changes (only the phone can prove): AutoFill saves and fills the EMAIL on sign-up / sign-in; the choose screen on a cold start and after a sign-in, and its exit onto Moments; a cold start OFFLINE on an account without a username shows the tabs, never the choose screen (`sessionConfirmed`); scanning a `/@name` QR and a moment QR (the host's `@name` there at once); the header against the design spec (baselines and gaps, cover and none, one and two name lines, a long coverless name, large Dynamic Type, the name's input in place, the blocked and private views); typing in the `@` field (cursor, deleting to empty, a 31st character).

### Person preview in moments, as built 2026-11-15

Simon: "in moments you cannot click the people … I want if you click them that you get a short preview, just like when you scan the qr code of the person", and Unblock right there for someone you blocked. Rulings in the session interview (no plan doc).

- **The card** is the scan result's person, extracted: `PersonPreview` (`people/PersonPreview.tsx`, catalog). `@name` SHOWS (ruled: tapping someone asks "who is this?"). Someone you blocked: "You blocked Mara." + **Unblock alone** (no View Profile, ruled; the scan card too), acting at once like the profile's Unblock (my reading: the option didn't say; flagged), through `relate`; the card turns into the normal one once the refetched header reads back. A failed read says "Couldn’t load this profile." + Try Again; a 429 (the per-address `rl:profile` 60/min, shared by a room on one Wi-Fi) says "Too many profiles opened on this network. Try again in a minute." (accepted, not a server change). A gone header: "This profile isn’t available."
- **Where a tap opens it** (all four ruled, plus the invite sheet, which I had missed: Simon, 2026-11-15): a People sheet row (avatar + name; the host's ⋯ keeps its menu), an impression's Brought By, Compare's Show All rows (the short score list keeps opening the rating detail), the Aroma Details People tab's PHOTO (the name keeps its aroma highlight), a friend row in the invite sheet's "Invite friends" pane (its Invite button stays its own target; the quick-add chips ARE invite buttons and keep sharing; `/api/me/friends` drops block pairs both ways, so no row there is a guest look). Not tappable (no person row): the moment settings card's "Hosted by", the "Also perceived by" popover (it opens the People tab), the taste ranking sheet's names. Pickers keep selecting (the Compare picker, the bringer picker); the line-up's people foot keeps opening People; your own row does nothing.
- 🔒 **The block look decides who is tappable** (`opensPreview`, `lib/blockLook.ts`): registered people and people you blocked, never a guest look, so someone who blocked you (one way or mutual) taps exactly like a real guest. 🔒 And only someone on the moment's ROSTER (`meta.participants`): the block lists only cover it, so a bringer or rater no longer in the moment who blocked you would read as normal and open a "gone" card (Codex 2026-11-15); the invite sheet's friend rows pass `from: 'friends'` (`/api/me/friends` already drops block pairs both ways). Keyed on the identity id (`u:<publicId>` → the public id), never a display name.
- **One sheet per moment screen**: `PersonPreviewProvider` (the line-up, an impression, and the moment settings hub, whose People + Invite sheets are the same components; each inside its screen's `BottomSheetModalProvider`), layer 2, `push` over whatever sheet the tap came from, the keyboard dismissed first (a row tapped with a sheet's search focused would present the card under it, review 2026-11-15); a surface asks `usePersonPreview()?.canOpen(id)` (null outside a provider: nothing tappable). `meta` null (not loaded, fatal) closes it. View Profile closes only the card and pushes the profile on THIS stack (`feedHref(mount, 'profile')`); the sheet the tap came from stays open behind it, so Back lands on the People list (or Show All, Aroma Details, Invite) still open (ruled 2026-11-15, like a likes list; the focus-aware bar hide above makes that safe).
- **Moments mount for the profile sub-tree** (Simon: "we already know how it is done"): 41 one-line mirrors under `moments/` of Feed's post + profile tree (as You's), the Moments `_layout` carries Feed's `[id]` + edit screen options and an `index` anchor, `lib/sessionStack.ts` no longer maps Moments to Feed, the tabs layout's pill-hide matchers know `/moments/<postId>` + `/moments/edit/`. Router sim `t18.cjs` (t0–t17 unchanged).
- **After a write**: an Unblock refreshes the moment's poll (`['session-state', code]`: "· Blocked" comes from `viewerBlocksOut`), a Follow or an Unblock `['my-friends']` (the People sheet's Friend word and the invite list; it leaves out block pairs). The Aroma Details sheet reads the preview outside its `<Sheet>` and bridges it in (`PersonPreviewBridge`, the portal rule in the Bottom sheet entry).
- ⚠️ **Device pass** (only the phone can prove): the preview sheet pushed over People / Show All / Aroma Details / the invite sheet's friends pane and back; View Profile closing the card only (the tab bar shows on the profile) and Back landing on the sheet still open, scrolling and tapping normally (the bar hidden again; the count is retaken one render after focus, so watch for a one-frame pill flash); Back from a profile to the moment (Moments tab), a post opened from that profile (open, pull-down, edit); Unblock flipping the card and the row's "· Blocked"; a row tapped with the sheet's search focused (keyboard up). Seeded: moment 4WXJZ4QJ (Max hosts; Cy normal, Ben blocked by Max, Abe blocks Max, two guests + Gina; Cy's bottle has 5 raters and Cy's aromas).

### Moment Visibility (the app, step 2), as built 2026-11-23

Plan: `.local/moment-visibility/step2-plan.md` (rulings R1–R15, technical calls T1–T13). Dark behind the server's `MOMENT_LOOKIN_ENABLED`: while it is off every route below answers 404 and nothing new shows.

- **The look-in is its own screen** (T1): `moments/look/[momentId]/index.tsx` and a bottle's page `moments/look/[momentId]/bottle/[key].tsx`, mirrored (one-line re-exports) under `feed/look`, `you/look`, `feed/[id]/look`, `you/[id]/look`, `moments/[id]/look`; `lookHref(mount, '' | 'bottle/[key]', …)` in `lib/sessionStack.ts`. 🔒 Never the moment screen in a read-only mode: that one POSTs `/visit` (it would make the viewer a member). The look of the moment screen through its moved parts (below), read-only: no Add, no ⋯, no in-place edit, no reveal; the Line-up has no toolbar (T8) and there is NO Compare tab (ruled 2026-11-24: each bottle's page carries its compare card; `CoverHeroLineup noTabs`, the plain layout is the Line-up alone). The pill shows on both (the bottle page has no footer; the impression's rule exists only for its rating footer).
- **The data** (`lib/useLookIn.ts`): one query per OPENING (`['look-in', momentId, 'audience' | 'link:<handle>']`; `lookInRequestPlan` in `lib/lookInLinks.ts` decides it: `via` in any form without a known handle is a dead link, never an audience read), shared by the look-in and its bottle pages, polled every 5 s while the screen using it is focused. 🔒 `retry: false`, no focus / reconnect refetch, and every attempt through ONE fetch gate (`lib/lookInDetails.ts`: a first read ≥ 5 s apart, a details read ≥ 2 s apart): one open look-in costs at most 42 requests a minute whatever is opened (the server's `rl:lookin:u` is 60). The open Compare cards' aromas come from the details read (`?bottles=`, ≤ 10 keys, cards still without aromas first, `pickDetailsBatch`). 🔒 Notes never reach a look-in (R15). A bottle's page shows that bottle's Compare card, open and without its header (`CompareBottle` in `CompareBody.tsx`, ruled 2026-11-24, in place of the named people's stars): the chart, the aromas (its own details read: the card reports itself open), each named person's score; the moment's own impression screen stays your rating only (ruled the same day). `{ member: true }` → `getMomentMembership` → the moment REPLACES the look-in on this stack (T7); a bottle page on top goes back first. Refusals: `lookInFatalOf` ("This moment isn’t available" by audience, "This link doesn’t work" by link, the rate-limited view only while nothing is shown).
- **Compare in a look-in** = one bottle's card on its page (`CompareBottle`), through `lib/lookInCompare.ts` (pure): bottle KEYS as wine ids, named people as the roster (`u:<publicId>`, a guest `g:<key>`: anything not `u:` is a guest in `lib/blockLook.ts`), the light ratings with `hasAromas`, `groupStats` from the line-up (R4: the card's numbers are the server's over everyone; a bottle only hidden people rated gets no card). The card reports itself open (`onOpenChange`) so the page fetches its aromas; `PersonPreviewProvider roster` without a code. The look-in-only seams of the old Compare tab (`CompareBody` `groupStats` / `emptyCopy` / `onOpenChange`, `ComparePickerSheet lookIn`) are gone with it. `buildItems` and the sorts live in `lib/compareItems.ts` (units pin the moment's own output).
- **Moved, not rewritten** (§ 4.7; the moment's screens render the same): the moment screen's layout parts → `components/moments/LineupParts.tsx` (`CoverHeroLineup`, `HeroTopBar`, `useTabTransition`, `LockCard`, `OvcAbout`, `LuRow`, …; seams: `toolbar: null`, `renderRow`, `empty`, `lockCard`, `HeroTopBar` without `onMenu`, `LockCard` without a time); the impression's `Hero` / `NameBlock` / `AboutBlock` → `components/moments/ImpressionParts.tsx`; the Moments home's join form → `components/moments/JoinCodeForm.tsx` (`onJoined`). Small COPIES where the original is tangled with host state, named in `components/moments/LookInParts.tsx`: `LookInRow` (LuRow's presentational half, the average on the right), `LookInAbout` (OvcAbout's read-only path), `LookInFoot` (AvatarFoot: "+N" counts the people not shown; "Hosted by" only when the host is named).
- **Entry points** (one rule, `lib/momentEntry.ts`): a known membership (your `['my-sessions']` row) opens the moment, a `momentId` the look-in, neither is inert. The feed card's and the post's place line (`useEnterableMoment(sessionId, momentId)`), someone's Moments list (shared rows key on the code and get "You were there", R7; open rows key on `m:<momentId>`). Joining (R6; moved 2026-11-24): a **+ Join** `IconPill` top right in both layouts (`VBar right`, `HeroTopBar trailing`) opens `LookInJoinSheet`, titled "Join <name>"; 🔒 only THIS moment's code joins there (`JoinCodeForm only` / `ScanResult onlyMoment`): the preview is asked with `?moment=<publicId>` and answers `sameMoment` yes or no (never the id); any other code, scanned or typed, a profile's QR included, reads "That isn’t the code for “<name>”." (`notThisMomentText`, `lib/joinByCode.ts`) and joins nothing. A join replaces the look-in with the moment.
- 🔒 **The look-in link** (T5): the `/l/` web page's "Open in Verre" hands `io.verre.app://l/<id>.<token>` to the app; `app/+native-intent.tsx` catches it BEFORE routing (the raw URL, both paths) and `lib/lookInLinks.ts` keeps the token in memory only, never in a route param, a query key, a cache or a log: a pending open (latest wins, consumed once, 15 minutes) and the tokens of open look-ins, one per OPENING by a random handle (`via=link&h=<handle>`). Sign-out clears both (`app/_layout.tsx`, beside `clearViewerCache`). The opener (`lib/usePendingLookIn.ts` `PendingLookInOpener`, its own null-rendering component in the tabs layout, so after sign-in and the username screen, R13, and its re-renders stay out of the layout) pushes on the FOCUSED stack (an opened post's own stack included, no tab switch; Soon switches to Moments first) and opens ON TOP of a post edit (ruled 2026-11-24, like Check In: every edit is a push, Back returns to it), CLOSES a fullscreen photo viewer first (`closeFullscreenViewers`, each viewer's own close through `useReportFullscreenViewer(open, close)`), and WAITS only while About / Attributions cover the tabs (`lib/lookInOpener.ts`, pure). Router sim `t21.cjs` (77 checks; t0–t20 unchanged).
- **Settings** (R8, R11; words and saving ruled 2026-11-24): the hub's **Moment Privacy** row (no value beside it: it broke the row's lines), opening the page for everyone (it only reads for anyone but the host and cohosts), none while the GET answers 404 (the feature is off, T10). The page `settings/visibility.tsx` (mirrored on the five session mounts), titled Moment Privacy: **Who Can See This Moment** with an ⓘ (`SetTitle info` + `ui/InfoTip`: what the setting does, `WHO_CAN_SEE_INFO`) over Visible To (`OptionSheet`, widest first like Privacy: Verre Users / Your Followers / Your Friends / Only People Who Joined, `AUDIENCE_MENU`; cohosts read "Host’s"), "Include Tasters’ Friends (Followers)" (never "guests" here; "joined" / "without joining" in place of "outside this moment" on the whole page and the web guest menu, and the shorter lines, ruled 2026-11-25 after two Codex rounds), then **Hide Location** and **Hide Description and Link** (ruled 2026-11-24: HIDE switches over the record's `showPlace` / `showDetails`, so ON = hidden = the default; the frozen rule reads the record: a hidden one can't be shown again), each switch with a short line (`guestCirclesHelper`, `HIDE_HELPER`), the frozen note; the **View-Only Link** (Share Link a full-width secondary `Button` through the native share sheet, Turn Off and Reset quiet rows behind alerts). 🔒 SAVED ON CHANGE, like You → Settings → Privacy (it replaced T9's Discard / Save): each change is ONE PATCH of that field, shown at once, one save at a time (a ref, synchronous), the served value back on a failure plus a re-read when the answer was not a refusal; no footer, so the pill shows there. Moment Setup (`settings/reveal.tsx`) saves on change the same way (Blind off also clears Blind for All locally, the server cascades it). Words in `lib/momentVisibilityCopy.ts`.
- Units: `scripts/tests/look-in-units.ts`, `look-in-compare-units.ts` (`check-vintage-units.yml`). ⚠️ **Device pass** (only the phone can prove): the plan's § 7.4 four lines.

### Moment Visibility step 3 (Incognito, Hide from Feed), as built 2026-11-24/25

Names and places (ruled 2026-11-25, R11–R13): "Only Inside This Moment" is called **Incognito** (the stored `onlyInside`) and is a setting of the MOMENT only (Moment Privacy), never a post's ⋯ row or status line. **Hide from Feed** works on moment posts too (the moment's choice, `moment_privacy.hidden_from_feed`: on Moment Privacy under Incognito, and the post's ⋯ row), and is the ONLY privacy row and line a post shows.

Plan: `.local/moment-visibility/step3-plan.md` (R1–R9, T1–T14). Server: `lib/postPrivacy.ts` (`lib/CLAUDE.md`). Dark behind `MOMENT_LOOKIN_ENABLED` (Only Inside) and `HIDE_FROM_FEED_ENABLED` (Hide from Feed): with a flag off its field never arrives, so no row shows.
- **Moment Privacy** (`settings/visibility.tsx`, R1, R12, R15): the section **Who Can See You** (`SetTitle`), first a block saying what YOUR account privacy allows (signed in; `ownAudienceBlock` over YOUR `/api/me/visibility`: a lead "Your account privacy settings limit who can see your participation without joining:", your setting ("Your Friends and Their Friends", the post audience core's rule gives, never fewer people than the truth; with an ⓘ after it holding step 3b's "Private Moment" note, `privateMomentNote`, phone look 2026-11-25), "No one (Incognito)" while Incognito, an Only Me variant with a note; Simon's structure, Codex's words) and the accent link **Change Account Privacy** (`SetNav bare accent icon="link"`). 🔒 The link opens your Privacy page ON THE MOMENT'S OWN STACK (`session/[code]/settings/my-privacy`, `PrivacySettings inMoment` titled "Account Privacy", without Blocked / Muted, which live on the You tab; mirrored on every session mount; router-sim `t23.cjs`; `dangerouslySingular`), so Back returns to Moment Privacy (device pass 2026-11-25: a push to `/you/settings/privacy` jumped tabs and Back landed elsewhere). Then the switches **Incognito** (helper: "Hides you and your post from everyone who hasn’t joined, even friends and followers.") and (signed in, `me.hiddenFromFeed` present) **Hide from Feed**, each with its line, for everyone in the moment, from the GET's `me` (hidden while `me` is null: no record). Saved on change through the page's one-save-at-a-time ref, `saveMe(field, value)`; the `me/privacy` answer is MERGED into `me` per field, never a replacement; then `applyMomentPrivacyToFeeds(…, field, …)` patches your posts of that moment. 🔒 An audience or link answer whose request left before a newer write of either choice (this page, or a post's ⋯ on any tab: both bump) keeps the `me` the page shows and re-reads once (`lib/postPrivacyState.ts` `privacyWriteGeneration` / `lateAnswerMe`). The page's prefetch: the line-up starts its read once the visit lands, so the settings hub's row draws with the others. Words in `lib/momentVisibilityCopy.ts`.
- **The ⋯ row** (R5, R12, R13): your own posts only, while `hiddenFromFeed` is present (a moment post or a check-in): `FeedCardMenu privacy` (cards) and the opened post's menu, "Hide from Feed" with a check while on (`MenuItem checked`), acting at once (`lib/postPrivacyActions.ts` `togglePostPrivacy`: the store first, the PATCH, every `['feed', …]` cache patched IN PLACE (`withPrivacy`, never invalidated), `['moment-visibility']` re-read for every field (a post carries no code; a moment post's Hide from Feed shows on Moment Privacy too, review 2026-11-25), your header marked stale; only a post's latest tap reconciles).
- **The status line** (R3, R13): `components/feed/PrivacyByline.tsx`, the struck-through eye + "Hidden from feeds" leading the small line under your name, on the card and the opened post, while on. Never "Incognito".
- 🔒 **The own-post store** (Codex r2): the opened post renders a PINNED copy the cache patch can't reach, so the check and the line read `effectivePrivacy` (the recorded value unless the post's copy came from a fetch that LEFT after the write: `privacyAt`, stamped by `getFeed` / `getFeedItem`). Cleared with the viewer cache. 🔒 A Moment Privacy write records per MOMENT too (`recordMomentPrivacy`), so a pinned copy no feed page holds still follows it; the newest record wins (post or moment). A write overtaken by another write of the SAME target while in flight (`writeSuperseded(target, gen)`: a check-in's field, or a moment's field, which its Moment Privacy page and its post's ⋯ share; `bumpTarget` at start and on landing, which also moves the page-wide generation) is recorded only as old as its request and every copy re-read, never published as news; a record never replaces a newer one; a queued tap re-checks the viewer before it goes out; the page's moment id is `me.sessionId` from the server (Codex 2026-11-25 + recheck).
- 🔒 **The impression page** (R4, T13, T14): NO new route files. A list row without a post you may open (`listRowTarget`, `lib/impressionRoute.ts`: Impressions by the row's id, Cravings by its `ratingId`) opens `r<ratingId>` on the post routes (`feedHref(mount, 'post', { id: 'r12', user })`: the `[id]` modal with the row's unfold on a tab stack, a `post/[postId]` card on a post's stack; `useOpenListImpression`, the read FIRST, then the push). The detail's IMPRESSION MODE (`isImpressionRouteId`): its id is never a number (`feedItemId` NaN, every registry guards `Number.isFinite`), `useFeedPost` and `useIsFeedPostDeleted` are OFF (an enabled read with a non-finite id would fall back to the owner's whole post list), the read is `['impression', owner, ratingId]` OUTSIDE `['feed', …]` (`impressionDetail` maps it into the standalone layout), no ⋯, no place, the author tap closes back onto the list. Without a valid `user` (cold, restored) or on a 404: "This impression isn’t available", no request. Router sim `t22.cjs` (33 checks; t0–t21 unchanged).
- Units: `scripts/tests/post-privacy-units.ts` (`check-vintage-units.yml`). ⚠️ **Device pass**: the plan's § 7 device list.

### Moment Defaults, as built 2026-11-25

`docs/dev/proposals/moment-defaults.md`; plan `.local/moment-visibility/moment-defaults-plan.md` § 3. Words in `lib/momentVisibilityCopy.ts` (§ Moment Defaults); pure parts in `scripts/tests/post-privacy-units.ts` § 9; router-sim `t24.cjs`.

- **Where they live** (Simon's split, 2026-11-25: "who can see you is a privacy setting, while who can see moments you created is a moment default"; no explanatory line anywhere: the titles say when, the alert the rest): Settings → **Moments & Check-Ins** (`you/settings/defaults.tsx`, the design's old "Tasting" row; later also the tasting defaults): the rows right on that page (no page one level deeper for now, Simon 2026-11-25): "Who Can See Moments You Create" with Visible To, the tasters' circle, Hide Location, Hide Description and Link; Settings → Privacy → **Hide Check-Ins from Feed** and **Hide Moment Posts from Feed** inside Post Visibility (the posts topics grouped, Simon 2026-11-25; helpers naming "your check-in posts" / "your moment posts") and a section **Joining or Creating Moments** (Incognito) after On My Profile; neither on the in-moment Account Privacy copy. The page has post-stack mirrors (`feed|you|moments/[id]/settings/`; `'defaults'` in `SettingsPage`). Rows: `components/moments/MomentPrivacyRows.tsx` (`HostPrivacyRows`, `YouPrivacyRows`; Create Moment's page uses both as `MomentPrivacyRows`, titled "Who Can See This Moment" / "Who Can See You", the only place with the account line). Saving: `lib/useMomentDefaults.ts` (shared): save on change, one at a time per screen. 🔒 After a save whose `existing` is not null, the native alert (D3) with THREE buttons (Simon 2026-11-25: a centred iOS alert never closes on a backdrop tap, "i miss exiting it"): **All N …** (one item: **Include Existing …**) runs the apply, **New … Only** keeps the existing ones, **Cancel** undoes the change (the old value saved back, no second alert); success is silent, a failure (a 429 included) the house error alert, and EVERY apply answer runs `afterDefaultsApply` (`lib/postPrivacyActions.ts`): the field's own-post records dropped and its apply time kept (`recordFieldApply`), every mounted feed list refetched in place, `['moment-visibility']` cancelled then invalidated, your header stale. An opened post's PINNED copy older than the apply re-reads its Hide from Feed once (`useApplyReread`, on focus and when the apply lands while focused; also after you left Settings). Concurrent changes elsewhere are not handled (ruled).
- **Create Moment → Privacy** (D4): a `ChoiceRow` "Privacy" under Blind Tasting, its value as the row's helper (line 1 the audience + circle, line 2 the whole phrases that fit, `FitPhrases` measuring them, an ellipsis when some are left out; never "Default"); shown once `['moment-defaults']` loaded (not loaded → no row and no `privacy`: the server applies them). It opens `…/moments/create-privacy` (Moment Privacy for this moment, local state), a SIBLING of each create mount (Moments, Feed, You; `momentCreatePrivacyHref`), the tab bar hidden there too; the state lives in `lib/createPrivacy.ts` keyed per create screen (seeded once, so a later defaults read never overwrites a change; cleared with the screen). The POST carries all six values (ruled).
- **The check-in rate stage**: a `ToggleRow` "Hide from Feed" under the rating, preset from the check-in default (only from a read of this screen), rendered once loaded; its value is in the draft (`CheckinDraft.hiddenFromFeed`, carried by `nextCheckinDraft` through stage 1) and always sent once shown. 🔒 Locked as sent from the moment the POST starts (`privacyLocked`, unlocked only by a definite refusal; `posting` makes a second rate stage of the flow wait), every async draft write bound to the occurrence that sent it (`writeOwn`); the draft store is subscribable. The composer's own two-flows-on-one-tab navigation is a named residual (plan § 8).
- **D1**: under a moment's date line (`OvcAbout status`, both layouts), while `me.onlyInside || me.hiddenFromFeed` (Moment Privacy's read, observed by the line-up): the struck-through eye + "Incognito" / "Hidden from feeds" / "Incognito · hidden from feeds" + an accent "Change" (the whole line opens Moment Privacy). Not on the look-in, not while a host edits in place.

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

- **Password re-auth prompts (Settings → Account).** Removing another
  device, Remove All Other Devices and Delete Account ask for the
  password through iOS's secure **`Alert.prompt`**, which Android lacks: there
  the per-device Remove buttons render disabled, and Remove All Other
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

- **Scan (Add Friends).** `CameraView.launchScanner` is VisionKit on iOS and
  the Google code scanner on Android, which dismisses itself on the first code
  of ANY kind (not only a Verre one) and never calls `dismissScanner`'s path:
  on Android a scanned foreign QR ends the scan instead of being ignored.
  Untested on Android; check the flow (and the shared camera permission
  string) when Android is tackled.

General rule: an iOS-only native primitive must leave a working (if reduced)
Android path AND a line here, so Android is a known punch-list, not a surprise.
