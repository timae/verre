# Usernames

**Status:** APPROVED 2026-11-13 (decisions D1 to D5, § 14; one Claude reviewer converged after two rounds, Codex approved after three, § 17). **SERVER HALF BUILT 2026-11-14** on `feature/usernames-server` (as built: § 18). The UI session is next (§ 13).

Three sessions: this plan (one reviewer), the server build, the UI build. Where the username shows in the UI is NOT decided here (§ 13 lists what the UI session gets).

## 1. Why

People should find and recognise each other by a unique name they chose: `@simon`. For display and for finding friends. From the next release on, every user has one.

**Not goals:** login by username, usernames inside moments, venue and producer pages (their route words are only reserved), any change to the id model.

## 2. Already ruled (2026-11-13)

- **Overrules one line of public ids.** `public-user-ids.md` § 2 "Not handles" is reversed. Everything else there stands.
- **Internally everything stays id.** The integer and the public id are unchanged. The username is a lookup and display name: follows, tags, bans, roles and every API id keep the public id. No sign-in by username (no Better Auth username plugin).
- **Same release as public ids** (local `main`, hold mode, behind the forced app update). The app build keeps 0.1.5 (§ 14 D4).
- **URL `/@username`**, by rewrite (an `@folder` is a parallel-routes slot). `/u/<publicId>` keeps working. The QR keeps the public id (it survives a rename); the share link uses `/@name`.
- **Rules:** lowercase, `a-z 0-9 . _`, no two dots in a row, 3 to 30 characters, unique. Reserved: every top-level route word (with `place`, `producer`), the brand, staff words, the reserved display names.
- **Renames:** 5 changes per 3 months. The most recent old name is held for its former owner 14 days. A deleted account's name is held 14 days too (ruled in this session, down from the 90 first proposed), stored as a hash.
- **Logged out, non-public profile:** today's name-only shell, unchanged.
- **Existing users:** a blocking "choose your username" screen at the next login, app and web. No auto-generated names.
- **Sign-up:** the username is on the form, web and app.
- **The app sign-up's fake success goes.** Sign-up answers "email already registered" honestly, like the web; the rate limits are the defence.
- **Search** finds people by name and by username.
- **Inside moments: no username.** Roster, meta and the Redis cache stay as they are.
- **Labels** "Name" and "Username"; outside forms `@name`.
- **Password AutoFill:** the email stays the login for password managers (UI session, § 13).

## 3. Schema

One new migration, additive, in `BEGIN` / `COMMIT` with `SET LOCAL lock_timeout = '5s'` and the P3009 recovery note, like `20261112230000_public_user_ids`. It is a NEW file: the public-ids migration is already applied to shared dev databases and is never edited (`prisma/CLAUDE.md`). On release day both apply in order in one `migrate deploy`.

**`users.username VARCHAR(30) NULL`.** Lowercase VARCHAR, not citext: the rules allow only lowercase ASCII, so there is no case to fold, and citext would add an extension and a second comparison semantics to the hottest table.

