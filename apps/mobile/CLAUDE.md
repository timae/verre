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
  plain gradient, no blur) — all pinned from `bundledNativeModules.json`;
  re-run `npx expo run:ios` after pulling.
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
- Typecheck: `npm run typecheck -w mobile`. Root `tsconfig.json` excludes
  `apps/` — the app typechecks with its own config only.
