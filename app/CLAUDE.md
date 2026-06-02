# app/ — Next.js App Router

Local rules for `app/*` route segments and pages. Root CLAUDE.md still applies; this is overlay context for the frontend route layer.

## Stack

Next.js 15 App Router. UI lives under `app/` (route segments) and `components/`.

## Top-level routes

- `/` — lobby (`app/(public)/page.tsx` → `LobbyClient`)
- `/login`, `/register` — NextAuth credentials flows
- `/me` and subpaths — logged-in dashboard, history, saved, profile, badges, account, feed
- `/session/<code>` — in-session shell (`SessionShell` provides context). Redirects to `/wines`.
- `/session/<code>/wines` — the sole wine-list surface. Tapping a row opens the wine modal on the Wine Info pane; the inline "Rate" button on unrated rows (or the score chip on rated rows) opens the modal on the Rate pane. Host-tier affordances render inline. Modal navigation between wines uses pull-to-swap / prev-next buttons / arrow keys.
- `/session/<code>/compare` — overlay/per-rater comparison view
- `/join/<code>` — invite landing page (anon name entry, or one-tap join for logged-in users; renders "session not found" for invalid codes)
- `/u/<id>` — public user profile + recent check-ins
- `/hof` — public Hall of Fame leaderboard

## State management

- **Server state**: TanStack Query (`useQuery` + `refetchInterval`) for wines/ratings/meta polling.
- **Client identity**: `localStorage` keys `vr_anon_<CODE>` (token), `vr_name_<CODE>` (display name), `vr_id_<CODE>` (identity id).
- **Session-scoped context**: `components/session/SessionShell.tsx` exposes `useSession()` returning `{code, displayName, myId, isHost, sessionMeta, wines, allRatings, myRatings, refresh, …}` to descendant screens.

## Fetch helpers

State-changing fetches against session endpoints go through `lib/sessionFetch.ts` (auto-attaches the anon token header, handles auth-invalid responses). Logged-in `/me/*` reads use `lib/authedFetch.ts`.

## Bootstrap URL params (presentation-only)

Bootstrap params like `?name=`, `?id=`, `?host=1` exist solely to seed client UI on first render after a redirect from create/join. They must be captured synchronously into `useState` initializers (so the first render has the value) and stripped from the URL via `router.replace` in a mount effect — see `SessionShell.tsx`. Never branch authorization on a URL param; never leave one in the URL where copy-paste turns it into a confused-UI bug for the recipient. Server trust still flows only through the NextAuth cookie or the `x-vr-anon-token` header.

## `router.refresh()` fallback on SSR-rendered surfaces

`/u/[id]` is a Server Component that calls `resolveProfileViewer(userId, viewerId)` at request time and branches to `<ProfileShell>` (tier-gated) / `<ProfileBlockedView>` (blocker-side) / full profile (`<ProfileHeader>` + `<ProfileTabs>`). When the viewer follows or unfollows a tier-gated profile, the gate result flips but the SSR'd shell wouldn't re-evaluate without a navigation.

**Pattern**: `<ProfileShell>` and `<ProfileHeader>` are client components (`'use client'`). Their follow/mute/block toggle callbacks default to `router.refresh()` when no caller-supplied callback is wired — so the SSR /u/[id] path re-runs the server gate after every relationship change without the user navigating. Client-cached callers (`UserProfileModal`, `ProfilePreviewInline`) pass their own TanStack invalidation callbacks instead; the fallback only fires when no callback is provided. Apply the same pattern on any other server component that hosts an interactive relationship-toggle.

## `instrumentation.ts` — keep Node-only code out of the Edge bundle

`instrumentation.ts`'s `register()` is analyzed and **bundled for BOTH runtimes** (Node *and* Edge — `middleware.ts` makes the Edge runtime real). A `NEXT_RUNTIME === 'nodejs'` runtime guard does **not** stop webpack from *bundling* a module — including a `await import(...)`'d one — for the Edge target. So importing anything that pulls in `node:fs` / `node:path` / `node:child_process` (etc.) directly from `instrumentation.ts` fails the **build** with `UnhandledSchemeError: Reading from "node:fs"…`, even though it would never *run* on Edge. (`tsc` won't catch this — it doesn't bundle; only `npm run build` does.)

**Pattern**: put the Node-only boot work in a separate root file `instrumentation-node.ts` and import it ONLY inside the nodejs branch:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node').then((m) => m.register())
  }
}
```

The bundler keeps `instrumentation-node.ts` (and its `node:*` transitive imports — here `lib/geoData.ts` for the geo boot seed) out of the Edge graph. `instrumentation-node.ts` is a plain module, NOT a Next-recognized special file (Next's detection regex is anchored to `^instrumentation\.…$`), so there's no double-register. Any future Node-only instrumentation work goes there, not in `instrumentation.ts`.
