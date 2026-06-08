# 06 — iOS app (first native deliverable)

**Status**: PROPOSED. Part of the [mobile-app meta-proposal](README.md). The first shippable native target. Assumes [00](00-shared-logic-extraction.md) (shared package) and the [01](01-identity-and-auth.md) auth gates are settled; visual work can proceed in parallel against mocked auth.

## 1. Stack

- **Expo + Expo Router.** Expo Router keeps the one-codebase web option open ([03](03-topology.md) §2) and enables the file-extension per-platform split ([03](03-topology.md) §2a). Real OS components. **Custom dev client from day one, not Expo Go** — both `expo-camera` (QR) and `@logto/rn`'s native deps need a prebuild/dev-client. **Resolve the build posture explicitly** (the doc is cost-conscious everywhere else): EAS-managed credentials + EAS Build (budget the free-tier minutes — a dev-client iteration loop can exhaust them) **or** local prebuild (free, needs Xcode, but it's a *workflow fork* — generates a native `ios/` dir, config-plugin changes need re-prebuild). For 2 devs on macOS, local prebuild is the cheaper default.
- **`@logto/rn`** — Logto's first-party Expo SDK owns the auth flow + token lifecycle ([01](01-identity-and-auth.md)). Stores tokens in `expo-secure-store`. **Peer deps — confirm the exact set on install** (`npx expo install @logto/rn` resolves them; the SDK's `peerDependencies` is authoritative, NOT this doc): the core set is `expo-crypto` + `expo-secure-store` + `expo-web-browser` + `@react-native-async-storage/async-storage`, and likely also `expo-application` + `expo-constants`. Don't hard-exclude `expo-linking` — the Expo quick-start uses it for the redirect URI; install it (it's needed anyway for the `/join/*` deep-linking).
  - ⚠️ **Sign-in is a web redirect, even for email/password in v1** (the SDK's standard flow — confirm against the installed SDK): `signIn()` opens the system browser / `ASWebAuthenticationSession`; the user types credentials on Logto's hosted page; it redirects back to the custom scheme (`signIn('io.verre.app://callback')`). So **user-cancel handling** (the sheet rejects on swipe-away — return to the login screen cleanly, not an error toast) and the **durable pending-join-across-redirect** flow (§3) are **v1 concerns, not social-only**. Strike any "(when social lands)" qualifier on the redirect machinery.
  - The token is fetched **per API resource**: `getAccessToken('https://<verre-api-resource>')` returns the JWT for Verre's API. A *second*, resource-less `getAccessToken()` is needed to call Logto's Account API for self-service "log out my devices" ([01](01-identity-and-auth.md) §5a trap b).
- **TypeScript + React** — same language/mental model as the web app; logic ports, components rebuild.
- **`packages/core`** ([00](00-shared-logic-extraction.md)) for score validation (`validateScore`), Crockford codes, coercion (`decimalToNumber`), wire types.
- **TanStack Query** for server state. Harden for native reconnection — `AppState → focusManager`, `AbortController` timeouts, NetInfo + `onlineManager`, single-flight ([02](02-realtime.md) §4). Persist with `@tanstack/query-async-storage-persister` so cold-start shows last state instead of spinners.
- **Design**: `vero-tokens.js` → theme; `react-native-svg` for scoring widgets; gestures as headless hooks ([05](05-design-system.md), [03](03-topology.md) §2a).

## 2. Native plugins (real OS integration)

| Capability | Plugin | Notes |
|---|---|---|
| Share | `expo-sharing` / RN `Share` | Real iOS share sheet — same one-line call gives the genuine OS UI. |
| Camera + photo picker | `expo-image-picker` / `expo-camera` | Replaces web `<input type=file>`. Bottle photos + avatars. Server S3 pipeline (EXIF strip) unchanged — client still POSTs image data to our API. |
| QR scanning | `expo-camera` (barcode) | **Net-new** — today we only *generate* QR (`qrcode.react`), never scan. Scan a session code → join. Forces a dev client (§1). |
| Haptics | `expo-haptics` | Score slider, rating commit, join. ([05](05-design-system.md) §5.) |
| Secure token storage | `expo-secure-store` (via `@logto/rn`) | The Logto SDK owns the Keychain write. Prefer `SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY` (no iCloud sync — each device its own session), **but confirm the SDK lets you configure the accessibility level** — if it doesn't, you inherit its default, not your setting. **Do NOT use `requireAuthentication` on the token item**: the SDK reads the token on *every* `getAccessToken()`, so it would trigger Face ID on every API call — and break the background-resume refresh ([02](02-realtime.md) §4); it's also invalidated on passcode/biometric change. Keychain **survives app uninstall** — decide the reinstall-wipe policy. |
| Status bar / splash / safe area | `expo-status-bar`, `expo-splash-screen`, `react-native-safe-area-context` | Native chrome. Safe-area is a real port ([05](05-design-system.md) §3). |

## 3. Deep-linking (Universal Links) — [D2](README.md#2-locked-decisions)

The QR-at-dinner flow depends on this:
- A session QR encodes a normal `https://verre.app/join/<code>` URL.
- **App installed** → Universal Link opens the app straight into the session join.
- **App not installed** → the URL opens in the browser → existing anonymous web join.

**Setup required (more pitfalls than "host the file"):**
- Host **`apple-app-site-association`** at `https://verre.app/.well-known/apple-app-site-association` — **`Content-Type: application/json`, no redirect, no `.json` extension, reachable without auth.** ⚠️ The current `middleware.ts` matcher (`['/me/:path*']`) doesn't touch `/.well-known` — so the rule is **don't *broaden* the matcher to cover `/.well-known/*`** when wiring native (a common `'/((?!api|_next).*)'` broadening would catch it and silently break Universal Links). Scope the association to **exactly `/join/*`** (and genuinely app-owned routes) — **never a wildcard**, or the app intercepts every `verre.app` link (security surface). (Use the modern `components` array, not the legacy `paths` array — Apple accepts both, but current tooling/`?mode=developer` assumes `components`.)
- **Use a dedicated custom URL scheme (e.g. `io.verre.app://callback`) for the Logto OAuth redirect URI — NOT a `verre.app` Universal Link.** Logto's sign-in (in v1, for email/password — §1) opens an `ASWebAuthenticationSession` and redirects back; if that redirect is a `verre.app` Universal Link, the OAuth callback and the `/join/*` deep link compete for the same RN router and an auth-code-bearing URL can mis-route into the join handler (or vice-versa). A custom scheme keeps the two inbound-link namespaces disjoint (reviewer Finding, mobile). **The URL scheme (`io.verre.app`) is distinct from the iOS bundle identifier** — register the scheme in `app.json` (`scheme`) and make the redirect URI in the Logto Console **match it exactly** (a classic first-run break).
- **Apple fetches AASA via its CDN — changes take 24–48h to propagate.** Use the `applinks:verre.app?mode=developer` associated-domain variant on dev builds to bypass the cache, or you'll burn a day thinking config is broken when it's just cached.
- **Android App Links are NOT "same mechanism"** (corrected from an earlier draft): `assetlinks.json` needs the **exact signing-cert SHA-256**, and **Play App Signing re-signs your app** — so the fingerprint must be the *Play-managed* cert, not your upload cert (near-universal first-launch break). `autoVerify` failures fall back to the chooser silently. Budget real Android-phase time here.

**Security of the inbound join (reviewer Finding 5 — the deep link is an auth-routing surface, not cosmetic):**
- The `code` comes from a URL anyone can craft. The native handler MUST run it through the shared `validateCodeInput`/`normalizeCode` ([00](00-shared-logic-extraction.md)) **before any authed action** — same validation the web join route does.
- **Never silently auto-join** a logged-in user off a third-party link: show the session, require a tap to join (a confused-deputy guard). Carry root CLAUDE.md's invariant — *URL params are presentation-only, never authorize on them* — into the RN router.

**Cold-start authed-join flow (the highest-UX-risk path, reviewer Finding 5):**
- The link can arrive **before auth state is hydrated** (SecureStore read is async). **Buffer the pending deep link**, show a splash, resolve auth, *then* route — either into the session (authed) or login-with-return-to-join (not authed). Easy to drop the deferred link during the auth race.
- The pending join intent must survive the auth round-trip **durably** (not in-memory) — including if login bounces to Apple/Google's sheet and the app is backgrounded mid-OAuth.
- ⚠️ **D1 (registered-only) makes this strictly worse than web**: the same QR that instant-anonymous-joins on web hits a sign-in wall in the app, at the dinner table. This is the conversion-cliff argument for **Apple-at-launch (O4)** — at minimum the cold-start join screen needs one-tap Sign in with Apple, or the moment feels hostile.

## 4. Screen inventory (rebuild list)

The features and navigation match the web ([meta-proposal §1](README.md#1-vision)); only the back button differs (Android phase). Screens to (re)build in RN:

- **Auth (v1 = email/password only on Logto; social deferred, [01](01-identity-and-auth.md) §3)**: login (School-2 layout — buttons reserved for the later social phase), register, account deletion (must be in-app — Apple 5.1.1(v)). **Note: the RN login screen mostly *launches* the Logto web-redirect — the actual email/password form is Logto's hosted page (§1).** So **theme Logto's hosted sign-in page** (Console › Sign-in experience) to match Verre, or it looks like a different app mid-flow. Cosmetic for founders-only dev builds; do it before any external tester sees a generic Logto page inside Verre.
- **Sessions** (the core): session shell, the wine list (sole surface), the wine modal (info + rate panes — the pull-to-swap **orchestration** is a Reanimated rewrite, not the gesture *recognition*, [05](05-design-system.md) §4), compare view, join (via QR scan or deep link).
- **Logged-in surfaces**: `/me` dashboard, history, saved, profile, badges, feed, public profiles (`/u/<id>`), Hall of Fame.
- **Scoring widgets**: stars, flavour radar/polar, score slider — geometry math → core, **render layer rewritten** (SVG-string → `<Path>`, [05](05-design-system.md) §2), gestures + haptics native.

## 5. The hard dependencies (don't start authed screens until these land)

From [01](01-identity-and-auth.md) §7 — the v1 auth gates:
1. **Logto stood up** (Dockerfile in the Deplo.io project + dedicated Economy auth DB), **email/password only** for v1 (no social connectors yet, [01](01-identity-and-auth.md) §3).
2. **Schema: `passwordHash` nullable + provider-id binding column** ([01](01-identity-and-auth.md) §3a) — additive, so social drops in later with no migration.
3. **`resolveUser(req)` built** — cookie branch **delegates to unchanged `auth()`**; Logto branch does full access-token validation (jose: access-token-not-id-token, audience, issuer, alg, JWKS-`kid`-refresh) + the **Logto-sub→`users.id` mapping**; `Authorization`-present ⇒ Logto authoritative. Swapped into the ~44 `auth()` handlers (mechanical — the session routes feed it into `resolveIdentity`, so it returns the NextAuth `Session` shape). *(No Edge-matcher bounce for `/api/me` — that was a misread.)*
4. **The §5/§5a 🔒 invariants** in [01](01-identity-and-auth.md): fresh-uncached `pro`/`role` both paths; **two-layer revocation** so native logout-all is *instant* (Logto **grant-delete** via Management-API M2M + a per-user `revokedAfter` not-before gate in `resolveUser`); the **native→web revocation** mandate (a native password-change must revoke **both** stores); never relax the web cookie `SameSite`/CORS-credentials; crash-SDK scrubs by **key name** (`Authorization`, Logto tokens, password fields, `viewerBlocks*`, `viewerMutes`, gate `status`).
5. **API version handshake** ([04](04-api-versioning.md)) — boundary for native-on-Logto + legacy-web-on-NextAuth coexistence, plus the in-app update screen (§6).
6. **Release fence** (anchored to the first non-redeployable / TestFlight-external install, not the first dev `.ipa`): cookie auth demonstrably unbroken on the seam in prod, a Logto token round-trips staging, and the §5/§5a 🔒 invariants implemented + tested. Full clause in [01](01-identity-and-auth.md) §7.

**Unauthenticated/visual work that can proceed in parallel now**: the design-system port ([05](05-design-system.md)), the scoring widgets/hooks, navigation skeleton, and any anonymous-readable screens (HoF) against mocked data — and against Logto's email/password flow.

## 6. Store-submission gates (surface early — several cause crashes/rejections if missed)

**Which gates bite when** — the v1-on-our-own-iPhones strategy depends on this line being legible:
- **Bites at the FIRST DEV BUILD (your + Tim's phones):** the **permission usage strings** (missing = *crash* on camera invoke). The rest of the app — including the QR *camera scan* (just camera + a code, no entitlement) — runs fine on a free team. The one thing a free team blocks is **Universal-Links testing**: the **associated-domains entitlement needs the PAID Apple program** (a free team silently strips it), so the `https://` deep-link join can't be tested until you're paid (see Build & release). The **keychain-sharing entitlement** matters only if `requireAuthentication` is used (which §2 says *don't*).
- **Bites at the FIRST TESTFLIGHT-EXTERNAL build:** everything else below + a **Beta App Review** (1–2 day turn, *can* reject). This is also where the [04](04-api-versioning.md) "first cohort you can't force-update" line actually lands.

- **Permission usage strings** (`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`) — **missing = hard crash** the instant the camera/picker is invoked (not a rejection, an actual crash). Expo config plugins generate the keys; you must supply the copy.
- **`PrivacyInfo.xcprivacy` privacy manifest** — the current **#1 upload-rejection cause** for teams that haven't shipped recently, and separate from nutrition labels: a build-embedded file declaring required-reason API usage that **each SDK (Sentry, Expo modules) must supply** and you aggregate. Missing/incorrect = **rejected at upload**, before review. Don't conflate with the nutrition labels.
- **Privacy Nutrition Labels (App Store) + Data Safety form (Play)** — mandatory. Verre collects email, photos, user content (notes), diagnostics (Sentry). Declare all of it; wrong = rejection or post-launch takedown.
- **Export compliance** (`ITSAppUsesNonExemptEncryption=false` — HTTPS-only is exempt) — set in Info.plist or the **submit-for-testing/distribution** step blocks on a manual questionnaire (the upload itself succeeds). Trivial, universally forgotten.
- **App Tracking Transparency / IDFA** — probably exempt (no ad SDK), but **explicitly configure `@sentry/react-native` to not collect the IDFA** and declare "not tracking"; verify against the built `.ipa`'s privacy manifest.
- **In-app account deletion** — mandatory (backend exists: `lib/accountDelete.ts`); reachable without contacting support, *delete* not deactivate. (Relevant before any store submission, even though social/SIWA is deferred.)
- **Native Apple sheet (when SIWA lands)** — confirm `@logto/rn` triggers the *native* SIWA sheet, not a web Apple login inside ASWebAuthenticationSession (the latter is an App-Review 2.1 reject). Plus the Apple revoke-on-delete via Logto's management API ([01](01-identity-and-auth.md) §6). Both are "verify against live Logto."
- **Alcohol content** — both stores' alcohol age rating (17+); some regions geo-restrict/reject alcohol apps. The launch-market list is a build-config (availability matrix) decision, not just a rating toggle — decide early.
- **UGC moderation** — notes/photos/display names are user-generated; report/block required. Verre has block/mute/kick-ban (`docs/dev/block.md`, `docs/dev/kick-ban.md`) — surface in-app.
- **Crash reporting** (Sentry) — must be in v1, **configured with the key-name scrub** from [01](01-identity-and-auth.md) §5.

**Build & release story (not just the checklist):**
- **Custom dev client from day one, not Expo Go** — `expo-camera` (QR) *and* `@logto/rn`'s native peer deps need a prebuild/dev-client. Plan EAS Build minutes or local prebuild into the local-dev story. **Install every native lib with `npx expo install` (not `npm install`)** — Expo SDK has New Architecture (Fabric) on by default now, and mismatched versions of `react-native-svg`/`gesture-handler`/`reanimated` **crash or fail to build** under Fabric (reanimated hard-errors on a version/Babel mismatch — it also needs its **Babel plugin** configured, which §4/§5's pull-to-swap rewrite leans on); `expo install` pins New-Arch-compatible versions.
- ⚠️ **The paid Apple Developer Program is required *even for the first dev build* if you want to test the QR/Universal-Links join.** A **free personal team** gives 7-day dev builds but **silently strips the associated-domains entitlement** — so Universal Links don't work and a scanned QR opens Safari instead of the app. You'll build, install, scan, and burn a day before realizing it's the free-team entitlement strip, not your AASA. Enroll in the paid program **early** (~$99/yr; org accounts need D-U-N-S verification, days of lead time); the associated-domains + keychain-sharing entitlements bake into the provisioning profile, so adding them later forces a credential regen.
- **TestFlight external testing needs a Beta App Review** (1–2 day turnaround, *can* reject) — it's not the free internal channel. Internal testers (≤100, no review) vs external (≤10k, review) changes how the "first cohort you can't force-update" line in [04](04-api-versioning.md) is staged. (First builds here are dev-provisioned to the developers' own devices — neither channel — so this bites only at the TestFlight step.)
- **OTA discipline** ([04](04-api-versioning.md) §3a) — EAS Update ships JS-only fixes without review, NOT native changes/feature-purpose changes. **Pin `runtimeVersion` to a fingerprint policy** (`expo-updates` fingerprint), NOT `"appVersion"`/`"sdkVersion"`: otherwise a JS bundle can land on a binary whose native modules don't match it and **brick every install on launch**. Without the fingerprint pin, the "OTA softens force-update" argument is a loaded gun.

## 7. Definition of "iOS phase done"

- Registered users can: log in (Logto), join a session (QR scan or deep link, via the buffered cold-start flow), rate wines with the full scoring UI + haptics, see others' ratings (foreground-realtime via the hardened `/state` poll), use the logged-in surfaces, manage their account (incl. in-app delete) and devices.
- Universal Links route installed/not-installed correctly; the deep-link join re-validates the code and never silent-auto-joins.
- Crash reporting live (with auth/`viewerBlocks*` scrubbing); permission strings, privacy labels, export-compliance, alcohol rating, UGC moderation all cleared.
- The three auth 🔒 invariants ([01](01-identity-and-auth.md) §5) implemented, not just documented.
- API version handshake + in-app update screen present in the build.

The Android phase reuses much of this (RN shared) plus: App Links + `assetlinks.json` (Play-managed signing cert — not "same mechanism" as iOS), the hardware back button, Material theming + the `.android.tsx` view split ([03](03-topology.md) §2a), Google sign-in (→ SIWA mandatory on iOS at that point), FCM if push has shipped, and Chromium-WebView/gesture parity QA. Written up when iOS proves the shape.
