# Native mobile apps — meta-proposal

**Status**: PROPOSED / not started. This is the index + the load-bearing decisions; each numbered sub-proposal owns one workstream. Nothing here has shipped.

## In plain English — what we're doing

We're turning Verre into real **iOS and Android apps** (then redesigning the website last), all running on **the same backend we already have**. The plan in a nutshell:

- **The apps are built with React Native (Expo)** — real native screens, not our website wrapped in a box — so they feel like proper iOS/Android apps. We're redesigning the look from scratch anyway, so there's no existing UI to "reuse" by wrapping it.
- **Logins get handled by Logto**, a free, open-source login system we run **on our own servers** (one small extra container next to Verre + ~CHF 5/mo for its database — the container's own running cost is a second small line to confirm on the Deplo.io plan). Nothing about logins goes to an outside company. We use Logto instead of building login plumbing ourselves, because rolling your own auth is how security holes happen.
- **Version 1 is email + password only.** "Sign in with Google/Apple" comes *later*, after the app itself works. The first test builds run on our own iPhones (Simon's + Tim's), not the App Store yet — so the App Store rules (like "must offer Apple login") don't apply yet.
- **The website keeps working** the whole time. It stays on its current login (NextAuth); only the new apps (and the eventual redesigned website) use Logto. The two coexist cleanly behind a version check. (It's not literally *untouched*: the web app gets a few small, additive, reversible changes — the shared-logic package, a viewer-dependent `/state` aggregate endpoint that *composes existing handlers* (security-shaped, not throwaway), the `resolveUser` seam wrapping its auth, and a static Universal-Links file at `/.well-known/` — but its *UI* isn't rebuilt until the last phase.)
- **The hard parts we've already worked through:** how the apps talk to the backend securely, how to keep "live" wine-rating updates feeling instant, how iOS and Android can share most code but still look native to each, and a long list of App Store gotchas. Each of those is its own short doc below.
- **What's deliberately left for later:** social login + linking accounts, push notifications, and offline use. None block v1.

The rest of this file is the precise version of the above. Each sub-proposal (00–06) goes one level deeper on one topic.

---

This is the meta-plan for taking Verre from "responsive web app" to "native iOS + Android apps, plus an eventual web redesign" — over **one unified backend**. It captures the decisions we've settled, the ones we've deliberately deferred, and points at the per-workstream docs.

The conclusions here survived two independent skeptical reviews (an initial architecture challenge, then a second pass that challenged the *optimizations* from the first). Where a reviewer changed our mind, the sub-proposal says so. Read the sub-proposals before writing code — this index intentionally stays at the "what and why," not the "how."

## 1. Vision

- **One backend, many clients.** The existing Next.js `app/api/*` surface (51 routes, Postgres + Redis + S3) stays as the single source of truth. iOS, Android, and the future redesigned web all talk to it.
- **Native that feels native.** Genuine OS patterns (real share sheet, native gestures, haptics, platform theming), not a website in a box. This is why we land on **React Native (Expo)** over Capacitor — see §4.
- **Per-platform splits where they matter, shared everything else.** Same features, same navigation. Differences are theming (iOS vs Material), platform-native widgets, and the Android back button. *(Auth is **not** a divergence axis: with Logto, the Apple/Google buttons are provider connectors behind one SDK flow + leaf-level button styling, not a structural split — [03](03-topology.md) §2a.)* The expensive kind of divergence — different information architecture per platform — is explicitly *not* happening.

## 2. Locked decisions

These are settled. Reopen only with new information.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Apps are for registered users only. Anonymous tasting stays browser-only.** | Deletes the entire native-anonymous token-lifecycle problem. Anonymous exists for *zero-friction web walk-ups*; that friction argument barely applies once someone *already has* the app. See [01-identity-and-auth](01-identity-and-auth.md) §1. **Note**: the *not-yet-installed* dinner-table scanner still hits a sign-in wall in the app (vs instant anonymous on web) — reviewers flag this conversion cliff, see O4. |
| D2 | **QR scan routes via Universal Links (iOS) / App Links (Android).** App installed → opens the app into the session. Not installed → opens the browser → existing anonymous web join. | One QR, one `https://verre.app/join/<code>` URL, routes itself. In-app QR *scanning* is net-new (today we only generate). See [06-ios-app](06-ios-app.md) §Deep-linking. |
| D3 | **React Native (Expo), not Capacitor.** | We are redesigning *all* UIs from scratch, so Capacitor's one advantage — reusing the existing web UI — is void. The interaction logic is greenfield either way; native widgets + OS patterns come for free in RN. See §4. |
| D4 | **Auth = self-hosted Logto for native (and the redesigned web); NextAuth stays on the legacy web app.** **v1 is email/password only; social login (Apple/Google) is deferred to a later phase.** | "Don't hand-roll auth, use standards" → adopt a standards OIDC provider rather than build token issuance on NextAuth. The honest justification is "won't hand-roll token issuance" (the existing revocation gate already substitutes for rotation), not "need rotation." Self-hosted/free/OSS satisfies no-external-provider + no-cost. First builds are dev-provisioned to our own iPhones, so Apple's SIWA rule doesn't bite yet. See [01-identity-and-auth](01-identity-and-auth.md). |
| D5 | **Next.js stays as the API host.** UI routes get replaced by the Expo app over time; `app/api/*` does not move. | The backend is already API-first and server-authoritative. No reason to rewrite it. Caveat: "pure API host" undersells the Next coupling that remains (Edge middleware, instrumentation boot, `/me` SSR) — see [03-topology](03-topology.md) §3. |

## 3. Deferred decisions (deliberately open)

| # | Decision | Why deferred | Decide by |
|---|---|---|---|
| O1 | **Does the redesigned web share ONE codebase with native (Expo Router + React-Native-for-Web) or stay a separate web build?** | We don't yet know how clean the RN components turn out, or whether web-specific needs (SEO, SSR, the SVG/gesture fidelity) fight RN-Web. Web redesign is the *last* phase, so we have lived RN experience before committing. | Start of the web-redesign phase. The thing we commit to *now* to keep both options cheap: extract framework-neutral logic into a shared package ([00](00-shared-logic-extraction.md)) and build the iOS app on **Expo Router** (so RN-Web stays reachable) rather than bare React Navigation. |
| O2 | **API versioning now, or not yet?** | The version handshake is now a **prerequisite of the Logto split** (it's what lets legacy-web-on-NextAuth and native-on-Logto coexist), so it moves earlier than the original "maybe later." The remaining open part is *how strict* (min-version gate timing). | The min-version gate + in-app update screen before the first external install. See [04-api-versioning](04-api-versioning.md). |
| O3 | **Realtime: stay on polling, or move to push/SSE?** | Polling (collapsed to one endpoint) is cheap to ship and de-risks the unknown of whether Deplo.io supports long-lived streams. But it is *not* real realtime on native (background suspension — though reviewers note everyone at a dinner is foregrounded, so reconnection robustness matters more than background). | After the iOS app proves out the live-session UX on a real device over cellular. See [02-realtime](02-realtime.md). |
| O4 | **Sign in with Apple at launch, or a later phase?** | D1 (registered-only) puts a sign-in wall at the QR-scan-at-dinner moment. Mobile + multi-platform reviewers argue one-tap Apple-at-launch is needed or that moment feels hostile; Logto makes it cheap to enable. A funnel/product call, not architecture. | Before the iOS app's join flow is finalized. See [01](01-identity-and-auth.md) §6, [06](06-ios-app.md). |
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

1. **[00 — Shared-logic extraction](00-shared-logic-extraction.md)** — *do first, independent of everything.* Zero security surface, immediate web benefit, unblocks the topology question. Every reviewer's #1 "safe move."
2. **[01 — Identity & auth](01-identity-and-auth.md)** — adopt self-hosted Logto (provider owns the token lifecycle); build the cookie-or-Logto-token `resolveUser` seam across ~44 handlers with its hard invariants. Must be settled before any authed native screen. Smaller than the original draft feared — no token system to build, no Edge fork (that was a misread).
3. **[02 — Realtime](02-realtime.md)** — collapse the 3 polls (ship anytime); decide push later.
4. **[04 — API versioning](04-api-versioning.md)** — now a **prerequisite of the Logto split** (lets legacy-web + native coexist); the in-app update screen must ship in build #1.
5. **[03 — Topology](03-topology.md)** — one-app-vs-separate; commit to Expo Router to keep O1 open; decide the iOS↔Android split mechanism (O5) during the iOS build.
6. **[05 — Design system](05-design-system.md)** + **[06 — iOS app](06-ios-app.md)** — the first shippable native deliverable.
7. *Android phase* and *web-redesign phase* — stubbed later; not written until iOS proves the shape.

The platform order is **iOS → Android → web redesign**. Backend workstreams (00–04) are platform-independent and front-loaded.

## 6. The biggest risks (what the reviews surfaced)

Ordered by how badly they'd bite if ignored:

1. **The auth seam is wide but mechanical — the risk is a few correctness rules, not 44 edits.** The `resolveUser` swap touches ~44 handlers, but it's a same-shape find-replace (the session routes feed it into `resolveIdentity`, so it returns the NextAuth `Session` shape, untouched trust model). The *real* risk is concentrated in: the **Logto-sub→`users.id` mapping** (or `Number(session.user.id)` → `NaN` in 30+ handlers), full **access-token validation**, the **cookie+bearer precedence rule**, the **two-layer revocation** (Logto grant-revoke + a not-before gate so native logout-all is *instant*, [01](01-identity-and-auth.md) §5a), and the **native→web revocation gap** (a native password-change must still revoke web sessions). [01](01-identity-and-auth.md) §5–5a. *(Corrections from review: not a "structural Edge fork" — the matcher gates `/me` pages, not `/api/me`; the social account-linking takeover risk is deferred since v1 is email/password only, but the **NextAuth↔Logto same-email account-fork** is a v1 issue closed by seeding the 2 users at cutover, §3b.)*
2. **The native security posture is deliberate, not accidental.** Native sends no `Origin`, so `isSameOrigin` correctly passes and the Logto token is the sole trust anchor — which means: never relax the web cookie's `SameSite`; never cache `pro`/`role` (paid-tier bypass); scrub the bearer token + `viewerBlocks*` from the crash SDK. [01](01-identity-and-auth.md) §5.
3. **RN-Web is a web-quality bet for *this* app.** The SVG radar, `<ScoreSlider>`, and the documented load-bearing pull-to-swap CSS render through RN primitives, not hand-tuned DOM. Expect to re-tune. [03](03-topology.md) §4, [05](05-design-system.md).
4. **The iOS↔Android split is asserted, not designed.** The user wants genuinely different per-platform widgets; building iOS components as monoliths bakes in an Android refactor. Use platform-file-extensions + extract behavior as headless hooks *during* iOS. [03](03-topology.md) §2a (O5).
5. **"Realtime" via polling isn't live when backgrounded** — but reviewers note the core use case (a dinner) has everyone foregrounded, so **reconnection robustness on bad signal** (timeouts, NetInfo, single-flight) matters more than background suspension. Push remains the real backgrounded-realtime answer, deferred. [02](02-realtime.md) §3–4.
6. **The registered-only join funnel + the in-app update channel.** D1 puts a sign-in wall at the QR-scan moment (O4); and the min-version "please update" screen must be in the binary from build #1 (can't be retrofitted). [01](01-identity-and-auth.md) §6, [04](04-api-versioning.md).

## 7. What is explicitly NOT in scope here

- **Push notifications as a feature** — there is no notification *system* (only a stub) and no email pipeline. That's its own backend project (APNs + FCM + a notifications domain + a sender). [02](02-realtime.md) §5 scopes it; it is not a mobile-app task.
- **Offline tasting / sync** — tastings happen in cellars with bad signal, so native users will *expect* it, but offline write-replay against the `mutateWines` WATCH/MULTI concurrency model is a hard conflict-resolution design, not a cache. Flagged, not designed. Future proposal.
- **The Gastro / B2B surface.** Out of scope for the consumer apps.
