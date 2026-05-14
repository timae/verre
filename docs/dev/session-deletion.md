# Session deletion — implementation

Hosts (not cohosts) can permanently delete a session. `DELETE /api/session/<code>`, host-strict authorization.

## Retention rule

Per `(user, wine)` pair:
- If the user **bookmarked** the wine, their rating row is **kept** so the bookmark detail page still renders score, notes, flavour wheel.
- If the user **didn't bookmark**, their rating is deleted. Hall of Fame entries follow the same rule (kept when bookmarked, dropped otherwise).

The wine rows themselves are kept (`session_id` set to NULL via the `ON DELETE SET NULL` foreign key) so bookmarked wines remain reachable from `/me/saved` with image and metadata intact.

## Lifetime snapshot counters never decrement

`users.lifetime_ratings` etc. stay at the higher value even after the underlying ratings are gone — protects badge progression. The live aggregations in `/me/profile` (avg flavor, total_rated count) will reflect the smaller dataset.

The full Postgres cleanup runs in a `prisma.$transaction` so any failure rolls back; Redis wipe (`s:<code>:*`) runs after.

## Participants in the deleted session

Get bounced when their next polled wines GET returns 404. SessionShell clears local cache for that code and redirects to `/join/<code>`, which renders the "session not found" page.
