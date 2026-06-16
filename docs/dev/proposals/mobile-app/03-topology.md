# 03 — Codebase topology

**Status**: PROPOSED. Part of the [mobile-app meta-proposal](README.md). Settles *what to commit to now* and *what to deliberately defer* about how many UI codebases exist.

## 1. The question

We will have, eventually: an iOS app, an Android app, and a redesigned web UI — all over one backend. The topology question is: **how many UI codebases?**

- **One codebase** — an Expo app rendering to iOS + Android via React Native, and to web via React-Native-for-Web. Maximum sharing.
- **Two codebases** — one Expo app for iOS + Android (RN shares ~95% across the two natively), one separate web build for the redesigned web.

## 2. What we commit to now (and why it keeps the choice open)

We do **not** decide one-vs-two now ([meta-proposal O1](README.md#3-deferred-decisions-deliberately-open)). The web redesign is the *last* phase, so we'll have lived RN experience before committing. We commit only to the things that make *both* futures cheap:

1. **Extract framework-neutral logic into a shared package** ([00](00-shared-logic-extraction.md)). Both futures want it.
2. **Build the iOS app on Expo Router**, not bare React Navigation. This is the load-bearing "keep it open" move: Expo Router is the thing that makes React-Native-for-Web reachable later. If iOS ships on bare React Navigation and the web team arrives 6 months later wanting to share code, that sharing becomes a rewrite. Expo Router costs ~nothing extra now and preserves the one-codebase option.
3. **Next.js stays the API host** ([meta-proposal D5](README.md#2-locked-decisions)) regardless — see §3 for the honesty caveat.

This is the correction from the second review: **deferring the decision is NOT the same as deferring the setup.** Building iOS-first in a way that's agnostic to the web outcome requires Expo Router + the shared package *up front*. Skip those and you've silently chosen "two codebases" by making the one-codebase path a rewrite.

> **§2a status update (2026-06-12, milestone 3):** the "converge the web score
> inputs before extracting `useScoreSlider`" precondition below is **rescinded**
> by Simon's ruling: the web's hand-tuned touch behaviour stays untouched until
> the web redesign, and the native app uses gesture-handler's native intent
> detection (`activeOffsetX`/`failOffsetY`) instead of porting the web
> recognizer — so there is no shared recognizer hook to extract. Only the pure
> value policy shipped to `packages/core` (`scoringInput.ts`). The convergence
> question returns, if at all, at web-redesign time. The hook-tier guidance
> below stands for *policy*, not recognizers.

## 2a. The iOS↔Android split — the axis the user actually cares about (O5)

The README frames topology as one-vs-two *codebases* (the web axis). But part of the user's requirement is genuinely-different **iOS vs Android** UI (Apple theming + Apple-native widgets; Material + Android-native; Android back button). The multi-platform review's point: that axis needs a *mechanism*, decided during iOS. **One thing to commit, one thing to do opportunistically — and one thing auth is NOT:**

**Note — auth is NOT a per-platform divergence axis.** Social login is one `signIn.social({ idToken })` flow per provider behind the native sheets (`expo-auth-session` for Google, `expo-apple-authentication` for Apple); the button styling is leaf-level (Apple's HIG mandates its button on iOS), not a structural split, and the backend `resolveUser` seam is platform-agnostic. So drop "platform-specific auth front doors" from the headline divergence list — it's a leaf, not an axis.

1. **Commit: structural per-platform divergence uses platform file extensions, NOT runtime `Platform.select`.** Metro auto-resolves `Button.ios.tsx` / `Button.android.tsx` against a shared `Button.types.ts`. Leaf-level `Platform.select` (a color, a shadow) is fine; a component that's 60% `if iOS / if Android` is the spaghetti to avoid. This is a cheap structural *habit* to adopt now — it dictates how the iOS components are factored — so adopt it. (Accessibility is a fourth per-platform leaf that lives in these views: `accessibilityRole`/`accessibilityLabel` + VoiceOver vs TalkBack semantics differ — see [05](05-design-system.md).)
2. **Opportunistic, NOT mandated: extract interaction behavior as headless hooks where it falls out for free.** The three-tier idea — `packages/core` (pure logic) → behavior hooks → per-platform views — is right *in principle*, but at iOS-first / 2-user scale, mandating a hook for every gesture before Android exists is building Android infrastructure early. **The honest scope (multi-platform + efficiency reviews):**
   - The hook cleanly captures the **policy** — thresholds, snap points, "what haptic fires", the keyboard-step/`snap` math. Pull that into a hook/core where it's free (it often is for `useScoreSlider`).
   - The hook does **NOT** capture the hard part: the **commit-slide-gate orchestration** (`WineModal.tsx` `commitAndSwap` is ~95 lines welded to the framer-motion slide track + the single-flight gate held through the animation's `onComplete`) or the **pointer-recognizer wiring** (the horizontal-vs-vertical intent detection in `RatingPane`, written against `PointerEvent`/`setPointerCapture`). That machinery is **rewritten on the animation/gesture library per platform regardless** — it's view-layer, not hook-able.
   - So: Android reuses the gesture work because it's *also* RN/Reanimated (the RN-sharing win), **not** because of the hook. The hook is a smaller, additional win on the pure-logic slice. The genuine Android de-risk is the **plain-language interaction spec** owed from the design team (thresholds/snap/haptic triggers) — capture that now; it costs nothing and prevents reverse-engineering behavior later, hook or no hook.
   - **Precondition — a *sequenced step*, not a parenthetical:** the two score inputs aren't just drifted copies, they use **materially different gesture recognizers**: canonical `ScoreSlider.tsx` uses `touchAction: 'none'` + *unconditional* `setPointerCapture` + a full `role="slider"` keyboard handler; the inline `ScoreSection` in `RatingPane` uses `touch-action: pan-y` + *deferred SLOP-gated* capture (intent detection) + *no* keyboard handler. **Converge them onto the SLOP/pan-y recognizer** (it's the iOS-scroll-coexistence-correct one per `components/wine/CLAUDE.md`) **and port the canonical one's keyboard a11y** — *before* extracting any `useScoreSlider`, or extraction bakes in the wrong recognizer or loses a11y, and creates a third copy. Make this a numbered task in the iOS-build plan, not a note.
     - **A related split exists on the *flavour* input — but the a11y polarity is the OPPOSITE of the score widget, so don't assume the same fix.** Both `RatingPane`'s inline `FlavourBar` and the canonical `FlavorChips` have the pan-y/SLOP recognizer. On a11y, **`FlavorChips` is the *stronger* source** (a hidden native `<input type="range">` → real `role="slider"`, native arrow-key level adjustment, screen-reader value announcement), whereas `FlavourBar`'s `<button>` overlays only do Enter/Space toggle, no arrow-key level change, `pointerEvents:'none'`. So for flavour, the convergence target is **`FlavorChips`' range-input a11y** — the reverse of the score widget (where the canonical `ScoreSlider` has the keyboard handler and the inline `ScoreSection` lacks it). Net: converge each widget onto *its* best recognizer + best a11y, but verify which is which per widget — the score and flavour mirrors point in opposite directions.

## 3. "Next stays the API host" is true but undersells the coupling

The backend is API-first and server-authoritative, so keeping `app/api/*` as the single backend is right. But "pure API host" is not accurate — Next remains a stateful app server, and the apps must account for that:

- **`middleware.ts` (Edge runtime)** gates the SSR `/me` *pages* on cookie presence. (Correction from the first draft: it does NOT gate `/api/me/*` — those self-gate in the Node runtime, see [01](01-identity-and-auth.md) §5. So it's not an auth blocker for native, but it *is* Next-runtime machinery that proves Next isn't a thin gateway.)
- **`instrumentation.ts` / `instrumentation-node.ts`** run boot work (geo-data S3 seed/download; `app/CLAUDE.md` Edge-bundling note). The API host has a background seeder and a weekly geo refresh job — stateful boot, not a thin function.
- **`isSameOrigin`** (the mandatory first guard on every write route) is browser-origin-shaped and silently passes native ([01](01-identity-and-auth.md) §5). The "API host" has a CSRF layer that no-ops for the native caller class — a thing to reason about, not inherit blindly.
- **`/me` SSR layout + `/u/[id]` server components** call `auth()` / `resolveProfileViewer` at request time. These are *web* routes that get replaced by the Expo app over time — but until the web redesign, they coexist with the API on the same server.

None of this blocks the plan. It means: budget Next as "the existing app server, with its UI routes progressively hollowed out," not "a clean API gateway we lift the backend into." There is no backend lift — the backend stays where it is.

## 4. The RN-for-Web quality bet (do not assume parity)

If we eventually choose one-codebase (O1 → yes), the web renders via React-Native-for-Web. **This app's identity is its custom UI**, and that's exactly where RN-Web is least guaranteed:

- **SVG scoring widgets** (flavour radar/polar) — the *coordinate math* (`arcSeg`, `radiusForLevel`, the label-stacking in `renderLabel`) is genuinely portable and is the durable asset → it belongs in `packages/core`. **But the render layer is NOT "ports cleanly" as an earlier draft claimed:** the existing charts render via `dangerouslySetInnerHTML` with a hand-built SVG *string* (`components/charts/PolarChart.tsx:112`, `RadarChart.tsx:66`), which **does not exist in React Native** — `react-native-svg` needs real `<Path>` JSX elements. So it's "extract the geometry to core, **rewrite** the string-assembly into an element tree" — the same split as gestures, applied to charts. If the new design's `vero-scoring.js` also emits SVG strings (plausible — it's generated web code), the render layer is a rewrite, not a port. (One un-costed RN-Web delta: the web charts use the string as a `useMemo` perf shortcut; RN-Web via element trees loses it.)
- **`<ScoreSlider>` and the pull-to-swap wine modal** — the high risk, and **over-feared in the *wrong place*** (see [05](05-design-system.md) §4): the scar-tissue CSS (`touch-action`, `overscroll-behavior`, `svh`) is anti-Safari and mostly vanishes in RN. The *real* cost is the commit-slide-gate orchestration welded to framer-motion (rewritten on Reanimated) and the `runOnJS` thread boundary — see §2a. Rendered back to web via RN-Web, the gesture fidelity on *this specific interaction* is likely a regression, not just a tuning risk (RN-gesture-handler on web synthesizes pointer events and won't reproduce iOS Safari's native `pan-y` momentum). For the gesture surfaces specifically, plan web-specific overrides even under one codebase — or it strengthens the case for O1 → separate web.

**Honest expectation:** one-codebase is "less total work" for logic, forms, and lists — and a *quality bet* for this app's signature interactions, where a real web build might do better. Treat web-via-RN as something to validate on the actual scoring/gesture screens before betting the web redesign on it — not a freebie. This is a reason the decision is deferred to the web-redesign phase: by then iOS will have proven how those interactions feel in RN.

## 5. Monorepo / bundler-tooling burden (real, manageable)

One shared package consumed by two bundlers (Next's webpack/turbopack and Expo's Metro) will surface bundler disagreements. The codebase already shows this class of pain (the inlined-S3-copy webpack workaround; the Edge-bundling instrumentation foot-gun — both in the area CLAUDE.md files). Keep `packages/core` platform-pure and dependency-light so Metro (the stricter bundler) stays happy ([00](00-shared-logic-extraction.md) §5). Budget a round of "Metro rejects what webpack tolerated." Not a blocker; not free.

**Concrete first Metro task (carried from the shipped [00](00-shared-logic-extraction.md) §5 "As built"):** `packages/core` is already built and shipped, consumed by web as raw TS source (`exports` → `./src/index.ts`, no dist). That source-entry shape is the specific thing Metro is least likely to accept out of the box. When this workstream stands up the Expo app and first imports `@verre/core`, the opening move is the `metro.config.js` (`resolver.sourceExts` + `watchFolders` + maybe `unstable_enablePackageExports`) vs. add-a-`dist`-build decision — see 00 §5 for the full note. This is owned here, not in 00.

## 6. Recommendation

- **Now**: shared package ([00](00-shared-logic-extraction.md)) + Expo Router for iOS. Next stays the API host as-is.
- **Defer**: one-vs-two codebases until the web-redesign phase, by which point iOS has de-risked the RN-Web quality question on real scoring/gesture screens.
- **Never**: build iOS on bare React Navigation "to decide later" — that silently picks two-codebases by making one-codebase a rewrite.
