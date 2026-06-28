# Native mobile apps — meta-proposal

**Status** (updated 2026-06-28): **backend auth foundation SHIPPED; iOS app well underway (milestones 1–4 + reveal/hide + impression CRUD merged), still pre-TestFlight.** `00` (shared-logic) and `01` (identity & auth — Better Auth, steps 1–7) are merged and live (dormant in prod — no native client ships yet). The iOS app (`02`–`06`) has shipped through M4: auth (email/password only), Moments home + create + settings, the session line-up, full scoring input, blind reveal/hide, and impression add/edit/delete. The big remaining pre-submission blockers are **social sign-in (Google/Apple, at-launch per D4/O4)**, **QR/Universal-Links join** (needs the paid Apple program), **in-app account delete**, and the `06` §6 store-submission gates; the other logged-in surfaces (feed, history, profiles, compare) are breadth. This is the index + the load-bearing decisions; each numbered sub-proposal owns one workstream. Per-workstream status:
- `00` shared-logic — ✅ shipped (`@verre/core`)
- `01` identity & auth — ✅ shipped/merged (PR #39); native social (step 6) deferred; see the doc's top status block
- `02` realtime — 🟨 steps 1–2 shipped (`/state` aggregate poll, web on it; native poll hardening — AppState→focusManager, NetInfo→onlineManager, fetch timeouts — landed with mobile milestone 2); push decision remains (O3)
- `04` API versioning — ✅ shipped with the first native client: `X-Verre-Client` header on every native call, structured 426 + blocking update screen in build #1, floor envs (`NATIVE_MIN_VERSION_*`, unset in prod) enforced at the native-auth chokepoint (`lib/clientVersion.ts`)
- `03` topology, `05` design system, `06` iOS app — 🟨 through **milestone 4 + reveal/hide + impression CRUD** (all merged to `main`): Moments home (02s live strip, join-by-code, recents), moment create + settings, session line-up (02b), full **scoring input** (gesture-handler Pan + haptics + editable number, M3), blind **reveal/hide** (host two-state mode, the collapsing-hero Dynamic Overlay), and impression **add / edit / delete** (host/cohost/own-provider, native Alert confirm; PR #55). `03` is effectively settled (shared `@verre/core` + Expo Router shipped; its one concrete task — web score-recognizer convergence — was **rescinded**, see its §2a). Flavour colours for the real FL sets still pending a design decision. **Not started**: feed/social surfaces, compare, history, profiles; **social sign-in (Google/Apple)**; QR/Universal-Links join; in-app account delete
- `07` Dynamic Type — ✅ phase-1 shipped: `FONT_SURFACES` + `phone.surface(...)`, hotspot migration, and a partial static gate; ongoing device checks still own visual layout intent
- Android phase, web redesign — ⬜ stubbed

## In plain English — what we're doing

We're turning Verre into real **iOS and Android apps** (then redesigning the website last), all running on **the same backend we already have**. The plan in a nutshell:

- **The apps are built with React Native (Expo)** — real native screens, not our website wrapped in a box — so they feel like proper iOS/Android apps. We're redesigning the look from scratch anyway, so there's no existing UI to "reuse" by wrapping it.
- **Logins get handled by [Better Auth](https://better-auth.com)** — a free, open-source login *library* (not a separate server) that runs *inside our existing backend* and uses *our existing database*. So there's **no new infrastructure** — no extra container, no second database. We use a proven library instead of building login plumbing ourselves, because rolling your own auth is how security holes happen. Crucially, it does **native Google/Apple sign-in** properly (our current web login, NextAuth, can't do that on a phone).
- **The app launches with email/password AND Google/Apple sign-in.** Test builds on our own iPhones can be email/password-only, but the **first App Store version ships with social login** — once you offer Google, Apple's rules require "Sign in with Apple" too, so we do both from launch.
- **The website keeps working** the whole time, on its current login (NextAuth), **untouched**. We do NOT rewrite the working web auth. The apps (and the eventual redesigned website) use Better Auth. Both share the *same user accounts* (one `users` table), so it's one identity per person — they're just two front doors into one house. The website gets only a few small, additive changes (the shared-logic package, a viewer-dependent `/state` aggregate endpoint, the `resolveUser` seam wrapping its auth, a static Universal-Links file). Running two login systems is a **deliberate permanent choice**, not a temporary hack — if the website is ever redesigned, it moves to Better Auth then.
- **The hard parts we've already worked through:** how the apps talk to the backend securely, the native Google/Apple flow, how to keep "live" wine-rating updates feeling instant, how iOS and Android share most code but still look native, and a long list of App Store gotchas. Each is its own short doc below. The login plan was stress-tested against real production data.
- **What's deliberately left for later:** push notifications and offline use. (Social login is NOT deferred — it's at launch.)

The rest of this file is the precise version of the above. Each sub-proposal (00–06) goes one level deeper on one topic.

---

This is the meta-plan for taking Verre from "responsive web app" to "native iOS + Android apps, plus an eventual web redesign" — over **one unified backend**. It captures the decisions we've settled, the ones we've deliberately deferred, and points at the per-workstream docs.

The conclusions here survived two independent skeptical reviews (an initial architecture challenge, then a second pass that challenged the *optimizations* from the first). Where a reviewer changed our mind, the sub-proposal says so. Read the sub-proposals before writing code — this index intentionally stays at the "what and why," not the "how."

## 1. Vision

- **One backend, many clients.** The existing Next.js `app/api/*` surface (51 routes, Postgres + Redis + S3) stays as the single source of truth. iOS, Android, and the future redesigned web all talk to it.
- **Native that feels native.** Genuine OS patterns (real share sheet, native gestures, haptics, platform theming), not a website in a box. This is why we land on **React Native (Expo)** over Capacitor — see §4.
- **Per-platform splits where they matter, shared everything else.** Same features, same navigation. Differences are theming (iOS vs Material), platform-native widgets, and the Android back button. *(Auth is **not** a divergence axis: with Better Auth, the Apple/Google buttons are one `signIn.social({ idToken })` flow behind the native sheets + leaf-level button styling, not a structural split — [03](03-topology.md) §2a.)* The expensive kind of divergence — different information architecture per platform — is explicitly *not* happening.

## 2. Locked decisions

These are settled. Reopen only with new information.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Apps are for registered users only. Anonymous tasting stays browser-only.** | Deletes the entire native-anonymous token-lifecycle problem. Anonymous exists for *zero-friction web walk-ups*; that friction argument barely applies once someone *already has* the app. See [01-identity-and-auth](01-identity-and-auth.md) §1. **Note**: the *not-yet-installed* dinner-table scanner still hits a sign-in wall in the app (vs instant anonymous on web) — reviewers flag this conversion cliff, see O4. |
| D2 | **QR scan routes via Universal Links (iOS) / App Links (Android).** App installed → opens the app into the session. Not installed → opens the browser → existing anonymous web join. | One QR, one `https://verre.app/join/<code>` URL, routes itself. In-app QR *scanning* is net-new (today we only generate). See [06-ios-app](06-ios-app.md) §Deep-linking. |
| D3 | **React Native (Expo), not Capacitor.** | We are redesigning *all* UIs from scratch, so Capacitor's one advantage — reusing the existing web UI — is void. The interaction logic is greenfield either way; native widgets + OS patterns come for free in RN. See §4. |
| D4 | **Auth = Better Auth (a TS library in the existing backend) for native + the redesigned web; NextAuth stays on the legacy web app, untouched, indefinitely.** **Email/password + Google/Apple social login ship together at the first App Store launch (social is NOT deferred).** | Social-at-launch is the deciding fact: NextAuth's Google/Apple providers are web-redirect-only (no native `id_token` path), so native social needs a library that supports it — Better Auth's `signIn.social({ idToken })` + first-party `@better-auth/expo`. It's a library (zero new infra: runs in our Next.js, uses our managed Postgres, no `CREATE ROLE`), and its default opaque DB-session matches Verre's existing `user_sessions.revokedAt` revocation model. Self-hosted-OIDC providers were rejected: Logto can't run on the cheap DB (`CREATE ROLE`), Zitadel has no Expo SDK + event-store growth, SuperTokens' OIDC is paid, Casdoor had unpatched auth-bypass CVEs. New-code-only: the working web auth is never rewritten; two systems share one `users` table as a deliberate permanent steady state. Spike-verified against real prod data. See [01-identity-and-auth](01-identity-and-auth.md). |
| D5 | **Next.js stays as the API host.** UI routes get replaced by the Expo app over time; `app/api/*` does not move. | The backend is already API-first and server-authoritative. No reason to rewrite it. Caveat: "pure API host" undersells the Next coupling that remains (Edge middleware, instrumentation boot, `/me` SSR) — see [03-topology](03-topology.md) §3. |

## 3. Deferred decisions (deliberately open)

| # | Decision | Why deferred | Decide by |
|---|---|---|---|
| O1 | **Does the redesigned web share ONE codebase with native (Expo Router + React-Native-for-Web) or stay a separate web build?** | We don't yet know how clean the RN components turn out, or whether web-specific needs (SEO, SSR, the SVG/gesture fidelity) fight RN-Web. Web redesign is the *last* phase, so we have lived RN experience before committing. | Start of the web-redesign phase. The thing we commit to *now* to keep both options cheap: extract framework-neutral logic into a shared package ([00](00-shared-logic-extraction.md)) and build the iOS app on **Expo Router** (so RN-Web stays reachable) rather than bare React Navigation. |
| O2 | **API versioning now, or not yet?** | The version handshake lets the native client (on Better Auth) and the legacy web (on NextAuth) evolve independently against one backend, so it moves earlier than the original "maybe later." The remaining open part is *how strict* (min-version gate timing). | The min-version gate + in-app update screen before the first external install. See [04-api-versioning](04-api-versioning.md). |
| O3 | **Realtime: stay on polling, or move to push/SSE?** | Polling (collapsed to one endpoint) is cheap to ship and de-risks the unknown of whether Deplo.io supports long-lived streams. But it is *not* real realtime on native (background suspension — though reviewers note everyone at a dinner is foregrounded, so reconnection robustness matters more than background). | After the iOS app proves out the live-session UX on a real device over cellular. See [02-realtime](02-realtime.md). |
| ~~O4~~ | **RESOLVED — Sign in with Apple (and Google) ship at the first App Store launch**, not a later phase. This is the deciding fact behind the D4 auth choice (it requires native social, which drove the Better Auth decision). Dev/test builds on the founders' own phones may be email/password-only. | Decided 2026-06-09. See [01](01-identity-and-auth.md) §1, [06](06-ios-app.md). |
| O5 | **iOS↔Android UI split mechanism** — runtime `Platform.select` vs platform-file-extensions (`.ios.tsx`/`.android.tsx`) + headless behavior hooks. | The user wants genuinely different per-platform widgets/theming. Reviewers warn that building iOS components as monoliths bakes in a refactor when Android arrives. The setup choice (extract gesture/scoring behavior as hooks during iOS) isn't deferrable even though Android ships later. | During the iOS build, not the Android phase. See [03-topology](03-topology.md) §2a, [05](05-design-system.md). |
| O6 | **3-target test matrix + per-platform a11y acceptance gates + divergent-bug ownership** — there's no test runner today (manual bash+curl), and the README sells a 3-target program (iOS→Android→web) with no rule for who QAs the matrix or verifies VoiceOver-vs-TalkBack / RN-Web gesture regressions. | Fine to defer for iOS-first v1 (one target, one a11y system, [06](06-ios-app.md) §7's "done" is the de-facto gate) — but it must be *named-deferred*, not silently absent, or it gets dropped exactly the way O5 warns "deferring the decision isn't deferring the setup." The shared `packages/core` + behavior hooks are the cheap unit-test anchor when it lands. | At the start of the Android phase. |

## 4. Why React Native, not Capacitor

The honest short version. Both wrap one backend; both get native share/camera/haptics via plugins. The difference is **who draws your screens**:

- **Capacitor** = your web UI in a WebView. Native-feel is something you *craft in CSS*; the OS patterns (native pickers, scroll physics, swipe-back) you re-create.
- **React Native** = real OS-drawn components from shared TS/React code. OS patterns come *for free*; you only spend effort on genuinely custom interactions.

Capacitor's decisive advantage is **reusing an existing web UI**. We are rebuilding every UI from scratch (the design handoff is new). That voids the advantage. Given the goal — "feels like a real iOS/Android app, uses patterns users know" — RN is the tool designed for that outcome.

**What this costs (stated plainly):** the existing 72 web components do *not* carry over; the *logic and the API* do. Same language (TypeScript/React), same mental model, but `<div>`→`<View>`, CSS→JS styles, and the app shell / navigation / data-fetching layer get rebuilt. The custom gestures (pull-to-swap) and SVG scoring widgets are re-implemented in RN's model — see [05-design-system](05-design-system.md).

This call is *defensible, not certain* — both reviewers agreed RN is reasonable here, and neither found a disqualifying flaw. If a constraint we don't know about anchors you to Capacitor (e.g. a dev who only knows web and zero appetite for RN), that legitimately reopens D3.

## 5. Sequencing

1. ✅ **[00 — Shared-logic extraction](00-shared-logic-extraction.md)** — SHIPPED (`@verre/core`). *Was the "do first" safe move.*
2. ✅ **[01 — Identity & auth](01-identity-and-auth.md)** — SHIPPED/merged (PR #39, 2026-06-10): Better Auth for native, new-code-only; NextAuth stays on web; the `identityStore` chokepoint + 2 CI gates; bcrypt/lazy-backfill bridge; native branch in `resolveUser`. Native social (step 6) deferred. Dormant in prod (no native client yet).
3. 🟨 **[02 — Realtime](02-realtime.md)** — step 1 shipped: the 3 polls collapsed into `GET /api/session/:code/state` (composed from `lib/sessionState.ts` builders; web switched). Native poll hardening lands with the iOS app; push decided later.
4. ⬅️ **[04 — API versioning](04-api-versioning.md)** — NEXT (with 02). Lets the native client (Better Auth) and legacy web (NextAuth) evolve independently against one backend; the in-app update screen must ship in build #1.
5. **[03 — Topology](03-topology.md)** — one-app-vs-separate; commit to Expo Router to keep O1 open; decide the iOS↔Android split mechanism (O5) during the iOS build.
6. **[05 — Design system](05-design-system.md)** + **[06 — iOS app](06-ios-app.md)** — the first shippable native deliverable.
7. ✅ **[07 — Dynamic Type](07-dynamic-type.md)** — PHASE 1 SHIPPED: scalable-container pass for user font-size settings; text keeps native scaling, containers follow the same surface cap. Static enforcement is partial by design; device validation remains the visual acceptance gate.
8. *Android phase* and *web-redesign phase* — stubbed later; not written until iOS proves the shape.

The platform order is **iOS → Android → web redesign**. Backend workstreams (00–04) are platform-independent and front-loaded.

## 6. The biggest risks (what the reviews surfaced)

Ordered by how badly they'd bite if ignored:

1. **The dual-store sync invariant is the load-bearing auth risk.** Native (Better Auth) and web (NextAuth) share one `users` table but have *separate* credential + session stores. A password change or "log out everywhere" must fan out to **both** stores, or native login goes stale / a revoked device survives. Mitigation: a single `lib/identityStore.ts` chokepoint (the only code allowed to write `password_hash`/`revokedAt`), CI-lint-enforced so drift is impossible, not just test-caught. Plus the account-deletion FK cascade (a missing `onDelete: Cascade` on Better Auth's tables 500s every web account delete) and the bcrypt hash+verify override (a `$2a/$2b` trap). [01](01-identity-and-auth.md) §3, §5–§6.
2. **A handful of hard security must-dos** that a config slip would re-open: 🔴 nOAuth account-takeover (`disableImplicitLinking` + pin `>=1.6.13` + the linking flags); 🔴 rate-limiting the new native login/social endpoints (Better Auth's default limiter is in-memory + bypassable → Redis-backed, design before shipping); `cookieCache` OFF (a CI test — it's a 2FA-bypass + never-cache-`auth()` violation); nonce on the native `id_token`; Apple `appBundleIdentifier`. Native sends no `Origin`, so the session is the sole trust anchor — never relax the web cookie's `SameSite`; never cache `pro`/`role`; scrub the session token + `viewerBlocks*` from the crash SDK. [01](01-identity-and-auth.md) §6.
3. **RN-Web is a web-quality bet for *this* app.** The SVG radar, `<ScoreSlider>`, and the documented load-bearing pull-to-swap CSS render through RN primitives, not hand-tuned DOM. Expect to re-tune. [03](03-topology.md) §4, [05](05-design-system.md).
4. **The iOS↔Android split is asserted, not designed.** The user wants genuinely different per-platform widgets; building iOS components as monoliths bakes in an Android refactor. Use platform-file-extensions + extract behavior as headless hooks *during* iOS. [03](03-topology.md) §2a (O5).
5. **"Realtime" via polling isn't live when backgrounded** — but reviewers note the core use case (a dinner) has everyone foregrounded, so **reconnection robustness on bad signal** (timeouts, NetInfo, single-flight) matters more than background suspension. Push remains the real backgrounded-realtime answer, deferred. [02](02-realtime.md) §3–4.
6. **The registered-only join funnel + the in-app update channel.** D1 puts a sign-in wall at the QR-scan moment — softened now that Google/Apple one-tap ship at launch (O4 resolved); and the min-version "please update" screen must be in the binary from build #1 (can't be retrofitted). [04](04-api-versioning.md).

## 7. What is explicitly NOT in scope here

- **Push notifications as a feature** — there is no notification *system* (only a stub) and no email pipeline. That's its own backend project (APNs + FCM + a notifications domain + a sender). [02](02-realtime.md) §5 scopes it; it is not a mobile-app task.
- **Offline tasting / sync** — tastings happen in cellars with bad signal, so native users will *expect* it, but offline write-replay against the `mutateWines` WATCH/MULTI concurrency model is a hard conflict-resolution design, not a cache. Flagged, not designed. Future proposal.
- **The Gastro / B2B surface.** Out of scope for the consumer apps.
