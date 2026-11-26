# Rating saves: merge saves, the version check, the app's outbox

Shipped with the tasting-feedback fixes (planned 2026-11-25, Simon's rulings in
`.local/tasting-feedback/build-prompt.md`). The app's moment impression screen
saves while you rate (about 1 s after an input settles) and on leave; offline,
saves wait on the phone and go out by themselves later. Four decisions shape it:

- **Merge saves.** The app sends only the CHANGED fields; a field left out is
  never touched.
- **The version check.** Every app save says which VERSION of the rating it was
  based on, and the server refuses an outdated one. The version lives in its own
  table (one row per person and bottle), so it survives a Clear.
- **Newer rating wins** for a save that WAITED on the phone; a LIVE edit is
  combined with a newer change made elsewhere (each field saves separately).
- **An offline outbox across restarts** (`apps/mobile/src/lib/rateOutbox.ts`);
  unsent entries are cleaned up after 90 days.

Only "Clear My Rating" deletes a rating from the app. The web Rate pane keeps
its explicit Save (a full save) and its Reset.

## `POST /api/session/:code/rate`

Order: same origin → the entrance gate (`openAsParticipant`) → **the save
limit** (signed in: `rl:rate:u:<userId>:10m`, 600 per 10 minutes, one budget
across moments; guests unlimited; `app/api/rate-limits.md`) → the body → the
early 404 → the promotion attempt (signed in) → the session mutation contract.

### Two body forms