- `users_username_key`: a plain unique index (NULLs stay distinct, so every existing row can be NULL).
- `users_username_format_chk`: `username IS NULL OR (username ~ '^[a-z0-9._]{3,30}$' AND username !~ '\.\.' AND username !~ '^\.' AND username !~ '\.$')`. It matches the FORMAT half of the core validator exactly (§ 4). 🔒 The reserved list is NOT in the CHECK: it is policy, it changes without a migration, and the operator script must be able to assign a reserved name (the brand's own account).
- A `pg_trgm` GIN index on `username`, declared in `schema.prisma` like the one on `name` (or the `migrate diff` gate fails).
- **Cost on `users`:** a nullable column with no default is a catalog-only change (no rewrite), but the transaction holds ACCESS EXCLUSIVE on `users` from the `ALTER` until COMMIT, through both index builds and the CHECK's validation scan. `lock_timeout` bounds only the WAIT for the lock, not how long it is held. At today's size (tens of rows) that is milliseconds; the release-day precheck records the row count and the migration's duration on a copy. Past roughly 100k users the index builds move into their own migrations as `CREATE INDEX CONCURRENTLY` (the transaction gate has an explicit carve-out for that, `scripts/check-migration-transactions.mjs`). The pre-deploy `pg_locks` check applies as before.
- **Nullable for good.** NULL means "has not chosen yet". No later `SET NOT NULL`: a future social sign-up creates the row before the person can choose.
- 🔒 **Set once, never cleared:** the trigger below refuses `username` going from a value back to NULL.

**`username_holds`**: `name_hash BYTEA PRIMARY KEY` (SHA-256 of the name), `user_id INT NULL` (the former owner of a rename hold, FK `ON DELETE SET NULL`; NULL for a deleted account's name), `username VARCHAR(30) NULL` (clear text for a RENAME hold only, so the owner can be shown "switch back to @old"; always NULL for a deleted account), `held_until TIMESTAMPTZ NOT NULL`. Indexes on `user_id` and `held_until`.

**`username_changes`**: `id`, `user_id INT NOT NULL` (FK `ON DELETE CASCADE`), `changed_at TIMESTAMPTZ NOT NULL DEFAULT now()`, index `(user_id, changed_at)`. The durable home of the rename quota.

Both tables get `schema.prisma` models whose index and foreign-key names are Prisma's own, or the `migrate diff` gate fails (`.github/workflows/check-schema.yml`). The CHECK, the functions and the triggers are invisible to that gate; the suite pins them (§ 12).

**`username_is_held(name, for_user)`**: one SQL function, the ONLY spelling of the hash and of "a live hold by someone else": `held_until > now() AND (for_user IS NULL OR user_id IS NULL OR user_id <> for_user)`. Spelled out because both NULLs matter: a sign-up has no user yet, and a deleted account's hold has none either; a NULL-safe comparison would read those two as "the same owner" and call the name free. The trigger and every app pre-check (§ 8, § 9) call it, so the two can't disagree.

**🔒 Holds are enforced by the database, not by app code (D1, ruled).** Four writers touch `users.username` (Better Auth's own insert at app sign-up, the web register, the change route, the operator script) plus every delete path. A trigger covers all of them and any future one, like the public-id mint trigger does:

- `AFTER INSERT` and `AFTER UPDATE OF username` (two row-level triggers on one function branching on `TG_OP`: a combined trigger can't name `OLD` in a `WHEN` clause). It returns at once when the new value is NULL (an old instance's register during the rolling deploy inserts one) or unchanged. Otherwise:
  1. Refuses unless the transaction is READ COMMITTED (see the race note).
  2. **Claim:** deletes the caller's OWN hold on the new name (switching back), then raises if `username_is_held` still says yes, with `ERRCODE = unique_violation` and `CONSTRAINT = 'users_username_held'`. The check tests `held_until > now()` itself; it never relies on the prune. A held name therefore fails exactly like a taken one. Through Prisma's MODEL calls that is `P2002` (`@prisma/adapter-pg` maps any SQLSTATE 23505, `dist/index.mjs:436-455`); a RAW statement gets `P2010` carrying the original code instead. So every app write of `username` is a model call (`tx.user.update`, `tx.user.create`), and one helper `isUsernameConflict(err)` recognises both shapes for the operator script.
  3. **Release** (an old name existed): deletes the user's other holds (only the MOST RECENT old name is held), then upserts a hold on the old name for 14 days.
  4. **Prune:** deletes expired holds, skipping rows another transaction has locked (so two concurrent writes can't deadlock on it). The delete trigger's prune uses the same form: it runs inside the account-deletion transaction, which can stay open for up to a minute.
- `BEFORE DELETE`: the user's own rename holds become anonymous (`user_id` and `username` NULL, their date kept), a non-NULL current name gets a 14-day hold with no user and no clear text (`ON CONFLICT (name_hash) DO UPDATE`, so an account deletion can never fail here: `lib/accountDelete.ts:438` is a raw `DELETE`), and expired holds are pruned. `lib/accountDelete.ts` needs no username code, and a raw `DELETE FROM users` holds the name too.
- `BEFORE UPDATE OF username`: refuses a change to NULL.
- **Expiry does not wait for the next username write:** the daily in-process prune (`lib/nativeSessionPrune.ts`, already once a day fleet-wide under its lock) also deletes expired holds, in its own `try` (a failure of the session prune must not skip it), so a deleted account's hash and a rename's clear-text old name are gone within a day or two of their 14 (the job's lock lives 20 hours, so a restart can push one run to the next day). The delete stays in `lib/`: `prisma/maintenance/*.sql` is held to an exact allow-list by the identity-writes gate.

The period (14 days, one constant for both kinds of hold) lives in the trigger function only; the API reads `held_until` from the row. `search_path` pinned on every function.

`UPDATE OF username` fires only for a statement that names the column. Prisma and Better Auth's adapter send only the supplied columns (`@better-auth/prisma-adapter/dist/index.mjs:308`), so the lifetime-counter bumps, profile edits and session writes never run it.

**The race, and why the trigger is AFTER.** B claims a name while A is releasing it (a rename or a deletion, not yet committed). B's row write waits on the unique index until A commits. An AFTER trigger runs after that wait, and under READ COMMITTED its queries see A's committed hold, so B is refused. A BEFORE trigger would have looked before the wait and missed it. Under REPEATABLE READ the trigger would read a stale snapshot, which is why step 1 refuses outright: two routes already use that level for other work (`app/api/me/bookmarks/route.ts:67`, `me/ratings/route.ts:58`; neither touches `users.username`), and a username write must never be added inside such a transaction. Nothing that writes `users` today runs above READ COMMITTED: account deletion uses the default, and Better Auth's adapter has no transaction configured at all (each statement commits by itself, § 9). Nobody can create a hold on a name without first owning it in `users`, so there is no second path into the race.

**The hash is weak on purpose, and the doc says so.** SHA-256 of a 3 to 30 character handle can be reversed by guessing names. It keeps a deleted person's handle out of plain sight in the table and in dumps; it does not stop someone who holds the database from testing whether `@simon` was deleted in the last 14 days. A keyed hash would, but the key lives in the app, so the database could no longer enforce holds. Ruled (D1): guessable is fine.

**The quota** is app code (`lib/username.ts`, § 7), not the trigger: the operator must be able to rename without spending the user's budget.

## 4. The validator (`packages/core/src/username.ts`)

Shared by web, app and server. Platform-pure like the rest of `@verre/core`.

- `normalizeUsername(input)`: for READS (links, the scanner, lookups, search). Trims, drops ONE leading `@`, accepts ASCII `[A-Za-z0-9._]` only BEFORE lowercasing (the `ß` → `SS` lesson from `normalizePublicUserId`), lowercases, then tests the format. Returns the canonical name or null. So `/@Simon` opens `@simon`.
- `validateUsername(raw)`: for WRITES. The same normalisation (a typed `Simon` is stored as `simon`, the response echoes the canonical form), then throws a user-facing message on a format failure or a reserved name. Messages follow `validateDisplayName`'s style, no em dashes.
- **Format:** `^[a-z0-9._]{3,30}$`, no `..`, no dot at the start or the end (D2), at least one letter or digit (ruled 2026-11-14 after the review: `___` and `_._` were valid).
- **Reserved** (`isReservedUsername`), one exported set, built from:
  - the display-name set, exported from `displayName.ts` instead of copied (`admin verre support host system deleted moderator mod help api staff official team root null undefined you`);
  - route words, web: `api join legal login register me session u`; app: `about attributions feed moments you soon signin signup`; future: `place places producer producers wine wines catalog moment impression impressions craving cravings settings search explore home profile user users account privacy terms contact press blog jobs security logout`;
  - file-like names that only matter if `/name` URLs ever exist: `robots.txt sitemap.xml favicon.ico favicon.png index.html manifest.json`;
  - brand and staff: `verre verreapp gastro administrator curator verified anonymous guest everyone all here nobody unknown`.
  - **Lookalikes (D3):** a name is also reserved when it equals a reserved word after its dots and underscores are removed (`v.e.r.r.e`, `_admin_`, `support_`). The brand rule (**narrowed 2026-11-14**, § 14 D3): refused when, with dots and underscores removed, it is made ONLY of `verre` and the staff words `official team support staff admin app help mod hq`, in any order (`verre_official`, `teamverre`, `verre.support.hq`). Verre is the French word for glass, so `unverredevin`, `verre.a.pied` and `verre_lover` stay allowed, and so do `happyverre` and `verremodern` (a staff word inside another word). Any other word lets a name through (`verre_official_ch`): accepted. The staff-word list is one exported constant. The operator script can still assign any refused name.
- 🔒 **A unit test collects the first URL segment of every route** in `app/` and `apps/mobile/src/app` (descending through `(group)` folders, taking route FILES as well as folders, skipping `_layout`, `+not-found` and dynamic segments, dropping hyphens) and fails when one is not reserved, so a new route word cannot be forgotten.
- **Nothing needs to stop a username looking like a public id or an all-digit old QR.** `/@name` and `/u/<id>` are separate paths, the scanner's legacy rule (`apps/mobile/src/lib/scanCode.ts:42`) applies under `/u/` only, and the API takes them in separate routes (§ 5). A 12-character name such as `abcdefgh1234` looks like a lowercase profile link but is never parsed in the same slot. 🔒 The rule that keeps it so: **no parameter ever accepts "public id or username"**. It goes into `app/api/CLAUDE.md`.

## 5. Lookup

**Web.** `next.config.ts` gains `rewrites()`: `/@:username` → `/u/by-username/:username`, plus a second rule with the source `/%40:username` for the encoded form. Next's own matcher compiles both: `/@:username` matches `/@simon`, `/@simon.f_1` and `/@Simon` and rejects `/@simon/x`; `/%40:username` matches `/%40simon`. Not yet proven end to end: that the router sees the raw, undecoded path under `next start` and behind the host's proxy, so the build pins both forms there. `proxy.ts` is not a cheap fallback (its matcher covers only `/me` and `/api`, and every other path it sees goes to NextAuth), so it is the last resort, with its own matcher entry and dispatch branch. The page `app/u/by-username/[username]/page.tsx` and today's `app/u/[id]/page.tsx` become two thin entries over one shared server component. 🔒 The order is parse → limiter → resolve → gate for BOTH, as on today's page (`app/u/[id]/page.tsx:36-39`): each entry only parses its own format and hands the shared component a resolver (public id → integer, or username → integer), which the component calls AFTER charging the limiter. A spent budget therefore runs no lookup at all. Same gate, same shell, blocked view and 404. A static `by-username` segment wins over `[id]`, and it is not a valid public id.

- The limiter is the SAME key string as today (`rl:profile:<ip>:1m`, 60/min), so the two pages and the two API routes share one budget. Both pages take the address from `getClientIp({ headers })`; today's page reads raw `x-forwarded-for[0]` (`app/u/[id]/page.tsx:33`), which the limit policy forbids and which is fixed in passing.
- Malformed, unknown, renamed away, held → `notFound()`. No redirect from an old name, ever: after the hold someone else may own it.
- 🔒 **Reads check the FORMAT only, never the reserved list** (web page, API route, scanner, share link): the reserved list is a rule for WRITES. An account the operator gave a reserved name (`@verre`) must open and share like any other.
- `/u/<publicId>` renders as before, no redirect to `/@name`.

**API.** `GET /api/users/by-username/[username]`. The body of `GET /api/users/[id]` moves into one function taking `userId | null`; both routes call it, so the by-username route cannot return anything the id route would not (blocked view, shell, full, `?view=header`, `private, no-store` on every path). Format-only parse before the limiter (malformed → 400), resolution after it (unknown or held → the same 404 as `'gone'`), the shared `rl:profile` key. Every answer carries `id` (the public id) and `username`.

**The app** opens a profile by public id as today. A scanned `/@name` (§ 11) calls the by-username route with `view=header`, then opens the profile by the `id` in the answer.

## 6. Where the server emits `username`

**Rule:** a person object OUTSIDE a moment carries `username: string | null` wherever it carries `name`. Inside a moment, never. It goes into `app/api/CLAUDE.md`.

- Profile: `/api/users/[id]` and `by-username` (blocked view, shell, full via `lib/profileLoad.ts`), so `resolveProfileViewer`'s `shell` and `blocked-by-me` results gain `username` beside `name`.
- People: `lib/profileHeader.ts` in-common faces, `lib/profilePeople.ts` rows, `/api/users/search` (admitted rows and gated stubs), `/api/me/friends`, `/api/me/tasted-with`, the blocks and mutes lists.
- Feed: `author`, `checkin.tags[]` (network feed, `?user=`, `profileLoad`'s recent posts), the check-in POST / PATCH echo.
- Your own: `session.user.username` on the web (the `session()` callback already reads `users` fresh on every call; `clientSession` passes it on), `user.username` on every native auth response (§ 9).
- **Not:** anything built by `lib/sessionState.ts`, `metaToWire`, the join / visit / bans / preview routes, the Redis cache, `/api/me/sessions` (its `people[]` are moment rosters).
- The build greps every person mapper again (the public-ids inventory, `.local/public-user-ids/inventory.md`, is the starting list, not the proof).

## 7. Search

- `/api/users/search` (`app/api/users/search/route.ts:57`): `u.name ILIKE $like OR u.username LIKE $ulike`. The username side has its OWN lenient normaliser (`usernameQuery` in core: drop one leading `@`, lowercase ASCII, null when any character is outside `[a-z0-9._]`): `normalizeUsername` would refuse a 2-character or partial query. A null drops the username clause (a query with a space can only match names). `_` is a legal username character AND a LIKE wildcard, so the pattern gets the same escape the name pattern has (`route.ts:52`). A query starting with `@` matches the username only; if what follows the `@` is not a possible username (`@sim on`), the answer is `[]`, never a fallback to names. Minimum 2 characters after the `@`. Order: exact username, username prefix, then `name, public_id` as today. Block scrub and limit unchanged; `rl:search` unchanged.
- People lists' `q` (`lib/profilePeople.ts:100`): the same clause and `@` rule.
- The Invite sheet's friend search runs on the phone, so it only needs `username` in `/api/me/friends` (§ 6).
- The index: the trigram GIN on `username`. The build checks the plan (a BitmapOr over both indexes) on a seeded table, from 3 characters: a 2-character pattern has no trigram and scans, as the name search does today.

## 8. Set and change

**`lib/username.ts` is the only app code that writes `users.username`** besides the two sign-up inserts; a small CI census (the `check-identity-writes` pattern) pins that.

- All three routes answer `Cache-Control: private, no-store` on every path.
- **`usernameTaken(name, forUser?)`** in `lib/username.ts`: in `users`, or `username_is_held`. The ONE pre-check, used by the availability route, the PUT, and both sign-ups (§ 9): a pre-check that read `users` only would let a held name through to the trigger, and the app sign-up would then fail generically on every try.
- **`GET /api/me/username`** → `{ username, changesLeft, nextChangeAt, previous: { username, heldUntil } | null }`. 60/min/user.
- **`PUT /api/me/username { username }`**. Its own route, not the profile PATCH: it has a quota, its own conflict answers and its own limiter, and the profile PATCH's contract is "returns the changed fields".
  - `isSameOrigin`, sign-in, validate (400 with the message), then `rl:username-set` 20/h/user (charged on attempts that pass validation; the same name again returns 200 before the charge).
  - One READ COMMITTED transaction: lock the user's row, stop if unchanged, check the quota (a first choice from NULL is free; any later change counts, switching back included: § 14 D5), update through the model API, add the `username_changes` row, drop the user's change rows older than the window. A refused change (taken, held) rolls back: no quota spent, no row left.
  - Answers: 200 with the same shape as the GET; 409 `{ code: 'taken' }` for taken AND held (one answer; a unique violation from either constraint); 409 `{ code: 'quota', nextChangeAt }`.
  - The quota window is a rolling 90 days.
- **`GET /api/me/username/available?username=`** → `{ available, reason?: 'invalid' | 'reserved' | 'taken' }`. Sign-in required, `rl:username-check` 60/min/user plus a 300/min per-address backstop (free accounts multiply a per-user budget; both charged after the 401, the address from `getClientIp`). It answers from `usernameTaken` (your own held name is available). Advisory only: the PUT's answer from the database is the authority.
- **The race** between two people: the unique index decides, the loser gets `P2002` → 409 `taken`. Pinned with two real connections (§ 12).
- **The operator script** `scripts/set-username.mts <email> <username> [--apply] [--allow-reserved]`, and `--release-hold <username>`. Dry run by default, from a checkout like `scripts/rehydrate-sessions.mts`. It validates the format, skips the quota, takes a reserved name only with the flag, and can never take a taken or held name (the database refuses). For stragglers, the brand's own account and a moderation rename.

## 9. Sign-up

**App (Better Auth).**

- `user.additionalFields.username = { type: 'string', required: false, input: true, returned: true }`. Better Auth copies a declared input field into its own user insert (`sign-up.mjs:157`), so the name is written in the SAME statement as the user row: no user row exists without its username. `required: false` because `true` would refuse every other create path; the sign-up hook enforces presence.
- The existing before-hook on `/sign-up/email` (`lib/betterAuth.ts:381`) validates the name as today, validates the username with the core validator (400 `INVALID_USERNAME`) and rewrites the body to the canonical form. Then it answers conflicts itself, before Better Auth's own duplicate check, from `usernameTaken` (holds included) and an email lookup: 422 with code `EMAIL_TAKEN`, `USERNAME_TAKEN` or `EMAIL_AND_USERNAME_TAKEN`, so the form can show both at once. The hook runs for `auth.api.*` calls too (`lib/betterAuth.ts:249`), so every test fixture is covered by it (§ 12).
- A lost race after that check (someone took the name in the same instant) comes back as Better Auth's generic 422 `FAILED_TO_CREATE_USER`: it swallows the unique violation. The form's retry gets the exact answer from the pre-check. Named, not engineered around.
- 🔒 `/update-user` stays disabled: with `input: true` it would accept a username and skip the quota. `scripts/check-better-auth-config.mjs` already fails the build if it is ever enabled; the gate gains a comment saying why it now matters twice. Belt: the `user.update.before` hook refuses any update carrying `username`.
- **The fake success goes:** `autoSignIn: false`, `customSyntheticUser` and `syntheticPublicId` with its constants (`lib/betterAuth.ts:17-39, 643-680`), the wrapper comment about real and synthetic answers looking alike, the § 18 parity checks (free vs taken bodies, the synthetic id twice), the "Enumeration oracle" section of `app/api/rate-limits.md`, `apps/mobile/CLAUDE.md:332` ("two-step flow… don't fix it"), `docs/dev/proposals/mobile-app/01-identity-and-auth.md:473, 533-538, 579`, and notes on `public-user-ids.md` § 2, § 5, § 8a a and § 11 pointing here. The § 18 check "a body carrying `publicId` → 400 for a free and a taken email alike" changes too: the conflict check now answers a taken email first. The `publicId` `input: false` refusal stays. Revisit only with the email pipeline (a generic "check your inbox" is real then).
- **One step:** with `autoSignIn` back at its default, sign-up creates the session and sets the cookie in the same call (`sign-up.mjs:255`). The session goes through the same `session.create.before` hook as a sign-in (device label, country). The app then drops its follow-up sign-in (`sign-up.tsx:40-48`, UI session); until it does, that second call would add a second device row. Build checks: the device row of a sign-up session, a web login right after an app sign-up (the password mirror), the revoke paths on such a session.
- **Better Auth's sign-up is not one transaction here** (`prismaAdapter(prisma, { provider: 'postgresql' })` sets no `transaction`, `lib/betterAuth.ts:150`): the user insert, the credential row and the session are three separate commits, and after-hooks run when the handler ends. Two residuals, named: a failed credential insert leaves a user row that can't sign in and owns its email (as today) and now its username (the operator deletes the row; the name is then held 14 days unless released); and with one-step sign-up the session row exists before the password mirror (`account.create.after`) runs, so a mirror that throws answers an error with no cookie while the session row stays. The second is a build check: what the next sign-in and Connected devices show after it.
- Comments to rewrite with it: `lib/betterAuth.ts:458-459` ("only /sign-in/email creates native sessions") and `:519-521` (the fill-NULL-only argument cites the synthetic path; it still holds, through the 422).
- The atomic floor `rl:ba-signup` 10/min/IP stays, and is now the stated bound on email probing.

**Web** (`app/api/auth/register/route.ts`): the body gains `username`; validate; pre-check both and answer 409 `{ error, fields: { email?: 'taken', username?: 'taken' } }` (`error` keeps today's "email already registered" text when only the email is taken); the insert carries the username; a `P2002` re-runs the pre-check (`usernameTaken`, holds included) to name the field instead of parsing Prisma's error (its shape depends on the driver adapter); if the re-check names neither, it answers the generic failure.

## 10. The blocking screen's server half

- **How clients learn it:** `username === null` on the user's own session. Web: `session.user.username`. App: `user.username` on every native auth response, written FRESH by the route wrapper from one primary-key read. It cannot come from Better Auth's own copy: the Redis session copy snapshots the user at sign-in (the reason `user.image` is already dropped there), so it would stay null for up to a year after the person chose. That copy still HOLDS the sign-in-time username at rest in Redis; nothing reads it for the wire.
- After the PUT, the web calls `update()`, the app refetches its session.
- **No server-side lock:** an account without a username keeps full API access; the client blocks. With 5 to 10 known people and the operator script for stragglers, a server gate on every route is not worth its risk.
- **Missing usernames elsewhere:** every person object may carry `username: null` (a straggler). Clients show no `@` line and link to `/u/<publicId>`.
- **From the deploy on, both sign-ups REQUIRE a username.** Consequence: between the server session and the UI session, sign-up from the app and the web form fails on local `main` (they do not send the field yet). Acceptable in hold mode; the server session drives sign-up through its tests.
- Rolling deploy: an old instance's register creates a row without a username; the blocking screen catches it.

## 11. Account deletion, share, scan

- **Deletion:** the `BEFORE DELETE` trigger holds the name (§ 3). `username_changes` cascades (the user's own data). `username_holds` is the one row that survives a deleted account on purpose, with no user reference and no clear text; `docs/dev/account-deletion.md` and the root cascade-vs-tombstone section name it.
- **Share:** core `profileSharePath(person)` returns `/@name`, or `/u/<publicId>` when there is no username. The app's `shareProfile` uses it; `profileLink` (the QR) keeps the public id.
- **Scan:** `parseVerreCode` learns `/@<name>` (and `/%40<name>`), normalised, as `{ kind: 'profile-username', username }`; a malformed name is not a Verre code. The app resolves it through § 5; a 404 (renamed, held, deleted) shows today's "This code isn't available."
- The app has no universal links (a custom scheme only, `apps/mobile/app.json:8`), so a shared `/@name` opens the website. If universal links come, their path list needs `/@*`.

## 12. Tests

- **Core units:** the validator table (length edges, each character class, `..`, the dot edges, uppercase and `ß` inputs, a leading `@`), the reserved set and the lookalike rule, the route-word test (§ 4), `usernameQuery`, `profileSharePath`, the scanner's new cases.
- **Schema** (a section in `scripts/tests/you-profile-integration.mts`): the format CHECK agrees with the core validator over a generated table of names (both directions, so neither can drift); the never-NULL-again rule; the isolation refusal, and its other half: a `users` update that does NOT name `username` succeeds inside a REPEATABLE READ transaction; an insert with a NULL username passes untouched.
- **Holds and quota:** rename holds the old name 14 days for its owner only; switching back; a second rename frees the first old name; a deleted account's name is refused for 14 days and stored without clear text or user; an expired hold no longer refuses even before any prune ran; the prune removes it (trigger and daily job); 5 changes pass and the 6th answers `quota` with the right date; a first choice is free; a refused change spends no quota and leaves no `username_changes` row; the operator path skips the quota. The hash has one spelling: `usernameTaken` and the trigger agree on a held name (both go through `username_is_held`).
- **The answer matrix:** for a live, a held and a free name, what the availability check, both sign-ups, the PUT and the logged-out lookup each answer (pins § 15's named difference and nothing beyond it).
- **Error shapes:** a taken name and a held name each surface as `P2002` through a model call and as `P2010` with code 23505 through a raw statement; `isUsernameConflict` takes both.
- **Races, two real connections, each with the negative control that fits ITS invariant:**
  - A claim against an uncommitted rename, and against an uncommitted deletion: refused after the commit. Control: the trigger switched to BEFORE must fail the test.
  - Two renames by ONE account that has 4 changes on record: exactly one succeeds, the other answers `quota`; one change row and one hold transition commit. Control: without the user-row lock, on a fixed schedule where both requests read 4 prior changes before either writes, the test must fail (the trigger's timing has nothing to do with this one).
  - Two claims of one free name: one wins, one `taken`. The unique index decides; control: none needed beyond the index existing (pinned in the schema section).
- **Sign-up:** app and web answer email taken, username taken and both, honestly; a HELD username answers "username taken" at both, for a rename hold AND a deleted account's hold (not a generic failure); an invalid or reserved username 400; a missing one 400; one-step app sign-up returns a working session with one device row; `/update-user` still 404; `user.update.before` refuses a `username`; a body carrying `publicId` still 400 for a free email.
- **Own session:** get-session after a PUT returns the NEW name although the Redis session copy still holds the old one.
- **Lookup:** `/@name`, `/@Name` and `/%40name` against `next start`; an account holding an operator-assigned RESERVED name opens through both web forms and the API route, and its share link is `/@name`; with the limiter spent, neither web entry and neither API route runs the target lookup; by-username answers equal the id route's for every gate state (ok, shell, blocked by me, blocked by them → 404, unknown, held, renamed away), with the limiter spent too.
- **Emission:** the § 18 walk asserts `username` on every surface in § 6 for the seeded pair. 🔒 The reverse canary: no moment response and no MOMENT key or value in Redis (`s:*`, `lock:session:*`) may contain a fixture username. Better Auth's own session copies are outside it (§ 10).
- **Search:** by name, by username, `@` prefix, a query with `_` (escaped, not a wildcard), a query with a space (names only), the order, block scrub before the limit.
- **Limits and gates:** each new route charges its limiter and answers `no-store`; the username-writes census has a negative control.
- The new routes join § 18 (the integer canary scans them). Every `check-schema.yml` suite runs before any push.

**Fixtures and suites to migrate** (they break twice: sign-up now needs a username, and it now creates a session):

- Every `signUpEmail` fixture: `scripts/tests/ba-session-lifetime.mjs:159-161, 665`, `redis-rehydration-additive.mts:135`, `redis-rehydration-cutover.mts:127`, `you-profile-integration.mts:293`. The three `mkUser` helpers (both rehydration suites, the you-profile suite) only need a cookie: each sends a username, takes the cookie FROM the sign-up and drops its follow-up sign-in, so a fixture user still has one native session. To pin in the helper: `auth.api.signUpEmail({ returnHeaders: true })` returns the signed `set-cookie` (the body's `token` is the raw token, not the cookie value). `ba-session-lifetime.mjs` is different: sign-in is its subject and its assertions count session rows from zero (`:233-258`, `:270`, `:317`, `:329`, `:348`, `:477`), so there each sign-up's session is retired through Better Auth (`deleteSession` on the returned token) right after the sign-up. The same for `you-profile-integration.mts:1679`, which signs in a freshly signed-up user and uses that cookie.
- 🔒 **Fixture usernames are generated per run** (one helper: 30 characters or fewer, `[a-z0-9._]`, from the run's timestamp; today's `TAG = yp-${Date.now()}` has a hyphen). The suites clean up with `DELETE FROM users` and are re-run against a persistent local database: a fixed name would be held for 14 days after the first run.
- The local harness (gitignored, updated in the same session): `.local/test-env/scripts/_ba-e2e-signup.ts` (its § 10 is cited by `app/api/rate-limits.md`), `_ba-e2e-step5.ts`, `fresh-install/device-sim*.mts`, `section-17-bot-defenses.sh`.

## 13. What the UI session gets

For Simon to answer there, not here:

1. Where `@name` shows: profile header, people rows, search results, feed author and tags, the Add Friends card, the Invite sheet's friend rows.
2. The sign-up forms (web and app): the Username field above the email, live format feedback, "email taken" and "name taken" together. Password AutoFill: email keeps `textContentType="username"` (app) and gets `autocomplete="username"` (web); the Username field never does. Verify iOS AutoFill save and fill, Safari, Chrome.
3. The app's sign-up becomes one step (drop the follow-up sign-in).
4. The blocking "choose your username" screen, app and web, with the live availability check.
5. Edit Profile: change the username, changes left, the next possible date, "switch back to @old" while it is held.
6. Labels: "Display Name" becomes "Name" everywhere.
7. Share uses `/@name`; the QR stays; the scanner's result for a `/@name` link.
8. The Invite sheet's and the people lists' search also match the username.
9. A person with no username yet: no `@` line.
10. The web `/@name` page: whether `/u/<id>` pages show a canonical link to it.

## 14. Decisions (ruled 2026-11-13)

- **D1, holds:** enforced by the database, with a plain SHA-256 (guessable by someone who holds the database: accepted). A deleted account's name is held 14 days, like a renamed one.
- **D2, dots at the edges:** a username cannot start or end with a dot.
- **D3, lookalikes:** reserved words also match with dots and underscores removed; `verre` is refused only together with a staff word (first ruled "anything containing verre", narrowed the same day: it is the French word for glass). § 4. **Narrowed again 2026-11-14 (Simon, after the server build):** only a name made of NOTHING BUT `verre` and staff words is refused. "Contains both" also caught `happyverre` and `apple_verre` (`app`), `verremodern` (`mod`), `verre.appellation`. The price, accepted: any extra word passes (`verre_official_ch`); "we can observe and block accounts".
- **D4, the app version:** the usernames build keeps 0.1.5 (nobody else has a 0.1.5 build). The floor in `lib/clientVersion.ts` is untouched.
- **D5, taken in the plan, open to objection:** switching back to a held name counts as one of the 5 changes; a first choice and an operator rename do not; "3 months" is a rolling 90 days; no server-side lock for accounts without a username; no redirect from an old name; the username stays nullable for good; a rename hold keeps the old name in clear text for its 14 days (so the owner can be shown it), a deleted account's never; someone who alternates between two names keeps the second one reserved for most of the time, at the price of all 5 changes (one extra name per person, accepted).

## 15. Not covered (named)

- Logged out, `/@<a common name>` shows the display name of a non-public account, 60/min per address. Names can be guessed where random ids could not. Accepted by ruling (§ 2); the shell is unchanged.
- "Is this name free" and the sign-up conflict answers tell whether a username exists, and sign-up tells whether an email does. By design; the limits bound it (`rl:username-check`, `rl:ba-signup` 10/min/IP, the web register's 100/min/IP).
- **A held name can be told from a free one and from a live one:** the availability check says taken while the logged-out `/@name` answers 404. That shows the name was given up in the last 14 days; someone who also holds the person's `/u/<id>` link can tell a rename (the profile is still there) from a deletion (it is gone). Holding a name can't be hidden without also hiding that it is unavailable.
- Someone blocked sees the blocker's username as taken and the profile as 404 while signed in. Signed out, the same link shows the shell or the profile, which proves the block. That is true of `/u/<id>` today; the username adds a second way to the same answer, nothing new.
- A `/@name` link dies at a rename or a deletion and can point at someone else once the 14 days end. The QR is the stable one.
- The hold hash can be reversed by guessing (§ 3).
- Some chat apps cut a trailing `_` off a link (`/@name_`). Only edge dots are refused (D2).
- A user row whose credential insert failed keeps its username (§ 9).
- A username is not verification: `@simon_real` with the display name "Simon" is still possible.
- A sign-up that loses a same-instant race for a name gets a generic failure once (§ 9).
- Accounts without a username exist until each person chooses or the operator sets one.

## 16. Docs to update (server session)

- Root `CLAUDE.md` § Trust model: "There is no concept of username" becomes: a username is a unique lookup and display name; it carries no trust, is never an identity, never authorises, and never appears inside a moment. Plus the feature index line.
- `app/api/CLAUDE.md` (the emission rule, "never id-or-username in one parameter"), `app/api/auth/CLAUDE.md` (sign-up answers honestly, one step), `app/api/rate-limits.md` (three new keys, the rewritten sign-up section), `lib/CLAUDE.md` (`lib/username.ts`), `prisma/CLAUDE.md` (the hand-written CHECK and triggers, the READ COMMITTED rule).
- `docs/dev/profile-visibility.md` (by-username goes through the same gate), `docs/dev/account-deletion.md` (the hold), `docs/dev/deployment.md` (the operator script, the release-day count of accounts without a username).
- README: the API table (four new routes, the changed sign-up and register bodies) and the feature list.
- `public-user-ids.md`: the superseded notes (§ 9).

## 17. Review history

- **Round 1** (2026-11-13, one Claude reviewer). No blocker. The trigger race, the isolation claim, `UPDATE OF`, Better Auth's input field and the by-username route were checked against the code and held. Folded, each verified first: the sign-up pre-checks include holds through one helper and one SQL function (a held name would have failed generically at app sign-up); the fixtures and suites that break, with per-run fixture usernames (the delete trigger holds a fixed one for 14 days); raw statements get `P2010`, so username writes are model calls; Better Auth's sign-up is three commits, not one transaction, and its two residuals; expiry through the daily prune, and the claim tests the date itself; trigger mechanics (two triggers, NULL insert, upsert on delete, Prisma models for both tables); the search normaliser and the `_` escape; the route-word test descends through groups; `no-store` and a per-address backstop on the availability check; the `%40` rewrite source; the reverse canary scoped to moment keys; the removal list (app CLAUDE.md, the auth proposal, two comments, the local harness).
- **Round 2** (2026-11-13, the same reviewer): CONVERGED, no blocker or major, every round-1 item resolved. Four minors folded: the hold predicate spelled out for a caller with no user and a hold with no user; the session-lifetime suite needs zero sessions after its fixtures, not one; the daily prune in its own `try`, and the delete trigger's prune skip-locked; `@` with an impossible remainder answers `[]`.
- **Codex round 1** (2026-11-13, `xhigh`): one major, four minors, all folded. Lookups applied the reserved list, so an account given a reserved name by the operator would have had a dead `/@name` link (reads are format-only now); the migration's lock is held through the index builds, not "an instant"; the shared profile page keeps parse → limiter → resolve; a concurrent test for the rename quota; the held-name difference named in § 15.
- **Codex round 2:** all five resolved; one minor folded (each race test gets the negative control of its own invariant: the BEFORE trigger for release-versus-claim, the missing row lock for the quota). **Round 3: APPROVED.**

## 18. As built: the server half (2026-11-14, `feature/usernames-server`)

Built to the plan. What differs from it, what it left open and how each was settled, and what the build checks found.

**Deviations and additions**

- **Two read-side normalisers, not one.** `normalizeUsername` (typed input: trims, drops one leading `@`) and `usernameFromPath` (a URL segment: nothing trimmed, no `@` dropped). With one function `/@@simon` and `/@%20simon` were second spellings of a profile. The web page, the by-username API route and the scanner use `usernameFromPath`.
- **`checkUsername`** is the validator without the throw (`{ ok, username } | { ok: false, reason: 'invalid' | 'reserved', message }`); `validateUsername` wraps it. The availability route needs the reason, and the PUT answers 400 with `code: 'invalid' | 'reserved'` beside the message.
- **One trigger function, three triggers.** `users_username_hold()` serves the two AFTER claim triggers AND the BEFORE DELETE one (branching on `TG_OP`), so the 14 days have one home. `username_hash(name)` is its own SQL function, called by `username_is_held` and by the trigger's inserts: the hash still has one spelling.
- **The expired-holds prune runs under the session prune's lock**, in its own `try` (`pruneLocked`, `lib/nativeSessionPrune.ts`), as planned; no second lock key.
- **A fourth limiter key:** `rl:username-read` (60/min/user) on `GET /api/me/username`, beside `rl:username-set` and `rl:username-check` (user + address).
- **`/api/me/account` GET carries `username`**, and `resolveUser` reads it on both branches (the app reads its own name from this route). Not in § 6's list; it follows from the rule (a person object with `name`).
- **The check-in POST / PATCH echo is unchanged.** § 6 lists it, but the echo holds no person object (only `userId`), so the rule adds nothing; the feed's `author` and `tags[]` carry the username.
- **Web register** answers `{ user: { name, username, … } }` on success; a missing username reads "username is required" on both sign-ups.
- **Reserved words:** `updaterequired` joined the list (the app's `update-required` route; the route-word test found it).
- **The scanner** knows `/@name` (`profile-username`, units in `scripts/tests/scan-code-units.ts`). The app's scan result shows "This code isn’t available." for it until the UI session wires the lookup (§ 13 item 7).
- **The writes census** (`scripts/check-username-writes.mjs`) also matches an assignment to a `.username` property (a `data` object built in steps). Two wire-object assignments are therefore expected sites (`auth.ts`, the native route wrapper).
- **The web suite** (`scripts/tests/usernames-web.mts`) drives `node .next/standalone/server.js` (what the image runs) and, with `--next-start`, `next start`; `check-schema.yml` builds the app for it.
- **Search order** uses `u.username IS NOT DISTINCT FROM $q` and a COALESCEd prefix test (no NULL ordering to reason about); the username side is a substring match like the name side.

**Build checks (the plan named them)**

- **The rewrite holds end to end:** `/@name`, `/@Name` and `/%40name` open the profile under both server modes; a deeper path, a malformed, unknown or renamed-away name is a 404; no redirect in either direction. Not yet checked: behind the host's proxy (a release-day check: open `/@<name>` and `/%40<name>` on the deployed site).
- **One-step sign-up:** the session carries the same device label as a sign-in ("iPhone 15 Pro · Verre App"), no raw address; Connected devices lists it as This Device; it revokes like any session. The real `@better-auth/expo` client is signed in by the sign-up call alone (cookie and session cache written, `user.username` on get-session): the app's follow-up sign-in can go.
- **A web login right after an app sign-up** works (the password mirror ran).
- **A password mirror that throws at sign-up:** the call answers a 500 with no cookie; the user row (with its username), the credential row and ONE session row stay. The next sign-in succeeds and completes the mirror; Connected devices then shows the stranded session as another device, removable like any. Pinned in § 21 e.
- **`returnHeaders`** on `auth.api.signUpEmail` gives the signed cookie (the fixtures use it).
- **The search plan** on 200,000 seeded users: a BitmapOr over `users_name_idx` and `users_username_idx` from 3 characters (about 5 ms), the username index alone for `@…` (about 3 ms), the name index alone for a query with a space; a 2-character query scans (about 95 ms), as the name search always did.
- **The migration** on a copy of the dev database (33 users): under 10 ms in total.
- **`user.update.before` refusing a username** makes Better Auth log one error line ("Failed to refresh committed user sessions"): its `updateUser` then has no row to refresh from. Reachable only by code that calls `updateUser` with a username, which nothing does.

**Decided after the build (Simon, 2026-11-14)**

These override the sections above where they differ (§ 2 "the most recent old name is held", § 3 step 3, § 4, § 8, § 14 D3 / D5).

- **The staff rule** (§ 4, § 14 D3), in two steps. First narrowed: as built ("contains `verre` and a staff word anywhere") it refused `happyverre`, `apple_verre`, `verremodern`, `modeverre` and `verre.appellation`, because the short staff words match inside ordinary words; now only a name made of nothing but `verre` and staff words. Then, from the security review, widened to staff words WITHOUT the brand: `official_support`, `admin.team` and `support_team` passed, and `app` alone was never reserved. Final rule: a name is refused when, with dots and underscores removed, it is made ONLY of `verre` and / or staff words; `app`, `admins`, `administrators`, `moderators` and `mods` are reserved as single words. Any other word lets a name through (`verre_official_ch`, `support_simon`): accepted, "we can observe and block accounts".
- **Every old name is held for its own 14 days** (security review). As planned, a second rename freed the first old name at once (`simon` → `simn` → `simon_f` released `simon` the same minute, and every `/@simon` link in circulation with it). Now the earlier hold stays until its date, without its owner and clear text. Only the most recent old name can be switched back to. Cost, accepted: one person can keep up to 5 extra names unavailable for 14 days (the quota bounds it).
- **A moderation rename can take the name away** (both reviewers: the one major finding). The trigger holds the old name FOR the renamed person, so they could switch straight back. `scripts/set-username.mts --block-old` blocks the old name for everyone, its former owner included, with no end date, until `--release-hold`. Stored as a hash; the operator keeps their own note of what is blocked.
- **At least one letter or digit** (security review): `___` and `_._` were valid names. In the validator and in the CHECK.

**From the review, fixed without a ruling**

- The PUT answered 400 `reserved` to an account re-submitting its own operator-assigned reserved name, and read the full state (three queries) before any limiter. Now: the format first, then one read of the current name; the same name is answered as a read of your own state (metered like the GET), before the reserved list and before the change budget.
- The writes census missed the ordinary `const data = { name, username }; prisma.user.update({ where, data })`, a spread, `UPDATE public.users`, the row form `SET (name, username) =`, a bracket assignment and Better Auth's `updateUser`. It matches them now (its self-test grew from 16 to 26 cases); the account PATCH's update object is typed to its two fields.
- Tests that did not pin what their label said: the "not chosen yet" cue is now asserted on a native auth response; "switching back counts" asserts `code: 'quota'`; the INSERT claim (the sign-up path) is raced, not only the UPDATE; the web register's lost-race branch runs against an uncommitted insert on a second connection.
- `/u/by-username/<name>` (the rewrite's target) also answers directly: the same page, gate and limiter, a third spelling. Left as is and pinned in the web suite.
- The trigger also accepts `read uncommitted` (Postgres runs it as READ COMMITTED). `nextChangeAt` is rounded up by a millisecond (the stored time has microseconds).
- Half of the suite's fixture users now have NO username (a credential and a sign-in instead of a sign-up), so the older sections also run against the shape production is in right after the deploy.

**Codex on the build (2026-11-14, `xhigh`): changes required, one major and two minors, all fixed**

- **`--block-old` could report a block it had not made** (major). The script read the account, then `changeUsername` took the row lock: a rename by the person in between made the block land on the name they held at that moment, or on none when they had taken the destination themselves, while the script still reported the name it had read as blocked and that name stayed held FOR them. `changeUsername` now takes `expectedCurrent` and answers `moved` under the lock; the script refuses (exit 1, nothing written, nothing reported blocked) and is run again. Pinned with a hook between the script's read and its write (both interleavings).
- The web suite's "name-only shell" check would have passed on a full profile. It now seeds a photo with a marker, asserts it is absent from the shell (by name and by id) and present on a public profile.
- `docs/dev/deployment.md` described the blocking screen and the new web form as shipped. It now says the server half must not be deployed alone.
- **Round 2: approve with minors**, the three resolved. One new minor, fixed: the script's output still said "blocked" on an unchanged or a refused outcome (and "would be blocked" beside "would be refused" in a dry run). It now makes that claim only for a change that was, or in a dry run would be, written.

**For the UI half (release gate)**

- Search now returns and ranks people by username (an exact username first, then prefixes). Until rows show `@username`, a result can look unexplained: "sim" may list "Anna Meier" (`@simmental`) first. The rows must show the username before this ships.

**Not done**

- The new CI steps (a `next build` and the web suite in `check-schema.yml`) have never run on a GitHub runner (hold mode). Locally they pass from a build made with no `.env` and only the three variables the workflow sets.
