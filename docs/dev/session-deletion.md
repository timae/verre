# Session deletion — implementation

Hosts (not cohosts) can permanently delete a session. `DELETE /api/session/<code>`, host-strict authorization.

> **Phasing note.** This document describes the **post-rewire** soft-delete model. The schema column (`sessions.deleted_at`) and partial index ship in **phase 1** of the rewire ([docs/dev/proposals/rewire.md](proposals/rewire.md)); the endpoint cutover from hard-delete to soft-delete + scrub ships in **phase 2**. Until phase 2 lands, the live behaviour still matches the pre-rewire doc — the retention rule below describes the destination, not the current state. Search git history for the old "rating retention by bookmark" rule if you need to read the pre-rewire behaviour.

## Soft-delete, not hard-delete

`DELETE /api/session/<code>` is a soft-delete: the `sessions` row is preserved as a tombstone, with `deleted_at = now()` and **every other column scrubbed to NULL**. The row's id is the grouping key for `ratings.session_id` and `feed_items.session_id` — preserving it is how every existing "show me my history from this session" query keeps working after deletion.

### Data-survival contract for a deleted session

After the soft-delete commits, the only data guaranteed to survive on the `sessions` row itself is:

- `id` — the grouping key; children (wines, ratings, feed_items) keep their FK references.
- `deleted_at` — the tombstone marker.

**Every other column is scrubbed to NULL**: `name`, `description`, `link`, `code`, `host_user_id`, `host_name`, `timezone`, `created_at`, `archived_at`, `address`, `date_from`, `date_to`, `blind`, and anything else added later. The tombstone is genuinely empty — you can tell the row exists and that it was deleted, nothing more.

The minimal contract is the easiest to audit for privacy and forces explicit doc + schema updates the day someone wants a specific field to survive. Cost is small: tombstoned-session UX in user history shows just "[deleted session]" with no extra context.

### Children survive untouched

- `wines.session_id` keeps pointing at the deleted session's id (today's behaviour preserved). Wine detail pages reachable from `/me/saved` MUST JOIN `sessions` to read `deleted_at` and render "[deleted session]" — never the scrubbed (NULL) name.
- `ratings.session_id` keeps pointing at the deleted session's id.
- `feed_items.session_id` keeps pointing at the deleted session's id.
- All ratings, feed_items, likes, tags, and `rating_images` survive untouched.
- `ratings.rated_at` is the relevant timestamp for "when did the user taste this" — on the rating row, never on the session, so deletion doesn't affect it.

### Why soft-delete instead of nulling the child FKs

The `session_id` is the only natural grouping key for "all my ratings from this tasting" and "all wines on this post." Nulling it on ratings/feed_items would collapse a user's three deleted-session posts into one indistinguishable bucket of orphaned ratings. Soft-delete preserves grouping for free, without any new column on either child table.

## Cohost behaviour after soft-delete

A deleted session is gone for everyone, including cohosts. The session-existence reads in `lib/session.ts` resolvers and `/api/session/[code]` endpoints filter `WHERE deleted_at IS NULL`, so cohost links 404 the same as everyone else's. Soft-delete is final from the user perspective; nothing about the cohost role grants visibility into tombstoned sessions.

## Lifespan expiry vs soft-delete — independent concepts

A session can be in one of three states:

| State | `deleted_at` | Redis | UI behaviour |
|---|---|---|---|
| **Live** | NULL | `s:{CODE}:meta` exists | Full live behaviour (admin, rate, etc.) |
| **Expired by lifespan** | NULL | gone (TTL expired) | Postgres row stays. Profile/feed/Tastes JOIN it as a normal session and render its name as historical context. Live-session URL doesn't work because Redis is empty. The session-existence filter does **not** exclude it. |
| **Soft-deleted** | non-null | wiped | Profile/feed/Tastes surfaces render "[deleted session]" with no link. Live-session URL 404s. |

Two different lifecycles, no overlap. The `deleted_at` column is for explicit host-deletion only; expiry-by-lifespan is unchanged from today.

## Side effects that continue to fire on the soft-delete path

Only the final `DELETE FROM sessions` becomes an `UPDATE sessions SET deleted_at = now(), <every-other-col> = NULL`. Everything else stays the same:

- **Hall of Fame cleanup** — unchanged; the existing rule applies (kept when bookmarked, dropped otherwise). Tim is reworking HoF separately; the rewire does not touch it.
- **S3 reclaim** for orphaned wine images on wines that no longer have any retained ratings.
- **`session_members` wipe** — cleared so future re-join flows don't pre-populate from a deleted session's roster.
- **Redis purge** of `s:{CODE}:*` keys — the live session bus is gone immediately.

The pre-rewire "delete unbookmarked ratings" cleanup is **removed** in phase 2. Ratings and feed_items survive the soft-delete; the tombstone label is what hides the deleted session from live use.

## Soft-delete vs hard-delete (GDPR purge) — different operations

A future GDPR / retention-window purge job is **not** the same operation as soft-delete. The plan ([proposals/rewire.md](proposals/rewire.md), §4 "Out of scope" item #12) captures hard-delete as future work. When it ships, the FK contract requires explicit cleanup before `DELETE FROM sessions`, because the three child FKs behave differently on delete:

1. `UPDATE feed_items SET session_id = NULL WHERE session_id = $sid` (FK is `ON DELETE RESTRICT` — a bare `DELETE FROM sessions` would be rejected).
2. `UPDATE ratings SET session_id = NULL WHERE session_id = $sid` (same — `ON DELETE RESTRICT`).
3. `DELETE FROM sessions WHERE id = $sid` (wines orphan automatically: `wines.session_id` is `ON DELETE SET NULL`).

Restrict was chosen over SetNull on the new FKs deliberately (see [proposals/rewire.md](proposals/rewire.md), §2 `feed_items` reasoning) — to force this cleanup to be explicit rather than silent. `wines.session_id` keeps its pre-existing `SET NULL` so bookmarked wines stay reachable after a session is gone.

## Participants in the deleted session

Get bounced when their next polled wines GET returns 404 (the live endpoint filters `deleted_at IS NULL`). SessionShell clears local cache for that code and redirects to `/join/<code>`, which renders the "session not found" page.

## Lifetime snapshot counters never decrement

`users.lifetime_ratings` etc. stay at the higher value even after a session is deleted — protects badge progression. Live aggregations (avg flavor, total_rated count) reflect the actual rating count, which now stays high since nothing is deleted from `ratings` on soft-delete.

## Host account deletion is a separate flow

When a host deletes their *account* (not the session), the rules in [`account-deletion.md`](account-deletion.md) apply — sessions with engagement stay alive with the host identity tombstoned to `[deleted]`; cohosts can administer. The session-soft-delete rule above only fires when the host (or eventually a cohost) actively deletes the session via `DELETE /api/session/[code]`. Different flows, different rules; no overlap.