| | FULL (the web, old app binaries, the app's Clear) | MERGE (`merge: true`, the app) |
|---|---|---|
| Fields | `score`, `flavors`, `notes` replaced (omitted = 0 / `{}` / none); `aromas` present-replaces, omitted-preserves | each of `score`, `flavors`, `notes`, `aromas` optional (at least one, else 400); an omitted one keeps the stored value |
| A new rating | the body's values | the supplied fields, the defaults for the rest |
| An empty result | REAPS the rating (the engagement cascade: photos, and the post with its likes when it was your last rating in the moment) | writes NOTHING: `{ ok: true, unchanged: true }` |
| Needs | nothing new (`opId` / `baseVersion` optional) | `opId` and `baseVersion` (400 otherwise); a signed-in rater (a guest's merge is a 400) |
| Success | `{ ok: true }` (a Clear included) | `{ ok: true, rating }` |

Every present field is validated as before (score `0..5` in 0.25 steps, the
flavour registry against the bottle's kind, the aroma gate), and the note goes
through `scrub` (control / bidi / zero-width strip + trim; blank = none) in BOTH
forms (ruled 2026-11-26: the free-text rule of `lib/CLAUDE.md`, and a NUL byte no
longer 500s). A whitespace-only note is no note, so a full save of score 0 with
only spaces reaps. The app compares its draft with `scrub(draft) ?? ''`.

🔒 **A merge never reaps.** Under the session lock the route computes the MERGED
result (the locked row ⊕ the validated, normalised supplied fields). When it is
empty (score 0, no structure, no aromas, no note) it returns the `unchanged`
outcome BEFORE `ensureMemberRow` (which can bump `lifetime_sessions_joined`), the
upsert and every side effect, and the route answers before the refresh, the
last-seen bump, the carousel unhide and badge evaluation. Emptying every field
by hand and leaving keeps the stored rating.

🔒 **A rating key without a row is never imported** into a merge (it can be a
post-edit clear whose Redis delete failed, or a rebuild's kept key of a live
user with no row; importing it would resurrect a deleted rating, its post and
XP). A merge with no row starts from the defaults. The same holds for a
signed-in FULL save with `aromas` omitted: it keeps the ROW's aromas, and a new
row starts from none (the key is not read). A guest's full save still keeps the
key's aromas, Redis being a guest's whole record.

The answer's `rating` is the complete canonical `RatingMeta` (`lib/session.ts`):
`{ score, flavors, aromas, notes, at, v }`, the same JSON as the rating key
(`at` = `ratings.mirror_at` in ms). Counters, XP, the feed item and the key all
come from the committed row (`RETURNING`), never from the request alone.

### The wrong-account guard (`viewer`)

🔒 The app adds `viewer` to every merge and Clear body: the WIRE identity of the
account it queued the change under (`u:<publicId>`; a guest's own `a:` id). The
rate POST checks it right after the body is read, BEFORE the 503, the version
check and any write: present and not the caller's own wire identity (the caller
translated through `lib/publicIds.ts` `wireIdentity`, the public id compared
case-insensitively; the integer id never leaves the server) → **409 `{
wrongViewer: true }`**, `private, no-store`, nothing written. Absent (the web,
old binaries): no check. Malformed (not a wire identity; an integer `u:` id is
malformed) → 400. It protects against a sign-out and sign-in between queueing a
change and sending it: the cookie that arrives is not the account the change
belongs to. The app treats the 409 like a 401 `invalid` (stops that viewer's
runner, keeps every entry, confirms with get-session).

### The 503: no signed-in rating is written to Redis only

🔒 A SIGNED-IN write of a session rating in a moment with no `sessions` row after
the promotion attempt (its promotion failed) answers **503 + `Retry-After: 5`**
and writes nothing, for the web as for the app: the rate POST and the Reset
DELETE (which makes no promotion attempt of its own). The decision is made under
the locks, right after the admission. The app's outbox retries; the web Rate
pane keeps the form and shows "Couldn’t save right now. Try again in a moment."
(`components/wine/WineModal.tsx`). Why: a version beside a Redis-only write
cannot commit atomically with it, and Redis-only bottle ids are scoped by moment
code; a web Save during a failed promotion would bypass the counter and a phone
edit waiting meanwhile would overwrite it once the promotion succeeds. GUESTS
keep today's Redis-only full save (no version).

### A rolled-back attempt (the contract's clean-up)

The rating key (with `v`) is written INSIDE the transaction, deliberately: under
the advisory lock every writer of the row is serialized, so the last committer
also wrote the key last (a write after COMMIT could be superseded, and under
auto-save its invalidations would storm). If the transaction then fails (a
COMMIT error, a deferred trigger, the transaction timer, the suites'
`beforeCommit` injection), the key would advertise `v + 1` while SQL is still at
`v`, and a phone could take it as its base. So 🔒 `ratingKeyWrite` records every
key of a SIGNED-IN rater it wrote in a Postgres-backed moment
(`MutationCtx.recordKeys`; also when the Redis reply is lost), and when the
transaction throws, `withSessionMutation` DELETES those keys and invalidates in
ONE script before rethrowing (`dropUncommittedKeys`: `scopedInvalidate`'s own
script with the keys as `dropKeys`, so a key is never deleted without the
rebuild queued; another incarnation's meta deletes nothing; best effort). Both
halves are needed: the rebuild writes rating keys
NX, so an invalidation alone would keep the stale key (a mutant that skipped
the DEL went red). The DEL is unfenced on purpose: it may also remove a
successor's correct key, and the invalidation that follows has the next request
rebuild every key from the record. A guest's key and a Redis-only moment are
untouched: there the key IS the data. On the contract's own re-run paths
(superseded, needs-lease, cold) the throwing call wrote nothing and every
current writer writes one key per attempt, so none of them invalidates today; a
writer that wrote a key and then hit one would invalidate before its re-run.
Pinned by the suite's § 2 (`/state` after a failed save shows SQL's version).

### After COMMIT

🔒 The committed outcome is answered AT ONCE. `touchWithMeta`, `bumpLastSeen`, the
carousel unhide and badge evaluation run in the background, each caught and
logged on its own (`lib/afterCommit.ts`; `settleAfterCommit` is the suites' seam): they can throw or STALL (the
shared Redis client queues commands while disconnected), and the app aborts a
request after 12 s, so an awaited one would report a committed save (or a
committed Clear) as failed. The Reset's refresh runs the same way. Pinned by
the suite's § 5 (`touchHooks.afterRead` throwing, and held pending).

🔒 The steps are COALESCED per key: the moment's refresh per moment, last-seen
and the carousel per rater and moment, badges per rater. While a key's run is in
flight, another save only marks it to run once more after, with the latest
function, so auto-save's save a second becomes at most one run plus one
trailing run per key (each step re-reads its state, so the trailing run covers
every save in between). Pinned by `scripts/tests/after-commit-units.ts` and the
suite's § 5 (a burst during a held refresh: one trailing refresh, not four).

## The version check (`rating_versions`, `lib/ratingVersions.ts`)

`rating_versions (user_id → users ON DELETE CASCADE, wine_id VARCHAR(21) with NO
foreign key, version INT, last_op_id UUID NULL, PRIMARY KEY (user_id, wine_id))`.
Versions exist ONLY for Postgres-backed moments, where a bottle id is the
`wines` primary key. The row has no key to `wines`: bottles are deleted and
re-minted, and the row must outlive them (the fence for late requests).

- **Every write** of a signed-in session rating of a Postgres-backed moment
  bumps it in the SAME transaction as the rating change, with ONE atomic
  statement (`INSERT … ON CONFLICT (user_id, wine_id) DO UPDATE SET version =
  rating_versions.version + 1, last_op_id = EXCLUDED.last_op_id RETURNING
  version`): the post edit of a soft-deleted moment runs without the session
  lock, so never read-then-write. `last_op_id` = the op's id, NULL for a writer
  without one.
- **The check.** Inside the contract, under its locks, after the admission and
  the bottle read and BEFORE anything is written: the current version is the
  row's `version`, or 0 without a row. When the request's `baseVersion` differs,
  nothing is written and the answer is **409 `{ stale: true, rating, version,
  lastOpId }`** (the current canonical rating, or `rating: null`). A request
  WITHOUT `baseVersion` (the web, old binaries) is not checked but still bumps,
  so a phone save based on an older version meets it.
- **`baseVersion`** is an integer ≥ 0 (0 = no version row: never rated, or rated
  before this release with no write since); **`opId`** a UUID (the app's
  `uuid.v4()`, never the 21-character client id: 400).
- ⚠️ This 409 is not the web's old-tab 409 (`app/CLAUDE.md` § Web wire
  generation: a GUEST's moment write from an old tab, no `X-Vr-Auth`): the web
  never sends `baseVersion`, so it never gets the `stale` body.
- **ONE name, `v`**: in the rating key JSON, on `/state` (own rows only), in
  every answer's `rating` (`RatingMeta.v?: number`, absent = 0); only the 409's
  top-level field is `version`. The rebuild restores `v` from `rating_versions`
  with a LEFT JOIN (`recordRatings`; absent without a row), classified
  `'rebuilt'` in `RATING_META_FIELDS`.
- 🔒 **`v` only on the caller's own rows**: `buildRatingsView(c, identities,
  callerId)` strips it from everyone else's (with auto-save it is an edit count
  per person and bottle, visible to the whole moment otherwise).

Why it holds: a re-sent op that had committed finds the version moved and gets
409 with its OWN `lastOpId` (the app adopts it); a stalled original arriving
after a newer save is refused; after rate → Clear the version moved twice, so a
stalled first save based on 0 is refused (no resurrection, no XP); a waited save
older than a web save is refused. An integer avoids the `mirror_at` traps
(nullable, microseconds, never backfilled, while the wire `at` is milliseconds).

### The writers (`scripts/check-rating-writes.mjs`, CI)

Every statement in `lib/` and `app/` that writes `ratings` or a rating key
(plus `DELETE FROM wines`, whose ratings cascade, and every call of
`engagementCascadeIn`) carries a tag (`// rating-write: BUMPS | COPIES |
EXEMPT`) and is pinned per file; an untagged or unpinned site fails the build,
and a BUMPS (COPIES) site whose enclosing function calls no bump (copy) helper
fails too. The list:

| Writer | Kind | How |
|---|---|---|
| The rate POST (merge, full, the Clear's reap) | BUMPS | `bumpRatingVersion` with the op's `opId` |
| The web Reset DELETE (its Postgres branch) | BUMPS | `bumpRatingVersion` when it deleted the rating of THIS moment; a Reset that finds no row here is version-neutral (the version row is per user and bottle id, and an id from the path may name another moment's bottle) |
| The post edit of a moment rating (`patchSessionRating`, the update and the reap; also in a soft-deleted moment) | BUMPS | `bumpRatingVersion`, `last_op_id` NULL; the live key carries the new `v` |
| `sessionWipe()` deleting a signed-in rater's ratings (ban, kick with delete, a full leave) | BUMPS | `bumpRaterVersions`: one statement for their rated bottles of the moment, BEFORE the delete (otherwise an entry that waited through a kick and a rejoin re-creates the deleted rating); no XP change for a host's wipe, the XP taken back for a full leave (below) |
| The host's bottle DELETE | BUMPS | `bumpBottleVersions` before the cascade: every rater of the bottle and every version row it already has (the add path can re-insert a supplied id) |
| The bottle re-mint (`copyCachedLineup`) | COPIES | `copyRatingVersions` for the raters whose ratings moved to the new id (`ON CONFLICT DO NOTHING`; the old id keeps its rows as the fence), so the copied keys' `v` still matches |
| Account deletion | EXEMPT | the rows cascade with the user |
| Standalone ratings (check-in POST, PATCH, DELETE) | EXEMPT | no moment, no version |
| A guest's Redis-only write | EXEMPT | no version (a signed-in one is refused, the 503) |
| A d: tombstone group's ratings, the rebuild, the reads and the key spelling | EXEMPT | no user / writes the record's values / not writes |

Order under the locks (`lib/CLAUDE.md` § Session mutation contract): the
admission → the 503 → the bottle → **the version check → the merge → the write
+ the bump** → the key.

## Counters and XP: once per rating

- Three flags on `ratings`: `five_star_counted`, `one_star_counted`,
  `note_counted`, read in the prior-row SELECT (`FOR UPDATE`) and set in the
  upsert, never cleared (the session lock serialises writers). The note rule is
  `char_length(notes) > 5` in SQL (code points: JS `.length` counts UTF-16
  units, so three emoji would qualify on save and miss the backfill).
- `lifetime_five_star`, `lifetime_one_star`, `lifetime_notes_written` fire only
  on their flag's flip; `lifetime_ratings` and the +10 only for a new rating.
- 🔒 The rating-action XP (+10 first save, +5 first five-star, +5 first note,
  `XP_REWARDS`) goes INTO the transactional `UPDATE users` beside the counters,
  and onto the row (`ratings.rating_action_xp`): after the contract the flags
  are committed, so a failed background award would lose it for good. A reaped
  save, an `unchanged` merge and a guest's save award nothing.
- Badge evaluation keeps running after the contract on every successful
  signed-in save, awarding only NEW badges' own XP (`checkAndAwardBadges(userId)`,
  no action parameter any more).
- 🔒 **The take-back on your OWN clear**: `engagementCascadeIn(…, { ownClear:
  true })`, passed ONLY by the empty full save, the web's Reset and a moment
  rating emptied in the post edit, debits the owner by the row's
  `rating_action_xp` (from `DELETE … RETURNING`), floored at 0, in the caller's
  transaction. A retry or a repeat finds no row and debits nothing; a first empty
  POST (insert + reap) debits 0; legacy rows carry 0 (their historical XP stays).
  Never for a host's bottle delete, a host's kick or ban with delete, or an
  account deletion. Counters never go down and earned badges stay; a take-back
  can drop a level (accepted).
- 🔒 **The take-back on your own "Delete my ratings"** (ruled 2026-11-26): a
  removed person (kicked or banned) who deletes their ratings of the moment
  (`POST /api/session/:code/leave?cleanup=full`, `sessionWipe` with its CALLER
  as the target) is debited the SUM of the deleted rows' `rating_action_xp`
  (`DELETE … RETURNING`), ONCE, floored at 0, in the wipe's transaction. A
  host's wipe of the same scope takes nothing. Otherwise leave, rejoin and
  re-rate would re-earn the XP every cycle.
- ⚠️ Lock order in `patchSessionRating`: the caller's `users` row `FOR NO KEY
  UPDATE` BEFORE the rating `FOR UPDATE`, in both branches (a soft-deleted moment
  runs a plain transaction, and account deletion takes the user row first and
  then rewrites the rating: rating-then-user would deadlock). A gone user is the
  existing 404.
- `POST /api/me/badges` is removed (it passed a client `action` through, +20 XP
  per call, no limiter, no client); GET and PATCH stay. Next answers 405.
- The backfill (`20261125234900_rating_flags_backfill`, between
  `-- @backfill:rating-flags` and `-- @endbackfill`): score 5 → five-star on,
  score 1 → one-star on, `char_length(notes) > 5` → note on, only those rows
  rewritten. Its own migration after the DDL (`20261125234816_rating_saves`),
  each in its own transaction, so the row rewrite never holds the DDL's ACCESS
  EXCLUSIVE lock on `ratings`. Run verbatim over rows written the old way by the
  suite (§ 8), which also checks it equals the same SET over every row.

## The app's outbox (`apps/mobile/src/lib/rateOutbox.ts`)

The app half of the contract (the hook `useImpressionAutosave`, the owner, the
runner). Only the moment impression screen auto-saves; not the check-in rate
stage, not the feed post edit.

### The entry

ONE entry per viewer (public id) × moment × wine, persisted in AsyncStorage (the
app container; deleted with the app; never cleared by `clearViewerCache()`). It
is the ONLY queue state; there is no list of jobs.

```
{ code, wineId,
  fields: { <name>: { value, rev } },          // edited fields only
  ackRev: { <name>: rev },
  baseVersion: number | 'unknown', baseHadRating: boolean | 'unknown',
  unresolvedOp?: { opId, body, baseVersion, revs },
  clear?: { opId, baseVersion?, restore },
  waited, createdAt, updatedAt }
```

- Revisions are entry-wide: a newer edit updates its field's value and rev, so
  "the latest edit wins" needs no ordering.
- **The base** is fixed when the entry is CREATED, from the own-rating snapshot
  the draft was seeded from (the owner's remembered answer, else the caller's row
  in the current `/state` ratings section): its `v`, or 0 for "no rating";
  `baseHadRating` with it (a pre-release rating has a row but `v` 0). With no
  snapshot yet both are `'unknown'`: edits persist, no op is built until a raw
  section arrives (a LIVE entry then takes the row's `v`, 0 without a row; a
  WAITED entry takes 0 without a row and is DROPPED when there is one). Never 0
  for unknown. Only the server's answers to this entry's ops move the base.
- `waited` = loaded from storage at launch, or edited offline, or the runner
  found itself offline with unsent revisions.
- One serialised OWNER per entry key: hydration, staging, applying an answer and
  removal, in order, each PERSISTED before the next op is sent. Staging happens
  on every settled edit (the ~1 s timer), every departure and every Clear; a
  field equal to the server value it was seeded from (normalised: `scrub` for the
  note) with nothing sent-but-unacknowledged is not staged.
- A departure resolves as soon as its revisions are persisted (online or
  offline); Previous / Next / Finish move on at once. It fails only when storage
  fails (the page stays and shows the error). Since build 2 the impression is a
  layer inside the line-up (ADR-0011, `apps/mobile/CLAUDE.md` § The impression
  layer): one page per neighbour, each with its own hook, and ONE transition
  guard per layer shared by paging (Previous, Next, an edge swipe), Finish and
  every close (the close button, Android Back, a pull-down).

### The runner

One request per entry at a time; offline it sends nothing. Online: (1) an
`unresolvedOp` is re-sent EXACTLY (same `opId`, body, `baseVersion`); (2) else a
staged `clear` (its `baseVersion` fixed at the FIRST send, from the entry's base,
then persisted); (3) else the fields whose rev > `ackRev` become ONE merge (a new
`opId`, the entry's base), persisted as `unresolvedOp`, then sent.

### The answer table

| Answer | The app |
|---|---|
| 2xx `{ ok, rating }` | resolved: acknowledge the revisions it carried, base := `rating.v`, patch the cache; remove the entry when nothing remains |
| 2xx `{ ok: true, unchanged: true }` | resolved; PARK the attempted revisions until a newer edit; the footer shows nothing new |
| 2xx `{ ok: true }` for a Clear | resolved: reset the draft, every field acknowledged, the Clear generation bumped, the rating removed from the cache, the entry removed |
| 409 `stale`, `lastOpId` = this op's `opId` | that op's SUCCESS (its earlier send committed): base := `version`, the cache gets `rating`; a Clear runs the Clear row |
| 409 `stale`, `rating: null`, the op's base 0 and `baseHadRating` false | not a conflict (a re-rate after a Clear, here or on the web, or after the host deleted it): base := `version`, re-send as a new op (waited entries too); a Clear answered this way is cleared |
| 409 `{ wrongViewer: true }` | not resolved: the cookie isn't the entry's viewer; like a 401 `invalid`, stop the viewer's runner, keep every entry, confirm with get-session |
| 409 `stale`, otherwise | a newer write from elsewhere: a WAITED entry is DROPPED (newer rating wins); a LIVE entry rebases ONCE (base := `version`, clean fields re-seeded, the edited ones re-sent); a second such 409 drops it with the footer error. A Clear is never rebased: the newer rating is shown and the person is asked again |
| 404, 403, 401 `X-Vr-Auth: removed` | resolved, entry dropped (the moment or wine gone, kicked, banned) |
| 401 `X-Vr-Auth: invalid` | not definitive alone: stop the viewer's runner, keep every entry, confirm with one `get-session` (still this viewer → that moment refused it: drop that entry) |
| 400 | resolved, entry dropped, logged (a client bug) |
| 429 | not resolved: retry after `Retry-After`; pauses EVERY entry of the viewer (the save limit is per person) |
| 503 (incl. a failed promotion) | not resolved: pauses every entry of THAT moment, retried with one of them, waiting the larger of `Retry-After` and the runner's backoff (5 s doubling to 5 min, reset by any 2xx or 409 from it) |
| `update_required` | not resolved: the runner stops until the next launch |
| any other error, 5xx, the timeout | AMBIGUOUS: back off and re-send the SAME op (the version check makes it safe) |

### What waits, what is dropped, the clean-up

- Waits (persisted, retried): offline, 429, 503, any ambiguous answer, a signed
  out or replaced viewer (entries are keyed by the viewer's public id and sent
  only for the signed-in viewer, never with another's cookie).
- Dropped, silently: 404 / 403 / removed, a waited entry meeting a newer rating,
  a waited entry with an unknown base when a rating exists, and
  `discardPending({ confirmed: true })` (a successful Delete Impression only).
  A bare `discardPending()` (a present line-up without the wine, a confirmed
  removal) ends the page's work and stages its draft into the entry, which is
  KEPT: the server's 404 / 403 / removed answer then drops it.
- Dropped with an alert ("Rating Not Saved", "Your last changes to X couldn't be
  saved.") when no page of that wine is visible: a second 409 for live edits, a
  400. A visible page shows the error in its footer instead.
- Entries older than **90 days** are removed unsent at launch (another account's
  waiting saves on a shared phone would otherwise stay until it signs in again).
- The line-up shows your ratings stored on the phone (the owner's overlay);
  Compare and other tasters see the server's state until the phone syncs.

## Rollback floor and deploy (release runbook)

- Deplo.io applies the migration before the new release serves: an old instance
  can still save for a few minutes after the backfill (a rating it touches can
  count once more; ruled, no write pause).
- ⚠️ An old server ignores `merge`, defaults an omitted score / flavors to 0 / `{}`
  and can reap: a note-only merge would zero a rating. Verify merge after EVERY
  serving instance has upgraded and BEFORE the app is distributed (smoke: a
  note-only merge over a stored score and structure); from distribution on, the
  oldest allowed rollback image must implement `merge: true`.

## Named residuals

- A signed-in Redis-only save made during a failed promotion BEFORE the deploy,
  then a note-only merge, loses that score (the key is never imported).
- A feed edit sets a score without counters; a later moment save can then claim
  the count. A rating that was 5 once and isn't now can count one more time; a
  clear and re-rate can add to the counters again (they never go down).
- A rollback to an old writer counts per transition and skips the take-back
  until roll-forward.
- The app half's residuals (two devices at once, a re-linked bottle, a line-up
  hidden meanwhile, …) are listed in the build prompt § 1 "Named residuals".

## Tests

`scripts/tests/rating-saves-integration.mts` (`check-schema.yml`, through the
real routes): merge and `unchanged` (§ 1), the version check and every writer
(§ 2, incl. the cross-moment Reset and the rolled-back save), the
wrong-account guard (§ 1b), the re-mint copy (§ 3), the 503 with the promotion failing and guests
unchanged (§ 4), the committed answer before the background refresh (§ 5),
counters and XP once per rating with every badge already earned, the take-back
on the three own-clear paths and the removed person's own "Delete my ratings",
none on a host's ban (§ 6), the soft-deleted moment's clear vs account deletion
(§ 7), the backfill verbatim (§ 8), the save limit (§ 9). The built-server 405 of
the badges POST: `scripts/tests/usernames-web.mts` § 5. The entrance-gate sweep
pre-fills `rl:rate:u:<id>:10m` (`scripts/tests/leak-fixes-section.mts`). The
app's outbox units: `scripts/tests/*-units.ts` in `check-vintage-units.yml`.
