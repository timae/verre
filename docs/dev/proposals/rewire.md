# The big rewire — unifying ratings, check-ins, and the feed

**Status**: phases 1, 1.5, 2, 3, and 4 all shipped (2026-05). The big rewire is complete. This doc remains the authoritative source for design rationale (the *why*); the per-feature impl docs (`session-deletion.md`, `account-deletion.md`, `social-feed.md`, etc.) describe the shipped behaviour.
**Branch**: `feature/rewire-plan` for this doc; subsequent phases each got their own branch.

This is the architecture and migration plan for unifying the two parallel rating systems (in-session ratings + standalone feed check-ins) into a single normalised model, and reshaping the feed to render sessions as aggregate "posts" rather than one-card-per-rating.

The goal of this doc is to settle the shape **before** we touch code. Once it's agreed, each phase becomes its own branch and PR.

This doc deliberately spends time on **why** each decision was made, not just **what** the decision is. Six months from now, edge cases will come up; the right call depends on what we were optimising for. Recipes without rationale rot fast.

> **Schema sketches in this doc are pseudocode.** They show columns, types, indexes, and key constraints, but are not valid Prisma syntax — translate to the project's Prisma conventions when implementing. Note: Prisma can't express partial unique indexes in `schema.prisma`; phase 1.5 needs raw SQL migrations alongside the model changes.

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

#### `wines` — mostly unchanged

The existing table already does most of what we need. Two activations:

- **`wines.category`** already exists with default `"wine"` and is read-only-passed-through today. We start writing it. Future categories: `"beer"`, `"spirit"`, `"food"`, etc.
- **`wines.style`** stays as the sub-classification (`red`/`white`/`spark`/`rose`/`nonalc` for wine; `IPA`/`Stout`/`Lager` for beer when it arrives).

The valid `(category, style)` pairs are constrained at the DB level via the new `category_styles` lookup table — see below.

```
wines
  ... existing columns ...

  // NEW: trigram indexes for future search/filter on wine name + producer
  CREATE INDEX wines_name_trgm ON wines USING GIN (name gin_trgm_ops);
  CREATE INDEX wines_producer_trgm ON wines USING GIN (producer gin_trgm_ops);
```

**Why no rename to `items`/`drinks`:** Same trade-off as `ratings` → `tastings`. Renaming a fundamental table costs a lot of mechanical churn (every FK, every Prisma relation, every `wineId` variable, every API path) for naming-only value. The future "a beer in the wines table" awkwardness is a comment-line problem; renaming preemptively isn't worth it.

**Why no `wines.attributes Json?` column for category-specific extras:** Earlier drafts had one. Beer IBU/ABV, food prep details, etc. are §9 out-of-scope. Adding speculative columns for unshipped features pollutes the schema and legitimises drift ("I'll just stuff it in attributes"). Add when category #2 ships; cost of adding later is one nullable column.

**Why trigram indexes now:** `pg_trgm` is already enabled in `prisma/schema.prisma`. Search/filter on the Tastes tab is captured as future work but inevitable. Adding the indexes now is cheap (~minutes for current row counts) and avoids a post-import rebuild on a much larger table later.

**Wine ID generation:** Today `wines.id` is `Date.now().toString()` (`lib/session.ts:333,346`). This collides under concurrent inserts (same millisecond) — fine at single-user pace, broken in any migration loop or concurrent-rate scenario. Phase 1 switches to standard **`nanoid` (21 chars)** for new wine creation. The columns get widened from `VarChar(20)` to `VarChar(21)` in the same phase — single-line migration on three columns (`wines.id`, `ratings.wineId`, `bookmarks.wineId`). Standard 21-char length is what every "nanoid" reference in the wider ecosystem means; future readers will recognise it without a custom-length puzzle. The migration script uses the same generator for newly-minted wine rows. Existing rows keep their shorter timestamp-string IDs (still fit). Chose `nanoid` over `cuid`/`cuid2` because it's smaller, single-purpose, and `cuid`'s rough-sortability is irrelevant here (we have `createdAt` for chronology).

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
  session   Session? @relation(onDelete: Restrict)        -- soft-delete is the contract; mirror feed_items.session

  @@index([wineId])
  @@index([userId])
  @@index([sessionId])
  @@index([userId, wineId])     // for the "all my tastings of this wine" query
  @@index([userId, sessionId])  // hot path: enumerate the wines a user engaged with in a session

  // Race-safe in-session uniqueness for logged-in users; standalone rows unconstrained
  // Note: `WHERE user_id IS NOT NULL` is load-bearing — Postgres treats NULLs as
  // distinct, so without this guard the constraint would not constrain anon ratings
  // (where user_id IS NULL). Anon two-tab race is an accepted edge case (anon
  // sessions are casual; if it ever matters, store identity-id from lib/identity.ts
  // on the rating row and add a parallel partial unique on it).
  CREATE UNIQUE INDEX ratings_session_unique
    ON ratings (user_id, wine_id, session_id)
    WHERE session_id IS NOT NULL AND user_id IS NOT NULL;
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
  sortOrder   Int          @default(0)
  createdAt   Timestamptz  @default(now())

  rating      Rating       @relation(onDelete: Cascade)

  @@index([ratingId, sortOrder])
```

**Why a separate table and not `ratings.imageUrl`:** Multiple photos per tasting is a stated requirement. A single column would force "one photo or none." A separate table is the natural shape.

**Why per-rating, not per-feed-item:** The user's photos belong to the tasting event, not to the social wrapper. They're visible on the Tastes tab (which reads `ratings`), on the live session screen (also `ratings`), and on the feed via the JOIN through `feed_items.ratingId` for standalone or the per-wine JOIN for session posts.

**Display fallback:** UI shows the rating's images first; if none, falls back to `wines.imageUrl` (the canonical bottle shot that hosts can set on the wine catalog row). The wine-detail surface (catalog view) only shows `wines.imageUrl`.

**Cascade on rating delete:** Photos are owned by the tasting; if the rating is deleted (via the engagement-deletion rule in §3, or account-deletion), the photos go with it. **S3 reclaim is independent of cascade** — the Postgres FK doesn't trigger S3 cleanup. Every rating-delete code path (engagement-deletion, account-deletion, ban transaction, "had a sip" source-image cleanup) MUST follow the **capture / commit / reclaim-after** pattern: capture `rating_images.imageUrl` into memory before the DELETE, then commit the cascade, then fire `reclaimImage()` on each captured URL after commit. Mirrors today's `lib/accountDelete.ts:188-219` (rollback safety: a transaction that aborts doesn't leave orphaned S3 deletes). Per root CLAUDE.md cross-cutting rule.

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
  createdAt     Timestamptz                                 -- default now(); never updated on conflict, so re-engagement
                                                            --   keeps the original post's chronology

  user      User      @relation(onDelete: Cascade)
  session   Session?  @relation(onDelete: Restrict)        -- soft-delete is the contract; hard-delete must explicitly clean up first
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

**Why `session.onDelete: Restrict` and not SetNull:** Soft-delete is the contract — hard-delete should never happen accidentally. SetNull would silently destroy the session-grouping signal (the very thing soft-delete exists to preserve) if a future GDPR purge or manual emergency forgot to null FKs first. Restrict makes the hard-delete fail loudly, forcing the cleanup path to confront the consequences explicitly. The same logic applies to `ratings.sessionId` — also Restrict.

**Why `locationPublic` boolean and not a 3-value enum:** Earlier drafts had `'public' | 'private' | 'none'`. Distinguishing "private tasting" from "no location" is UX copy decided per kind, not data. Boolean: `true` → render "@ Bar Toni, Zürich"; `false` → render nothing (no signal at all). If product later wants the explicit-private signal, a boolean→enum migration is additive.

**Why `createdAt` defaults to `now()` (engagement time):** Both blind and non-blind feed_items are created at engagement time (per §3 — blind is a tasting format, not a privacy gate, so the same creation rule applies). The default `now()` matches the source rating's `ratedAt` because both happen in the same insert transaction. The upsert never updates `createdAt` on conflict, so subsequent rates in the same session don't shift the post's chronology.

#### `feed_item_likes` and `feed_item_tags` — new tables

Same shape as `checkin_likes` / `checkin_tags`, FKs to `feed_items.id`. Created in phase 1; populated during the migration in phase 2 from the existing tables.

```
feed_item_likes
  userId      Int
  feedItemId  Int
  createdAt   Timestamptz @default(now())

  user      User      @relation(onDelete: Cascade)
  feedItem  FeedItem  @relation(onDelete: Cascade)

  @@id([userId, feedItemId])
  @@index([feedItemId])

