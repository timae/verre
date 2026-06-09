# 02 — Realtime for native

**Status**: PROPOSED. Part of the [mobile-app meta-proposal](README.md). The second review corrected the optimistic "version-cursor sidesteps push" framing — this doc keeps the cheap win, but is honest that polling is not realtime on native.

## 1. Today

`components/session/SessionShell.tsx` runs **three independent `useQuery` polls at `refetchInterval: 5000`** (verified):
- `['session-meta', C]` (line 180)
- `['wines', C, myId]` (line 187) — **note the `myId` in the key**: the wine view is viewer-dependent (blind redaction), so this response varies per viewer.
- `['ratings', C]` (line 217)

So each participant fires 3 requests / 5s. In a 20-person tasting that's ~12 req/s of pure polling against Redis-backed routes. On web in a tab it's a smell; on native cellular it's a battery + data complaint, and (critically) it **stops entirely when the app is backgrounded** because iOS suspends the JS runtime.

## 2. Step 1 — collapse 3 polls into 1 (ship anytime, helps web too)

Add `GET /api/session/:code/state` returning `{meta, wines, ratings}` behind a single query. Cuts request volume 3→1 with **zero new infrastructure**, and benefits the existing web app immediately. This part is unambiguously good; do it regardless of the rest.

**What collapsing costs (don't pretend it's free):**
- **Partial-failure isolation is lost.** Today if `ratings` 500s, `meta` and `wines` still render. One endpoint = one failure = blank session. Mitigate by building the aggregate to degrade gracefully (return the sub-objects that succeeded, null the one that failed) rather than all-or-nothing.
- **The aggregate is viewer-dependent and less cacheable.** Because `wines` is keyed on `myId` (blind redaction per viewer), the merged response must compute viewer-specific redaction *even when only ratings changed*. Per `app/api/CLAUDE.md`, viewer-dependent responses are already `private, no-store`, so there's nothing to cache anyway — but the point is the combined body is *bigger and per-viewer*, not smaller-and-shared. Collapsing reduces request *count*, not per-request work.
- **Payload size grows on big sessions** (meta + all wines + all ratings every 5s per participant). Step 2 is what bounds that.

**`/state` must COMPOSE the three handlers, not rewrite them — and "compose" is real work, because the handlers aren't factored yet.** The meta GET computes per-viewer `viewerBlocksOut/In` + sets `private, no-store`; the wines GET applies the per-viewer hideLineup gate + `redactWine` (blind/`blindForEveryone`); the live-session ratings come straight from Redis as already-numeric JSON (the `decimalToNumber` Decimal-coercion lives on the *Postgres*-backed read paths, not the live-ratings route — so `/state`'s live ratings inherit the correct number shape, no coercion needed there). Two of these three transforms are security-sensitive with silent failure modes (leak a block-pair; leak a blind wine identity). **The catch:** the three GET handlers are *monoliths* today (e.g. `wines/route.ts` inlines the hideLineup gate + `redactWine` + `wineToWire` directly in the route body), so "compose the inner functions" requires **first extracting those bodies into shared functions** — make that an explicit task, or `/state` re-derives them and risks dropping the blind/hideLineup gate (a data-exposure regression). The `/state` handler MUST call those extracted functions, never re-derive, and MUST set `Cache-Control: private, no-store` unconditionally. Treat `/state` as **composing extracted handler internals**, not as new logic.

## 3. The change-cursor — deferred, and probably not worth building at all

An earlier draft proposed a step 2: bump a Redis counter on every mutation, poll with `?since=<v>`, return "nothing changed" until it moves, to make idle polls cheap. **Reviewers (efficiency + regression) argued to cut it, and that's the call here.** Two reasons:

