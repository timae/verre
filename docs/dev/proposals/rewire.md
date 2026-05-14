# The big rewire — unifying ratings, check-ins, and the feed

**Status**: planning, not yet started.
**Branch**: `feature/rewire-plan` for this doc; subsequent phases each get their own branch.

This is the architecture and migration plan for unifying the two parallel rating systems (in-session ratings + standalone feed check-ins) into a single normalised model, and reshaping the feed to render sessions as aggregate "posts" rather than one-card-per-rating.

The goal of this doc is to settle the shape **before** we touch code. Once it's agreed, each phase becomes its own branch and PR.

This doc deliberately spends time on **why** each decision was made, not just **what** the decision is. Six months from now, edge cases will come up; the right call depends on what we were optimising for. Recipes without rationale rot fast.

---

## 1. The problem today

Two systems, same conceptual operation (a user gives a wine a score + flavours + notes), entirely separate plumbing:

| | In-session rating | Standalone check-in |
|---|---|---|
| Table | `ratings` (FK to `wines`) | `checkins` (wine fields denormalised inline) |
| Wine row | Yes — `wines.id` is the catalog anchor | No — wine name/producer/vintage live as columns on the checkin |
| Score required? | Yes (NOT NULL) | No (nullable; check-in can exist without a score) |
| Likes / tags | None | `checkin_likes`, `checkin_tags` (FK to `checkins.id`) |
| Lands on the feed? | No | Yes |
| Lands on user's history? | Yes (`/me/history`) | Yes, separately (`/me/feed`) |
| Hall of Fame trigger | Yes (score ≥ 5) | No |

Two consequences:

1. **A session rating is socially invisible.** You rate 8 wines in a session with friends; nothing about that taste experience reaches the feed. To share, you'd have to manually re-create check-ins.
2. **History is fragmented.** The "wines I've tasted" list lives in two tables that never join. Profile filtering / search across all of a user's tastes is impossible without UNION-ing them.

The rewire collapses these into one model where **a rating is a rating, regardless of how it got created**.

---

## 2. The shape we're moving to

### Mental model

- A **wine** (row in `wines`) is a catalog entry. One row per wine-as-the-DB-sees-it.
- A **rating** (row in `ratings`) is the atomic taste event: one user, one wine, one moment in time, with a score + flavours + notes + timestamp. Score is optional (more on this below).
- A **feed item** (row in a new `feed_items` table) is what shows up on the social feed. Two kinds:
  - **standalone** — wraps a single rating (the old "check-in").
  - **session** — wraps a session-worth of ratings by one user (one feed item per (session, user) pair, not per wine).
