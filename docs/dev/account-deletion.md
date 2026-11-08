# Account deletion — implementation

`DELETE /api/me/account` takes `{password}`, bcrypt-verifies against the user row, then runs the cleanup in `lib/accountDelete.ts`:

## Pipeline (redis-rehydration release A — `docs/dev/proposals/redis-rehydration.md` § 6)

🔒 **One Postgres transaction over every session the user touched AND the user row.** Nothing commits per session: a failure anywhere rolls everything back, the account and every reference stay exactly as they were, and the deletion is retryable with no progress table. (Per-session commits would detach a still-live account's ratings and let a retry mint a second tombstone identity for the same person in the same session.)

1. **Native sessions first** (`deleteAllNativeSessions`, through the identity chokepoint, time-bounded) — the only step that commits before the transaction; revoke-first is the safe failure order.
2. **Capture image URLs** of rows that go unconditionally (standalone rating images, hosted-session wine photos, the avatar). Rows decided under the locks capture their images inside the transaction. Every reclaim fires only after COMMIT.
3. **Discovery** (plain SELECTs, outside any lock) is a TENTATIVE plan: it only names the session codes to lock — hosted ∪ member rows ∪ rated ∪ wines added by `u:<id>` — and enforces `ACCOUNT_DELETE_MAX_WIPES` (empty hosted sessions) BEFORE any durable statement (the request fails retryably naming the count; no pre-pass).
4. **The transaction.** `withSessionLocks` (`lib/sessionMutation.ts`): advisory locks `hashtext('session:' || code)` in sorted code order, then the live `sessions` rows `FOR UPDATE`; then the `users` row `FOR UPDATE`; then the touched set is re-read (grew ⇒ retry). Per session, the branch is **decided from state re-read under those locks**:
   - **hosted ∧ unengaged now** (no Postgres rating by anyone else, tombstones count; and — only then — no other identity's rating key in Redis) → **wipe**: the DELETE-route scrub contract, the host's own ratings deleted, wines orphaned, members / bans / HoF rows deleted, a `session_tombstones` row, and the session's Redis keys deleted **inside** the transaction on a fail-fast connection. A Redis failure rolls the whole deletion back.
   - **kicked** (`removed_state = 'kicked'`) → the user's ratings there are **hard-deleted** (they were kept only for the user's own history).
   - **otherwise** → **anonymize**: one fresh `tombstone_key = 'd:<uuid>'` per (user, session) on the user's ratings (`user_id → NULL`, `rater_name → '[deleted]'`); the user's wines' provenance → that key + `'[deleted]'`; host columns tombstoned if hosted; the user's `session_bans` row deleted.
   - Soft-deleted sessions (no code) get one key per session on the user's ratings, unlocked.
   - Account level: standalone ratings hard-cascade; HoF tombstoned (deprecated surface, outside the tombstone-key contract); the user's session-less wines lose their name; `session_bans` rows for `u:<id>` deleted; `DELETE FROM users` (its NO ACTION FKs refuse if a session rating or hosted session was missed). A deadlock (only possible with the user's own concurrent write) retries the whole operation, bounded.
5. **After COMMIT** — projections, best-effort, time-bounded, compare-and-set: the **`d:` migration** of each live anonymized session's Redis copy (rating keys renamed to the `d:` identity or deleted for a kicked session, identities entry swapped, provenance rewritten in the wines array, the user dropped from `coHostIds`/`providerIds`, host fields tombstoned in meta; Lua, idempotent, skip-missing); the user's **Redis-only registrations** (a logged-in `/join` on a session with no Postgres trace of them) relabeled or removed; the `u:<id>:carouselhidden` key. A projection that fails leaves presentation stale only: the record holds the keys, and `wineToWire` renders `'[deleted]'` for any `u:` adder whose users row is gone.

No Redis lease in release A: no other writer takes one yet. Accepted residuals until release B: an anonymous rating that lands between the engagement re-read and the wipe is wiped with the moment; a stale writer can recreate keys after the wipe; a transaction that fails after its Redis wipe leaves that empty moment unreadable until B's rebuild.

UI lives in `components/me/AccountSettings.tsx` as a Danger Zone modal: shows the email read-only, asks for password, on success wipes all `vr_anon_*` / `vr_name_*` / `vr_id_*` localStorage keys (so other tabs in the same browser don't render with stale identity) and `signOut()`s.

## Concrete cascade vs tombstone choices

Per the cross-cutting rule in root CLAUDE.md:

- **Tombstone** (UPDATE → `[deleted]` or NULL on the FK column):
  - `ratings` WHERE `session_id IS NOT NULL` — session ratings; other tasters' compare views + HoF need them. Each carries `tombstone_key` (one `d:<uuid>` per deleted user per session) so the anonymous rater stays one identity; kicked-session ratings are hard-deleted instead.
  - `wines.added_by_identity_id` / `added_by_display_name` of the user's wines → the session's tombstone key + `'[deleted]'`.
  - `hall_of_fame` — legacy "Perfect 5s" table; preserved until Tim's HoF v2 work decides its fate.
  - hosted `sessions.host_user_id` — cohorts inherit administration when the host's account dies.
  - in-Redis identity map entries (migrated to the session's `d:` tombstone identity).
- **Cascade hard-delete** (FK `onDelete: Cascade` on the user side):
  - `ratings` WHERE `session_id IS NULL` — standalone ratings have no other user dependents. Their `feed_items` (1:1, `kind='standalone'`) and `rating_images` go with them via downstream cascades on `feed_items.rating_id` and `rating_images.rating_id`.
  - `feed_items` (kind='session') — the user's session posts. Cascade via `feed_items.user_id`.
  - `feed_item_likes`, `feed_item_tags` — both sides cascade via the user FK.
  - `bookmarks`, `user_badges`, `session_members`, `user_mutes`, `user_blocks`, `follows` — all cascade.

When adding a new table tied to users, decide which side it falls on using the test in root CLAUDE.md.

## S3 image reclaim is independent of cascade

Postgres cascade-deleting a row does NOT trigger S3 cleanup — the bytes stay in the bucket forever unless the deletion path explicitly fires `reclaimImage()`. Any new table that stores an `imageUrl` field needs explicit reclaim added to its deletion paths (account-delete, session-delete, edit-replace). See `lib/accountDelete.ts` and `app/api/session/[code]/route.ts` for examples.

The capture-before-delete / commit / reclaim-after ordering is mandatory. A transaction rollback after captured URLs were already S3-deleted would leave a "DB says image exists, S3 says it doesn't" inconsistency. The pattern guarantees the inverse: S3 deletes never happen unless the DB commit succeeds first.