feed_item_tags
  feedItemId  Int
  userId      Int       -- the tagged user
  createdAt   Timestamptz @default(now())

  user      User      @relation(onDelete: Cascade)   -- tagged user deletes account → tag disappears
  feedItem  FeedItem  @relation(onDelete: Cascade)

  @@id([feedItemId, userId])
  @@index([userId])
```

Both follow today's `checkin_likes` / `checkin_tags` cascade pattern: when the tagged/liking user deletes their account, the edge disappears (the author keeps the post; the social signal alone goes). When the feed_item is deleted (e.g. account-deletion of the author), all likes and tags on it cascade.

#### `checkins` and friends — dropped in phase 4

During phases 1–3 they coexisted with the new model. Phase 4 dropped them on 2026-05-18. Aside — `checkins.isPublic` had already been dropped before the rewire started; every check-in was feed-eligible and gated only by profile-visibility tier, so the migration treated every check-in as feed-eligible accordingly.

---

## 3. The engagement trigger — what creates a session feed item

Today, opening a wine in a session UI doesn't commit anything. A user can browse the wine list and never engage with any of them. The session is a tasting opportunity, not a forced rating obligation.

After the rewire, the question is: **when does a wine become "a wine I tasted in this session"** — and therefore appear on my session feed item?

**The rule: any engagement counts.** A user is considered to have tasted a wine in a session when they save any of:
- a score (where `score > 0` — `score = 0` means "not rated" per the existing convention), OR
- one or more flavour chips, OR
- a note.

Setting any one of those creates the `ratings` row (with the others NULL/empty). The wine then appears on the session feed item for that user. If it's the user's first engagement in that session, the upsert into `feed_items` (with `ON CONFLICT DO NOTHING` on `(userId, sessionId)`) creates the session post.

**Cascading semantic change worth flagging:** before the rewire, "rated" implied "scored" — every rating row had a non-zero score. After the rewire, a chips-only or notes-only rating row also exists. This changes what "rated" means across the codebase:

- **Lifetime counters** (`users.lifetime_ratings`): increment on every rating insert, including chips-only / notes-only. Acceptable — the user did engage, the counter reflects engagement-events not scoring-events. UI label: "tastings" not "ratings."
- **HoF trigger** (`score >= 5`): unchanged — already filters by score, chips-only rows never qualify. Safe.
- **`five_star` counter, `high_avg` badge, "rated above 4" queries**: all already filter by score; chips-only rows naturally excluded. Safe.
- **"Rated/unrated" UI badge** on the wine list inside a session: needs explicit decision. Old semantic: "has a non-zero score" → unrated badge for users who chipped-only. New semantic could be: "has any rating row" → rated badge for chips-only too. Lean: new semantic — the user engaged, that's what the badge should reflect. Confirm in phase 2's UI work.
- **Profile Tastes tab**: shows all `ratings` rows including chips-only / notes-only. UI must render score column as "—" for those.
- **Compare view (live session)**: today renders "Anna 4★, Bob 3★" per-(user, wine). Post-rewire, a chips-only row has `score = 0` (or NULL); UI must render it as "—" or hide the user's score column for that wine. Also today every rating has a real score, so `WHERE score IS NOT NULL AND score > 0` is implicit; phase 2's compare path needs the explicit filter for any "average score" / "highest scorer" computation to keep working.

**Why this rule:** In a session setting, we have no other signal that the user actually drank a wine. (Standalone is different — the act of creating a check-in is itself the signal that "I drank this.") Engagement on the rating page is the only behavioural proxy we have. Three forms of engagement matters because:

- A user might know the score immediately ("4 stars, easy") without thinking about flavours.
- Another might want to capture flavours and a note but feel undecided on a score.
- Another might just want to write "had this with the duck, paired beautifully" and not score at all.

All three count as "I tasted this." Standalone scoreless check-ins are the same idea — see the score-nullable reasoning in §2.

### Symmetric un-engagement: deletion

If a user clears their score (back to 0), removes all chips, and empties the note, the rating row is deleted. If it was the user's only rating in the session, the session feed item is deleted too.

Application-level ordering, mirroring `lib/accountDelete.ts:188-219` (rollback-safe): **(1)** capture `rating_images.imageUrl` for the rating into memory; **(2)** run the two SQL statements below (each in its own auto-commit, NOT inside a wrapping `prisma.$transaction` — both statements would share a snapshot and the bug returns); **(3)** if step 2 succeeded, fire `reclaimImage()` on each captured URL. Capture-first / commit / reclaim-after preserves the property that a transaction rollback doesn't leave orphaned S3 deletes (the cascade FK doesn't trigger S3 cleanup either way, per root CLAUDE.md).

The CTE pattern from earlier drafts had a subtle MVCC bug — Postgres CTE sub-statements share a snapshot, so a `NOT EXISTS (SELECT FROM ratings)` in the same CTE as a `DELETE FROM ratings` would still see the just-deleted row in its snapshot and never fire the cleanup. Two separate statements (each with its own snapshot) avoid this:

```sql
-- Step 1: delete the now-empty rating
DELETE FROM ratings
 WHERE id = $rating_id
   AND (score = 0 OR score IS NULL)
   AND flavors = '{}'::jsonb
   AND (notes IS NULL OR notes = '')
 RETURNING user_id, session_id;
-- (capture user_id / session_id from RETURNING; if no rows returned, skip step 2)

-- Step 2: if no other ratings remain for this user in this session, drop the feed_item
-- Use $user_id and $session_id captured from step 1; explicitly self-exclude the
-- just-deleted rating id to avoid any read-after-delete races.
DELETE FROM feed_items
 WHERE user_id = $user_id
   AND session_id = $session_id
   AND NOT EXISTS (
     SELECT 1 FROM ratings
      WHERE user_id = $user_id
        AND session_id = $session_id
        AND id <> $rating_id      -- belt-and-suspenders against snapshot races
   );