- **Likes**, **tags**, and **location** attach to the **feed item**, not to individual ratings. (Instagram's model: like the post, not each photo.)
- **Bookmarks** keep attaching to wines (the existing model — "I want to try this wine"). Per-post interest is captured as future work; the schema column gets added later (see `.local/future-work-rewire.md`).

### A "rating" is really a "tasting"

The user-facing concept is **a tasting** — a discrete event of "I drank this wine, here's what I thought, on this date." The same user can taste the same wine many times across their lifetime. This is not an edge case — it's the central use case:

- "I have 6 bottles of a red that ages well; I want to add a tasting every 5 years and see how it evolves."
- "I had this wine in a session last March, and I'm having it again standalone tonight. Both are real tasting events; I want both in my history."
- Future: a "7th round with this wine" badge that counts how many times you've come back to a bottle.

So conceptually `ratings` is misnamed — it's `tastings`. We keep the table name `ratings` for the same reason we keep `wines` instead of renaming to `items`: the mechanical cost of renaming every Prisma relation, every variable, every API path is high, and the value is naming-only. The doc and code comments name the mismatch where it matters; user-facing copy says "tasting."

### Profile surfaces (the three tabs)

| Tab | Source | Purpose |
|---|---|---|
| **Posts** | `feed_items WHERE userId = me` | Chronological "what I shared." Sessions show as 1 post (with N wines inside), check-ins as 1 post each. |
| **Tastes** | `ratings WHERE userId = me` | Searchable, filterable history of every wine you've tasted. Multiple rows per (you, wine) when you've tasted it more than once. UI shape (group-by-wine vs flat chronological) is out of scope for the rewire — settled later. |
| **Wishlist** | `bookmarks WHERE userId = me` | "Wines I want to try." Already exists today as `/me/saved`. |

### Schema deltas

#### `wines` — mostly unchanged

The existing table already does most of what we need. Two activations:

- **`wines.category`** already exists with default `"wine"` and is unused. We start writing it. Future categories: `"beer"`, `"spirit"`, `"food"`, etc.
- **`wines.style`** stays as the sub-classification (`red`/`white`/`spark`/`rose`/`nonalc` for wine; `IPA`/`Stout`/`Lager` for beer when it arrives).

The valid `(category, style)` pairs are constrained at the DB level via the new `category_styles` lookup table — see below.

**Why no rename to `items`/`drinks`:** Same trade-off as `ratings` → `tastings`. Renaming a fundamental table costs a lot of mechanical churn (every FK, every Prisma relation, every `wineId` variable, every API path) for naming-only value. The future "a beer in the wines table" awkwardness is a comment-line problem; renaming preemptively isn't worth it.

#### `category_styles` — new lookup table

```
category_styles
  category   String   // 'wine', 'beer', 'spirit', 'food', ...
  style      String   // 'red', 'IPA', 'Negroni', 'hard', ...
  label      String   // human-display: 'Red Wine', 'Imperial Stout'
  sortOrder  Int      // for UI dropdowns
  active     Boolean  // soft-delete; we don't drop unused styles in case wines reference them

  @@id([category, style])
  @@index([category, sortOrder])
```

`wines` gets a composite FK `(category, style) REFERENCES category_styles(category, style)`. Postgres supports this directly.

**Why a lookup table and not a CHECK constraint:** A CHECK with an allow-list (`category='wine' AND style IN ('red','white',...)`) works for 5 stable wine styles. It does not work for beer's hundreds of styles, where adding a new style would mean a code-deploy migration. Lookup table = adding a style is a single INSERT row, no migration.

**Why `category_styles` and not `wine_styles` / `drink_styles` / `item_styles`:** Names the table by what it contains (a mapping from category to its valid styles), not by domain. Works for wine + beer today and cheese + coffee tomorrow without renaming. Column-name parity with `wines.category`.

**Why `active` instead of hard-delete:** A wine row that references `(category='wine', style='legacy_thing')` would break if the lookup row vanished. Soft-delete keeps the FK valid; UI filters `active=true` for the dropdown.

#### `ratings` — drop the over-strict unique, allow scoreless rows

Two changes to the existing table:

1. **Drop `@@unique([wineId, userId])`.** Replace with no unique constraint at all.
2. **Make `score` nullable** (`Decimal?` instead of `Decimal`).

```
ratings
  id        Int          @id @default(autoincrement())
  wineId    String
  userId    Int?
  sessionId Int?         // NEW — NULL = standalone rating, otherwise FK to session
  raterName String       // tombstone snapshot, today's behaviour
  score     Decimal?     // NEW — was NOT NULL
  flavors   Json
  notes     String?
  ratedAt   Timestamptz

  @@index([wineId])
  @@index([userId])
  @@index([sessionId])
  @@index([userId, wineId])    // for the future "all my tastings of this wine" query
```

**Why drop the unique:** The constraint was load-bearing for one reason — in a session, "rate the same wine twice" should mean "edit your rating," not "create a second rating." That's correct *inside one session*. It breaks the moment the same wine row gets tasted across contexts:

- Same wine in two sessions (post-dedup, when we eventually get there).
- Same wine in a session AND as a standalone check-in.
- Same wine standalone twice (the aging-bottle case — "I had this in 2020 and again in 2025, both are real tastings").

A unique constraint that has to be sidestepped by creating fresh `wines` rows for every taste event is fighting the data model. Dropping it makes the schema honest: each taste event is its own row, period.

The session UX continues to feel like "edit in place" because in *that session*, the user only has one tasting of that wine — UI naturally hits the right row via `WHERE userId=X AND wineId=Y AND sessionId=Z`, finds at most one row, edits it. Outside a session, the "+ check-in" button always inserts a new row.

**Why score nullable:** Some users want to log "I drank this wine" as a memory aid without committing to a score — "I had it but I'm not sure what to rate yet" or "I'm using this app as a history of what I drank where with whom, not as a rating system." Forcing a score betrays that use case.

The cost is small print: HoF / "average score" / "rated above 4" queries need `WHERE score IS NOT NULL`. Trivial to remember; the linter won't catch it but the queries are few and concentrated.

**Why the new `sessionId` column on `ratings`:** Today we resolve "is this a session rating?" via `wines.sessionId`. After the rewire that's wrong, because a single wine row can host both session ratings and standalone ratings. The rating itself needs to know its origin context. Also makes the session feed item enumeration trivial: `SELECT * FROM ratings WHERE userId=X AND sessionId=Y` directly gives "what wines did X engage with in session Y."

#### `feed_items` — new table

```
feed_items
  id                  Int @id autoincrement
  userId              Int
  kind                String  // 'session' | 'standalone'
  sessionId           Int?    // set when kind='session'
  ratingId            Int?    // set when kind='standalone' (single-rating shortcut)
  venueName           String?
  city                String?
  country             Char(2)?
  lat / lng           Decimal?
  locationVisibility  String  // 'public' | 'private' | 'none' (default 'none')
  createdAt           Timestamptz default now()

  @@index([userId, createdAt desc])      // profile "Posts" tab
  @@index([createdAt desc])              // global feed pagination
  @@unique([userId, sessionId])          // one feed item per (user, session) — see below
```

**Why feed_items separate from ratings:** A session feed item bundles many ratings into one social post (Instagram-multi-image model). It can't sit on a rating row. A standalone feed item could conceptually live on the rating, but giving both kinds the same shape means one render path, one like target, one pagination cursor — much simpler than special-casing standalone-as-rating vs session-as-bundle.

**Why `kind` and not just "infer from sessionId":** Explicit is better. A reader (human or query) doesn't have to know "sessionId IS NULL means standalone, IS NOT NULL means session." Also future-proofs against a third kind we haven't thought of (e.g. badge unlocks, if we ever fold those into `feed_items`).

**Why `@@unique([userId, sessionId])`:** Each user gets exactly one feed item per session — a "session post." User A and user B in the same session get two separate feed items (their own posts, with their own ratings inside). This is correct: each user is sharing their own experience, not a shared one. The unique constraint exists to prevent **double-creation under concurrent rates** — when user A rates wine 1 and wine 2 in session X near-simultaneously, both inserts try to upsert "feed item for (A, X)"; the unique constraint + `ON CONFLICT DO NOTHING` makes the second insert a no-op.

**Why `locationVisibility`:** A standalone check-in at a public bar should show the location in the feed (helps friends know where to find good wine). A tasting session at someone's home should not — it's a private space. Three values:

- `'public'` — render "@ Bar Toni, Zürich" on the feed card.
- `'private'` — render "🏠 private tasting" (or similar). Lat/lng never exposed.
- `'none'` — no location line at all. Default.

Migrated standalone check-ins with location data get `'public'` (their location was already in the feed). Migrated session feed items get `'none'` (we don't have data and didn't promise visibility). Host-side UI to set this on session-create is post-rewire.

#### `feed_item_likes` and `feed_item_tags` — new tables

Same shape as `checkin_likes` / `checkin_tags`, but FK to `feed_items.id`. Created in phase 1; populated during phase 2 backfill from the existing tables.

#### `checkins` and friends — dropped in phase 5

Until then they coexist with the new model.

---

## 3. The engagement trigger — what creates a session feed item

Today, opening a wine in a session UI doesn't commit anything. A user can browse the wine list and never engage with any of them. The session is a tasting opportunity, not a forced rating obligation.

After the rewire, the question is: **when does a wine become "a wine I tasted in this session"** — and therefore appear on my session feed item?

**The rule: any engagement counts.** A user is considered to have tasted a wine in a session when they save any of:
- a score, OR
- one or more flavour chips, OR
- a note.

Setting any one of those creates the `ratings` row (with the others NULL/empty). The wine then appears on the session feed item for that user. If it's the user's first engagement in that session, the upsert into `feed_items` (with `ON CONFLICT DO NOTHING` on `(userId, sessionId)`) creates the session post.

**Why this rule:** In a session setting, we have no other signal that the user actually drank a wine. (Standalone is different — the act of creating a check-in is itself the signal that "I drank this.") Engagement on the rating page is the only behavioural proxy we have. Three forms of engagement matters because:

- A user might know the score immediately ("4 stars, easy") without thinking about flavours.
- Another might want to capture flavours and a note but feel undecided on a score.
- Another might just want to write "had this with the duck, paired beautifully" and not score at all.

All three count as "I tasted this." Standalone scoreless check-ins are the same idea — see the score-nullable reasoning in §2.

**Symmetric un-engagement: deletion.** If a user clears their score, removes all chips, and empties the note, the rating row is deleted. If it was the user's only rating in the session, the session feed item gets deleted too. Symmetric with the engagement-based creation; prevents accidental engagements from being sticky.

---

## 4. What we deliberately are NOT doing in this rewire

To keep the scope sane, these are explicit non-goals:

1. **Dedup of wines across sessions / users.** Today no dedup exists; every wine-add creates a fresh row. With the current tiny user base, almost every wine is unique anyway. The infrastructure (`pg_trgm`) is in place; we add the dedup logic the day a duplicate becomes a problem. See `.local/future-work-rewire.md`.
2. **Renaming `wines` → `items` / `drinks`** or **renaming `ratings` → `tastings`.** High mechanical churn for low present-day value. Defer until something else forces the rename.
3. **Per-post bookmark counts ("5 friends interested in this wine *on this post*").** Captured as future work — needs a `bookmarks.feed_item_id` column. Schema is forward-compatible; we plant the column when we ship the feature.
4. **Profile search/filter over the new Tastes tab.** The rewire builds the data model that makes this trivial later; the actual search UI is a follow-up.
5. **Tastes-tab UI shape** (group-by-wine vs flat chronological vs toggle). Out of scope; settled when the tab is wired.
6. **Public/private session location toggle UI.** The `locationVisibility` column ships now (so we don't need a follow-up migration), but the host UI to set it on session-create is post-rewire.
7. **Hall of Fame changes.** HoF stays exactly as-is during the rewire — same trigger (score ≥ 5 from a session rating), same dedup rule. Tim is reworking HoF separately; this rewire doesn't touch it.
8. **Auto-tagging session participants.** A future option ("tag everyone you tasted with") — captured as future work. The rewire doesn't ship it.
9. **Aggregate views beyond the basic session card.** No "10 friends rated this wine" cross-session views in this pass — the data model unblocks them, the UI doesn't ship them.
10. **Notifications on likes/tags moving from `checkins` → `feed_items`.** No notification system exists today; nothing to update.

---

## 5. Migration of existing data

The user base is small enough to migrate cleanly. We migrate.

### What needs migrating

For each existing `checkins` row:
1. Look up or create a `wines` row (the rewire moves to "every check-in is backed by a wine row"). `sessionId = NULL`. Default `category = 'wine'`.
2. Create a `ratings` row pointing at that wine. `sessionId = NULL`. `score` carries through (NULL if the original was scoreless — now legal).
3. Create a `feed_items` row with `kind='standalone'`, `ratingId` set, `venueName/city/country/lat/lng/createdAt` carried over, `locationVisibility='public'` if any location field is non-NULL else `'none'`.
4. For each `checkin_likes` row: create a `feed_item_likes` row pointing at the new feed item.
5. For each `checkin_tags` row: create a `feed_item_tags` row pointing at the new feed item.

For each existing `ratings` row that came from a session (today: every row): set `sessionId` to the session-id derived from the wine's existing `sessionId`. (Today the rating belongs to a session implicitly via the wine; we now make it explicit on the rating itself.)

For each existing `(session, user)` pair where the user has at least one rating in that session:
1. Create a `feed_items` row with `kind='session'`, `sessionId` set, `createdAt` = the user's earliest rating timestamp in that session.
2. No likes/tags to migrate (sessions don't have those today).

### Wines that exist but have no `category`

Today every wine row has `category='wine'` by default — the column has been there silently. After the rewire we activate the FK to `category_styles`. Pre-flight: seed `category_styles` with `('wine', 'red'), ('wine', 'white'), ('wine', 'spark'), ('wine', 'rose'), ('wine', 'nonalc')` before applying the FK. Existing wines whose `style` is NULL or doesn't match a seeded row need either a backfill or temporary FK relaxation — settle in phase 1 once we count the affected rows.

### How the migration script runs

A one-shot TypeScript file at `prisma/migrations/<timestamp>_rewire_data/data-migration.ts` (or just a script we run by hand against prod). Wraps the whole thing in a single Prisma transaction. Idempotent guard at the top: `if (await prisma.feedItem.count() > 0) throw 'already migrated'` so it can't run twice.

Phases 2 and 3 are separate branches; the data migration is part of phase 2 and we hold phase 3 (the read cutover) until we've eyeballed the migrated rows in a staging DB and on prod.

---

## 6. Phasing

Each phase = one branch, one PR, mergeable on its own. After each merge to main, the system is shippable. No long-lived rewire branch.

### Phase 1 — additive schema only
**Branch**: `feature/rewire-p1-schema`

- New tables: `category_styles`, `feed_items`, `feed_item_likes`, `feed_item_tags`.
- Seed `category_styles` with the 5 wine styles.
- New columns: `feed_items.locationVisibility`, `ratings.sessionId`.
- Drop `@@unique([wineId, userId])` on `ratings`. Make `ratings.score` nullable.
- Add the composite FK `wines (category, style) → category_styles (category, style)` — only after the pre-flight check that all existing wine rows have valid pairs (or we relax to a soft FK and backfill in phase 2).
- No code changes. No reads, no writes affected. Just structure.

Mergeable to main with zero behaviour change. Production gets the new tables on the next deploy.

### Phase 2 — dual-write + backfill
**Branch**: `feature/rewire-p2-dualwrite`

- `POST /api/checkins` continues to write to `checkins` AND now also writes the equivalent `wines` + `ratings` (sessionId=NULL) + `feed_items` + `feed_item_likes/tags`. Same for PATCH/DELETE on a check-in (mirrored deletes).
- `POST /api/session/[code]/rate` continues to write `ratings` AND now also (a) sets `ratings.sessionId` on the new row and (b) creates/upserts the `feed_items` row for `(session, user)` (idempotent — only the first engagement in a session creates the feed item).
- Run the backfill script (§5) once against staging, eyeball, then prod.
- After this phase: both the old `checkins` table and the new `feed_items`/`ratings`-with-sessionId mirror are populated and stay in sync. Reads still come from the old tables.

This is the highest-risk phase — anything that diverges between the writers will surface here. Worth slowing down for.

### Phase 3 — read cutover
**Branch**: `feature/rewire-p3-readcutover`

- `/api/feed` SELECTs from `feed_items` (with JOINs to `ratings` + `wines`) instead of `checkins`. Output shape stays compatible with the existing `CheckinCard` component: standalone feed items render as before; session feed items render as a stub "session card" until phase 4 ships the aggregate UI.
- `/api/me/feed` (own feed): same.
- `/u/<id>` profile activity: switch the source from `checkins` to `feed_items`.
- `/api/me/history` (the future "Tastes" tab data) starts pulling from `ratings` directly, no longer needs the `UNION` between ratings and checkins.
- Block / mute / visibility plumbing (`batchLoadVisibilities`, `viewerCanSeeAuthor`, block-pair like/tag scrubbing) gets re-pointed from `checkin_id` keys to `feed_item_id` keys. The logic itself stays — only the join keys change.

After this phase, the new model is what users see. The old `checkins` table is still being written (phase 2's dual-write) but no longer read.

### Phase 4 — UI rewire (aggregate session card)
**Branch**: `feature/rewire-p4-aggregate-card`

- New `<SessionFeedCard>` component for `feed_items.kind='session'` — renders the host name + session name + a list/grid of wines rated by the user, with their scores. Likes + tags on the card, not per-wine.
- `<CheckinCard>` (the existing one) handles `feed_items.kind='standalone'`.
- `FeedClient` switches on `kind` to pick the renderer.
- Profile gets the three-tab split (Posts / Tastes / Wishlist). Tastes-tab UI shape kept minimal — chronological list is fine for the rewire; richer grouping is future work.

This phase is pure frontend; no schema, no API.

### Phase 5 — drop the old tables
**Branch**: `feature/rewire-p5-drop-checkins`

- Stop writing to `checkins` / `checkin_likes` / `checkin_tags`. Remove the dual-write code paths from phase 2.
- Wait at least one production deploy cycle after phase 4 ships, ideally a week, so we can revert phase 4 without losing the write side.
- Drop the three tables in a destructive migration (per `prisma/CLAUDE.md`: explicit human confirmation, `pg_dump` first).
- Remove the `Checkin*` Prisma models, dead code.

This is the irreversible step. Everything before it can be rolled back.

---

## 7. Risks and how we mitigate them

| Risk | Mitigation |
|---|---|
| **Dual-write divergence in phase 2.** Old and new writers slowly drift. | One write path per endpoint, both branches in the same function, same transaction where possible. Smoke-test by running the backfill repeatedly against a staging DB and diffing the row counts. |
| **Double-creation of a user's feed item under concurrent rates.** User A rates wine 1 + wine 2 in session X near-simultaneously; both inserts try to upsert "feed item for (A, X)". | The `@@unique([userId, sessionId])` constraint + `ON CONFLICT DO NOTHING` in the upsert. Won't crash; will silently dedupe to one feed item. |
| **Privacy regression on session locations.** Hosts didn't opt in to anything when they created their existing sessions; if we default `locationVisibility` to `public`, we'd surface "Simon's living room" as a venue if it ever got entered. | All migrated session feed items default to `locationVisibility='none'`. Session-create UI to set this is a follow-up; until then, sessions show no location. |
| **Block-pair scrubbing breaks during read cutover.** The current feed has 30+ lines of careful block-aware filtering on `checkin_id`. | Phase 3's PR includes a side-by-side: old `/api/feed` vs new `/api/feed` for the same viewer should return the same items minus the session aggregations. Run before merge. |
| **Lifetime counters double-count during phase 2.** Today `users.lifetime_ratings` etc. increment from the in-session rating endpoint. If the dual-write also increments from the standalone-checkin endpoint (which today increments per-checkin counters separately), we might double. | Audit the counter increments per endpoint before phase 2 lands. Counter increments stay tied to the canonical write path (the rating insert), not duplicated on the feed-item insert. |
| **Existing wines with `(category, style)` that doesn't match `category_styles`.** Pre-flight check before adding the FK. | Phase 1 includes a `SELECT category, style, COUNT(*) FROM wines WHERE (category, style) NOT IN (SELECT category, style FROM category_styles)`. If non-zero, decide: backfill or relax the FK to deferred / soft. |
| **Engagement-deletion edge case.** User clears their last rating in a session — feed item should also be deleted. | The session-rate DELETE path (or the symmetric "all fields cleared = delete row" trigger) checks `COUNT(*) FROM ratings WHERE userId=X AND sessionId=Y` post-delete; if zero, deletes the feed item. |

---

## 8. Open questions to settle before phase 1

1. **`feed_items.kind` value name** — `'standalone'` or `'checkin'`? Lean: **`'standalone'`** because we'll continue to use the word "check-in" in user-facing copy for both kinds (a session check-in is what happens when you engage with a wine in a session; a standalone check-in is what we used to call a check-in). Internal kind names should disambiguate, not double the user-language overload.
2. **Pre-flight `category_styles` mismatch count** — count how many existing wines have `(category, style)` pairs not in the seed list. If zero, FK can be added in phase 1 directly. If non-zero, decide: backfill missing pairs into `category_styles`, or relax the FK and backfill in phase 2.
3. **What happens to a session feed item if the host deletes the session?** Today: ratings are kept if bookmarked, else deleted (per `docs/dev/session-deletion.md`). For the feed item: probably "delete the feed item if zero ratings remain after the session-deletion rule runs." Worth a one-liner addition to `docs/dev/session-deletion.md` after phase 1 lands.

---

## 9. Out of scope (revisit later)

- Beer / spirit / food category support (the `category` column ships and the `category_styles` table is in place, but no UI, no flavour wheels, no styles seeded for non-wine).
- A real drinks catalog (importing 10k+ wines).
- Wine dedup across sessions / users.
- Per-post bookmark counts.
- Public/private session toggle UI.
- Auto-tagging session participants.
- Comments on feed items.
- Cross-user wine aggregates ("47 people rated this wine 4.2 avg").
- Profile search/filter on the Tastes tab.
- Tastes-tab UI shape (group-by-wine vs flat chronological).
- "7th round with this wine" badge / aging analytics.

All of these become easy or trivial to build *because* of this rewire. None of them ship as part of it.
