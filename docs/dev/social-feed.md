# Social feed — implementation

A logged-in surface around individual users. Sessions are still the primary tasting context; the feed is *what someone has been drinking* both inside and outside session contexts.

## Schema (Postgres)

The rewire phase 2 cutover unified standalone check-ins and session ratings under a single `feed_items` table. Two `kind` values today: `'standalone'` (a self-posted check-in of a wine you had) and `'session'` (an aggregate "I participated in this tasting" post, materialised on first engagement). User-facing copy still says "check-in" for both kinds.

Tables and their roles:

- `follows(followerId, followingId)` — explicit social graph, composite PK, cascade on user delete. No-self-follow enforced at both the DB level (CHECK constraint) and the route level (`/api/users/<id>/follow` rejects with 400).
- `feed_items(id, userId, kind, sessionId, ratingId, venueName, city, country, lat, lng, locationPublic, createdAt)` — the unified post. `userId NOT NULL` (anon ratings never produce a feed_item — see §3 of `proposals/rewire.md`). `kind='standalone'` has `ratingId` set + `sessionId` NULL; `kind='session'` has `sessionId` set + `ratingId` NULL. `@@unique([userId, sessionId])` so concurrent rates in the same session collapse to one post via `ON CONFLICT DO NOTHING`.
- `feed_item_likes(userId, feedItemId, createdAt)` — composite PK, cascade.
- `feed_item_tags(feedItemId, userId, createdAt)` — composite PK; `userId` is the *tagged* user, not the author. Tags exist for standalone only today (session-rate POST doesn't accept `taggedUserIds`).
- `ratings(id, wineId, userId, sessionId, origin, raterName, score, flavors, notes, ratedAt)` — every rating row, session or standalone. `origin='session'|'standalone'`. Partial unique on `(user_id, wine_id, session_id) WHERE session_id IS NOT NULL AND user_id IS NOT NULL` — multiple standalone tastings of the same wine are legal (aging-bottle case), but in-session ratings are at-most-one per `(user, wine)`.
- `rating_images(id, ratingId, imageUrl, sortOrder, createdAt)` — per-tasting photo album. Cascade on rating delete. S3 reclaim is INDEPENDENT of the FK cascade — every rating-delete code path follows the capture-before-delete / commit / reclaim-after pattern.

Legacy `checkins / checkin_likes / checkin_tags` tables still exist until phase 4. Phase 2's data migration backfilled feed_items + likes + tags from them; phase 2's write paths stopped writing to them. Phase 4 drops them.

**ID-equality preservation**: the data migration mints `feed_items.id = source.checkins.id` for backfilled standalone rows, so any cached client URL with `/api/checkins/<id>/...` shape resolves to the same logical row before and after the cutover. The `feed_items_id_seq` is bumped past `MAX(checkins.id)` afterward so new POSTs don't collide.

## Engagement trigger (the rule for session feed_items)

A session feed_item materialises on first engagement by a logged-in user. Engagement = any of: a score > 0, OR a non-empty flavour chip set, OR a non-empty note. The rate POST (`app/api/session/[code]/rate/route.ts`) runs the rating upsert first, then a `hasEngagement` guard, then an idempotent `INSERT INTO feed_items ... ON CONFLICT (user_id, session_id) DO NOTHING`.

Per `proposals/rewire.md` §3: anonymous ratings never create feed_items (schema-enforced via `userId NOT NULL` on feed_items). An empty rate POST (all three fields empty) does NOT create a feed_item — and, when the upsert lands an empty payload on a previously-engaged row, the engagement-deletion cascade (`lib/engagementCascade.ts`) reaps the row and drops the session feed_item if it was the user's only rating in the session. The Reset path (`DELETE /api/session/[code]/rate/[wineId]`) runs the same cascade in `force` mode (bypasses the empty-payload predicate). The undo chip in WineModal gives a 7s window to re-POST the prior values.

## Network query

`/api/feed` resolves the caller's "network" as the union of: the caller themselves, everyone they follow, and everyone they share a session with (via `session_members` self-join). The query returns feed_items ordered by createdAt, paginated by cursor.

Visibility / mute / block filtering composes multiplicatively per author: block-pair authors are dropped first (strictest), then muted authors, then the author's profile-visibility tier is gated via `canViewProfile`. The viewer always sees their own content (self-block and self-mute are rejected at the API + DB level).

## Discriminated payload (response shape)

The feed response carries items tagged by `type`:

- `type: 'checkin'` — standalone feed_items. Renders via the existing `<CheckinCard>`. `checkin.id` is now the `feed_items.id` (migration-preserved id-equality means cached client URLs keep working).
- `type: 'session'` — session feed_items. Renders via `<SessionFeedCard>` with per-wine fan-out. Wire shape declared in `lib/feedTypes.ts` (`SessionFeedPayload` + `SessionFeedWine`). The bulk loader `lib/sessionFeedWines.ts` runs ONE Prisma query per feed page across all session posts on the page (OR-of-AND on `(userId, sessionId)` pairs, backed by the composite index).

Badge unlocks used to merge in as a third `'badge'` discriminant. Removed: they cluttered the feed and didn't carry post-context. `/me/badges` remains the canonical surface; inline badge attribution on the triggering post is tracked as a follow-up.

Soft-deleted sessions show "[deleted session]" in the card header but still render the per-wine list (only the session-level identity scrubs). The blind-redaction predicate is `!meta.deleted && meta.blind && !revealed && !(!meta.blindForEveryone && (isHost || ownsWine))` — short-circuits on `deleted` (a post-delete blind tasting reveals wine identity regardless of `wines.revealedAt`); the host/own-wine bypass is suppressed when `meta.blindForEveryone` is on (then only `revealed` un-redacts). **Cross-cutting rule**: any new surface that renders per-wine session data must use `loadSessionFeedWines` (server-side redaction) and NOT roll its own join — the blind invariant lives in that helper and nowhere else.

See [session-deletion.md](session-deletion.md) for the full soft-delete contract and the DB-level trigger that enforces it.

## Tags require mutual follow

`/api/checkins` POST and `/api/checkins/[id]` PATCH both run a SQL self-join against `follows` to filter the requested `taggedUserIds` down to mutual-follows-of-the-author. Non-mutuals are silently dropped server-side. Edit-time re-validation means an unfollow after creation drops the tag on the next save.

Block-pair members are also excluded from the tag write (`user_blocks` lookup combined with the mutual-follow check in one SQL query) — tagging a user the author block-pairs with shouldn't persist a row that the render-time filter would then hide globally anyway.

## Likes are persisted

`/api/feed` includes a `liked: boolean` per feed_item, computed by a single `feed_item_likes` lookup keyed by the caller. The like button reflects the server state; toggling sends POST or DELETE to `/api/feed-items/<id>/like`.

Block-pair-adjusted like counts: a like by user X on a feed_item by user Y is invisible to ALL viewers (not just the block-pair members) once a block exists between X and Y. The query subtracts `COUNT(DISTINCT fl.user_id)` over JOIN'd block-pair rows to protect against mutual A↔B blocks double-counting the same like.

## S3 reclaim on edit/delete

Rating images live at `wines/ci_<userId>_<keyId>.<ext>` keyed by `Date.now()` at POST and at PATCH (so a PATCH that replaces an image always uses a different key). PATCH and DELETE both call a local `reclaimImage` helper that issues `DeleteObjectCommand` for the previous URL — fire-and-forget, logs failures, never blocks the user response.

**The capture-before-delete / commit / reclaim-after pattern is the cross-cutting rule** (per root CLAUDE.md). Every rating-delete path — ban-tx wipe, account deletion, and the engagement-deletion cascade (`lib/engagementCascade.ts`) — captures `rating_images.imageUrl` into memory BEFORE the DELETE, commits the cascade, then fires `reclaimImage()` AFTER commit. A transaction rollback never leaves orphan S3 deletes. ("Had a sip" COPIES bytes via S3 `CopyObjectCommand`; it doesn't reclaim, and the new check-in owns its own copy outright.)

`wines.imageUrl` is the canonical catalog bottle shot. Standalone POSTs write `NULL` on the wine row — the user's tasting photo lives on `rating_images`, not on the wine. This way a cascade-delete of the rating doesn't leave a dangling S3 pointer on a wine row that may survive (bookmarked from elsewhere).

## "Had a sip" copy flow

A logged-in viewer who follows the source author can clone a standalone feed_item (`+ had a sip` button on feed cards and `/u/<id>`). Wire field is `copyFromCheckinId` (name preserved for client/URL compatibility; semantics shifted to a `feed_items.id` of `kind='standalone'`).

Server resolves the source feed_item, rejects unless: `kind === 'standalone'` AND source has a rating AND `viewerCanSeeAuthor(viewerId, source.userId)` returns true AND the viewer follows the author AND `source.userId !== viewerId`. All failure branches collapse to a single generic `400` to avoid enumeration of per-id existence / ownership / follow state.

On success, mints a FRESH wine + rating + feed_item + rating_image row in the new model (Path B per `proposals/rewire.md` §5). No shared wine identity — the no-dedup non-goal applies here too. Source image priority: the rating's first attached image (the user's tasting photo) falling back to the wine's canonical bottle shot. Bytes are S3-copied server-side into a fresh user-owned key; the image URL itself is never trusted from the client.

The feed payload includes `viewerFollowsAuthor` per feed_item to gate the button without a per-row roundtrip.

## Places search

`/api/places` is a thin adapter: Google Places when `GOOGLE_PLACES_API_KEY` is set, OSM Overpass + Nominatim fallback otherwise. Both upstreams parameterised via `fetchJson` helper that throws labelled errors on non-OK / non-JSON responses (so transient outages surface in logs instead of a generic SyntaxError).

## Public surface

Profiles at `/u/<id>` are public reads; viewer's `isFollowing` flag populated when authed. `/api/users/search` is anonymous prefix lookup for follow/tag discovery — never participates in authorization (see root CLAUDE.md trust-model section).

Profile activity surfaces BOTH `kind='standalone'` feed_items (rendered via `<CheckinCard>`) AND `kind='session'` feed_items (rendered via `<SessionFeedCard>`). Profile-stat `checkins` (tile labelled "tastes" on the profile UI) counts every `ratings` row for the user — session and standalone combined, including chips-only / score-zero rows. Sourced directly via `prisma.rating.count` rather than `users.lifetime_ratings` (which has a known parity gap with standalone POSTs, captured in `.local/future-work-rewire.md`).