1. **No business case at current scale.** It only cuts *idle* poll cost (the hypothetical "12 req/s in a 20-person tasting"), a load level the app never hits at 2 users. It does nothing for the actual realtime gaps (§4).
2. **It's a latent staleness-bug generator.** There is **no mutation-version helper at all** to hook a cursor onto. `touchWithMeta` is *not* one — it's a TTL refresher (`EXPIRE`s session keys) with inconsistent coverage (it's called on some no-op-ish paths like `visit`, and *not* on `settings`/`bans`, which re-stamp TTLs inline instead). So a cursor can't piggyback on it; it would need a **new mutation funnel** routed through every write path (`mutateWines`-style) — itself a real refactor. And the mutations most likely to be missed (blind toggle, lifespan, roles, bans/kicks) are exactly the ones a live tasting must propagate; missing one is *silent* — that mutation type just stops being live, no error. **A stale blind-toggle is a data-exposure regression** (a wine that should now be redacted-for-everyone keeps showing un-redacted to clients that never re-fetch).

**Decision: cut the change-cursor from mobile-app scope.** Re-evaluate only if real sessions ever reach a participant count where poll volume matters — and even then, its hard prerequisite is a mutation-funnel refactor (route *all* session mutations through one helper that bumps the cursor, the way wine writes funnel through `mutateWines`), which is its own project. Keep step 1 (`/state` collapse), which is an unambiguous win for web today.

## 4. The honest part — polling is not realtime on native

**The mobile reviewer reframed which half of this actually matters.** The original worry was background suspension; the sharper point is that the core use case mostly doesn't hit it:
- **Background suspension is *masked* by foreground-resume refetch for this use case** — not "doesn't happen." Tasters stare at their phones (foregrounded); the host sometimes puts the phone down to pour, backgrounds, and misses ratings arriving — but the resume refetch (below) catches them up on pickup. So it doesn't need push; it needs the resume path to be solid.
- **Auth adds NO token-refresh hang surface here — a real simplification of the original Logto draft.** Better Auth uses an **opaque, DB-backed session cookie** (`@better-auth/expo` stores it in `expo-secure-store` and attaches it to requests) — there is **no client-side access-token refresh round-trip** before the first authed call, and the session **slides automatically** server-side on use (`updateAge`). So the cold-start/resume path doesn't wait on an SDK refresh, and there's no rotation/reuse-detection mid-session-logout class to mitigate. The native call just sends its cookie; if the session is expired/revoked the server 401s and the app routes to re-login. (Contrast: the old `@logto/rn` plan needed a hand-written single-flight `getValidToken()` wrapper around a lazy `getAccessToken()` refresh — that whole apparatus is gone.)
- **The real gap is reconnection robustness on bad signal** (cellars, restaurants). The plan must add, and the original draft omitted: **request timeouts** for the `/state` poll (RN `fetch` has *no* default timeout — a poll into a dead radio hangs ~30–60s on TCP; wire `AbortController`), **network-state awareness** (`@react-native-community/netinfo` → TanStack `onlineManager`, plus a "reconnecting" affordance), and a **single-flight guard** so a foreground-resume request storm doesn't fire N parallel refetches into a flaky reconnect.
- **Foreground-resume refetch** still needs `AppState → focusManager` wired explicitly (RN has no browser `visibilitychange`) — and debounce the iOS `active` transition (it fires for control-center/notification-shade pulldowns). Note the iOS `inactive` state too (app-switcher, incoming-call banner, **and the OAuth/login sheet itself**, which is in v1 per [06](06-ios-app.md) §1) sits between `active` and `background` — don't treat it as a real foreground/background flip.

**Net framing:** v1 native ships **foreground-realtime via the collapsed `/state` poll, hardened for reconnection**, and accepts that backgrounded clients aren't live. Push (§5) is the real backgrounded-realtime answer, deferred. Deplo.io's SSE/streaming uncertainty is a legitimate reason to sequence the streaming/push answer after iOS proves the foreground UX — not a reason to claim polling is sufficient for the backgrounded case.

## 5. Push notifications — a separate, from-scratch subsystem (NOT a mobile-app task)

"Push-driven invalidation" hides a large project. There is **no notification system** (only a stub) and **no email pipeline** in Verre today. Real push requires:
- **APNs (iOS) + FCM (Android)** — two different server-side senders, different credentials, different payload formats. Capacitor/Expo unify the *device-registration* JS API; the *server* must talk to both.
- **A device-token table** — register/store/revoke push tokens, tied to the session/identity so logout/revoke also drops the push token.
- **A notifications domain** — what events generate a notification, recipient resolution (must filter block-pairs — see the stub in `lib/userBlock.ts`), delivery, dedup, read-state.

This is its own proposal, sequenced after the apps exist. It is explicitly **out of scope** for the mobile-app workstreams ([meta-proposal §7](README.md#7-what-is-explicitly-not-in-scope-here)). When it lands, it doubles as both the realtime-while-backgrounded mechanism *and* the re-engagement channel — but do not let "realtime, later" smuggle a multi-week backend project into a mobile-app checkbox.

## 6. Sequencing

1. **Ship step 1 (collapse to `/state`)** — anytime, web + native both benefit. Compose the three existing handlers (§2), `private, no-store`.
2. **Harden the native poll for reconnection** — `AppState → focusManager` (with debounced `active`), `AbortController` timeouts, NetInfo + `onlineManager`, single-flight on resume. Mandatory for native (§4).
3. **Decide push vs SSE** *after* the iOS app demonstrates the live-session UX on a real device over cellular ([meta-proposal O3](README.md#3-deferred-decisions-deliberately-open)). Verify Deplo.io streaming support *before* committing to SSE.
4. **Change-cursor: cut** (§3) — not in mobile-app scope; revisit only at a participant scale that doesn't exist yet, and only behind a mutation-funnel refactor.
