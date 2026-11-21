# Social feed — implementation

A logged-in surface around individual users. Sessions are still the primary tasting context; the feed is *what someone has been drinking* both inside and outside session contexts.

## Schema (Postgres)

The rewire phase 2 cutover unified standalone check-ins and session ratings under a single `feed_items` table. Two `kind` values today: `'standalone'` (a self-posted check-in of a wine you had) and `'session'` (an aggregate "I participated in this tasting" post, materialised on first engagement). User-facing copy still says "check-in" for both kinds.

Tables and their roles:

- `follows(followerId, followingId)` — explicit social graph, composite PK, cascade on user delete. No-self-follow enforced at both the DB level (CHECK constraint) and the route level (`/api/users/<id>/follow` rejects with 400).
- `feed_items(id, userId, kind, sessionId, ratingId, venueName, city, country, lat, lng, locationPublic, createdAt)` — the unified post. `userId NOT NULL` (anon ratings never produce a feed_item — see §3 of `proposals/rewire.md`). `kind='standalone'` has `ratingId` set + `sessionId` NULL; `kind='session'` has `sessionId` set + `ratingId` NULL. `@@unique([userId, sessionId])` so concurrent rates in the same session collapse to one post via `ON CONFLICT DO NOTHING`.
- `feed_item_likes(userId, feedItemId, createdAt)` — composite PK, cascade.
- `feed_item_tags(feedItemId, userId, createdAt)` — composite PK; `userId` is the *tagged* user, not the author. Tags exist for standalone only today (session-rate POST doesn't accept `taggedUserIds`).
- `ratings(id, wineId, userId, sessionId, origin, raterName, score, flavors, aromas, notes, ratedAt)` — every rating row, session or standalone. `origin='session'|'standalone'`. Partial unique on `(user_id, wine_id, session_id) WHERE session_id IS NOT NULL AND user_id IS NOT NULL` — multiple standalone tastings of the same wine are legal (aging-bottle case), but in-session ratings are at-most-one per `(user, wine)`.
- `rating_images(id, ratingId, imageUrl, sortOrder, createdAt)` — per-tasting photo album. Cascade on rating delete. S3 reclaim is INDEPENDENT of the FK cascade — every rating-delete code path follows the capture-before-delete / commit / reclaim-after pattern.

Phase 4 dropped the legacy `checkins / checkin_likes / checkin_tags` tables. The `/api/checkins` URL surface is preserved for client compatibility — both `POST /api/checkins` and `PATCH/DELETE /api/checkins/:id` write to the new model (`feed_items` + `ratings` + `wines` + `rating_images`). The `:id` path segment is now a `feed_items.id` of `kind='standalone'`; phase 2's migration mint of `feed_items.id = source.checkins.id` plus the `feed_items_id_seq` bump means cached client URLs still resolve.

Since 2026-07-17 the PATCH also accepts `kind='session'` feed items (the mobile feed's owner-only ⋯ → Edit): a rating-only body `{wineId, score?, flavors?, aromas?, notes?}` resolved against the caller's `(user_id, wine_id, session_id)` rating. It honors the rate-route invariants (score validation, `gateAndFillFlavors` keyed to the wine's server style, aroma present-replaces), mirrors into the live Redis rating key + `touchWithMeta` while the session is alive (PG-only once expired), runs `engagementDeletionCascade('empty-only')` when the edit empties the rating (deleting the Redis copy only when the cascade confirms), and deliberately skips lifetime counters — an edit is not new activity. Wine identity, venue, and standalone-only fields 400/ignore on this branch.

## Engagement trigger (the rule for session feed_items)

A session feed_item materialises on first engagement by a logged-in user. Engagement = any of: a score > 0, OR a non-empty flavour chip set, OR a non-empty note. The rate POST (`app/api/session/[code]/rate/route.ts`) runs the rating upsert first, then a `hasEngagement` guard, then an idempotent `INSERT INTO feed_items ... ON CONFLICT (user_id, session_id) DO NOTHING`.

Per `proposals/rewire.md` §3: anonymous ratings never create feed_items (schema-enforced via `userId NOT NULL` on feed_items). An empty rate POST (all three fields empty) does NOT create a feed_item — and, when the upsert lands an empty payload on a previously-engaged row, the engagement-deletion cascade (`lib/engagementCascade.ts`) reaps the row and drops the session feed_item if it was the user's only rating in the session. The Reset path (`DELETE /api/session/[code]/rate/[wineId]`) runs the same cascade in `force` mode (bypasses the empty-payload predicate). The undo chip in WineModal gives a 7s window to re-POST the prior values.

## Network query

`/api/feed` resolves the caller's "network" as the union of: the caller themselves, everyone they follow, and everyone they share a session with (via `session_members` self-join). The query returns feed_items ordered by createdAt, paginated by cursor.

Visibility / mute / block filtering composes multiplicatively per author: block-pair authors are dropped first (strictest), then muted authors, then the author's POST audience is gated via `canViewPosts` (profile tier AND Check-Ins Visible To, the stricter wins: `docs/dev/profile-visibility.md`). The viewer always sees their own content (self-block and self-mute are rejected at the API + DB level).

**Places on read (Show My Locations).** A standalone post's place line (`venueName`, `city`, `country` = the VENUE) is nulled by `postPlace` unless the author shows locations or the viewer is the author; the wine's origin (`wineRegion` / `wineCountry`) is never touched. 🔒 The author's flag comes from `batchLoadVisibilities` (network) or the gate's `settings` (`?user=`), never from the post's `user` include: `author: f.user` ships that select verbatim, so a column added there lands on every post. `feed_items.location_public` is written but read nowhere (it only means "has a place"). lat / lng ship only in the author's own POST / PATCH responses.

### Author filter (`?user=<id>`, the app's profile feed)

`/api/feed?user=<publicId>` returns one person's posts (the PUBLIC id; an integer is a 400, an unknown public id the same 404 as `gone`) through the SAME projection (likes, tags, session wines with blind redaction, cursor). Only the author set changes: the route gates `resolveProfileViewer(user, viewer)` and must get `ok` (self always is), then uses `[user]` in place of the network. Every other gate result (`gone`, `shell`, `blocked-by-me`) is a 404 — `GET /api/users/:id` is what tells the client which state it is. An `ok` profile whose posts are hidden from this viewer (`gate.sees.posts` false: Check-Ins Visible To) is **200 `{ items: [], nextCursor: null }`**, never 404 (404 means gone to the app); the profile header's `checkinsAudience` carries the why. The network query and the mute filter are skipped: mute is a network-feed filter (`docs/dev/mute.md`), and opening someone's profile is an explicit choice to look at them.

The native app keys it `['feed', 'user', id]` beside the network feed's `['feed']`, so the same post can sit in both caches; every post mutation writes all `['feed', …]` caches (`apps/mobile/src/lib/feedCache.ts`).

## Discriminated payload (response shape)

The feed response carries items tagged by `type`:

- `type: 'checkin'` — standalone feed_items. Renders via the existing `<CheckinCard>`. `checkin.id` is now the `feed_items.id` (migration-preserved id-equality means cached client URLs keep working).
- `type: 'session'` — session feed_items. Renders via `<SessionFeedCard>` with per-wine fan-out. Wire shape declared in `lib/feedTypes.ts` (`SessionFeedPayload` + `SessionFeedWine`). The bulk loader `lib/sessionFeedWines.ts` runs ONE Prisma query per feed page across all session posts on the page (OR-of-AND on `(userId, sessionId)` pairs, backed by the composite index).

Badge unlocks used to merge in as a third `'badge'` discriminant. Removed: they cluttered the feed and didn't carry post-context. `/me/badges` remains the canonical surface; inline badge attribution on the triggering post is tracked as a follow-up.

Both payload kinds carry the rating's `aromas` (`[{a, m, p?}]`, aroma-layer.md §1) — shipped UNREDACTED even on a blind wine, like `score`/`flavors`: descriptor selections are the taster's own perception, never wine identity (§7). The mobile feed impression detail renders them via `AromaReadChips`; the web renders them via its own read-only twin (`components/ui/AromaReadChips.tsx` — PR D) on `CheckinCard` and on every `SessionFeedCard` wine row (blind rows included, same §7 rule).

**Row keys (Moment Visibility step 1a).** Every row of a session payload's `wines[]` carries `ratingId` (the author's `ratings.id`): the key clients use for lists and for finding a row. 🔒 A BLIND row carries the wine's `id` only when the viewer wrote that rating (their Edit / Delete Rating need it); for everyone else it is left out: a blind bottle's id is label identity (an old photo key fetches the label, and the id joins the row to other surfaces). The same on the Impressions list (`lib/profileLists.ts`): a blind row carries `wineId` only on your own list; rows already key on `id`, the rating's. Cravings rows carry `ratingId`, the rating their score and post come from (catalogue model change step 7: since step 5 that can be another bottle of the same wine than the craving's), beside `postId` only. Clients must never match an absent id against an absent id: the app opens a post from a list by the post row's rating (`apps/mobile/src/lib/listPost.ts`; units `scripts/tests/list-post-units.ts`).

Soft-deleted sessions show "[deleted session]" in the card header but still render the per-wine list (only the session-level identity scrubs). 🔒 What a bottle shows outside its moment is ONE SQL rule, `lib/outsideView.ts` (lists plan D4, on the DB clock, NULL-safe toward fail-closed): **redacted** = blind, not revealed, the moment not deleted, not over by its record dates (`MOMENT_DEFAULT_SPAN_MS`), and no bypass (the strict host or the bottle's adder; none under Blind for All) → a blind row (no name, producer, vintage, grape, photo, catalog fields or purchase link; score, date, style and aromas stay); **hidden** = Hide Line-up before its reveal time and the viewer is not the moment's host (strict host or a current cohost) → LEFT OUT, the author's own view included. `loadSessionFeedWines` reads both flags for the page's ratings in one raw query (no TypeScript twin); a moment post whose line-up is hidden from the viewer is left out of the feed and `profileLoad` IN the query (`hiddenSessionIds` + the grouped `notHiddenPosts`), so the cursor never carries its time, and it comes back at its old time once the line-up shows. The same rule drives `/api/me/ratings`, `/api/me/bookmarks`, the profile tile lists and their counts (a CRAVING whose source is redacted or hidden for its owner is LEFT OUT, never a blind row: `lib/cravings.ts`, catalogue model change § 5); the tile photo rule `SAFE_PHOTO` (`lib/profileTiles.ts`) is its stricter subset. **Cross-cutting rule**: any new surface that renders a moment's bottles outside the moment selects `outsideViewSql` (and per-wine feed data goes through `loadSessionFeedWines`), never a predicate of its own. Rate + bookmark POSTs refuse a bottle whose line-up is hidden from the caller by the LIVE rule (`lineupHiddenFor`, `lib/sessionState.ts`), the same 404.

See [session-deletion.md](session-deletion.md) for the full soft-delete contract and the DB-level trigger that enforces it.

## Tags require mutual follow

`/api/checkins` POST and `/api/checkins/[id]` PATCH both run a SQL self-join against `follows` to filter the requested `taggedUserIds` down to mutual-follows-of-the-author. Non-mutuals are silently dropped server-side. Edit-time re-validation means an unfollow after creation drops the tag on the next save. 🔒 `taggedUserIds` are PUBLIC ids (`lib/publicIds.ts` `parseTagList`): any element that isn't a well-formed public id (an old tab's integer) is a 400 for the WHOLE request, before any upload or write, so it can never become `[]` and wipe a post's tags (the PATCH deletes and re-inserts); a well-formed unknown id drops like a non-mutual. Resolved before the check-in transaction (tags are written after COMMIT, so a late 400 would leave the post created and a retry would duplicate it). Feed and profile rows emit `author.id` and `tags[].id` as public ids.

Block-pair members are also excluded from the tag write (`user_blocks` lookup combined with the mutual-follow check in one SQL query) — tagging a user the author block-pairs with shouldn't persist a row that the render-time filter would then hide globally anyway.

## Likes are persisted

`/api/feed` includes a `liked: boolean` per feed_item, computed by a single `feed_item_likes` lookup keyed by the caller. The like button reflects the server state; toggling sends POST or DELETE to `/api/feed-items/<id>/like`.

Block-pair-adjusted like counts: a like by user X on a feed_item by user Y is invisible to ALL viewers (not just the block-pair members) once a block exists between X and Y. The query subtracts `COUNT(DISTINCT fl.user_id)` over JOIN'd block-pair rows to protect against mutual A↔B blocks double-counting the same like.

## S3 reclaim on edit/delete

Rating images live at `wines/ci_<rand>.<ext>` (`lib/imageKeys.ts`: 32 random hex characters, nothing that points to the person and no timestamp, public-user-ids D2; the bucket is public, so a key must not be guessable; keys from before carry the user's integer and are moved by `scripts/rekey-user-images.mts`) at POST and at PATCH (so a PATCH that replaces an image always uses a different key). "Had a sip" copies to the same shape. PATCH and DELETE both call a local `reclaimImage` helper that issues `DeleteObjectCommand` for the previous URL — fire-and-forget, logs failures, never blocks the user response.

**The capture-before-delete / commit / reclaim-after pattern is the cross-cutting rule** (per root CLAUDE.md). Every rating-delete path — ban-tx wipe, account deletion, and the engagement-deletion cascade (`lib/engagementCascade.ts`) — captures `rating_images.imageUrl` into memory BEFORE the DELETE, commits the cascade, then fires `reclaimImage()` AFTER commit. A transaction rollback never leaves orphan S3 deletes. ("Had a sip" COPIES bytes via S3 `CopyObjectCommand`; it doesn't reclaim, and the new check-in owns its own copy outright.)

`wines.imageUrl` is the canonical catalog bottle shot. Standalone POSTs write `NULL` on the wine row — the user's tasting photo lives on `rating_images`, not on the wine. This way a cascade-delete of the rating doesn't leave a dangling S3 pointer on a wine row that may survive (bookmarked from elsewhere).

## "Had a sip" copy flow

A logged-in viewer who follows the source author can clone a standalone feed_item (`+ had a sip` button on feed cards and `/u/<publicId>`). Wire field is `copyFromCheckinId` (name preserved for client/URL compatibility; semantics shifted to a `feed_items.id` of `kind='standalone'`).

Server resolves the source feed_item, rejects unless: `kind === 'standalone'` AND source has a rating AND `viewerCanSeePosts(viewerId, source.userId)` returns true (the post gate: profile tier + Check-Ins Visible To) AND the viewer follows the author AND `source.userId !== viewerId`. All failure branches collapse to a single generic `400` to avoid enumeration of per-id existence / ownership / follow state.

On success, mints a FRESH wine + rating + feed_item + rating_image row in the new model (Path B per `proposals/rewire.md` §5). No shared wine identity — the no-dedup non-goal applies here too. Source image priority: the rating's first attached image (the user's tasting photo) falling back to the wine's canonical bottle shot. Bytes are S3-copied server-side into a fresh user-owned key; the image URL itself is never trusted from the client.

The feed payload includes `viewerFollowsAuthor` per feed_item to gate the button without a per-row roundtrip.

## Places search

`/api/places` is a thin adapter: Google Places when `GOOGLE_PLACES_API_KEY` is set, OSM Overpass + Nominatim fallback otherwise. Both upstreams parameterised via `fetchJson` helper that throws labelled errors on non-OK / non-JSON responses (so transient outages surface in logs instead of a generic SyntaxError).

## Public surface

Profiles at `/u/<id>` are public reads; viewer's `isFollowing` flag populated when authed. `/api/users/search` is anonymous prefix lookup for follow/tag discovery — never participates in authorization (see root CLAUDE.md trust-model section).

Profile activity surfaces BOTH `kind='standalone'` feed_items (rendered via `<CheckinCard>`) AND `kind='session'` feed_items (rendered via `<SessionFeedCard>`). Profile-stat `checkins` (tile labelled "tastes" on the profile UI) counts every `ratings` row for the user — session and standalone combined, including chips-only / score-zero rows. Sourced directly via `prisma.rating.count` rather than `users.lifetime_ratings` (which has a known parity gap with standalone POSTs, captured in `.local/future-work-rewire.md`).


## Saves on the feed (catalogue model change § 5, build step 5)

Every feed bottle row (`loadSessionFeedWines`, and a check-in's) carries `saved` for a signed-in viewer, from one statement for the page's moment bottles and one for its check-ins (`lib/cravings.ts` `savedFlags`): a visible row reads whether a visible craving of its wine exists (merges followed); a row redacted for the viewer reads only the viewer's own save of THAT bottle (`blind_saves`, all that a save of a hidden bottle stores; it counts as a craving once the bottle shows), never the wine-level state, so a feed "Wine N" never lights up because the viewer craves the wine. A visible row shows its catalogue entry (merges followed), else its snapshot. `POST/DELETE /api/feed-items/:id/crave` saves from a post (a moment post's row named by its key, `{ratingId}`: a hidden bottle on someone else's post carries no wine id since Moment Visibility 1a; a check-in's bottle is the post's own, no body): the post gate first (`viewerCanSeePosts`, 404), the bottle must be the post's (the author's rating in that moment, else 404), a hidden line-up 404, then the save budget (`rl:crave`, shared with the moment's save), then the outside rule for the caller decides a blind save (answered alike whatever the wine) before the 409 for an unlinked bottle. The craving remembers the post (`source_item_id`): on the saver's Cravings its bottle photo and id show only to viewers who may see that post (ruled 2026-11-20). A check-in row still carries its `wineId` (a key; its save needs none: the bottle is the post's own).