```

If step 1 matched zero rows (rating wasn't actually empty), step 2 is skipped — correct no-op. If two concurrent tabs both delete-the-last-rating, the second's step-1 returns zero rows (the row is already gone), so its step 2 is also skipped, and the first tab's step 2 deletes the feed_item exactly once. The `id <> $rating_id` guard in step 2's NOT EXISTS is defensive — protects against any MVCC oddity where step 1's commit isn't yet visible to step 2's snapshot.

**Flavours equality contract:** The `flavors = '{}'::jsonb` check requires that an "empty" flavours payload is literally `{}`, not `{red: 0, oak: 0}` (zero-count keys). Today `lib/checkinValidation.ts` does NOT strip zero-count keys — it only validates types — so submitting score+chips and then deselecting the chips would persist `{red: 0}` and the engagement-deletion match would silently fail. **Phase 1.5 prerequisite**: update `validateFlavors` to drop entries with `value === 0` before storing. Two-line change in `lib/checkinValidation.ts`.

**Caveat:** the in-session rating page has only "go back," no undo. Auto-delete on cleared-input is destructive and a tap-fumble away. **Phase 3 must ship the undo affordance before this rule is enabled.** Captured in `.local/future-work-rewire.md`; phase 3's task list includes it.

**Re-engagement after un-engagement:** if a user fully un-engages with a wine (rating + feed_item deleted) and then re-engages later, the new rating creates a new `feed_items` row with a fresh `createdAt = now()`. The post chronology resets to the re-engagement time. Intentional — the original post no longer exists, so there's no "original" timestamp to preserve.

**Multi-device photo upload protocol:** when a user has stale UI state (laptop showing pre-existing rating, but laptop's local cache thinks no rating exists), the in-session rate POST does `INSERT ... ON CONFLICT (user_id, wine_id, session_id) WHERE session_id IS NOT NULL AND user_id IS NOT NULL DO UPDATE ... RETURNING id`. The `RETURNING id` resolves to the existing rating's id (not the laptop's intended-new id). Server-side flow:
1. Run the rating upsert with `RETURNING id`. Capture the canonical rating id.
2. Do NOT trust any client-provided rating id. The client may send `ratingId=N` based on stale state; server ignores it for write-target purposes.
3. For each photo in the request body, INSERT into `rating_images` with the canonical RETURNING'd id. The client never knows or needs the locally-generated id; only the server-canonical one.
4. Response includes the canonical rating id and the new `rating_images` rows; client reconciles its local state.

This pattern prevents both the FK-fail case (laptop's locally-minted id doesn't exist) and the wrong-rating case (laptop's id happens to collide with another rating's id by autoincrement coincidence).

### Anonymous engagement

Anon users (`a:<uuid>` identity, no `users` row) write to `ratings` with `userId=NULL` and `raterName=<their display name>` — today's behaviour, preserved.

**Anon ratings do NOT create `feed_items` rows.** No userId means no author for the post; nobody can follow an anon. The session post for an anon-only session simply never materialises. This is enforced at the schema level by `feed_items.userId NOT NULL`.

A session that has both anon and logged-in participants gets feed_items only for the logged-in ones. Each logged-in user has their own session post; anon engagement is invisible on the feed but still affects the live session view (compare, ratings, etc.) as today.

### Blind tastings: per-wine redaction, no special creation rule

**Blind is a tasting format, not a privacy setting.** A blind tasting just means tasters don't know the wines until reveal. The social-share-visibility dimension is handled by the user's profile-visibility tier (today's existing system) — completely separate.

So blind sessions follow the **same feed_item creation rule as non-blind**: the post materialises on first engagement, exactly as for any other session. No deferred creation, no `sessions.allRevealedAt` denormalisation, no special path.

The blind dimension only affects **rendering**: for each wine in a feed_item's enumeration (or in the user's own Tastes view), the redaction predicate is `sessions.blind = true AND wines.revealedAt IS NULL` AND viewer is not the host AND viewer doesn't own the wine (provider self-view exception preserved). Already-revealed wines render normally. Non-blind sessions never redact (the `blind` guard short-circuits). **Deleted sessions (`sessions.deletedAt IS NOT NULL`) take absolute precedence: the post collapses to a single "[deleted session]" tombstone card with no per-wine enumeration**, regardless of any wines' `revealedAt` state — this is the only safe rule when `sessions.blind` itself has been scrubbed to NULL by the §8 contract. The Tastes-tab view of a tombstoned session's individual wines still works (each rating row carries its own `wineId` and renders the wine card), but feed-side aggregate posts collapse.

**`wines.revealedAt` must be persisted to Postgres on every reveal.** Today the reveal endpoints only write Redis. Phase 1.5 adds a Postgres write to: `/api/session/[code]/wines/[wineId]/reveal` (POST + DELETE), `/api/session/[code]/wines/reveal-all`, `/api/session/[code]/wines/hide-all`. Each updates `wines.revealed_at` on the affected wines (set or null per the action). Cheap (one row per wine touched) and the only way the renderer's redaction rule works post-Redis-eviction.

**What followers see for a pre-reveal blind post:**
- Author's identity, post timing, location (if `locationPublic`), the post exists.
- Per-wine: each rating's score / flavours / notes (those are the user's data) + the wine card with name/producer/vintage/grape/region/country/etc. **redacted** for unrevealed wines.
- As the host reveals wines (per-wine or all-at-once), the post "fills in" — the next render after a reveal shows the now-revealed wine fully. **This is intended as a feature, not a bug**: the reveal becomes a moment, the post evolves, followers can come back to see "the big reveal" land.

**What's NOT exposed pre-reveal:**
- Wine identity (the entire point of blind).
- `rating_images` for unrevealed wines (a label-bearing pour photo would leak the wine). Same redaction rule extends to images: hide `rating_images` rows whose attached rating's wine is unrevealed.

**Redaction helper:** the existing `redactWine` lives in `app/api/session/[code]/wines/route.ts:16` (file-local). **Phase 2 must extract it to `lib/wineRedaction.ts`** so the new feed-read path uses it from day one — otherwise the phase-2-to-phase-3 window would render unredacted blind-session wines on the feed (privacy bug). Same helper then powers the Tastes-tab render and the live session view (which keeps its existing call site, just imports from the new lib path). Helper takes a wine + a "is this revealed?" flag and returns the wine with identifying fields blanked out when not revealed.

**The user's own pre-reveal Tastes view:** their own score / flavours / notes / `rating_images` stay visible (their own data); wine identity still redacts via the same helper. Identical rule, applied to the same data, on every surface.

**Un-reveal (host hits hide-all or per-wine reveal DELETE):** the wine's `revealedAt` toggles back to NULL, the redaction helper fires again on the next render. No special case in the data model, no feed_item to clean up.

**Adding a wine to a session after engagement (blind or non-blind):** the new wine has no `revealedAt`. It's enumerated on a participant's session post once they rate it. For non-blind, the wine renders normally (no redaction). For blind, the wine renders redacted until the host reveals it. Same code path, same query, different render output.

**Privacy comment:** a follower seeing "Alice is in a blind tasting with 5 wines, scored avg 4★, posted 20 minutes ago" is the social signal blind tastings should produce. Anyone who wants stricter participation-level privacy uses the profile-visibility tier (private / public-mutual / public-users / public-internet) — orthogonal axis. The future "per-rating private flag" (§4 #14) is the per-rating equivalent if we ever need finer control.

**Why this single-path model:** Earlier drafts treated blind as a privacy feature requiring deferred feed_item creation, denormalised `sessions.allRevealedAt`, atomic UPDATEs on each reveal, wine-add guards, and Redis-then-Postgres failure-recovery hooks. **All of that complexity went away once we recognised blind is a tasting format, not a privacy mechanism.** One render-time helper handles every case; no schema columns needed; un-reveal is automatic.

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
8. **Auto-tagging session participants.** A future option ("tag everyone you tasted with"). The current `feed_item_tags` shape stays the same; if the future feature needs to distinguish auto vs manual tags, a `source` column is purely additive (one nullable string, default backfilled to `'user'` for existing rows).
9. **Aggregate views beyond the basic session card.** No "10 friends rated this wine" cross-session views in this pass — the data model unblocks them, the UI doesn't ship them.
10. **Notifications on likes/tags moving from `checkins` → `feed_items`.** No notification system exists today; nothing to update.
11. **Archive / "past sessions" lifecycle as a separate user action.** Today's implicit "live for N hours then expired" lifespan is unchanged. The new `sessions.deletedAt` is for explicit host-deletion only, not for archiving.
12. **Hard-delete (GDPR purge) job.** Future work. The cleanup order matters because the three child FKs have different `ON DELETE` rules: `feed_items.session_id` and `ratings.session_id` are `Restrict` (added in phase 1; reject the delete loudly to force explicit cleanup), while `wines.session_id` is `SET NULL` (pre-existing; orphans the wine row so bookmarked wines stay reachable per the rule on line 688). A bare `DELETE FROM sessions` would therefore be rejected by the first two and would silently null `wines.session_id` on the third. The purge job must explicitly null `feed_items` and `ratings` FIRST, then `DELETE FROM sessions` (which handles wines via the `SET NULL` cascade): `UPDATE feed_items SET session_id = NULL WHERE session_id = $sid`, `UPDATE ratings SET session_id = NULL WHERE session_id = $sid`, THEN `DELETE FROM sessions WHERE id = $sid` (wines orphan automatically). Restrict was chosen over SetNull on the new FKs deliberately (per §2 `feed_items` reasoning) — to force this cleanup to be explicit rather than silent. Document when the purge job ships.
13. **Curated collections / multiple feed_items per rating** (e.g. one rating shown on both a personal post AND a curated "best of 2026" collection). Out of scope, no roadmap. When it ships, needs a `feed_item_ratings(feedItemId, ratingId)` join table and a deprecation of the current `feed_items.ratingId` column — destructive migration. Earlier drafts planted the empty join table now to make that migration additive; dropped because curated collections aren't on a near-timeline and an empty Prisma model is a confusion landmine for the two developers in the meantime.
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
5. For each `checkin_tags` row: create a `feed_item_tags` row pointing at the new feed item.
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

After the rewire: `POST /api/checkins` keeps the `copyFromCheckinId` field name (no API breaking change). The field semantics shift: the value is now interpreted as a `feed_items.id`. **To preserve URL/cache compatibility**, the migration backfills `feed_items.id` to match the source `checkins.id`: for each migrated check-in, the new standalone `feed_items` row is inserted with the same id as its source. Then the autoincrement sequence is bumped past the highest used id (`SELECT setval('feed_items_id_seq', (SELECT MAX(id) FROM feed_items))` — note the scalar subquery; the form `setval(seq, MAX(id)) FROM feed_items` would fire setval once per row). Net effect: `copyFromCheckinId=47` resolves to the same logical row before and after the rewire — no client breakage, no cached-link 404s. Future API rename (when `copyFromCheckinId` becomes too misleading to keep — e.g. when curated collections add a third `kind`): accept both names for one release, drop the old name, fully additive.

Behaviour after migration: load the source feed_item, apply the existing same-gates (caller is mutual-follow + visibility-allowed), then:
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

Migration runs during a brief downtime window. **Enforcement**: scale the app to zero replicas (or `kubectl scale --replicas=0` / Deploio analogue), run the script, scale back up. At current scale (Tim+Simon, no production traffic to speak of) this is under a minute and easier than introducing a maintenance-mode middleware that exists forever for a once-a-decade event. Tell the other developer "don't touch the app for a minute" and you're done. If the user base ever grows to where downtime is genuinely costly, revisit and add the middleware then.

### Stale dependencies that get rewritten in the merged phase 2

`docs/dev/social-feed.md` describes the old check-ins-table model and references `checkins.isPublic` (already removed from the schema, but the doc wasn't updated). Phase 2 (read cutover) rewrites it to describe the new `feed_items`-based feed.

---

## 6. Phasing

Each phase = one branch, one PR, mergeable on its own. After each merge to main, the system is shippable. No long-lived rewire branch.

### Phase 1 — additive schema only
**Branch**: `feature/rewire-p1-schema`

- New tables: `category_styles`, `feed_items`, `feed_item_likes`, `feed_item_tags`, `rating_images`, `_migration_checkpoints`.
- Seed `category_styles` with the 5 wine styles.
- New columns on existing tables: `ratings.sessionId`, `ratings.origin`, `sessions.deletedAt`. (`ratings.score` stays NOT NULL until phase 1.5 — see below for why the unique-constraint swap moves there too.)
- Backfill `ratings.origin = 'session'` for all existing rows (today, every rating is from a session).
- Backfill `ratings.sessionId` from `wines.sessionId` for all existing rows (NULL where the wine was already orphaned).
- Add the composite FK `wines (category, style) → category_styles (category, style)`. Pre-flight check (§8) confirmed clean — no backfill needed. Re-run before merge.
- Add the partial index `sessions(id) WHERE deleted_at IS NULL`.
- Add GIN trigram indexes on `wines.name` and `wines.producer`.
- Widen `wines.id`, `ratings.wineId`, `bookmarks.wineId` from `VarChar(20)` to `VarChar(21)` and switch `wines.id` generation from `Date.now().toString()` to standard 21-char `nanoid` in `lib/session.ts`.
- Rewrite `docs/dev/session-deletion.md` to document the new soft-delete rule (the actual code change ships in phase 2).
- No application read paths change. Existing `@@unique([wineId, userId])` stays in place — its consumers in `app/api/session/[code]/rate/route.ts` (`findUnique({where: {wineId_userId: ...}})` and `upsert` calls relying on the Prisma-generated compound key) keep working unchanged. The unique swap moves to phase 1.5 alongside the rate-endpoint refactor.

Mergeable to main with zero behaviour change visible to users. Production gets the new tables on the next deploy.

### Phase 1.5 — write-side prereqs (zero downtime)
**Branch**: `feature/rewire-p1.5-prereqs`

Self-contained changes that have independent value, can ship without downtime, and remove the largest foot-guns from phase 2. None require the migration; all are testable in isolation.

- **Refactor the rate endpoint away from `wineId_userId` compound-key reliance AND make it write `ratings.sessionId`.** Today `app/api/session/[code]/rate/route.ts:78,84` use `prisma.rating.findUnique({where: {wineId_userId: ...}})` and `upsert({where: {wineId_userId: ...}})`. Both names are Prisma-generated from the existing `@@unique([wineId, userId])`. Replace with **raw `INSERT ... ON CONFLICT (user_id, wine_id, session_id) WHERE session_id IS NOT NULL AND user_id IS NOT NULL DO UPDATE SET …`** (`prisma.$executeRaw`) — the SAME SQL phase 2 needs anyway, just shipped one phase earlier. Two reasons: (a) it's race-safe under the new partial unique (the find-then-write alternative would surface 23505 errors to users on concurrent same-(user, wine) POSTs); (b) writing `sessionId` from day one closes the in-session uniqueness gap that would otherwise exist between phase 1.5 and phase 2 (the partial unique only fires on rows with non-NULL `sessionId`). **Implementation note**: the endpoint has `code` (string) but needs `sessions.id` (int) for the FK write — add a `prisma.session.findUnique({where:{code}}).id` lookup, OR refactor `pgUpsertSession` (`lib/session.ts:372`) to return the id. **Caveat**: raw SQL bypasses Prisma's typecheck — a future column rename (`session_id` → anything) won't be caught at compile time, only at runtime. Same trade-off `app/api/session/[code]/rate/route.ts:113` already accepts; cite it in the PR.
- **Drop `@@unique([wineId, userId])` on `ratings`. Add raw partial unique on `(user_id, wine_id, session_id) WHERE session_id IS NOT NULL AND user_id IS NOT NULL`** (the `user_id IS NOT NULL` clause is load-bearing — Postgres treats NULLs as distinct, so without it anon two-tab races wouldn't be constrained). **Both the DROP and the CREATE INDEX must be in the same migration file** wrapped in explicit `BEGIN; ... COMMIT;` — never split across two migrations, otherwise there's a window with no constraint at all. Make `ratings.score` nullable in the same migration. **Inter-deploy backfill**: the migration must also run a one-shot `UPDATE ratings SET session_id = w.session_id FROM wines w WHERE r.session_id IS NULL AND r.wine_id = w.id` to catch any new in-session ratings written between phase 1's deploy and this migration (the OLD rate endpoint that ran during that gap didn't write sessionId). The rate-endpoint refactor above must ship in the SAME PR — the new SQL references the new partial-unique index for its `ON CONFLICT` clause; the old `@@unique` consumers in the old endpoint reference the old name. Only by shipping refactor + drop + add + backfill together is there no compile/runtime gap.
- **Persist `wines.revealedAt` to Postgres on every reveal endpoint** (`/api/session/[code]/wines/[wineId]/reveal` POST + DELETE, `/api/session/[code]/wines/reveal-all`, `/api/session/[code]/wines/hide-all`). Each gains a Postgres `UPDATE wines SET revealed_at = $value WHERE id = $wid` (or `WHERE session_id = $sid AND revealed_at IS NOT NULL` for hide-all). Today these endpoints only touch Redis; this prereq is what lets phase 2's renderer read `wines.revealedAt` from a stable source post-Redis-eviction. **Known accepted limitation**: `pgUpsertWine` only fires for logged-in hosts (the wine row only exists in Postgres if the host was logged in at wine-add time). The new UPDATE silently no-ops for anon-host wines, so logged-in participants in an anon-host blind session see their session post stay redacted on the feed even after host reveal. Acceptable today because blind is a pro feature requiring login → all real blind sessions today have a logged-in host → `pgUpsertWine` fires → bug doesn't trigger. Captured in `.local/future-work-rewire.md` for the day blind ever ships without login (or for future product decisions that change the host-identity gate).
- **Fix `validateFlavors` to strip zero-count keys** in `lib/checkinValidation.ts`. Two-line change. Today the function only validates types; a payload of `{red: 0, oak: 0}` round-trips as `{red: 0, oak: 0}` instead of `{}`. Phase 2's engagement-deletion SQL (`flavors = '{}'::jsonb`) requires the canonical empty form.
- **Extract `redactWine` from `app/api/session/[code]/wines/route.ts:16` to `lib/wineRedaction.ts`.** The new module exposes `redactWine(wine, opts)` where `opts = {revealed, isHost, ownsWine, index}` — preserves today's host-bypass + provider-self-view exceptions + "Wine N" index labelling. The existing call site in `app/api/session/[code]/wines/route.ts:82-93` switches to importing from the new lib path; behaviour unchanged. Phase 2's new feed-read path consumes the same helper from day one.

Mergeable independently. No downtime. No migration. Full test coverage on the rate-endpoint refactor + redaction-helper extraction is a hard PR-merge gate (regression risk on shared UI surfaces).

### Phase 2 — migrate + cut over
**Branch**: `feature/rewire-p2-cutover`

The migration phase. Brief downtime window (scale to 0 replicas, run script, scale back up). Phase 1.5's prereqs (rate-endpoint refactor, partial unique, redaction extraction, revealedAt persistence, validateFlavors fix) are assumed shipped before this PR opens.

**Schema-touching writes:**
- `POST /api/checkins` switches to writing through the new model: `wines` + `ratings` (sessionId=NULL, origin='standalone') + `feed_items` (kind='standalone') + `feed_item_likes/tags` + `rating_images`. Old `checkins` table receives a final mirror write during the migration window, then writes stop. The `copyFromCheckinId` body field is preserved (not renamed) — the field accepts a feed_item_id under the new semantics; old client code continues to work.
- `POST /api/session/[code]/rate` adds: sets `ratings.sessionId` and `ratings.origin = 'session'`; creates/upserts the `feed_items` row for `(session, user)` with `kind='session'` (idempotent — only the first engagement creates the feed item). Same path for blind and non-blind sessions; blind is a tasting format only, handled at render time via per-wine redaction (§3). Conflict resolution: `INSERT ... ON CONFLICT (user_id, wine_id, session_id) WHERE session_id IS NOT NULL AND user_id IS NOT NULL DO UPDATE SET score=..., flavors=..., notes=..., rated_at=...` — last-write-wins, no 23505 errors surfaced.
- Session-rate DELETE path implements the engagement-deletion two-statement pattern from §3. **Refactor required**: today's `prisma.rating.deleteMany({where: {wineId, userId}})` doesn't capture the deleted row id — must change to a single-row DELETE with `RETURNING id, user_id, session_id` so step 2's `id <> $rating_id` self-exclusion guard works. Includes the safety prerequisite: undo affordance must be in phase 3 before this rule is enabled. **S3 reclaim ordering** (capture / commit / reclaim-after, per §3): capture `rating_images.imageUrl` BEFORE the DELETE; fire `reclaimImage()` AFTER the DELETE commits. **Don't wrap in `prisma.$transaction`** — both statements would share an MVCC snapshot and the bug returns.
- `DELETE /api/session/[code]` switches from hard-delete to soft-delete: set `sessions.deletedAt = now()` and scrub every other column to NULL per the §8 contract. Stop deleting unbookmarked ratings. All existing side effects (HoF cleanup, S3 reclaim, session_members wipe, Redis purge) continue to fire.
- Ban transaction adds: also delete the banned user's `feed_items` row for that session, in the same transaction as the rating deletes. Symmetric: kick keeps both ratings + feed_item; ban deletes both. S3 reclaim for any `rating_images` on the deleted ratings follows the capture/commit/reclaim-after pattern.
- Account-deletion path (extends today's `lib/accountDelete.ts`):
  - **S3 reclaim ordering** (capture / commit / reclaim-after, mirroring `lib/accountDelete.ts:188-219`): capture `rating_images.imageUrl` for the user's standalone ratings (sessionId IS NULL) into memory BEFORE the cascade. Session-rating images are tombstoned with the rating, not deleted, so they stay (no capture needed).
  - Standalone ratings (`sessionId IS NULL`) hard-cascade — no other user depends on them, so they go with their `feed_items` and `rating_images`.
  - Session ratings (`sessionId IS NOT NULL`) continue tombstoning per `docs/dev/account-deletion.md` (`UPDATE ... SET userId=NULL, raterName='[deleted]'`).
  - Implementation order: capture image URLs → tombstone session ratings → `DELETE FROM ratings WHERE userId=$id` cascades only the standalone rows → after commit, fire `reclaimImage()` on each captured URL.
  - `feed_items.userId Cascade` then takes care of: standalone feed_items (1:1 with the cascaded standalone ratings) AND the user's session feed_items.
- "Had a sip" path: keep the `copyFromCheckinId` field name; the value now refers to a `feed_items.id` of `kind='standalone'`. Implement the path-B copy semantics (fresh wine + rating + feed_item + image clone via rating_images).

**Read cutover:**
- **Use Prisma `include` for batched fetches**: `prisma.feedItem.findMany({ include: { rating: { include: { wine: true, images: true } } } })` — single round-trip, batched IN clauses for the relations. Naive per-row accessors would N+1; explicit `include` shape avoids it.
- `/api/feed` SELECTs from `feed_items` (with JOINs to `ratings` + `wines` + `sessions`). Output shape stays compatible with the existing `CheckinCard` component for standalone; session feed items render a stub session card until phase 3 ships the aggregate UI. The query JOINs `sessions` precisely to read `deletedAt` so tombstoned-session posts can render the "[deleted session]" label. The `redactWine` helper (extracted to `lib/wineRedaction.ts` in phase 1.5) handles per-wine identity hiding.
- `/api/me/feed` (own feed): same.
- `/u/<id>` profile activity: switch the source from `checkins` to `feed_items`.
- `/api/me/history` (the future "Tastes" tab data) starts pulling from `ratings` directly, no longer needs the `UNION` between ratings and checkins.
- Block / mute / visibility plumbing (`batchLoadVisibilities`, `viewerCanSeeAuthor`, block-pair like/tag scrubbing) gets re-pointed from `checkin_id` keys to `feed_item_id` keys. The mute filter (`feed_items.userId NOT IN (caller's mutes)`) is included. **This is a meaningful slice of phase 2 work, not a rename** — each helper has its own assumptions about ID type and result shape; touch each call site explicitly.
- **Hall of Fame trigger stays at session-rate POST.** Today HoF inserts fire from `app/api/session/[code]/rate/route.ts`. The phase 2 rewrite of that endpoint preserves the HoF logic in place. Re-verify in the PR that the HoF trigger still fires after the route refactor.
- Session-existence call sites (~5 total: `/api/session/[code]` GET, settings, name, `lib/session.ts` resolvers) get the inline `WHERE deletedAt IS NULL` filter.

**Migration:**
- Run the batched + checkpoint-tracked script (§5) inside the downtime window. Eyeball staging first, then prod.
- **Migration-script self-guard**: the script's first action is `IF (SELECT COUNT(*) FROM feed_items) > 0 THEN ABORT` — protects the `copyFromCheckinId` ID-equality invariant against a stray `feed_items` write between phase 1 and phase 2 (e.g. dry-run leftover, hotfix typo).
- The window is brief (under a minute at current scale): scale app to 0, take `pg_dump`, run migration script, deploy the new code with reads pointing at `feed_items`, scale back up.

**Rewrite `docs/dev/social-feed.md`** to describe the new model.

This is the highest-risk phase. **Rollback (current scale):** restore the `pg_dump` taken pre-migration; accept that any writes during the cutover window are lost. Acceptable at Tim+Simon scale.

**Phase 2 verification checklist** (run before lifting downtime):
- **Pre-cutover live-session check**: confirm no session is currently active (no participant, host, or cohost has rated within the last hour). Scaling the app to 0 mid-tasting bounces everyone. At Tim+Simon scale just text each other; future: use `scanKeys('s:*:r:*')` (per `lib/CLAUDE.md` — non-blocking SCAN, never `redis.keys()`). Best-effort, not atomic — bias toward rescheduling on ambiguous results.
- **Pre-flight re-run**: re-run the `category_styles` mismatch query from §8 against prod immediately before the migration. Expect zero rows.
- **Row-count parity**: `COUNT(*) FROM checkins` must equal `COUNT(*) FROM feed_items WHERE kind='standalone'`. Same for likes/tags.
- **Golden-set diff**: snapshot `/api/feed?cursor=now` JSON for 5–10 representative users pre-migration; replay post-migration; diff. Expected differences: standalone check-ins now appearing as `feed_items` with same content; session feed_items appearing as stubs.


### Phase 3 — UI rewire (aggregate session card) — SHIPPED
**Branch**: `feature/rewire-p3-aggregate-card`

(Was phase 4 in earlier drafts; renumbered after the 2+3 merge.)

What shipped, with the divergences from the original spec called out:

- **`<SessionFeedCard>`** (`components/social/SessionFeedCard.tsx`) renders `feed_items.kind='session'` with per-wine fan-out, author byline, host name, session name, and a card-level Like button. Wire shape in `lib/feedTypes.ts` (`SessionFeedPayload` + `SessionFeedWine`). Bulk loader in `lib/sessionFeedWines.ts` runs ONE Prisma query per feed page across all session posts.
- **Tombstoned-session render diverges from the §3 collapse rule** as originally stated. The original §3 said "the post collapses to a single '[deleted session]' tombstone card with no per-wine enumeration." Shipped behaviour: "[deleted session]" replaces the session-level identity in the header, but the per-wine list still renders. The blind-redaction predicate short-circuits on `meta.deleted` — a post-delete blind tasting reveals wine identity regardless of `wines.revealedAt`. Trade-off accepted: a host who deletes a blind session pre-reveal authorises the reveal; participants engaged with the wine; the alternative ("treat scrubbed-blind as blind") over-redacts non-blind tombstoned sessions forever because non-blind wines never have `revealedAt` set.
- **`<CheckinCard>`** (the existing one) continues to handle `feed_items.kind='standalone'`. `FeedClient` and `ProfileCheckins` switch on `type`.
- **Profile rename, not three-tab split.** The original spec said "Posts / Tastes / Wishlist". Shipped: rename the existing "Check-ins" tab to "Tastes" (same content — feed_items merged chronologically), keep Ratings (flavour wheel viz), keep Badges, keep People. Wishlist stays at `/me/saved` for now. Stat tile now sources `prisma.rating.count` (every rating row including chips-only and score-zero) instead of standalone-only — semantic mismatch with `users.lifetime_ratings` captured in `.local/future-work-rewire.md`. Future Tastes-tab work (search field, style filter, group-by-wine) all in `.local/future-work-rewire.md`.
- **Tab URL params** (`?tab=ratings/badges/people`) for deep links. `?tab=tastes` is the default and gets stripped. `UserProfileModal` passes `syncToUrl={false}` so opening a profile preview over `/session/<code>/wines` doesn't rewrite the underlying page's URL.
- **Engagement-deletion cascade** (`lib/engagementCascade.ts`) fires from two trigger sites: the POST handler when the upsert lands an empty payload (`empty-only` mode — safe predicate gates the destruction) and the DELETE handler (Reset path — `force` mode). Both wipe the Redis per-rating placeholder, gated on the cascade's `boolean` return so a concurrent engaged POST from another tab doesn't lose its Redis state. The lifetime-counter bump skips when the cascade reaped to avoid permanent drift.
- **Undo chip in WineModal** replaces the legacy go-back bubble in the same portal slot. 7s auto-dismiss. Surfaces after every commit (Save, swap-while-dirty, Reset). `priorRating` snapshot drives the inverse op: null → DELETE; non-null → re-POST. Tap navigates back to the just-acted wine with the same slide animation a swap uses. Hoist to a session-scoped provider (so modal close doesn't dismiss the chip) is captured in `.local/future-work-rewire.md`.
- **Pre-reveal blind-session rating display** wires through `lib/sessionFeedWines.ts` server-side redaction. The user's own score/chips/notes/`rating_images` stay visible regardless; only wine identity hides.
- **Pre-existing bug surfaced**: `pgUpsertSession` never wrote the `blind` column to Postgres. Live session view reads from Redis, so the bug was dormant — until the feed/profile started reading `blind` from Postgres for the redaction predicate. Fixed in chunk E (write on create; intentionally NOT in the update path — no UI to toggle mid-flight).

Cross-cutting invariants added to `docs/dev/social-feed.md` and `docs/dev/session-deletion.md`. New regression smoketests at `.local/test-env/scripts/section-rewire-p3-*.sh`.

This phase is pure frontend + the engagement-deletion handler + the pgUpsertSession blind-column fix. No schema, no migration.

### Phase 4 — drop the old tables — SHIPPED 2026-05-18 (PR #28)
**Branch**: `feature/rewire-p4-drop-checkins` (deleted after merge).

(Was phase 5.)

What landed:

- `prisma/migrations/20260516125827_rewire_phase4_drop_checkins/migration.sql` — dropped `checkins` / `checkin_likes` / `checkin_tags` / `_migration_checkpoints` with explicit `DROP CONSTRAINT IF EXISTS` + `DROP TABLE IF EXISTS` (matches the `project-verre-deploy-constraint-vs-index` memory pattern for prod-vs-local materialisation differences).
- `prisma/schema.prisma` — `Checkin`, `CheckinLike`, `CheckinTag`, `MigrationCheckpoint` models removed; three `User` backrefs gone.
- `lib/accountDelete.ts` — the `prisma.checkin.findMany` capture-and-reclaim block + the cascade-list comment block updated for the new model only. Standalone rating-image reclaim continues via the existing `rating_images` JOIN.
- `app/api/checkins/route.ts` and `app/api/checkins/[id]/route.ts` — kept (URL preserved for client compat; already writing to feed_items as of phase 2).
- `.local/test-env/scripts/section-rewire-p4-drop-checkins.sh` — regression net asserting the 4 tables are gone, the URL surface still works, account-delete still completes, and the phase-3 engagement-deletion cascade still reaps. 23/23 ✅ locally.

The merge sequence followed was:

1. Fresh `pg_dump -Fc` of prod taken immediately before merge (the rollback artifact).
2. End-to-end validation against a local restore of that dump (account-delete on a real test user, profile + feed reads, POST/PATCH/DELETE on `/api/checkins`) — all clean.
3. Merge → Deploio ran `prisma migrate deploy` → tables dropped atomically.

This was the irreversible step. Everything before it could be rolled back; this couldn't. Recovery path (if it had been needed): re-create the four tables via a new additive migration (Prisma model bodies recoverable from this PR's git history), then `pg_restore --data-only --disable-triggers` the targeted 4-table dump. `--disable-triggers` is required because `pg_restore` loads tables alphabetically and `checkin_likes` would otherwise fail its `checkin_id_fkey` before `checkins` is loaded — drill-tested against the prod dump.

---

## 7. Risks and how we mitigate them

| Risk | Mitigation |
|---|---|
| **Soft-delete leak: deleted session shows as live somewhere.** A `prisma.session.findX` call without `WHERE deletedAt IS NULL` would render a deleted session as active. Risk grows with scale and new features. | Phase 2 adds the inline filter to all ~5 session-existence call sites. PR description lists every audited site. The view (`live_sessions`) is a future option if the surface grows past ~15 sites. |
| **Wine ID collision** during migration or concurrent rates. `Date.now().toString()` collides for inserts in the same millisecond. | Phase 1 widens the column to `VarChar(21)` and switches to standard 21-char `nanoid` for new wine creation. Migration script uses the same generator. |
| **Engagement-deletion race across tabs.** Two concurrent "delete my last rating" tabs could both see "the other deleted it" and orphan the feed_item. | Two-statement pattern with `id <> $rating_id` self-exclusion in the second statement's NOT EXISTS (§3). Each statement gets its own MVCC snapshot, so the second sees the first's effect; the self-exclusion is belt-and-suspenders against any visibility lag. |
| **Migration interrupted mid-run.** A single-transaction script that crashes leaves a half-migrated state with no recovery. | Batched + checkpoint-tracked migration (§5). Restart resumes from the last checkpoint; running on already-migrated data is a no-op. |
| **Concurrent in-session edits create duplicate ratings.** The dropped `@@unique([wineId, userId])` would allow two-tab races to insert two rows. | Partial unique `(userId, wineId, sessionId) WHERE sessionId IS NOT NULL` on ratings (§2). Standalone re-tasting stays unconstrained (aging-bottle case). |
| **Blind tasting wine identity leak before reveal.** | Per-wine render-time redaction with predicate `sessions.blind = true AND wines.revealedAt IS NULL` (§3). Deleted-session label takes precedence. Phase 1.5 persists `wines.revealedAt` to Postgres on every reveal/un-reveal endpoint (today Redis-only). Single helper, every render path. The reveal becomes a UX moment when wine cards "fill in." |
| **Anonymous engagement crashes feed_items insert.** Anon users have no `userId`; `feed_items.userId NOT NULL` would reject. | Explicit rule (§3): anon ratings skip `feed_items` entirely. The `NOT NULL` constraint enforces this at the schema level — a bug that tries to insert an anon feed_item gets rejected loudly, not silently. |
| **Ban transaction leaves orphan feed_item.** Today's ban deletes ratings; without an update, the banned user's session feed_item would survive pointing at deleted ratings. | Phase 2 ban transaction extended to also delete `feed_items WHERE userId=target AND sessionId=this`. Same transaction as the rating cleanup. |
| **Account-deletion semantic drift.** Cascade vs tombstone is a careful per-table choice today; new tables need the same care. | Phase 2 implements per-row treatment: standalone ratings hard-cascade (no other user depends on them); session ratings tombstone (other tasters' compare views need them) per today's pattern. `feed_items.userId Cascade` then takes care of all feed_items the user authored. `rating_images` cascade with their parent rating. |
| **Migration runs against active writes.** In-flight checkin or session-rate POSTs during the migration window could slip past the snapshot. | Brief downtime window during phase 2: scale app to 0 replicas, run migration, scale back up. Under a minute at current scale. Don't try lock-free. |
| **`pg_dump` not taken before destructive phase.** Phase 4 drops three tables; mistake here is unrecoverable. | Phase 4's PR template requires the dump file checksum before merge. Per `prisma/CLAUDE.md` destructive-changes rule. |
| **Phase 1.5 partial-unique window**: if DROP and CREATE INDEX ship in two migrations, there's a window with no in-session uniqueness constraint at all. | Single migration file, explicit `BEGIN; ... COMMIT;` wrapper, refactor + drop + add + inter-deploy backfill in same PR (§6 phase 1.5). |
| **Phase 1.5 `validateFlavors` silent fail**: without zero-strip, the engagement-deletion `flavors = '{}'::jsonb` match never fires for users who tweaked-then-cleared chips. | Phase 1.5 fixes `validateFlavors` to drop `value === 0` keys before storing (§3 flavours equality contract). Two-line change with test. |
| **Anon-host blind reveal feed leak**: logged-in participants in an anon-host blind session see their post stay redacted on the feed even after host reveal (the `wines.revealedAt` UPDATE silently no-ops without a Postgres `wines` row). | Acceptable today: blind is pro-only, pros are logged-in, host always has a Postgres row → bug doesn't trigger. Captured in `.local/future-work-rewire.md` for the day blind ever ships without login. |

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

  **Every other column is scrubbed to NULL** — `name`, `description`, `link`, `code`, `host_user_id`, `host_name`, `timezone`, `created_at`, `address`, `date_from`, `date_to`, `archived_at`, `blind`, anything else that's on the row today or added in the future. Lifespan today is encoded in Redis TTL, not in a Postgres column — so there's no `lifespan_tier` column to scrub; if one ever lands, it joins the scrub list. The tombstone is genuinely empty: you can tell the row exists and that it's deleted, nothing more. The canonical scrub list (kept in sync with the actual `UPDATE sessions SET ... = NULL` block) lives in `docs/dev/session-deletion.md`.

  Children of the deleted session keep their data; the session_id link survives on ratings and feed_items, but is nulled on wines:

  - `wines.session_id` is NULLed on soft-delete (today's pre-rewire behaviour preserved per the Q3 phase-2-implementation decision). The wines themselves stay reachable for bookmark/Wishlist surfaces. **The wishlist tombstone label resolves via `ratings.session_id`** — find a rating the viewer wrote against this wine, follow its `session_id` to the tombstoned session row, read `deletedAt`. This commits to the future direction where `wines.session_id` becomes deprecated entirely (a wine is a thing, ratings are the session-scoped event).
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

  **Cohost behaviour after soft-delete:** A deleted session is gone for everyone, including cohosts. Their `live_sessions`-style filter (inline `WHERE deletedAt IS NULL` on session-existence reads) returns no row, so cohost links 404 the same as everyone else's. Soft-delete is final from the user perspective; nothing about cohost role grants visibility into tombstoned sessions.

  **Lifespan expiry vs soft-delete:** These are independent concepts. A session can be:
  - **Live**: `deletedAt IS NULL` AND Redis `s:{CODE}:meta` exists. Full live behaviour (admin, rate, etc.).
  - **Expired by lifespan**: `deletedAt IS NULL` AND Redis is gone (TTL expired). The Postgres row stays as historical record. Profile/feed/Tastes surfaces JOIN it as a normal session and render its name/wines as historical context. The `live_sessions`-style filter does NOT exclude it (it's not deleted, just expired). No live-session UI links work because Redis is empty; the user's history shows it as "Friday Pinot Night, March 2026" with no clickable session URL.
  - **Soft-deleted**: `deletedAt IS NOT NULL`. PII scrubbed. Profile/feed/Tastes surfaces render "[deleted session]" with no link. Live-session UI 404s.

  Two different lifecycles, no overlap. The rewire's `deletedAt` is for explicit deletion only; expiry-by-lifespan is unchanged from today.

  **Lifetime counters** continue to never decrement (today's behaviour). Live aggregations (avg flavour, total_rated) reflect the actual rating count, which now stays high since nothing is deleted.

  **Phase 1** adds `sessions.deletedAt` column + the partial index. **Phase 2** updates the session-deletion endpoint to soft-delete and routes session-existence reads through the inline filter. **Phase 1's PR** includes the rewrite of `docs/dev/session-deletion.md` to match.

- **Anon → logged-in (or account-creation) conversion mid-session is an existing limitation, not addressed by the rewire.** Today, a user who joins a session anon (`a:<uuid>`) and then either logs in to an existing account OR creates a new account keeps their anon-keyed ratings — the rating's `userId` stays NULL, the identity in Redis stays `a:<uuid>`. Same outcome for both flows. The rewire doesn't fix this (it's a UX / identity-resolution problem, not a DB-shape problem). It also doesn't make it worse. But the rewire DOES make the consequence more visible: post-rewire, the user's Posts tab will show no session_post for that session even though they engaged. Captured in `.local/future-work-rewire.md` as a deferred follow-up. If the user wants their session post to appear on their profile, they need to log in or create an account BEFORE first engagement in the session.

- **Aging-bottle clarification:** the rewire's "no dedup" non-goal means a user tasting "Primitivo Senza Parole 2021" 6 times across 30 years creates 6 separate `wines` rows (each from a distinct check-in or session-add) and 6 `ratings` rows. The "all my tastings of this wine" pattern only works WITHIN a single wines row (e.g. multiple standalone tastings of THE SAME wines.id, which happens when the user adds it once and re-rates standalone). Once dedup ships (future work), this collapses to "1 wine + N ratings." For now, the schema supports both shapes; the multi-tasting use case works through the partial unique constraint allowing multiple standalone ratings per (user, wine) pair.

- **Profile-visibility tier interaction with session feed_items:** The rewire keeps today's rule: session participation is a stronger signal than profile-visibility tier. A session feed_item is visible to:
  - The author (always, on their own profile).
  - Anyone who is a fellow participant in that session (look up via `ratings WHERE sessionId = X`, NOT via `session_members` — the latter gets wiped on soft-delete and isn't a reliable participant signal post-deletion; ratings survive and are the source of truth), regardless of the author's profile-visibility tier.
  - Any viewer the author's profile-visibility tier allows (the normal feed gate).
  Co-participants bypass the visibility tier ONLY for that session's feed_item — not for the author's other posts. Rationale: you tasted with this person, so you can see their post about that tasting; the broader profile-visibility setting protects the author's other content.

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

- **Partial-unique duplicate count on `(userId, wineId, sessionId)` after the backfill.** Today's `@@unique([wineId, userId])` blocks any duplicate `(wineId, userId)` pairs across the entire ratings table — once we drop it and add the partial unique on `(user_id, wine_id, session_id) WHERE session_id IS NOT NULL AND user_id IS NOT NULL`, the new constraint must hold. Hypothetical-backfill check:

  ```sql
  -- After populating ratings.sessionId from wines.sessionId, would any
  -- (user_id, wine_id, session_id) triple have COUNT > 1?
  SELECT user_id, wine_id, w.session_id, COUNT(*)
  FROM ratings r
  JOIN wines w ON w.id = r.wine_id
  WHERE r.user_id IS NOT NULL AND w.session_id IS NOT NULL
  GROUP BY user_id, wine_id, w.session_id
  HAVING COUNT(*) > 1;
  ```

  Expected: zero rows (today's unique constraint guarantees this within the wine.session pair). Run before phase 1 PR merges. If non-zero, investigate before adding the new constraint.

- **`feed_items` empty before phase 2 migration.** The `copyFromCheckinId` ID-equality story (§5) requires that no `feed_items` rows exist before the migration backfill inserts them with explicit ids matched to source `checkins.id`. Phase 1 creates the `feed_items` table but writes nothing to it; phase 2's migration is the first writer. Re-run `SELECT COUNT(*) FROM feed_items` immediately before the migration: must return zero.

---

## 9. Out of scope (revisit later)

- Beer / spirit / food category support (the `category` column ships and the `category_styles` table is in place, but no UI, no flavour wheels, no styles seeded for non-wine, no category-specific fields like beer IBU/ABV — those get added with the category they belong to).
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
- Curated collections / multiple feed_items per rating (would need a `feed_item_ratings` join table; destructive migration when shipped).
- Auto-reveal for blind sessions (anchored on `sessions.dateTo`, `sessions.dateFrom + N days`, or `createdAt + 30d` fallback — schema is already in place).

All of these become easy or trivial to build *because* of this rewire. None of them ship as part of it.
