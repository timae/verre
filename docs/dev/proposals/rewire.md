# The big rewire — unifying ratings, check-ins, and the feed

**Status**: planning, not yet started.
**Branch**: `feature/rewire-plan` for this doc; subsequent phases each get their own branch.

This is the architecture and migration plan for unifying the two parallel rating systems (in-session ratings + standalone feed check-ins) into a single normalised model, and reshaping the feed to render sessions as aggregate "posts" rather than one-card-per-rating.

The goal of this doc is to settle the shape **before** we touch code. Once it's agreed, each phase becomes its own branch and PR.

This doc deliberately spends time on **why** each decision was made, not just **what** the decision is. Six months from now, edge cases will come up; the right call depends on what we were optimising for. Recipes without rationale rot fast.

> **Schema sketches in this doc are pseudocode.** They show columns, types, indexes, and key constraints, but are not valid Prisma syntax — translate to the project's Prisma conventions when implementing.

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
- A **session** (row in `sessions`) is a tasting event with a host, a wine lineup, and participants. Soft-deletable — the row never goes away.
- A **feed item** (row in a new `feed_items` table) is what shows up on the social feed. Two kinds:
  - **standalone** — wraps a single rating (the old "check-in").
  - **session** — wraps a session-worth of ratings by one user (one feed item per (session, user) pair, not per wine).
- **Rating images** (rows in a new `rating_images` table) are per-tasting photos — a small album attached to one rating. Falls back to the wine's canonical photo when empty.
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

#### `sessions` — soft-deletable

Add one column:

```
sessions
  ... existing columns ...
  deletedAt   Timestamptz?    // NEW: NULL = live, set = deleted (tombstone)
                              // On delete: every column except `id` and `deletedAt` is scrubbed
                              // to NULL. The tombstone is genuinely empty. See §8 for contract.

  // Partial index for the dominant filter (`WHERE deleted_at IS NULL`)
  // — a normal B-tree on a mostly-NULL column wouldn't be selective.
  CREATE INDEX sessions_live_idx ON sessions (id) WHERE deleted_at IS NULL;
```

**Why soft-delete on `sessions` and not on the children:** session_id is the natural grouping key for "all my ratings from this tasting" and "all wines on this post." If we hard-deleted `sessions` and nulled the FKs on ratings/feed_items, we'd lose the grouping (and a user's three deleted sessions would all collapse into one indistinguishable bucket of orphaned ratings). Keeping the `sessions` row as a tombstone preserves the grouping for free — every existing query that joins on `session_id` keeps working, and a `sessions.deletedAt IS NOT NULL` check tells the UI to render "[deleted session]" instead of the original name.

**The leak risk and how we contain it:** every query that lists "live sessions" or checks "is this session live and admin-able" needs `WHERE deletedAt IS NULL`. The session-existence surface in the codebase is small (~5 sites today: host check, lifespan check, settings + name endpoints, `lib/session.ts` resolvers — independent of Redis lookups). We add the inline filter to those sites in phase 2 and audit the PR. A Postgres view (`live_sessions`) is not worth introducing for a 5-site surface — Prisma doesn't model views as first-class, and the indirection costs more than it saves. Add the view the day the surface grows past ~15 sites.

**Important note on what the filter does NOT hide:** the `live_sessions` filter is for "is this session a live admin target?" It does NOT hide deleted sessions from feeds, profiles, or history surfaces. Those surfaces JOIN `sessions` precisely to read `deletedAt` and decide between rendering the live name or the "[deleted session]" tombstone label. So the rewire is explicit about which queries filter and which don't:

| Query | Filter `deletedAt IS NULL`? | Why |
|---|---|---|
| `/api/feed` and profile Posts/Tastes tabs | No | Wants the JOIN to render tombstones |
| `/api/session/[code]` GET / settings / wines / name endpoints | Yes | 404 deleted sessions to admins/participants |
| `lib/session.ts` resolvers | Yes | Deleted sessions are gone for live use |

#### `wines` — mostly unchanged + extras landing zone

The existing table already does most of what we need. Two activations and one addition:

- **`wines.category`** already exists with default `"wine"` and is read-only-passed-through today. We start writing it. Future categories: `"beer"`, `"spirit"`, `"food"`, etc.
- **`wines.style`** stays as the sub-classification (`red`/`white`/`spark`/`rose`/`nonalc` for wine; `IPA`/`Stout`/`Lager` for beer when it arrives).
- **`wines.attributes Json?`** — NEW. Landing zone for category-specific fields (beer IBU/ABV, food prep details, etc.). Heavy-use fields get promoted out of `attributes` into typed columns later.

The valid `(category, style)` pairs are constrained at the DB level via the new `category_styles` lookup table — see below.

```
wines
  ... existing columns ...
  attributes  Json?       // NEW: category-specific extras, app-layer validated

  // NEW: trigram indexes for future search/filter on wine name + producer
  CREATE INDEX wines_name_trgm ON wines USING GIN (name gin_trgm_ops);
  CREATE INDEX wines_producer_trgm ON wines USING GIN (producer gin_trgm_ops);
```

**Why no rename to `items`/`drinks`:** Same trade-off as `ratings` → `tastings`. Renaming a fundamental table costs a lot of mechanical churn (every FK, every Prisma relation, every `wineId` variable, every API path) for naming-only value. The future "a beer in the wines table" awkwardness is a comment-line problem; renaming preemptively isn't worth it.

**Why `attributes` as JSON:** Postgres `jsonb` is first-class and indexable via GIN. Cost: no schema enforcement (a typo writes silently). Acceptable for rarely-queried, category-specific extras. App-layer validation becomes load-bearing for any field we plan to filter on. Pattern matches Stripe's `metadata`.

**Why trigram indexes now:** `pg_trgm` is already enabled in `prisma/schema.prisma`. Search/filter on the Tastes tab is captured as future work but inevitable. Adding the indexes now is cheap (~minutes for current row counts) and avoids a post-import rebuild on a much larger table later.

**Wine ID generation:** Today `wines.id` is `Date.now().toString()` (`lib/session.ts:333,346`). This collides under concurrent inserts (same millisecond) — fine at single-user pace, broken in any migration loop or concurrent-rate scenario. Phase 1 switches to a collision-safe generator (`nanoid` or `cuid`) for new wine creation, and the migration script uses the same generator for newly-minted wine rows. Existing rows keep their timestamp-string IDs.

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

