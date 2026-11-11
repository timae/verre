# Profile visibility — implementation

User-facing copy: `../profile-visibility.md`.

Per-user settings controlling who can read profile content (`/u/<id>` page, `/api/users/<id>` and sub-routes, feed entries authored by this user, check-in like POSTs). Stored on `users`:

- `profile_visibility VARCHAR(32)` — one of `public-internet` / `public-users` / `public-followers` / `public-mutual`. CHECK constraint hand-added in the migration; **the TypeScript union in `lib/profileVisibility.ts` is the authoritative source of truth**, the CHECK is belt-and-suspenders.
- `visibility_fof BOOLEAN` — when true, friend-of-follower (depth 1: viewer→intermediary→profile) is also admitted. Only meaningful for `public-followers` and `public-mutual`; `public-internet` and `public-users` already admit anyone qualifying via FoF.
- `checkin_visibility VARCHAR(32) NULL` — **Check-Ins Visible To** (You profile step 4): the audience for the owner's POSTS. NULL = Same as Profile; else `public-users` / `public-followers` / `public-mutual` / `only-me` (hand-added CHECK `checkin_visibility_chk`; never `public-internet`, which would equal NULL). Union `CheckinVisibility` in `lib/profileVisibilityShared.ts`.
- `show_cravings`, `show_moments`, `show_locations` `BOOLEAN NOT NULL DEFAULT true` — the On My Profile switches.

## Tier semantics (locked)

