# Proposal: Wine product catalog (redesign)

**Status:** design / not yet implemented. Supersedes the flat `wine_products` model in PR #82 (converted to draft — kept only as the reference for its reusable UI: the web product page, the aggregate query, and the mobile screen).

## Context

PR #82 shipped public wine product pages backed by a flat `wine_products` table with **auto-dedup-on-write**: a normalized `producer + name + vintage` string key drove a `find-or-create + fill-nulls` on every wine write. Review (Simon, 2026-07-22) rejected the *model* — not the pages — because auto-dedup silently and irreversibly collapses distinct entries, assumes every entry is shared reference data, and bakes vintage into identity. Retrofitting it after public pages exist and get linked means re-keying every product, re-pointing every rating, and unwinding wrongly-merged data.

**The invariant everything hangs on:**

> An entry is created **distinct**. Combining entries is a separate, deliberate, **reversible** action — a **merge**. The string/fuzzy match is only a **suggestion** that surfaces likely duplicates for confirmation; it is **never** an automatic find-or-create hook.

This doc specifies the **Foundation-first v1**: the correct identity + lifecycle spine, `shared`-scope only, with the schema deliberately leaving room for the deferred ownership/organization axis so it lands additively (no re-key).

## Decisions (locked)

- **v1 scope:** Foundation-first. Build producer/product/vintage + lifecycle + suggest-then-confirm merge. Everything is `shared`. Defer `owned` scope, orgs, ownership sets, view/edit grants, producer verification, co-owner consent.
- **Merge trigger:** suggest-then-confirm (fuzzy match → review queue → human confirm), reversible.
- **PR #82:** draft; the real catalog lands in a new branch/PR.
- **Seed:** a curator-supplied source dataset (`data/wines/wines_master.jsonl`, 15,658 rows — gitignored, stays local).

## 🔒 Data-provenance rule (hard)

The seed is a **curator-supplied external dataset**. **Never store the source URL or any source-provenance field in the DB**, and never expose source provenance on any surface.

**Ruling (Simon):** the catalog's identity is **our own IDs** (nanoid PKs, like the rest of the schema) — **prod persists NO source ids at all**. The source-provided ids (winery/wine/vintage) are used **only transiently at ingest time** (in-memory) to group rows into producer/product/vintage; they are not written to the prod catalog. **Testing exception:** during dev it's fine to keep the source ids in a scratch column for convenient idempotent re-ingest — but that column must not exist in the prod schema. See the `wine-catalog-source-provenance` memory.

## The dataset already gives us the spine

Each record is a **vintage** carrying stable source ids that encode the exact hierarchy — so the seed dedups **exactly, with no string matching**:

```
winery (4,659)  →  wine (11,732)  →  vintage (15,658)
 producer            product            vintage
```

Fields we map: `winery_id/winery_name` → producer; `wine_id/name` → product; `vintage_id/vintage_year` → vintage; `region_id/region_name/country_code` → region/country; `wine_type` → style; `style_grapes` → grape(s); `flavors` → descriptor hints (not our structure axes — informational only). **Dessert + Fortified are deferred (Simon): skip those rows at ingest** (~737, 4.7%) rather than mis-file them; re-add when the style set grows. 20% of products already span >1 vintage, so vintage-out-of-identity matters immediately; 32 rows are non-vintage (`vintage_year` null).

## v1 data model

Four catalog tables (names indicative), plus a link column on the existing `wines`:

**`producers`** — first-class maker.
- `id` (our nanoid), `name`, `region`/`country` (normalized ref, see below), `status` (lifecycle, below), `linksTo` (self-FK for merge), provenance (`addedBy`, `createdAt`). *(No source id in prod; dev loader may add a scratch source-id column, absent from the prod schema.)*

**`wine_products`** — the product (groups vintages). The primary mergeable entity.
- `id` (our nanoid), `name`, `category` (`wine` today; extensible), `style` (nullable; red/white/rosé/spark/nonalc — dessert/fortified deferred), plus:
- `scope` — enum `shared` | `owned`, **default `shared`; only `shared` used in v1.** Reserved now so `owned` is additive.
- `status` — `provisional` | `confirmed` | `linked` | `archived` | `rejected`.
- `linksTo` — nullable self-FK; when `status = linked`, points at the survivor. Reads resolve through it.
- provenance (`addedBy`, `curatedBy`, timestamps). *(No source id in prod; dev-only scratch column.)*

**`product_producers`** — **many-to-many** product ↔ producer, with optional `role` (lead | collaborator). A collab is one product with 2+ links (set at creation; NOT a merge). v1 seed = one link per product, but the relation is M:N from day one.

**`wine_vintages`** — the **rating grain**.
- `id` (our nanoid), `productId` (FK), `year` (nullable → the non-vintage / year-less instance), optional per-vintage overrides (abv, etc.), `status` + `linksTo` (within-product vintage de-dup is a lighter merge). *(No source id in prod; dev-only scratch column.)*