#### `ratings` — drop the over-strict unique, allow scoreless rows, link to session, mark provenance

Five changes to the existing table:

1. **Drop `@@unique([wineId, userId])`.** Replace with a partial unique that only constrains in-session rows (see below).
2. **Make `score` nullable** (`Decimal?` instead of `Decimal`). Note: today's convention `score = 0` means "not rated" (per root CLAUDE.md and `docs/dev/score-system.md`); the rewire keeps this convention. NULL is reserved for "never had a score at all" (e.g. a memory-aid check-in).
3. **Add `sessionId Int?` FK.** Direct link to the originating session (NULL = no session).
4. **Add `origin String`.** Provenance tag: how this rating came into being. Today: `'session'` | `'standalone'`. Future: `'imported'`, `'restaurant_api'`, `'bottle_scan'`, etc.
5. **Add partial unique** `(userId, wineId, sessionId) WHERE sessionId IS NOT NULL`. Inside a session: at most one rating per (user, wine, session) — race-safe. Outside (standalone): unconstrained, supporting the aging-bottle case.

```
ratings
  id        Int          @id @default(autoincrement())
  wineId    String
  userId    Int?         // NULL for anon ratings (today's behaviour preserved)
  sessionId Int?         // NEW — FK to session when origin='session'; NULL otherwise
                         // Survives session-delete because sessions is soft-deleted (§8 contract)
  origin    String       // NEW — 'session' | 'standalone' (today); future: 'imported', etc.
                         // Immutable once set; sets at insert time
  raterName String       // tombstone snapshot for [deleted] users, today's behaviour
  score     Decimal?     // NEW — was NOT NULL. score=0 still means "not rated"; NULL means
                         //       "never scored" (memory-aid check-in)
  flavors   Json
  notes     String?
  ratedAt   Timestamptz

  images    RatingImage[]    // see below

  @@index([wineId])
  @@index([userId])
  @@index([sessionId])
  @@index([userId, wineId])     // for the "all my tastings of this wine" query
  @@index([userId, sessionId])  // hot path: enumerate the wines a user engaged with in a session

  // Race-safe in-session uniqueness; standalone rows unconstrained
  CREATE UNIQUE INDEX ratings_session_unique
    ON ratings (user_id, wine_id, session_id)
    WHERE session_id IS NOT NULL;
```

**Why drop the unique:** The old constraint was load-bearing for one reason — in a session, "rate the same wine twice" should mean "edit your rating," not "create a second rating." That's correct *inside one session*. It breaks the moment the same wine row gets tasted across contexts:

- Same wine in two sessions (post-dedup, when we eventually get there).
- Same wine in a session AND as a standalone check-in.
- Same wine standalone twice (the aging-bottle case — "I had this in 2020 and again in 2025, both are real tastings").

A unique constraint that has to be sidestepped by creating fresh `wines` rows for every taste event is fighting the data model. Replacing it with the partial unique keeps the in-session race protection while honouring the multi-tasting-per-wine reality.

The session UX continues to feel like "edit in place" because in *that session*, the user only has one tasting of that wine — UI naturally hits the right row via `WHERE userId=X AND wineId=Y AND sessionId=Z`, finds at most one row, edits it. Outside a session, the "+ check-in" button always inserts a new row.

**Why score nullable:** Some users want to log "I drank this wine" as a memory aid without committing to a score — "I had it but I'm not sure what to rate yet" or "I'm using this app as a history of what I drank where with whom, not as a rating system." Forcing a score betrays that use case.

The cost is small print: HoF / "average score" / "rated above 4" queries need `WHERE score IS NOT NULL AND score > 0`. Trivial to remember; the queries are few and concentrated.

**Why `sessionId` on ratings:** Today we resolve "is this a session rating?" via `wines.sessionId`. After the rewire that's wrong, because a single wine row can host both session ratings and standalone ratings. The rating itself needs to know its session context. Also makes the session feed item enumeration trivial: `SELECT * FROM ratings WHERE userId=X AND sessionId=Y` — backed by the explicit `(userId, sessionId)` index — directly gives "what wines did X engage with in session Y," and this query keeps working after session-delete because the soft-delete preserves the `sessions` row.

**Why `ratings.origin` despite having `sessionId`:** Provenance is a separate question from session-membership. Today there are two ingestion paths (session, standalone), and `sessionId IS NULL ⇔ standalone` happens to hold. But future paths — Vivino / CellarTracker imports, restaurant API integrations, bottle scans, guided tasting flows — would all be `sessionId IS NULL` with completely different origins. Without `origin`, the user's profile couldn't tell "manually checked this in" from "imported from CellarTracker" — they'd both look like "standalone." The `origin` column captures provenance that `sessionId` alone can't express. Future origin types add a string value, no schema migration. Note: `origin` is about *how the rating was created*, not about *what kind of feed_item it ended up in* — the latter is `feed_items.kind`, which lives on the social wrapper.

**Why the partial unique instead of full unique:** Concurrent edits inside a session must collapse to one row (race-safe). Standalone re-tasting of an aged bottle must allow multiple rows (aging-bottle use case). The partial unique with `WHERE sessionId IS NOT NULL` does both.

**Future-proofing for "private ratings" / feed-opt-out:** A rating without a feed_item is fine in this model — `feed_items` is a separate table, not a parent. Adding a per-rating "is this private" flag or a per-user "opt out of feed" preference is purely additive; no schema rewrite needed.

#### `rating_images` — new table

```
rating_images
  id          Int          @id @default(autoincrement())
  ratingId    Int
  imageUrl    String
  caption     String?
  sortOrder   Int          @default(0)
  createdAt   Timestamptz  @default(now())

  rating      Rating       @relation(onDelete: Cascade)

  @@index([ratingId, sortOrder])
```

**Why a separate table and not `ratings.imageUrl`:** Multiple photos per tasting is a stated requirement. A single column would force "one photo or none." A separate table is the natural shape.

**Why per-rating, not per-feed-item:** The user's photos belong to the tasting event, not to the social wrapper. They're visible on the Tastes tab (which reads `ratings`), on the live session screen (also `ratings`), and on the feed via the JOIN through `feed_items.ratingId` for standalone or the per-wine JOIN for session posts.

