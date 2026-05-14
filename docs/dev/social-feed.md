# Social feed — implementation

A separate logged-in surface around individual users — sessions are still the primary tasting context, the feed is *what someone has been drinking* outside or alongside sessions.

## Schema (Postgres, additive — sessions / ratings / Hall of Fame unaffected)

- `follows(followerId, followingId)` — explicit social graph, composite PK, cascade on user delete. No-self-follow is enforced at both the DB level (CHECK constraint in the migration SQL — not visible in `schema.prisma`) and the route level (`/api/users/<id>/follow` rejects with 400).
- `checkins(id, userId, wineName, producer, vintage, grape, type, score, flavors, notes, imageUrl, venueName, city, country, lat, lng, isPublic, createdAt)` — standalone wine logs (no session).
- `checkin_likes(userId, checkinId)` — composite PK, cascade.
- `checkin_tags(checkinId, userId)` — composite PK; `userId` is the *tagged* user, not the author.

## Network query

`/api/feed` resolves the caller's "network" as the union of: the caller themselves, everyone they follow, and everyone they share a session with (`session_members` self-join). The feed merges check-ins (public only) and badge unlocks (last 30 days) ordered by createdAt, paginated by cursor.

## Tags require mutual follow

`/api/checkins` POST and PATCH both run a SQL self-join against `follows` to filter the requested `taggedUserIds` down to mutual-follows-of-the-author. Non-mutuals are silently dropped server-side — clients can request anyone, only mutuals get persisted. Edit-time re-validation means an unfollow after creation drops the tag on the next save (acceptable: if you can't tag them today, the tag shouldn't survive an edit).

## Likes are persisted

`/api/feed` includes a `liked: boolean` per check-in, computed by a single `checkin_likes` lookup keyed by the caller. The like button reflects the server state; toggling sends POST or DELETE to `/api/checkins/<id>/like`.

## S3 reclaim on edit/delete

Check-in images live at `wines/ci_<userId>_<keyId>.<ext>` (POST keys by timestamp, PATCH keys by check-in id, so a PATCH that replaces an image always uses a different key). PATCH and DELETE both call a local `reclaimImage` helper that issues `DeleteObjectCommand` for the previous URL — fire-and-forget, logs failures, never blocks the user response.

## "Had a sip" copy flow

A logged-in viewer who follows the source author can clone a public check-in (`+ had a sip` button on feed cards and `/u/<id>`). Wire field is `copyFromCheckinId` — image URL is never trusted from the client; server resolves the row, rejects unless source `isPublic` + source author ≠ caller + caller→source follow exists, then S3 `CopyObjectCommand`s into a fresh key the copier owns. No refcount: each check-in owns its image bytes outright, so existing `reclaimImage` paths stay correct. The feed payload includes `viewerFollowsAuthor` per check-in to gate the button without a per-row roundtrip.

## Places search

`/api/places` is a thin adapter: Google Places when `GOOGLE_PLACES_API_KEY` is set, OSM Overpass + Nominatim fallback otherwise. Both upstreams parameterised via `fetchJson` helper that throws labelled errors on non-OK / non-JSON responses (so transient outages surface in logs instead of a generic SyntaxError).

## Public surface

Profiles at `/u/<id>` are public reads; viewer's `isFollowing` flag populated when authed. `/api/users/search` is anonymous prefix lookup for follow/tag discovery — never participates in authorization (see root CLAUDE.md trust-model section).
