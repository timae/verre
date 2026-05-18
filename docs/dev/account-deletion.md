# Account deletion — implementation

`DELETE /api/me/account` takes `{password}`, bcrypt-verifies against the user row, then runs the cleanup in `lib/accountDelete.ts`:

## Postgres pipeline

The rewire phase 2 cutover split rating treatment by `session_id`. Pipeline:

1. **Capture image URLs BEFORE the transaction** (capture / commit / reclaim-after, per root CLAUDE.md):
   - Standalone `rating_images.image_url` for ratings where `userId = $id AND sessionId IS NULL`. These cascade with the rating below.
   - `wines.imageUrl` for wines hosted in sessions the user hosted (host-curated bottle shots).
   - The user's own avatar (`users.imageUrl`).
   - Session ratings (`sessionId IS NOT NULL`) are NOT captured — their rating_images survive with the tombstoned rating (other tasters' compare views still need them).

2. **Single Postgres transaction**:
   - `DELETE FROM ratings WHERE user_id = $id AND session_id IS NULL` — hard-cascades standalone ratings. Their feed_items (kind='standalone', 1:1 via ratingId) cascade via `feed_items.rating_id` FK; their `rating_images` cascade via `rating_images.rating_id` FK.
   - `UPDATE ratings SET user_id=NULL, rater_name='[deleted]' WHERE user_id = $id AND session_id IS NOT NULL` — tombstones session ratings (other tasters' compare views need them).
   - `UPDATE hall_of_fame SET user_id=NULL, rater_name='[deleted]' WHERE user_id = $id` — tombstones HoF rows (today's behaviour preserved).
   - `UPDATE sessions SET host_user_id=NULL, host_name='[deleted]' WHERE host_user_id = $id` — tombstones host fields on live sessions the user hosted. Already-soft-deleted sessions have `host_user_id` NULL so they don't match.
   - `DELETE FROM users WHERE id = $id` — cascades the rest (see below).

3. **S3 reclaim AFTER commit** — fire-and-forget on all captured URLs. If S3 fails, the bytes become orphan; the DB state is correct.

4. **Redis cleanup** (`applyRedisCleanup`): SCAN every `s:*:meta` and decide per session:
   - If user is host AND no non-host has rated yet → drop the entire session (Redis + Postgres soft-delete). Order: Redis FIRST (so a concurrent rate POST sees no meta and 404s), then Postgres scrub via `deleteSessionFromPostgres` (now also a soft-delete since the rewire phase 2 trigger blocks hard-deletes — see `docs/dev/session-deletion.md` for the trigger contract).
   - If user is host AND there's engagement → keep the session alive, set `meta.host = '[deleted]'`, null `meta.hostUserId` and `meta.hostIdentityId`. The softened strict-host check in `app/api/session/[code]/route.ts` lets cohosts delete the session from there.
   - If user is cohost or plain participant → relabel their identity-map entry to `'[deleted]'` and drop them from `meta.coHostIds`. Their rating data stays so other tasters' compare views are unchanged.

The plan + apply runs as a single SCAN+decide+act loop per session — no TOCTOU window between observation and action.

UI lives in `components/me/AccountSettings.tsx` as a Danger Zone modal: shows the email read-only, asks for password, on success wipes all `vr_anon_*` / `vr_name_*` / `vr_id_*` localStorage keys (so other tabs in the same browser don't render with stale identity) and `signOut()`s.

## Concrete cascade vs tombstone choices

Per the cross-cutting rule in root CLAUDE.md:

- **Tombstone** (UPDATE → `[deleted]` or NULL on the FK column):
  - `ratings` WHERE `session_id IS NOT NULL` — session ratings; other tasters' compare views + HoF need them.
  - `hall_of_fame` — legacy "Perfect 5s" table; preserved until Tim's HoF v2 work decides its fate.
  - hosted `sessions.host_user_id` — cohorts inherit administration when the host's account dies.
  - in-Redis identity map entries.
- **Cascade hard-delete** (FK `onDelete: Cascade` on the user side):
  - `ratings` WHERE `session_id IS NULL` — standalone ratings have no other user dependents. Their `feed_items` (1:1, `kind='standalone'`) and `rating_images` go with them via downstream cascades on `feed_items.rating_id` and `rating_images.rating_id`.
  - `feed_items` (kind='session') — the user's session posts. Cascade via `feed_items.user_id`.
  - `feed_item_likes`, `feed_item_tags` — both sides cascade via the user FK.
  - `bookmarks`, `user_badges`, `session_members`, `user_mutes`, `user_blocks`, `follows` — all cascade.

When adding a new table tied to users, decide which side it falls on using the test in root CLAUDE.md.

## S3 image reclaim is independent of cascade

Postgres cascade-deleting a row does NOT trigger S3 cleanup — the bytes stay in the bucket forever unless the deletion path explicitly fires `reclaimImage()`. Any new table that stores an `imageUrl` field needs explicit reclaim added to its deletion paths (account-delete, session-delete, edit-replace). See `lib/accountDelete.ts` and `app/api/session/[code]/route.ts` for examples.

The capture-before-delete / commit / reclaim-after ordering is mandatory. A transaction rollback after captured URLs were already S3-deleted would leave a "DB says image exists, S3 says it doesn't" inconsistency. The pattern guarantees the inverse: S3 deletes never happen unless the DB commit succeeds first.
