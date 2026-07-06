# 04 — API versioning

**Status**: PROPOSED. Part of the [mobile-app meta-proposal](README.md). The first review flagged the *absence* of versioning as the top gap after auth; the second review argued the fix is bigger than "a header and a guard" and that "not yet" may be the right call at current scale. This doc holds both: why it matters, why it's not cheap, and the proposed sequencing.

## 1. Why it suddenly matters (it didn't before)

On the web, the client and the API **deploy together**. Any of the 51 routes can change response shape freely, because the only client is the one that just shipped with the change. There is **no API versioning anywhere** in the codebase today (grep: no `/v1`, no version header, no min-version gate) — and that has been *correct* for a web-only app.

A native binary breaks this assumption permanently:
- **Old app versions keep calling your API for months.** Users don't update; you cannot force them.
- **A breaking response change silently breaks installed apps.** Examples specific to Verre: the `Decimal`→`Number()` score coercion (root CLAUDE.md), adding a required field, or — the dangerous case — *removing/reshaping* a field. The score-as-string trap is exactly the kind of change that an old app would mis-handle without any server error.

So the moment a binary is in TestFlight/the App Store, "additive-only or you break users" becomes a real constraint.

## 2. Why it's NOT just "a header and a guard" (reviewer correction)

The header + min-version gate is the cheap 5%. The expensive 95%:

- **Additive-only-forever collides with Verre's security-shaped payloads.** Several responses are viewer-dependent and security-sensitive (`viewerBlocksOut/In`, profile-gate `status`, redacted wines; `app/api/CLAUDE.md`). Sometimes the *correct* fix is to **remove or reshape** a field (e.g. a privacy fix that stops leaking something). An additive-only contract forbids that without a version bump — which reintroduces per-route version skew across 51 routes. "Just add fields, never remove" is not always compatible with "fix the leak."
- **A min-version gate implies an upgrade channel you don't have.** "Force update" means *telling* the client to update — but there's no push, no email pipeline ([02](02-realtime.md) §5). In practice a min-version gate today means "we hard-break old installs and they discover it by erroring." That's a product/UX decision (a blocking "please update" screen in the app), not a server header.
- **Per-route skew leaks the abstraction.** If only some routes change, "the API is on v2" stops being true uniformly. Either clients track per-route versions (complex) or the whole surface versions in lockstep (simple to reason about, expensive to evolve). Neither is one-line.

## 3. The upgrade-channel reality

The cheapest *correct* version story for a native app is a **min-supported-version handshake**:
- Client sends its version (e.g. `X-Verre-Client: ios/1.4.0`).
- Server compares against a configured floor; if below, returns a structured "update required" response the app renders as a blocking screen with an App Store link.
- Above the floor, additive-only discipline keeps older-but-supported versions working.

This needs: the client to *send* its version, the app to *handle* the update-required response gracefully (a real screen, not a crash), and an operator control to set the floor. The blocking screen **is** the upgrade channel — it works without push/email, which is why it's the realistic mechanism here.

## 3a. OTA (EAS Update) changes the math — and the version header must report it

The mobile reviewer flagged a real omission: **Expo's EAS Update ships JS/asset-only changes over-the-air without App Store review.** This materially softens the "old versions call for months" premise — a *client-side* fix (e.g. handling a reshaped API field) can often be pushed in hours, not waited out. But it comes with hard limits the plan must internalize:

- **OTA can ship**: JS, styles, assets, bug fixes, content. **OTA cannot ship**: native code — new native modules, permission strings, `app.json`/Info.plist changes, Expo SDK upgrades, new config plugins. Adding `expo-camera`, the push module, or changing the deep-link entitlement = **store submission required.** The team must hold the native-vs-JS line or they'll plan an OTA for something that can't be OTA'd.
- **OTA has a review-compliance rule**: Apple permits JS OTA updates only if they don't *materially change the app's purpose/features* beyond what was reviewed. Keep OTA for fixes/tweaks; gate features behind store builds.
- **Consequence for the version header**: an OTA update changes JS but not the native build number. So `X-Verre-Client` must report **both** the native runtime version **and** the OTA update id — a single `ios/1.4.0` string is insufficient once OTA is in play, because the floor logic must be able to distinguish an OTA-patched client from a stale binary.
- **Safety mechanism (the loaded gun):** pin `runtimeVersion` to a **fingerprint policy** (`expo-updates` fingerprint), NOT the common `"appVersion"`/`"sdkVersion"` defaults. The fingerprint makes the client **refuse** an OTA bundle whose native requirements don't match the installed binary, instead of accepting it and crashing on launch. Without this, an OTA that assumes a native module the binary lacks bricks every install — which would turn the "OTA softens force-update" argument into the opposite of a safety net. ([06](06-ios-app.md) §6.)

## 4. Recommendation: versioning co-arises with the native client, and the client screen ships in build #1

The original "maybe not yet" framing is **superseded** — but precisely. The auth *routing* fork keys on **which auth system validates the request** (`resolveUser`: native → Better Auth session, web → NextAuth `auth()`), not the version header, so versioning is **not a literal prerequisite** of the native auth work. Rather: the native client is the first thing that **creates a second, independently-deployed client generation**, and *that* is what makes versioning load-bearing (response-shape decisions + a force-update floor once a client you can't redeploy exists). So they **co-arise** — ship the version boundary alongside the native client, not as a gate it waits on. What's still right-sized vs over-built:

- **Now (prerequisite)**: establish the version boundary — **send `X-Verre-Client` (native version + OTA id, §3a) from day one**, and define how the API distinguishes client generations. This is what the native-on-Better-Auth + legacy-web-on-NextAuth coexistence rides on.
- **In iOS build #1 (NOT "before external install" — earlier)**: the **in-app update-required screen must ship in the first binary.** The migration reviewer's sharp point: the screen can't be retrofitted server-only, so if the first external build lacks it, the first cohort is the one you can't force-update — the exact failure this prevents. The server can *ignore* the floor initially, but the client must already *speak the protocol* from build #1. (Server-side floor enforcement can still wait until the first non-lockstep external tester.)
- **Ongoing, once external installs exist**: additive-only-by-default as a *review check*, with the explicit escape hatch that a security fix may reshape a field and bump the floor (forcing an update) when leaving the old shape would leak. Additive-only is not absolute for a privacy-shaped API.

**Decide server-side floor *enforcement* timing by**: the first build on a device you can't force-redeploy ([meta-proposal O2](README.md#3-deferred-decisions-deliberately-open)). But the **client capability ships in build #1 regardless.**

## 5. What this is NOT

Not a REST `/v1/` URL restructure of 51 routes. Not a parallel v2 surface. The proposal is: a client-version header (now, ignored), a min-version floor + update screen (before external installs), and additive-by-default-with-a-security-escape-hatch as a discipline (once it matters). The smallest thing that prevents silently bricking installed apps.

## 6. Known breaking-change instances awaiting the floor

Concrete cases of §1's "adding a required field" that already shipped to the server and would 400 a stale native binary once one exists. Harmless today (app dormant in prod, no external install), but each is a reason the min-version floor + update screen must land **before the first TestFlight upload** — add a gate on these routes at that point.

- **`POST /api/session` now requires `sessionName` + `dateFrom`** (2026-07-06). An old binary that omits either gets a bare 400, not a graceful 426/update prompt. Release-fence item: bump `app.json` `version` and gate create on the min-version floor before external installs.
