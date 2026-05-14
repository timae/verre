# Account deletion — implementation

`DELETE /api/me/account` takes `{password}`, bcrypt-verifies against the user row, then:

1. **Postgres transaction**: tombstones references on tables with `ON DELETE NoAction` (`UPDATE ratings SET user_id=NULL, rater_name='[deleted]'` etc. for `ratings`, `hall_of_fame`, `sessions.host_user_id`), then `DELETE FROM users WHERE id=$id`. Cascades fire on `bookmarks`, `user_badges`, `session_members`.
2. **Redis cleanup** (`lib/accountDelete.ts`): SCAN every `s:*:meta` and decide per session:
   - If user is host AND no non-host has rated yet → drop the entire session (Redis + Postgres `sessions` row + wines orphan + session_members delete) so the session vanishes from participants' `/me/history`.
   - If user is host AND there's engagement → keep the session alive, set `meta.host = '[deleted]'`, null `meta.hostUserId` and `meta.hostIdentityId`. The softened strict-host check in `app/api/session/[code]/route.ts` lets cohorts delete the session from there.
   - If user is cohost or plain participant → relabel their identity-map entry to `'[deleted]'` and drop them from `meta.coHostIds`. Their rating data stays so other tasters' compare views are unchanged.

The plan + apply runs as a single SCAN+decide+act loop per session — no TOCTOU window between observation and action.

UI lives in `components/me/AccountSettings.tsx` as a Danger Zone modal: shows the email read-only, asks for password, on success wipes all `vr_anon_*` / `vr_name_*` / `vr_id_*` localStorage keys (so other tabs in the same browser don't render with stale identity) and `signOut()`s.

## Concrete cascade vs tombstone choices

Per the cross-cutting rule in root CLAUDE.md, this codebase applies:

- **Tombstone** (UPDATE → `[deleted]`, FK set to NULL): `ratings`, `hall_of_fame`, hosted `sessions.host_user_id`, the in-Redis identity map. Reason: deleting one user shouldn't break other tasters' compare views or Hall of Fame leaderboard.
- **Cascade hard-delete** (FK `onDelete: Cascade`): `checkins`, `checkin_likes`, `checkin_tags`, `follows`, `bookmarks`, `user_badges`, `session_members`. Postgres handles these atomically inside the same transaction.

When adding a new table tied to users, decide which side it falls on using the test in root CLAUDE.md.

## S3 image reclaim is independent of cascade

Postgres cascade-deleting a row does NOT trigger S3 cleanup — the bytes stay in the bucket forever unless the deletion path explicitly fires `reclaimImage()`. Any new table that stores an `imageUrl` field needs explicit reclaim added to its deletion paths (account-delete, session-delete, edit-replace). See `lib/accountDelete.ts` and `app/api/session/[code]/route.ts` for examples.
