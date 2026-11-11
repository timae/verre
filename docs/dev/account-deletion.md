# Account deletion — implementation

`DELETE /api/me/account` takes `{password}`, bcrypt-verifies against the user row, then runs the cleanup in `lib/accountDelete.ts`:

## Pipeline (redis-rehydration releases A + B — `docs/dev/proposals/redis-rehydration.md` § 6)

🔒 **One Postgres transaction over every session the user touched AND the user row.** Nothing commits per session: a failure anywhere rolls everything back, the account and every reference stay exactly as they were, and the deletion is retryable with no progress table. (Per-session commits would detach a still-live account's ratings and let a retry mint a second tombstone identity for the same person in the same session.)

1. **Native sessions first** (`deleteAllNativeSessions`, through the identity chokepoint, time-bounded) — the only step that commits before the transaction; revoke-first is the safe failure order.
2. **Capture image URLs** of rows that go unconditionally (standalone rating images) before the transaction. Everything decided under the locks captures its images inside the transaction: the profile photo + cover (read with the users row `FOR UPDATE`, so a concurrent replace blocked on that lock finds no row and reclaims its own upload, `lib/profileImage.ts`), and the wine photos of a moment WIPED with the account in two phases (ruling D9, 2026-11-10): (1) the wipe captures its wines' (id, url) before orphaning them; (2) after the rating deletes AND the `DELETE FROM users` cascade (the user's own bookmarks), only candidates with no remaining rating and no remaining bookmark join the attempt's reclaim set. A moment that SURVIVES the deletion (anonymised) keeps every wine photo: its line-up still shows them (ruled 2026-11-10; until then every hosted wine photo was reclaimed). Every reclaim fires only after COMMIT, and only the committed attempt's set (a rolled-back or replanned attempt reclaims nothing). Pinned by `scripts/tests/you-profile-integration.mts` § 4. 🔒 Forward rule: when users can add photos to MOMENT impressions, those are their own uploads and must be reclaimed here (today's tombstone path keeps a tombstoned rating's `rating_images`).
3. **Discovery** (plain SELECTs, outside any lock) is a TENTATIVE plan: it names the codes to lock — hosted ∪ member rows ∪ rated ∪ wines added by `u:<id>` — and the **wipe candidates**: hosted sessions with no Postgres rating by anyone else, ∪ every code reserved by an earlier `'replan'`. More candidates than `ACCOUNT_DELETE_MAX_WIPES` fails the request retryably, naming the count, BEFORE anything durable (no pre-pass).
4. **Leases** (release B): `lock:session:{CODE}` for each candidate, sorted, on the fail-fast client, BEFORE the transaction — a lease taken while holding advisory locks would invert the lock order (Redis → advisory → row). Busy or Redis unreachable → retryable failure, nothing changed. A deletion with no candidate issues no Redis command at all.
5. **The transaction.** `withSessionLocks` (`lib/sessionMutation.ts`): advisory locks `hashtext('session:' || code)` in sorted code order, then the live `sessions` rows `FOR UPDATE`; entry checks for the leased codes (lease still ours, cache holds this incarnation); then the `users` row `FOR UPDATE`; then the touched set is re-read (grew ⇒ retry). Per session, the branch is **decided from state re-read under those locks** (every rating writer takes the session's advisory lock, so the Postgres engagement read is authoritative):
   - **hosted ∧ unengaged in Postgres ∧ leased** → the anonymous rating keys (read under the lease) decide: engaged → anonymize; empty → **wipe**: the DELETE-route scrub contract, the host's own ratings deleted, wines orphaned, members / bans / HoF rows deleted, a `session_tombstones` row, and the session's Redis keys deleted **inside** the transaction through a **fenced DEL** (Lua token check). A Redis failure or a lost lease rolls the whole deletion back.
   - **hosted ∧ unengaged in Postgres ∧ NOT leased** (it became empty after discovery) → **`'replan'`**: roll back, release the leases, restart from discovery with the code reserved (at most 3, then retryable). The reservation carry-over is what prevents a loop.
   - **kicked** (`removed_state = 'kicked'`) → the user's ratings there are **hard-deleted** (they were kept only for the user's own history).
   - **otherwise** → **anonymize**: one fresh `tombstone_key = 'd:<uuid>'` per (user, session) on the user's ratings (`user_id → NULL`, `rater_name → '[deleted]'`); the user's wines' provenance → that key + `'[deleted]'`; host columns tombstoned if hosted; the user's `session_bans` row deleted. A reserved lease it no longer needs is released after COMMIT.
   - Before each session's work every held lease is **renewed** (fenced); a refused renew rolls everything back.
   - Soft-deleted sessions (no code) get one key per session on the user's ratings, unlocked.
   - Account level: standalone ratings hard-cascade; HoF tombstoned (deprecated surface, outside the tombstone-key contract); the user's session-less wines lose their name; `session_bans` rows for `u:<id>` deleted; `DELETE FROM users` — its NO ACTION FKs and the `ratings_session_rater_known` CHECK refuse if a session rating or hosted session was missed. A deadlock (only possible with the user's own concurrent write) retries the whole operation, bounded.
6. **After COMMIT** — projections, best-effort, time-bounded, never on an offline client: the **`d:` migration** of each live anonymized session's Redis copy (rating keys renamed to the `d:` identity or deleted for a kicked session, identities entry swapped, provenance rewritten in the wines array, the user dropped from `coHostIds`/`providerIds`, host fields tombstoned in meta; Lua, idempotent, skip-missing), **under that session's lease** (the held one, or one acquired for it) and **bumping the publication generation** (`s:{C}:gen`) so a rebuild that read the pre-deletion record can never publish it. Busy or failed → **scoped invalidation** (meta DEL if it is still this incarnation + a generation bump): the next open rebuilds from the record, whose reconciliation removes the gone user. Then the user's **Redis-only registrations** (a logged-in `/join` on a session with no Postgres trace of them), relabeled or removed under each session's lock (busy → skipped, logged), and the `u:<id>:carouselhidden` key. If both the migration and its invalidation fail (Redis down), the deleted user's name stays in that roster until a rebuild; `wineToWire` already renders `'[deleted]'` for any `u:` adder whose users row is gone.

Release A's residuals are closed by B: a rate takes the session's advisory lock, so an anonymous rating either committed before the engagement re-read or finds the session gone; a stale writer cannot recreate `meta` / `wines` (NX/XX) or a shared-state key (fenced); a transaction that fails after its wipe leaves a live row whose next open rebuilds it. A worker killed mid-deletion holds its leases until they lapse (15 s): an immediate retry is told "busy, try again".

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