- `public-internet` — anyone, no auth required. Profile + check-ins indexable by search engines.
- `public-users` — any logged-in Verre user. **Default for new signups.**
- `public-followers` — only people who follow the profile owner (asymmetric: owner doesn't have to follow back).
- `public-mutual` — only mutual follows (both directions of `follows`).

## Default migration (existing users)

The privacy-tiers migration `UPDATE`s pre-existing rows to `public-internet` to preserve their de-facto state, and only NEW rows hit the column default `public-users`. Don't change this without surfacing the retroactive-tightening question to the user — silent default changes break shared profile URLs.

## Post audience (Check-Ins Visible To)

**The stricter of profile and check-in always wins**: `canViewPosts(settings, viewer)` = the profile gate (`canViewProfile(visibility, viewer, fofEnabled)`) AND (`checkinVisibility === null` OR (`!== 'only-me'` AND `canViewProfile(checkinVisibility, viewer, false)`)). The `false` is the rule that **an explicit check-in tier never uses FoF**: FoF only applies with Same as Profile. Only Me admits nobody but the owner. Self short-circuits before it, blocks before that.

🔒 **Stored independently, never clamped**: tighten the profile and the posts follow; loosen it again and the stored check-in choice comes back. The app calls these "posts" (never "check-ins", ruled 2026-11-11; the wire keeps `checkinVisibility`), greys choices broader than the account visibility ("Change your account visibility first") and shows Same as Account Visibility as a switch; the server accepts any member of the union.

🔒 **Fail closed**: a stored value outside the union reads as `only-me` in the gate, `batchLoadVisibilities`, the owner's GET and the PATCH's compare (`readSettings`), so it hides the posts (an unknown string would otherwise fall into `canViewProfile`'s mutual branch) and the owner can still overwrite it.

**Covered** (P2): the network feed (`networkAuthors` pre-filter → `canViewPosts`), `/api/feed?user=` (`gate.sees.posts`, else **200 `{ items: [], nextCursor: null }`**, never 404: 404 means gone to the app), the Impressions tile (count + photo + pin), the web's `stats.checkins` (the Tastes tile) and the default `/u/<id>` + `/api/users/<id>` payload's `recentCheckins` / `recentSessionPosts`, like POST, "had a sip" (the source), tags (they render only on the post). Both kinds of post: standalone check-ins and your moment posts, on every surface OUTSIDE a moment.

**Exempt** (named, Q9): everything inside a moment (trust model; a moment's address included), the palate aggregates + XP + lifetime counters (`stats.ratings` too), badges (but see dates below), people lists, in common, search. Residuals: they move with each post, so a watcher can infer activity; search + people lists ship raw `xp` and `imageUrl` whatever the listed person's tier (`users/search/route.ts`, `lib/profilePeople.ts`, pre-existing); someone ELSE's post (one that tags you, or their moment post) can still show where you were; web PNG / WebP uploads keep their metadata (JPEG-only EXIF strip, `lib/s3.ts`; the app re-encodes to JPEG).

**Badge dates are owner-only**, always: `/api/users/<id>/badges` answers `earned_at: null` for every other viewer (some badges unlock on the post itself: `first_5star`, `long_note`, `harsh_critic`), and the list stays in catalog order.

**Like DELETE stays open** (a recovery path): your own like comes off whenever the post exists, even if it is now hidden from you (shell, blocked-by-me, posts hidden) → `{ liked: false }` with NO count; a hidden post you never liked → 404 (no new existence oracle). 🔒 `'gone'` (the author blocks you, or a mutual block) stays 404 even when your like existed: a 200 would tell "blocked" from "deleted" (`block.md`); the like is still removed, silently, so an unblock doesn't bring it back.

The full profile payload (`/api/users/<id>`, header view included) carries `checkinsAudience` (the stored choice) ONLY when it hides the posts from this viewer, never on your own profile: the app's "Follow Lena to see posts" line. It is the one sanctioned output of another user's settings.

## Show Cravings / Show Moments / Show My Locations

- **Show Cravings** off: the Cravings tile is absent for others (and, later, the Cravings list).
- **Show Moments** off: the Moments tile is absent for others (and, later, the Moments list), and the web's `stats.sessions` is omitted. Moment POSTS follow Check-Ins Visible To; inside a moment nothing changes.
- 🔒 A hidden tile is ABSENT from `tiles` (no count, no photo, no pin) and its queries never run (`resolveTilePhotos(profileId, tiles)` takes the requested keys, no default); the owner's stored pin is kept. The app shares the row among the tiles left.
- **Show My Locations** off: the place line (venue, city, VENUE country) of the owner's check-ins disappears for everyone but the owner, applied on READ by `postPlace(post, authorShowsLocations, viewerIsAuthor)` in the network feed, `?user=` and `profileLoad`. 🔒 Never the wine's origin (`wineRegion` / `wineCountry`). 🔒 The author's flag comes from `batchLoadVisibilities` (network) or the gate's `settings` (`?user=`, profile), never from the post's `user` include (`author: f.user` ships that select verbatim). `feed_items.location_public` stays unread (it only means "has a place"). lat / lng: only the author's own POST / PATCH responses echo them. A moment's address stays visible to the people in it.

## Authorization chokepoints — never bypass

- `lib/profileVisibility.ts` `resolveProfileViewer(profileId, viewerId)` — single-profile gate. Returns `{status: 'ok' | 'shell' | 'blocked-by-me' | 'gone', …}` (plus `name` for `shell`/`blocked-by-me`; `viewer`, `settings` and `sees: { posts, cravings, moments }` for `ok`, every `ok` built by one local `ok()`). Map `status === 'gone'` to 404 (not 403, not 401) so the caller can't distinguish "no such user" from "exists but tier denies you" — that's the leak prevention. 🔒 The `ok` result carries the owner's raw `settings`: never serialize it.
- `viewerCanSeePosts(viewerId, authorId)` — the per-pair POST gate for one post's author (like POST, "had a sip"): `resolveProfileViewer` + `sees.posts`. Not for loops.
- The profile loaders take the `ok` gate as a REQUIRED parameter (`loadProfile({ userId, gate })`, `loadProfileHeaderExtras(userId, gate, count)`): tsc fails a caller that forgets. `loadProfile` has two callers (`/api/users/[id]`, `app/u/[id]/page.tsx`), `loadProfileHeaderExtras` one (`/api/users/[id]`).
- `batchLoadVisibilities(ids)` + `resolveProfileViewerBulk(ids, viewerId)` + `viewerFofAuthorSet(viewerId, ids)` + `canViewPosts` — batch path used by feed and search to avoid N+1 lookups.
- `setProfileVisibility(userId, { expected, changes })` — the only sanctioned write path (compare-and-set, below). Bypassing it and writing the columns directly skips the lock and the audit trail.
- **Post-read census** (`scripts/check-post-reads.mjs`, `check-lint.yml`): every read of `feed_items` / `feed_item_likes` / `feed_item_tags` in `app/` + `lib/` sits in an allow-listed file with a pinned count, so a new read path needs a reviewed pin. ⚠️ Blind spot: post content also lives in `ratings` / `rating_images`, cravings in `bookmarks`, memberships in `session_members` (not matched); the required gate parameters above and the leak matrix (`scripts/tests/you-profile-integration.mts` § 11) cover those.

## The write: compare-and-set (`PATCH /api/me/visibility`)

- GET → `{ visibility, fofEnabled, checkinVisibility, showCravings, showMoments, showLocations }`.
- PATCH = `{ expected: { …the six as last read }, …changes }`. `expected` carries all six (⚠️ a future seventh setting must be OPTIONAL in `expected` and compared only when sent, else every older client 400s on every save); `changes` ⊆ the six (partial, at least one); unknown keys or ill-typed values → 400; a body without a valid `expected` → 400 "Reload the page and try again." (the web shows `error` raw). There is **no legacy shape**.
- In one transaction the users row is locked (`SELECT … FOR UPDATE`) and compared against THAT row: stored == `expected` ⊕ `changes` already → 200 no-op (a retry whose first attempt committed); any `expected` field ≠ stored → **409 `{ error, current }`**; else update + audit → 200 `{ ok: true, current }`. Full-snapshot compare (covers the coupled FoF ↔ tier; an A→B→A in between is harmless). Under READ COMMITTED a second request's `FOR UPDATE` waits, then reads the committed row, so two racing saves can't both win.
- Limits: 60/min outer; the 30/h inner peek-then-check counts an actual change of ANY field; a 409 or a no-op charges nothing.
- `Cache-Control: private, no-store` on every return.
- ⚠️ Roll FORWARD, never back past this release: the previous code ignores `checkin_visibility` and the `show_*` columns (the migration is additive, so it runs), so an Only Me user's posts and every hidden place line would show again. The same holds for the minutes an old instance serves during a deploy.
- The web form (`components/me/AccountSettings.tsx`) keeps all six from its GET as its snapshot, always sends BOTH `visibility` and `fofEnabled` as changes, and after every 200 and every 409 replaces both its shown values and its snapshot with `current` (a 200 without `current`, from the previous release mid-deploy, re-GETs).

## Hall of Fame: retired (2026-11-11)

`/hof` and `GET /api/hof` were a public surface outside every tier. Both are gone (see `docs/dev/score-system.md`). A future leaderboard must gate through the profile-visibility chokepoints like any other user-scoped surface.

## Session compare views are NOT gated by profile visibility

Trust model: session participation > profile tier. If you joined a session together, you see each other's ratings and display names — `profile_visibility` only governs *outside-session* surfaces. Don't try to gate session ratings by profile_visibility; you'll break the compare screen.

## Tag display follows the post author's gate

…not the tagged user's (since step 4: the author's post gate, `canViewPosts`). A user tagged in someone else's check-in appears according to that check-in's visibility — being tagged is a presentation surface the tagged user consented to via mutual-follow at creation time. Edit-time mutual-follow re-validation already drops a tag if the relationship has been broken since.

## Audit log (`profile_visibility_log`)

Internal-only, no API surface, no UI. One row per change, plus an initial signup row with `from_*=NULL` for forensic completeness (web register only; native Better Auth sign-up writes no row: a pre-existing gap). Since step 4 every row is a FULL before/after snapshot: `from_/to_tier`, `from_/to_fof`, `from_/to_checkin_tier`, `from_/to_show_cravings`, `from_/to_show_moments`, `from_/to_show_locations`. Same as Profile is logged as the sentinel `'profile'` (`AUDIT_SAME_AS_PROFILE`), so a NULL check-in column means only "a row from before these columns" or the signup row's `from_*`. Cascade rule is `ON DELETE SET NULL` — the trail survives account deletion (tombstone pattern) so post-mortem queries can still reconstruct timelines for deleted users.