**Display fallback:** UI shows the rating's images first; if none, falls back to `wines.imageUrl` (the canonical bottle shot that hosts can set on the wine catalog row). The wine-detail surface (catalog view) only shows `wines.imageUrl`.

**Cascade on rating delete:** Photos are owned by the tasting; if the rating is deleted (via the engagement-deletion rule in §3, or account-deletion), the photos go with it. S3 reclaim runs per the existing pattern — every image deletion path explicitly fires `reclaimImage()` (per root CLAUDE.md cross-cutting rule).

#### `feed_items` — new table

```
feed_items
  id            Int          @id @default(autoincrement())
  userId        Int                                        -- author; NOT NULL by design (anon skipped, see §3)
  kind          String                                     -- 'session' | 'standalone'; immutable once set
  sessionId     Int?                                       -- set when kind='session'
  ratingId      Int?                                       -- set when kind='standalone'
  venueName     String?
  city          String?
  country       Char(2)?
  lat           Decimal?
  lng           Decimal?
  locationPublic Boolean      @default(false)              -- true = render the venue/city; false = render nothing
  createdAt     Timestamptz                                 -- set explicitly to source rating's ratedAt
                                                            --   for blind-deferred items; default now() otherwise

  user      User      @relation(onDelete: Cascade)
  session   Session?  @relation(onDelete: SetNull)         -- safety net for hard-delete; soft-delete keeps the FK
  rating    Rating?   @relation(onDelete: Cascade)         -- standalone is 1:1; cascade is right
  likes     FeedItemLike[]
  tags      FeedItemTag[]

  @@unique([userId, sessionId])         -- one feed_item per (user, session); ON CONFLICT DO NOTHING on rate
  @@index([userId, createdAt(sort: Desc)])
  @@index([createdAt(sort: Desc)])
```

**Why feed_items separate from ratings:** A session feed item bundles many ratings into one social post (Instagram-multi-image model). It can't sit on a rating row. A standalone feed item could conceptually live on the rating, but giving both kinds the same shape means one render path, one like target, one pagination cursor — much simpler than special-casing standalone-as-rating vs session-as-bundle.

**Why `kind` does three jobs:**
1. Tells the renderer how to display the post (session aggregate card vs standalone single-wine card).
2. Tells the data-fetch layer where to find the wines/ratings inside (`kind='session'` → JOIN ratings on `(userId, sessionId)`; `kind='standalone'` → JOIN ratings on `feed_items.ratingId`).
3. Future extensibility hook — adding `kind='badge_unlock'` or `kind='curated_collection'` later means add a value, add a renderer, optionally add a column for the new kind's link target. No migration of existing rows. **Note**: future kinds that need uniqueness on something other than `(userId, sessionId)` should add a partial unique index per kind (e.g. `WHERE kind='badge_unlock'` on `(userId, badgeId)`) — the current `@@unique([userId, sessionId])` doesn't constrain them at all because their `sessionId` is NULL.

**Why both `sessionId` and `ratingId` are nullable:** Each kind sets the relevant one. Future kinds (`'badge_unlock'`, `'milestone'`, `'curated_collection'`, etc.) leave both NULL and reference their own targets via additional optional columns.

**Why no `kind` constraint at the DB level:** String column, app-layer validation. Same reasoning as `wines.category` — adding a new kind is a code change, not a schema change.

**Why `userId NOT NULL`:** Anon users don't get feed_items (see §3 for the explicit rule). Forcing the column non-null prevents accidental anon writes from getting past the schema.

**Why `@@unique([userId, sessionId])`:** Each user gets exactly one feed item per session — a "session post." User A and user B in the same session get two separate feed items (their own posts, with their own ratings inside). This is correct: each user is sharing their own experience, not a shared one. The unique constraint exists to prevent **double-creation under concurrent rates** — when user A rates wine 1 and wine 2 in session X near-simultaneously, both inserts try to upsert "feed item for (A, X)"; the unique constraint + `ON CONFLICT DO NOTHING` makes the second insert a no-op. The constraint doesn't apply to standalone (sessionId is NULL there, and Postgres treats NULLs as distinct in unique constraints by default — so 50 standalone feed_items for the same user are all considered unique).

**Why `session.onDelete: SetNull` despite soft-delete being the primary path:** Safety net. If we ever hard-delete a session row in the future (a periodic GDPR purge job, or a manual emergency), the FK won't break. Day-to-day, soft-delete preserves the FK and SetNull never fires.

**Why `locationPublic` boolean and not a 3-value enum:** Earlier drafts had `'public' | 'private' | 'none'`. Distinguishing "private tasting" from "no location" is UX copy decided per kind, not data. Boolean: `true` → render "@ Bar Toni, Zürich"; `false` → render nothing (no signal at all). If product later wants the explicit-private signal, a boolean→enum migration is additive.

**Why `createdAt` is sometimes the source rating's `ratedAt`:** Blind-deferred materialisation (§3) creates feed_items at reveal time, not at engagement time. If we used `now()`, the feed would show old tastings as fresh new posts — confusing. Setting `createdAt = ratedAt` keeps the feed chronology honest.

#### `feed_item_likes` and `feed_item_tags` — new tables

Same shape as `checkin_likes` / `checkin_tags`, but FK to `feed_items.id`. Created in phase 1; populated during the migration in phase 2 from the existing tables.

`feed_item_tags` adds one column over today's `checkin_tags`:

```
feed_item_tags
  feedItemId  Int
  userId      Int
  source      String   @default("user")   -- 'user' | 'auto' (future)
  createdAt   Timestamptz @default(now())

  @@id([feedItemId, userId])
  @@index([userId])
```

**Why `source`:** Future auto-tagging of session participants ("tag everyone you tasted with") needs to distinguish auto-tags from user-added tags so the UI can let users override or remove auto-tags. Adding `source` now (default `'user'`) means the future auto-tag feature ships without a schema migration.

#### `checkins` and friends — dropped in phase 5

Until then they coexist with the new model. Note: today's `checkins.isPublic` no longer exists (already dropped, per `lib/profileLoad.ts:56`); every check-in is feed-eligible and gated only by profile-visibility tier. Migration treats every check-in as feed-eligible accordingly.

