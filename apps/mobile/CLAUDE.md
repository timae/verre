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
  `X-Verre-Client` header + the 426 update-required handshake). Never bare
  `fetch` against the backend.

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