**`wines.vintageId`** (replaces #82's `productId`) — the existing per-session/per-checkin `wines` instance links to a **catalog vintage**. Set by the add-flow from an explicit user choice or a freshly-minted `provisional` vintage — **never** by a string match. `ratings` continue to hang off `wines` unchanged; aggregation rolls `ratings → wines → vintage → product`.

**Region/grape (v1 = normalized strings, Simon):** store as cleaned, **accent-folded** strings (so `Rhône`/`Rhone` don't fragment) — cheap, gives exact display + basic dedup. A first-class **region tree** (country→region→subregion→appellation, enabling region pages + roll-ups) is **reserved for later** and lands additively, not as a re-key.

### Lifecycle + merge (the reversibility guarantee)

- New user entry → `provisional`. Seed entries → `confirmed` (curator-authoritative). `rejected` = admin-only junk verdict, pulled from the public catalog. `archived` = discontinued but **fully findable** (search, direct link, page, ratings, history all intact) — only dropped from "add" suggestions.
- **Merge = a one-way `linksTo` pointer**, never a destructive collapse. Ratings **never move** — they stay on their original `wines`/vintage and **resolve through the pointer at read time**, so the survivor shows every merged entry's ratings and **unmerge is a single update**. A survivor absorbs many merges (many rows `linksTo` it); the back-direction is a query.
- "flagged/reported" is a **separate orthogonal signal**, not a status (an entry can be `confirmed` *and* flagged).
- **Authority (v1):** only admins/curators edit a `confirmed` entry or confirm a merge. (Producer-scoped authority + verification is deferred — see below.)

### Add-a-wine flow (answers "wine not in our dataset")

1. On add, **search first** (fuzzy `pg_trgm` over products+producers) → "Did you mean … ?".
2. **Pick a suggestion** → `wines.vintageId` points at that existing vintage. **No new catalog row.**
3. **"Not listed"** → mint a new **`provisional`** product+vintage (distinct), link the instance to it. Immediately usable/ratable; the fuzzy match later surfaces it in the **curator review queue** as a possible duplicate to merge (reversibly) into a `confirmed` entry.

Nobody is blocked from adding; nothing auto-collapses.

## Ingestion plan (seed)

One-shot script (not a schema migration), run against the catalog once the tables exist. It reads the source ids **only in-memory** to group rows (winery→product→vintage) and mints **our own nanoid PKs**; all seed rows land `confirmed`. **Strips the source-URL + source-slug fields; persists no source ids in prod.**
- **Prod:** idempotency comes from running it once against a fresh catalog (our IDs are freshly assigned). A controlled re-seed truncates + reloads rather than upserting on a foreign key.
- **Testing:** the dev loader may keep the source ids in a scratch column for convenient re-runs; that column is dev-only and absent from the prod schema.

## Deferred (Phase 2+), but schema-ready now

`owned` scope; the **organization** entity + membership roles; **ownership sets** `(ownerType: user|org, ownerId)`; per-entry **view/edit grants** (public|granted); **producer verification/claiming** + producer-scoped edit authority (authoritative on factual fields, zero control over community ratings/aggregates, cannot hide/delete a rated `shared` entry); **co-owner consent** (joint-account: reversible-alone / destructive-needs-all); scope promotion `owned → shared` (one-way trapdoor that permanently surrenders delete/hide). The `scope` column + the merge/lifecycle machinery are shaped so these are additive tables + columns, not a re-key.

## Carry-forward / debts

- **Reusable from #82:** the web product page, the aggregate query (re-pointed at vintage→product roll-up + `linksTo` resolution + expiry parity), the mobile screen, the review-fix regression tests.
- **CI gate:** if the fuzzy match survives as a merge-suggestion signal, its TS/SQL parity needs an **actual CI gate** (the #82 comments referenced one that doesn't exist).
- **Ratings re-point migration:** existing session/standalone ratings currently point only at `wines`. v1 backfill links `wines → wine_vintages` where a confident exact match to a seed vintage exists; the rest stay unlinked (no product page) until a user/curator links them — **never** auto-string-matched.

## Open decisions

- ~~Persist the source ids at all~~ — **RESOLVED (Simon):** our own IDs only in prod; no source ids persisted. Source ids are ingest-time-only (in-memory) grouping keys; a dev scratch column is fine but absent from prod.
- ~~Region/grape normalization depth for v1~~ — **RESOLVED (Simon):** normalized accent-folded strings for v1; region tree reserved for later.
- ~~Style set (Dessert/Fortified)~~ — **RESOLVED (Simon):** deferred; skip those rows at ingest.
- Vintage-level vs. product-level as the merge unit for the review queue (proposed: product primary, vintage as a lighter within-product case).