---

## 3. The engagement trigger — what creates a session feed item

Today, opening a wine in a session UI doesn't commit anything. A user can browse the wine list and never engage with any of them. The session is a tasting opportunity, not a forced rating obligation.

After the rewire, the question is: **when does a wine become "a wine I tasted in this session"** — and therefore appear on my session feed item?

**The rule: any engagement counts.** A user is considered to have tasted a wine in a session when they save any of:
- a score (where `score > 0` — `score = 0` means "not rated" per the existing convention), OR
- one or more flavour chips, OR
- a note.

Setting any one of those creates the `ratings` row (with the others NULL/empty). The wine then appears on the session feed item for that user. If it's the user's first engagement in that session, the upsert into `feed_items` (with `ON CONFLICT DO NOTHING` on `(userId, sessionId)`) creates the session post.

**Why this rule:** In a session setting, we have no other signal that the user actually drank a wine. (Standalone is different — the act of creating a check-in is itself the signal that "I drank this.") Engagement on the rating page is the only behavioural proxy we have. Three forms of engagement matters because:

- A user might know the score immediately ("4 stars, easy") without thinking about flavours.
- Another might want to capture flavours and a note but feel undecided on a score.
- Another might just want to write "had this with the duck, paired beautifully" and not score at all.

All three count as "I tasted this." Standalone scoreless check-ins are the same idea — see the score-nullable reasoning in §2.

### Symmetric un-engagement: deletion (with atomicity)

If a user clears their score (back to 0), removes all chips, and empties the note, the rating row is deleted. If it was the user's only rating in the session, the session feed item is deleted too.

The cleanup must be **atomic** — concurrent tabs racing on the same rating must not produce orphaned feed_items. The pattern:

```sql
BEGIN;
  -- delete the now-empty rating
  DELETE FROM ratings
   WHERE id = $rating_id
     AND score = 0 OR score IS NULL
     AND flavors = '{}'::jsonb
     AND (notes IS NULL OR notes = '');

  -- if no other ratings remain for this user in this session, drop the feed_item
  DELETE FROM feed_items
   WHERE user_id = $user_id
     AND session_id = $session_id
     AND NOT EXISTS (
       SELECT 1 FROM ratings
        WHERE user_id = $user_id
          AND session_id = $session_id
     );
COMMIT;
```

The `NOT EXISTS` is evaluated under the same transaction's read-after-write visibility, so two concurrent tabs racing on "delete my last rating" will serialise on the rating-row lock and only one will see "no rows remain."

**Caveat:** the in-session rating page has only "go back," no undo. Auto-delete on cleared-input is destructive and a tap-fumble away. **Phase 4 must ship the undo affordance before this rule is enabled.** Captured in `.local/future-work-rewire.md`; phase 4's task list includes it.

### Anonymous engagement

Anon users (`a:<uuid>` identity, no `users` row) write to `ratings` with `userId=NULL` and `raterName=<their display name>` — today's behaviour, preserved.

**Anon ratings do NOT create `feed_items` rows.** No userId means no author for the post; nobody can follow an anon. The session post for an anon-only session simply never materialises. This is enforced at the schema level by `feed_items.userId NOT NULL`.

A session that has both anon and logged-in participants gets feed_items only for the logged-in ones. Each logged-in user has their own session post; anon engagement is invisible on the feed but still affects the live session view (compare, ratings, etc.) as today.

### Blind tastings: deferred materialisation

Blind tastings hide the wine identity from tasters until the host triggers a reveal. If a session feed item materialises at engagement time, followers would see "Alice tasted Wine #3" with the wine's actual name leaking out before reveal — defeating the blind.

**Rule for blind sessions:**
- `ratings` rows are created on engagement as normal (the live session needs them).
- `feed_items` rows are NOT created at engagement time.
- On reveal (host triggers it, or auto-reveal in the future — see future-work doc), a one-shot job creates the missing `feed_items` rows for every (user, session) pair where the user has at least one rating.
- Each created `feed_items.createdAt` is set to that user's earliest `ratings.ratedAt` in the session (NOT to the reveal timestamp), so the social feed chronology reflects the actual tasting time.

**Pre-reveal display in profile / Tastes / live session** (anywhere a blind-session rating surfaces in UI):
- The user's own score, flavours, notes, and rating images stay visible (those are the user's own data).
- All wine-identifying fields are redacted: `name`, `producer`, `vintage`, `grape`, `region`, `country`, `vinification`, `description`, `purchaseUrl`. Plus `wines.imageUrl` (the canonical bottle shot, which would also leak identity).
- Reuse the existing redaction helper from the live session view; do not invent a new code path.

**Post-reveal:** all fields render normally; the deferred feed_item creation has already populated the social posts.

### Score=0 vs cleared

`score = 0` means "not rated" (existing convention). It is a stored, valid score value. The engagement-deletion trigger fires when the WHOLE rating is empty (no real score AND no flavours AND no notes), not just when score=0.

UI sends `score=0` when the user explicitly says "no score" but kept other input. UI sends an empty rating (or an explicit DELETE) when the user clears everything. App-layer code (not schema) decides which.

---

## 4. What we deliberately are NOT doing in this rewire

To keep the scope sane, these are explicit non-goals:

1. **Dedup of wines across sessions / users.** Today no dedup exists; every wine-add creates a fresh row. The "had a sip" copy flow (§5) also creates a fresh wine row — no shared catalog identity. The infrastructure (`pg_trgm`) is in place; we add the dedup logic the day a duplicate becomes a problem.
2. **Renaming `wines` → `items` / `drinks`** or **renaming `ratings` → `tastings`.** High mechanical churn for low present-day value. Defer until something else forces the rename.
3. **Per-post bookmark counts ("5 friends interested in this wine *on this post*").** Captured as future work — needs a `bookmarks.feed_item_id` column. Schema is forward-compatible; we plant the column when we ship the feature.
4. **Profile search/filter over the new Tastes tab.** The rewire builds the data model + the trigram indexes that make this trivial later; the actual search UI is a follow-up.
5. **Tastes-tab UI shape** (group-by-wine vs flat chronological vs toggle). Out of scope; settled when the tab is wired.
6. **Public/private session location toggle UI.** The `locationPublic` column ships now, but the host UI to set it on session-create is post-rewire.
7. **Hall of Fame changes.** HoF stays exactly as-is during the rewire — same trigger (score ≥ 5 from a session rating), same dedup rule. Tim is reworking HoF separately; this rewire doesn't touch it.
8. **Auto-tagging session participants.** A future option ("tag everyone you tasted with"). The schema (`feed_item_tags.source`) supports it; the feature ships separately.
9. **Aggregate views beyond the basic session card.** No "10 friends rated this wine" cross-session views in this pass — the data model unblocks them, the UI doesn't ship them.
10. **Notifications on likes/tags moving from `checkins` → `feed_items`.** No notification system exists today; nothing to update.
11. **Archive / "past sessions" lifecycle as a separate user action.** Today's implicit "live for N hours then expired" lifespan is unchanged. The new `sessions.deletedAt` is for explicit host-deletion only, not for archiving.
12. **Hard-delete (GDPR purge) job.** The schema supports it (FK SetNull on `feed_items.session`, etc.) but the actual purge job is future work. The cleanup order matters: a hard-purge of a deleted session must first null `wines.session_id` on any wines still pointing at it (today's `NoAction` FK would otherwise reject the delete). Document when the purge job ships.
13. **Multiple feed_items per rating** (e.g. one rating shown on both a personal post AND a curated "best of 2026" collection). Today's model is rigid: standalone is 1:1, session is N:1 via `(userId, sessionId)`. Curated collections needing this would require a `feed_item_ratings(feedItemId, ratingId)` join table — a destructive migration relative to today's `ratingId` column. Worth knowing when planning that future feature.
14. **Per-rating "private" flag / per-user "opt out of feed."** Schema supports this additively (a `ratings.private Boolean default false` and/or a `users.feedOptOut` column). When it ships, also need an HoF-suppression rule — private 5★ ratings shouldn't enter the public leaderboard.
15. **Master-data ownership for shared wines.** Today's "had a sip" creates fresh wine rows (per §5), so this question doesn't arise. When real cross-user dedup ships, the question of "who can edit wine metadata" needs a real answer — captured in future-work.

---

## 5. Migration of existing data

The user base is small enough to migrate cleanly. We migrate.

### What needs migrating

For each existing `checkins` row:
1. Look up or create a `wines` row (the rewire moves to "every check-in is backed by a wine row"). The wine row gets `sessionId = NULL` (standalone wines have no session). Default `category = 'wine'`. ID minted via the new collision-safe generator.
2. Create a `ratings` row pointing at that wine. The rating's `sessionId = NULL`, `origin = 'standalone'`. `score` carries through (NULL or 0 if the original was scoreless — both legal now).
3. Create a `feed_items` row with `kind='standalone'`, `ratingId` set, `userId` from the source check-in (NOT NULL guaranteed because checkins always have a userId today), `venueName/city/country/lat/lng/createdAt` carried over, `locationPublic = true` if any location field is non-NULL else `false`.
4. For each `checkin_likes` row: create a `feed_item_likes` row pointing at the new feed item.
5. For each `checkin_tags` row: create a `feed_item_tags` row pointing at the new feed item (`source = 'user'`).
6. If the source check-in had an `imageUrl`, create a `rating_images` row referencing the new rating.

For each existing `ratings` row (today: every row came from a session): set `sessionId` from the wine's existing `sessionId` if present, else NULL (the wine may have been orphaned by a prior session-delete). Set `origin = 'session'`.

For each existing `(session, user)` pair where the user has at least one rating in that session AND the user is logged-in (`userId IS NOT NULL`):
1. Create a `feed_items` row with `kind='session'`, `sessionId` set, `userId` set, `createdAt` = the user's earliest rating timestamp in that session. (Anon-only ratings produce no feed_items, per §3.)
2. No likes/tags to migrate (sessions don't have those today).

`sessions.deletedAt` is NULL for all migrated rows — every existing session is live (or expired by lifespan, which is a separate concept).

### Pre-existing side effects on session-delete must keep firing

The current `DELETE /api/session/[code]` endpoint runs more than just rating cleanup: it deletes Hall of Fame entries (per the bookmark-or-drop rule), reclaims S3 images for orphaned wine rows, wipes `session_members`, and purges Redis keys. All of these continue to fire under the new soft-delete path. The only change is: instead of deleting the `sessions` row, we set `deletedAt = now()` and scrub the row's PII columns to NULL. Wine + rating + feed_item retention follows the new contract (§8).

### Category/style FK

Pre-flight (§8) confirmed every existing wine row has a valid `(category, style)` pair against the seeded `category_styles` table — including the NULL-handling case. Phase 1 adds the composite FK directly with no backfill. Re-run the pre-flight query before phase 1 PR merges.

### "Had a sip" mapping

Today: `POST /api/checkins` with `copyFromCheckinId` clones an existing check-in onto the caller's profile, including image bytes.

After the rewire: `POST /api/checkins` with `copyFromFeedItemId` (renamed for accuracy). Behaviour: load the source feed_item (must be `kind='standalone'`), apply the existing same-gates (caller is mutual-follow + visibility-allowed), then:
1. Create a NEW `wines` row with the source wine's metadata copied (no shared catalog identity — the rewire's "no dedup" non-goal applies to the social copy flow too).
2. Create a NEW `ratings` row pointing at the new wine.
3. Create a NEW `feed_items` row with `kind='standalone'`.
4. If the source had images, copy the bytes into a new `rating_images` row attached to the new rating (today's image-bytes-clone pattern continues, just attached to the new model).

**Why no shared wine_id:** "Had a sip" predates wine dedup. Sharing wine_id sneaks dedup in by the back door, raising the master-data question (who can edit shared wine fields?) before there's a real catalog. Path B (fresh row) keeps the model honest with its own non-goals. When real dedup ships, "had a sip" can become smarter — until then, every copy is a fresh denormalised wine row, same as today.

### How the migration script runs

A SQL script (or a TypeScript script if wine_id minting needs nanoid) at `prisma/migrations/<timestamp>_rewire_data/`. **Batched + checkpoint-tracked** for genuine idempotency:

- A `_migration_checkpoints` table tracks "last processed source row id" per migrated table.
- The script processes 1000 rows per transaction, commits, updates the checkpoint, repeats.
- Crash mid-run = restart picks up at the last checkpoint, no re-processing of completed batches.
- True idempotency: running the script on already-migrated data is a no-op (every batch finds zero unprocessed rows).
- At Tim+Simon scale this finishes in seconds; the batching is for future-proofing against 100k+ row growth where a single transaction would hold locks for minutes.

Migration runs during a brief read-only maintenance window (env flag, or app shutdown). At current scale this is under a minute. The window matters because in-flight `POST /api/checkins` or session-rate writes during migration could slip past the snapshot. Don't try to run lock-free.

### Stale dependencies that get rewritten in the merged phase 2

`docs/dev/social-feed.md` describes the old check-ins-table model and references `checkins.isPublic` (already removed from the schema, but the doc wasn't updated). The merged phase 2/3 (read cutover) rewrites it to describe the new `feed_items`-based feed.

---

## 6. Phasing

Each phase = one branch, one PR, mergeable on its own. After each merge to main, the system is shippable. No long-lived rewire branch.

### Phase 1 — additive schema only
**Branch**: `feature/rewire-p1-schema`

- New tables: `category_styles`, `feed_items`, `feed_item_likes`, `feed_item_tags`, `rating_images`, `_migration_checkpoints`.
- Seed `category_styles` with the 5 wine styles.
- New columns: `feed_items.locationPublic`, `ratings.sessionId`, `ratings.origin`, `sessions.deletedAt`, `wines.attributes`, `feed_item_tags.source`.
- Drop `@@unique([wineId, userId])` on `ratings`. Add partial unique `WHERE sessionId IS NOT NULL`. Make `ratings.score` nullable.
- Backfill `ratings.origin = 'session'` for all existing rows (today, every rating is from a session).
- Backfill `ratings.sessionId` from `wines.sessionId` for all existing rows (NULL where the wine was already orphaned).
- Add the composite FK `wines (category, style) → category_styles (category, style)`. Pre-flight check (§8) confirmed clean — no backfill needed. Re-run before merge.
- Add the partial index `sessions(id) WHERE deleted_at IS NULL`.
- Add GIN trigram indexes on `wines.name` and `wines.producer`.
- Switch `wines.id` generation from `Date.now().toString()` to `nanoid` (or `cuid`) in `lib/session.ts`.
- Rewrite `docs/dev/session-deletion.md` to document the new soft-delete rule (the actual code change ships in phase 2).
- No application read paths change. Just structure + the one-time origin/sessionId backfill + the wine ID generator switch.

Mergeable to main with zero behaviour change visible to users. Production gets the new tables on the next deploy.

### Phase 2 — migrate, dual-write briefly, cut over (was phases 2 + 3 in earlier drafts)
**Branch**: `feature/rewire-p2-cutover`

This is the heavy phase. Single branch, single PR, runs during a brief maintenance window.

**Schema-touching writes:**
- `POST /api/checkins` switches to writing through the new model: `wines` + `ratings` (sessionId=NULL, origin='standalone') + `feed_items` (kind='standalone') + `feed_item_likes/tags` + `rating_images`. Old `checkins` table receives a final mirror write during the migration window, then writes stop.
- `POST /api/session/[code]/rate` adds: sets `ratings.sessionId` and `ratings.origin = 'session'`; for non-blind sessions, creates/upserts the `feed_items` row for `(session, user)` with `kind='session'` (idempotent — only the first engagement creates the feed item); for blind sessions, defers feed_item creation until reveal (§3).
- Session-rate DELETE path implements the engagement-deletion atomicity pattern from §3 (transaction + `NOT EXISTS`). Includes the safety prerequisite: undo affordance must be in phase 4.
- `DELETE /api/session/[code]` switches from hard-delete to soft-delete: set `sessions.deletedAt = now()` and scrub every other column to NULL per the §8 contract. Stop deleting unbookmarked ratings. All existing side effects (HoF cleanup, S3 reclaim, session_members wipe, Redis purge) continue to fire.
- Session reveal path: for blind sessions, run the deferred-materialisation job that creates `feed_items` rows for every (user, session) with engagement, setting `createdAt = source rating's earliest ratedAt`.
- Ban transaction adds: also delete the banned user's `feed_items` row for that session, in the same transaction as the rating deletes. Symmetric: kick keeps both ratings + feed_item; ban deletes both.
- Account-deletion path:
  - Standalone ratings (`sessionId IS NULL`) hard-cascade — no other user depends on them, so they go with their `feed_items` and `rating_images`.
  - Session ratings (`sessionId IS NOT NULL`) continue tombstoning per `docs/dev/account-deletion.md` (`UPDATE ... SET userId=NULL, raterName='[deleted]'`) — other tasters' compare views still need to render "Anna rated this 4★" after Anna deletes her account.
  - Implementation order: tombstone session ratings first, then `DELETE FROM ratings WHERE userId=$id` cascades only the standalone rows.
  - `feed_items.userId Cascade` then takes care of: standalone feed_items (1:1 with the cascaded standalone ratings) AND the user's session feed_items (their social presence in those sessions disappears; other participants' session feed_items are unaffected). New tables match this pattern from `lib/accountDelete.ts`.
- "Had a sip" path: rename the body field from `copyFromCheckinId` to `copyFromFeedItemId`; implement the path-B copy semantics (fresh wine + rating + feed_item + image clone via rating_images).

**Read cutover:**
- `/api/feed` SELECTs from `feed_items` (with JOINs to `ratings` + `wines` + `sessions`). Output shape stays compatible with the existing `CheckinCard` component for standalone; session feed items render a stub session card until phase 4. The query JOINs `sessions` precisely to read `deletedAt` so tombstoned-session posts can render the "[deleted session]" label.
- `/api/me/feed` (own feed): same.
- `/u/<id>` profile activity: switch the source from `checkins` to `feed_items`.
- `/api/me/history` (the future "Tastes" tab data) starts pulling from `ratings` directly, no longer needs the `UNION` between ratings and checkins.
- Block / mute / visibility plumbing (`batchLoadVisibilities`, `viewerCanSeeAuthor`, block-pair like/tag scrubbing) gets re-pointed from `checkin_id` keys to `feed_item_id` keys. The mute filter (`feed_items.userId NOT IN (caller's mutes)`) is included.
- Session-existence call sites (~5 total: `/api/session/[code]` GET, settings, name, `lib/session.ts` resolvers) get the inline `WHERE deletedAt IS NULL` filter.

**Migration:**
- Run the batched + checkpoint-tracked script (§5) inside the maintenance window. Eyeball staging first, then prod.
- The window is brief (under a minute at current scale) but real — set the read-only env flag, run the script, flip the cutover, lift the flag.

**Rewrite `docs/dev/social-feed.md`** to describe the new model (it currently describes the soon-to-be-dead `checkins` model).

This is the highest-risk phase. The migration is reversible only via `pg_dump` restore; take the dump before lifting the read-only flag.

### Phase 3 — UI rewire (aggregate session card)
**Branch**: `feature/rewire-p3-aggregate-card`

(Was phase 4 in earlier drafts; renumbered after the 2+3 merge.)

- New `<SessionFeedCard>` component for `feed_items.kind='session'` — renders the host name + session name + a list/grid of wines rated by the user, with their scores. Likes + tags on the card, not per-wine. Tombstoned-session variant renders "[deleted session]" and unlinks.
- `<CheckinCard>` (the existing one) handles `feed_items.kind='standalone'`.
- `FeedClient` switches on `kind` to pick the renderer.
- Profile gets the three-tab split (Posts / Tastes / Wishlist). Tastes-tab UI shape kept minimal — chronological list is fine for the rewire; richer grouping is future work. Each Tastes row shows session context: live session → link, deleted session → "[deleted session]" label, no session → "standalone."
- **Ship the in-session rating-page undo affordance** (per `.local/future-work-rewire.md`). This is a hard prerequisite for the engagement-deletion auto-delete rule from §3 — without undo, a tap-fumble destroys data. Undo lives on the rating page; pattern is a 5–10 second snackbar with the deletion deferred until the window expires.
- Pre-reveal blind-session rating display: wire the existing redaction helper (used by the live session view) into the Tastes tab and the Posts tab so blind ratings render with all wine-identifying fields hidden until reveal. The user's own score/flavours/notes/images stay visible.

This phase is pure frontend; no schema, no API.

### Phase 4 — drop the old tables
**Branch**: `feature/rewire-p4-drop-checkins`

(Was phase 5.)

- Wait at least one production deploy cycle after phase 3 ships, ideally a week, so we can revert phase 3 without losing data.
- Drop `checkins` / `checkin_likes` / `checkin_tags` in a destructive migration (per `prisma/CLAUDE.md`: explicit human confirmation, `pg_dump` first).
- Remove the `Checkin*` Prisma models, dead code.

This is the irreversible step. Everything before it can be rolled back.

---

## 7. Risks and how we mitigate them

| Risk | Mitigation |
|---|---|
| **Soft-delete leak: deleted session shows as live somewhere.** A `prisma.session.findX` call without `WHERE deletedAt IS NULL` would render a deleted session as active. Risk grows with scale and new features. | Phase 2 adds the inline filter to all ~5 session-existence call sites. PR description lists every audited site. The view (`live_sessions`) is a future option if the surface grows past ~15 sites. |
| **Wine ID collision** during migration or concurrent rates. `Date.now().toString()` collides for inserts in the same millisecond. | Phase 1 switches to `nanoid` / `cuid` for new wine creation. Migration script uses the same generator. |
| **Engagement-deletion race across tabs.** Two concurrent "delete my last rating" tabs could both see "the other deleted it" and orphan the feed_item. | Atomic transaction with `WHERE NOT EXISTS` (§3). Concurrent tabs serialise on the rating-row lock; only one sees no rows remaining. |
| **Migration interrupted mid-run.** A single-transaction script that crashes leaves a half-migrated state with no recovery. | Batched + checkpoint-tracked migration (§5). Restart resumes from the last checkpoint; running on already-migrated data is a no-op. |
| **Concurrent in-session edits create duplicate ratings.** The dropped `@@unique([wineId, userId])` would allow two-tab races to insert two rows. | Partial unique `(userId, wineId, sessionId) WHERE sessionId IS NOT NULL` on ratings (§2). Standalone re-tasting stays unconstrained (aging-bottle case). |
| **Blind tasting feed leak.** Engagement-time feed_item creation would publish wine identity before reveal. | Deferred materialisation (§3): `feed_items` for blind sessions are created at reveal time, with `createdAt = source rating's earliest ratedAt` so feed chronology stays honest. Pre-reveal Tastes/Posts surfaces use the existing redaction helper. |
| **Anonymous engagement crashes feed_items insert.** Anon users have no `userId`; `feed_items.userId NOT NULL` would reject. | Explicit rule (§3): anon ratings skip `feed_items` entirely. The `NOT NULL` constraint enforces this at the schema level — a bug that tries to insert an anon feed_item gets rejected loudly, not silently. |
| **Ban transaction leaves orphan feed_item.** Today's ban deletes ratings; without an update, the banned user's session feed_item would survive pointing at deleted ratings. | Phase 2 ban transaction extended to also delete `feed_items WHERE userId=target AND sessionId=this`. Same transaction as the rating cleanup. |
| **Account-deletion semantic drift.** Cascade vs tombstone is a careful per-table choice today; new tables need the same care. | Phase 2 implements per-row treatment: standalone ratings hard-cascade (no other user depends on them); session ratings tombstone (other tasters' compare views need them) per today's pattern. `feed_items.userId Cascade` then takes care of all feed_items the user authored. `rating_images` cascade with their parent rating. |
| **Pre-existing session-delete side effects skipped.** Today's hard-delete fires HoF cleanup, S3 reclaim, session_members wipe, Redis purge. Soft-delete must keep all of these alive. | Phase 2's `DELETE /api/session/[code]` rewrite preserves every side effect; only the final `DELETE FROM sessions` becomes `UPDATE sessions SET deleted_at=now(), name=NULL, ...`. PR includes a side-by-side check. |
| **Migration runs against active writes.** In-flight checkin or session-rate POSTs during the migration window could slip past the snapshot. | Brief read-only maintenance window via env flag during phase 2's migration. Under a minute at current scale. Don't try lock-free. |
| **`pg_dump` not taken before destructive phase.** Phase 4 drops three tables; mistake here is unrecoverable. | Phase 4's PR template requires the dump file checksum before merge. Per `prisma/CLAUDE.md` destructive-changes rule. |

---

## 8. Decisions and contracts

**Settled:**

- **`feed_items.kind` values: `'standalone'` and `'session'`.** User-facing copy continues to use the word "check-in" for both kinds (a session check-in vs a standalone check-in). Internal `kind` names disambiguate without doubling the user-language overload.

- **Session deletion is a soft-delete, not a hard-delete.** Replaces today's rule in `docs/dev/session-deletion.md`. The new behaviour:

  - **Set `sessions.deletedAt = now()`.** The session row stays in the DB.
  - **Scrub every other column on the `sessions` row to NULL.** Full list per the data-survival contract below.
  - **Ratings and feed_items are not touched.** `sessionId` references stay intact on both, providing the grouping signal.
  - **Wine rows** continue to follow today's rule (kept with `sessionId` pointing at the soft-deleted session row).
  - **HoF retention rule today** (kept if bookmarked, dropped otherwise) is unchanged — Tim's HoF rework is separate and we don't touch HoF in the rewire.
  - **Pre-existing side effects** (HoF cleanup, S3 reclaim, session_members wipe, Redis purge) continue to fire on the soft-delete path. Only the final `DELETE` becomes an `UPDATE`.

  ### Data-survival contract for a deleted session

  After `DELETE /api/session/[code]`, the only data guaranteed to survive on the `sessions` row itself is:

  - `id` — the grouping key, never changes. Children (wines, ratings, feed_items) keep their FK references.
  - `deletedAt` — the tombstone marker.

  **Every other column is scrubbed to NULL** — `name`, `description`, `link`, `code`, `host_*`, `timezone`, `created_at`, `address`, `dateFrom`, `dateTo`, `archivedAt`, lifespan tier, blind flag, anything else that's on the row today or added in the future. The tombstone is genuinely empty: you can tell the row exists and that it's deleted, nothing more.

  Children of the deleted session keep their data and their session_id link:

  - `wines.session_id` keeps pointing at the deleted session's id (today's behaviour preserved)
  - `ratings.session_id` (NEW column) keeps pointing at the deleted session's id
  - `feed_items.session_id` keeps pointing at the deleted session's id
  - All ratings, all feed_items, all likes/tags on those feed_items survive untouched
  - All `rating_images` survive (cascade is on `ratings`, which is preserved)
  - `ratings.ratedAt` is the relevant timestamp for "when did the user taste this" — it's on the rating row, never on the session, so deletion doesn't affect it

  ### Why this shape

  **Why soft-delete on `sessions` instead of nulling the FKs on children:** The session_id is the only natural grouping key. If we nulled it on ratings/feed_items, two of a user's three deleted-session posts would become indistinguishable from each other and from each other's wines. Soft-delete preserves grouping for free without any new column on either child table.

  **Why scrub everything except `id` + `deletedAt`:** Anything we keep on the tombstone is data we'd have to defend later ("why did you keep the timezone?"). The minimal contract is the easiest to reason about, the easiest to audit for privacy, and forces us to be explicit if we ever decide a specific field should survive (it'd require a doc update + schema change). The cost is small: tombstoned-session UX in user history shows just "[deleted session]" with no extra context. Acceptable.

  **Why `ratings.origin` despite `sessionId`:** See §2's reasoning. Origin is provenance (how the rating was created — session, standalone, future imports/scans/integrations), distinct from session-membership (whether it has a `sessionId`). Both columns are needed; they answer different questions.

  **Note on host account deletion (separate flow):** When a host deletes their *account* (not the session), the existing rules in `docs/dev/account-deletion.md` apply — sessions with engagement stay alive with the host identity tombstoned to `[deleted]`; cohosts can administer. The new session-soft-delete rule above only fires when the host (or eventually a cohost) actively deletes the session via `DELETE /api/session/[code]`. Different flows, different rules; no overlap.

  **Lifetime counters** continue to never decrement (today's behaviour). Live aggregations (avg flavour, total_rated) reflect the actual rating count, which now stays high since nothing is deleted.

  **Phase 1** adds `sessions.deletedAt` column + the partial index. **Phase 2** updates the session-deletion endpoint to soft-delete and routes session-existence reads through the inline filter. **Phase 1's PR** includes the rewrite of `docs/dev/session-deletion.md` to match.

**Pre-flight checks:**

- **`category_styles` mismatch count.** ✅ Confirmed clean against prod — query returned zero rows. FK lands in phase 1 with no backfill needed. Query (NULL-safe):

  ```sql
  -- Catches non-canonical (category, style) pairs AND NULL styles
  SELECT category, style, COUNT(*)
  FROM wines
  WHERE style IS NULL
     OR (category, style) NOT IN (
       VALUES ('wine','red'), ('wine','white'), ('wine','spark'),
              ('wine','rose'), ('wine','nonalc')
     )
  GROUP BY category, style;
  ```

  Re-run before phase 1 PR merges in case new wines were added with non-canonical styles in the meantime.

---

## 9. Out of scope (revisit later)

- Beer / spirit / food category support (the `category` column ships, the `category_styles` table is in place, and `wines.attributes` is the JSON landing zone for category-specific fields — but no UI, no flavour wheels, no styles seeded for non-wine).
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
- Archive / "past sessions" as a separate user action, distinct from delete.
- Hard-delete (GDPR purge) job for sessions older than retention window.
- Snapshot of session name at deletion time (richer "[deleted: Friday Pinot Night]" history).
- Per-rating "private" flag / per-user "opt out of social feed."
- Master-data ownership for shared wines when real cross-user dedup ships.
- Per-feed-item image override (alternate to `rating_images` for posts that want a different photo from the tasting).
- Multiple feed_items per rating (curated collections — would need `feed_item_ratings` join table, destructive migration relative to today).
- Auto-reveal for blind sessions (anchored on `sessions.dateTo`, `sessions.dateFrom + N days`, or `createdAt + 30d` fallback — schema is already in place).

All of these become easy or trivial to build *because* of this rewire. None of them ship as part of it.
