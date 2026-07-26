# Wine catalog — implementation plan

**Status:** **Phase 1 SHIPPED** on `main` as `4bc14c5` (PR #86, 2026-07-25); phases 2–5 pending. Companion to `wine-catalog.md` (the RFC, spec-of-record for the *model*); this doc is the *build* — phase order, the rulings that unblocked it, and the amendments the plan must carry.

**Starting phase 2?** Read § Phase 2 first — the trigram query form is the thing most likely to be got wrong, and it fails SILENTLY by being slow rather than wrong. Note the GIN `<%` form documented there was **superseded by a GiST KNN order** on scale grounds; the superseded section is kept because its traps still apply to any similarity query. Then `prisma/CLAUDE.md` for the schema invariants Prisma cannot express. Phase 1's branch has been merged and deleted; work from `main` on a new `feature/…` branch.

The RFC's three open decisions are resolved (see its § Open decisions — RESOLVED). This plan absorbs those rulings plus a review pass whose amendments are recorded inline, each at the phase that must honour it.

## Phase order at a glance

| Phase | Name | Status | Ships |
|---|---|---|---|
| 1 | Domain-schema migration | ✅ **SHIPPED** `4bc14c5` | `staff_roles` + `staff_role_audit`, the four catalog tables, `product_eans`, `wines` link columns, `catalog_audit`, raw SQL |
| 2 | Add-flow + fuzzy search | ✅ **SHIPPED** `79a49a2`, gated OFF | The five add branches, one `pg_trgm` matcher (GiST KNN), Redis link mirroring |
| — | **Model change** | 📋 **PLANNED** — [`wine-catalog-model-change.md`](wine-catalog-model-change.md) | Occurrences replace per-event `wines`; ratings→occurrence→catalog; bookmarks→catalog; Postgres-authoritative promotion |
| 3 | Review queue + merge machinery | Pending | Curator surfaces, merge/unmerge, suggestion policy, **change proposals** |
| 4 | Integration-schema migration | Pending | Import + pull contract, and the tables they need |
| 5 | Backfill + product pages | Pending | Legacy exact-match backfill, reusable UI from `feature/wine-product-pages` |

**Execution order** (from the model-change proposal § 7, which is the spec-of-record):

```
attributions page → first catalog fill → model change → review queue (phase 3)
```

The attributions surface is a **licence obligation** and hard-gates the fill. The fill gates the model change, because once anonymous users can only *pick* existing entries an empty catalog leaves them unable to add anything.

⚠️ **The phases-2-and-3 release boundary was REVERSED** (Simon, 2026-07-25). It previously read: *public catalog creation stays disabled until phase 3's reject/merge/audit path works, because publicly-searchable user-authored content with no moderation path is not a valid steady state.* That reasoning was sound at the time and is superseded by scale, not by argument — with a handful of testers the accumulation risk is negligible, and blocking the model change behind a full curator UI costs more than it protects. **What must still hold:** entries minted before the queue exists stay `provisional` and are **recorded as awaiting review from day one**, so nothing is silently treated as reviewed. If usage grows before phase 3 lands, re-close the fence rather than letting the backlog accumulate unbounded.

## Conventions that apply to every phase

- **Timestamps are `@db.Timestamptz(6)`.** The schema has 35 `Timestamptz(6)` columns and zero `(3)`; consistency wins. Never order by timestamp precision — order by id or sequence.
- **PKs are 21-char nanoids** (`VarChar(21)`), matching `wines.id`. Enumerated columns are `varchar` + `CHECK` (house convention, no PG enums).
- **One ID for life** (RFC § Lifecycle). Nothing ever re-mints.
- Catalog table shapes are a versioned interface — see the RFC § Catalog write ownership. Shape changes are surfaced explicitly, never made silently.

## Phase 1 — Domain-schema migration

Everything structural, nothing user-facing.

1. **`staff_roles`** — per the RFC ruling 1. Resolver in `lib/staffRole.ts`; `admin` satisfies any curator-level check.
2. **`producers`, `wine_products`, `wine_vintages`, `product_producers`** — exactly the RFC § v1 data model.
3. **`product_eans`** — in v1 (the RFC originally reserved it for Phase 2; moved because prod carries EANs and they give a hard identity key for deduping user adds instead of leaning on fuzzy name match alone). See § EAN semantics below.
4. **`wines.productId` + `wines.vintageId`** — nullable, plain FK on product, composite FK `(vintageId, productId)` → `wine_vintages (id, product_id)`, plus `CHECK (vintage_id IS NULL OR product_id IS NOT NULL)`. Eight of the nine forward catalog FKs are `NoAction`/`Restrict`; `product_producers.product_id` is the sole intentional `Cascade`.
5. **`catalog_audit`** — app-only bookkeeping, not part of the import interface.
6. **`staff_role_audit`** — the append-only grant/revoke history required below. A separate model from `catalog_audit`: that one records actions on *catalog entities*, this one records changes to *privilege*, and conflating them would put a role revocation in the same stream as a vintage merge. Rows are never updated or deleted, including when the `staff_roles` grant they describe is cascaded away by account deletion.
   - 🔒 **Subject and actor are immutable ID snapshots, not FKs.** "Survives account deletion, never updated" and "plain FK to `users`" are incompatible: a `Cascade` FK deletes the history, and `SetNull` mutates a row that is supposed to be append-only. So the audit row stores the subject/actor **user id as a scalar snapshot**. Any relational FK is nullable or omitted entirely. This is the cascade-vs-tombstone rule from root `CLAUDE.md` resolved toward *neither*: the row is a durable record about an account, not a row belonging to it.
   - 🔒 **No display-name snapshot** (ruled 2026-07-24). Privilege auditing needs to answer *which account* held power, and the id answers that completely; the name is convenience. Retaining a name forever would carve an exception out of account deletion, which elsewhere in this codebase rewrites names to `[deleted]` precisely so a deleted user's name stops surfacing. Readers resolve current names by join; a deleted user shows as an unresolvable id, which is the correct outcome. The `wines.addedByDisplayName` precedent does **not** transfer — that snapshot is load-bearing because anonymous adders have no user row to join to, whereas every staff grant is by definition a registered account.
7. **`prisma/CLAUDE.md` correction** — `users.role` recorded as dead, staff powers documented as living in `staff_roles`.

### Staff-role lifecycle (all of this is phase 1, not deferred)

A role table alone is not a role system. Required alongside it:

- **Bootstrap + recovery.** The first admin is created by a **direct-DB `INSERT`** with `grantedBy` null, so the audit trail is honest that the system minted it rather than pretending a human did. Deliberately not a script (it would duplicate `lib/staffRole.ts`'s grant semantics, and user ids differ per environment so nothing is committable) and deliberately not an endpoint — an in-app admin-recovery route would *be* the privilege-escalation hole, and requiring DB access is what makes the database's unconditional last-admin refusal tenable. Runbook, including the guarded curator→admin promotion: `prisma/CLAUDE.md`.
- **Append-only grant/revoke audit.** Deleting a `staff_roles` row otherwise destroys the history of who held what. Grants and revocations both append.
- **Revocation is immediate — resolve from a fresh DB read.** Roles are never cached into a JWT or session. This mirrors the existing 🔒 never-cache-`auth()` invariant in `lib/CLAUDE.md`: any cache TTL is a window in which a revoked privilege still resolves, which is the security hole itself.
- **Last-admin protection.** The revoke path refuses to remove the final admin grant.
- **An explicit permission map**, written down: who may grant roles, and who may hard-purge. Purge is the most destructive operation in the system and does not belong to every curator.

### Verified against real Postgres 16

These were run before writing the migration, not assumed. All hold:

- Element-wise `text[]` folding works as a **STORED generated column**, and a `pg_trgm` GIN index on a generated column is accepted.
- `UNIQUE NULLS NOT DISTINCT (product_id, year)` correctly rejects both a duplicate year and a second NV row.
- The composite FK rejects a vintage belonging to a different product; the `CHECK` rejects `vintage_id` set with `product_id` null (the composite FK alone would not — it is MATCH SIMPLE, so it skips whenever any column is null).
- `CHECK ((status = 'linked') = (links_to IS NOT NULL))` rejects a `linked` row with no pointer.
- `f_unaccent` already exists as `IMMUTABLE PARALLEL SAFE STRICT` (`prisma/migrations/20260705120000_moments_search_unaccent`), so generated folded columns and functional trgm indexes are legal without new plumbing.

⚠️ **`array_agg` over zero rows returns NULL, not `{}`.** The array-fold helper must be STRICT with `COALESCE(array_agg(...), '{}'::text[])` in its non-null execution path, so `{} → {}` rather than silently becoming NULL.

### Arrays are non-null; `{}` is the missing value

🔒 **`grapes` is a non-null `text[]`, and `{}` means "no grapes recorded" — there is no known-empty state at PRODUCT grain in v1.** ⚠️ **This is the PRODUCT rule.** `wine_vintages` gained a known-empty state in `20260726090000` via an explicit `grapes_override` boolean — the flag exists precisely because a nullable array could not express it: **Prisma returns `[]` for both `NULL` and `{}`** on a scalar list (measured against the generated client), so the tri-state was invisible to every application read path. The two grains now have deliberately different missingness semantics; see § Fact rules. Verified against the toolchain: Prisma cannot model an optional scalar list (`String[]?` → *"Optional lists are not supported. Use either `Type[]` or `Type?`"*), and the repo is on Prisma 6.x. Postgres itself holds `NULL` vs `{}` fine, so this is a representation limit rather than a database one — but backing a nullable array through raw SQL would mean reads bypassing the Prisma client, which is real drift for a distinction nothing in v1 consumes (matching vetoes on conflicting `style`/`abv`, never on grape absence). ✅ **It did become load-bearing at vintage grain, and the additive fix shipped as predicted** — `grapes_override` alongside the non-null array (`20260726090000`), not a nullable column. The same route stays available for `wine_products` if a product-level known-empty is ever needed; nothing in v1 consumes one.

**Arrays therefore need their own missingness rule, and it is not the scalar one:**

- **Scalar facts keep the strict `IS NULL` rule** below — unchanged.
- **`{}` counts as missing and IS enrichable** by a non-empty incoming value — **at PRODUCT grain**. A rule treating a product's `{}` as a user-asserted "known none" would block legitimate enrichment on every grape-less row in the catalog. ⚠️ **`wine_vintages` is the exception and inverts this**: `grapes_override = true` makes its array authoritative INCLUDING `{}`, and import must never fill it — a vintage's known-empty state is exactly what the flag exists to carry. Omitting grapes on an incoming `override = true` is a **reject**, never a normalization to `{}`. See § Fact rules.
- **A deliberately-empty array is protected by `curatorLocked`**, exactly as a deliberate scalar NULL is. **On `wine_products` that lock is the only thing** that makes an empty array authoritative; absent a lock, empty means unrecorded. ⚠️ **`wine_vintages` has a second route**: `grapes_override = true` makes its array authoritative *including* `{}` — that is the flag's entire purpose, and it needs no curator lock (see § Fact rules).

⚠️ **`''` reaches the fold as a value — the empty-vs-null guard must sit upstream of it, not only in it.** The array-fold `COALESCE` above protects the *array* case; scalar identity fields (`name`, `producer`, `region`) arrive already coerced and it never fires for them. Verified in the existing write path: `lib/session.ts:353` `clean()` is `scrub(v) ?? ''`, which turns null into empty string on the way into Redis, while `lib/session.ts:582`/`619`/`634` mirror to Postgres as `wine.producer || null`, turning it back. Same value, two representations, decided by different operators in different files — `??` only catches null/undefined, so `''` survives it, where `||` collapses it.

Consequence if this reaches the catalog unhandled: `f_unaccent(lower(''))` is `''`, not NULL, so every blank-producer entry folds to the same key and fuzzy-matches as an exact collision — minting one shared catalog identity where there should be none.

**The defect is missing boundary validation, not the `??` operator** — `??` is correct wherever the empty string is a meaningful value, and blanket suspicion of it would be noise. Two rules at the boundary instead:

- **Required names (`producers.name`, `wine_products.name`) are trimmed and rejected when blank** — route validation *plus* `CHECK (btrim(name) <> '')`, so no write path can bypass it.
- **Optional facts that participate in matching (`region`) normalize blank → NULL** at the boundary. Region is a fact rather than an identity field, but it feeds `regionFolded` and joins the fold, so a blank there still collides.

🔒 **For scalar facts, never widen the fill-null predicate beyond `IS NULL`.** Fill-null is `COALESCE(existing, incoming)`, NULL-strict by construction, so any non-null value — including `''` — survives enrichment untouched. Relaxing the predicate to also match empty (`OR existing = ''`, or an "is null/blank" formulation) converts a deliberate value into a gap to fill. Blank *identity* strings never reach that predicate in the first place, because the boundary rejects them (below).

The array rule above is the deliberate exception, and the asymmetry is the point: `{}` is enrichable because it is the only representation of *unrecorded* for an array, whereas a scalar has a real NULL for that job. `curatorLocked` is what makes either one authoritative when a curator means it.

### Pre-migration review deliverable

Before anything migrates, the full set goes to Simon for review — not just the four headline models: all five import-facing models (`producers`, `wine_products`, `wine_vintages`, `product_producers`, `product_eans`), the `wines` field additions, `staff_roles`, `staff_role_audit`, `catalog_audit`, **and the exact raw migration SQL** with every constraint and index. The raw SQL matters as much as the Prisma definitions here, because the constraints *are* the contract — `NULLS NOT DISTINCT`, the composite FK, and the lifecycle CHECKs cannot be expressed in `schema.prisma` and would otherwise be reviewed only as prose.

### EAN semantics

- **Stored as a string**, preserving leading zeros — a numeric type corrupts `0`-prefixed EAN-13s.
- **Canonicalized and validated** on write. 🔒 Both gates ship as database CHECKs, not route validation: `product_eans_format_check` (exact GTIN lengths 8/12/13/14) **and** `product_eans_check_digit` (the GTIN check digit, via the `gtin_check_digit_ok` function). Neither substitutes for the other — length rejects 9/10/11-digit values that are not GTINs at all, while the check digit rejects a plausible-length code whose final digit does not verify. An earlier draft asserted check-digit validation "at the write boundary" while nothing implemented it; verified at the time that a real EAN-13 and the same code with a corrupted final digit were both accepted.
- 🔒 **An EAN already assigned to another product is a conflict/review event — never an automatic reassignment.** This is the RFC's "false merges are the expensive failure" principle applied to strong identifiers: a shared EAN raises confidence, it never silently moves a barcode between products.
- **`firstSeen` is write-once**, set on insert and never updated — it is the "when did this barcode first reach us" fact, and a fill-null rule would leave it correct only by accident.
- **`lastSeen` is monotonic and explicitly exempt from fill-null.** Under the fill-null-only rule a non-null `lastSeen` would never advance, freezing at first sight — so it is updated explicitly, and only ever forward.
- **Confidence is app-side, not part of the import interface.** A shared EAN raises match confidence at suggestion time (RFC § merge-suggestion policy); the interface carries the barcode as a fact and does not carry a confidence score.

## Phase 2 — Add-flow + fuzzy search

**Status: built, not yet public.** The five add branches, the one matcher, the Redis + Postgres link mirroring, and the blind-redaction strip are implemented; `CATALOG_PUBLIC_ENABLED` (`lib/catalogGate.ts`) keeps creation closed to everyone but staff **until the attributions surface, the first fill, the model change, and its release conditions are all satisfied** — the fence now opens WITH the model-change phase, before phase 3 (see the execution order above). Code: `lib/catalogSearch.ts` (search), `lib/catalogWrite.ts` (the mutation chokepoint), `lib/catalogGate.ts` (the fence), `app/api/catalog/{search,entries}`. Tests: `scripts/tests/catalog-addflow-integration.mjs`, wired into `check-schema.yml`.

### ⚠️ SUPERSEDED: the GIN `<%` form below was replaced by a GiST KNN order

**What ships now:** `col <->> catalog_fold_v1($1)` ordered with a `LIMIT`, against `producers_name_folded_gist_idx` / `wine_products_name_folded_gist_idx` (`20260725160000_catalog_gist_knn`). The 0.3 threshold is a **post-filter** on the returned rows, so there is no GUC and no interactive transaction.

**Why**, measured on PG16 at 300k rows: `<%` at 0.3 is not *selective* — candidates scale 1:1 with the catalog (a "selective" multi-word name still admitted 8.5% of the catalog), the heap recheck dominated, and latency grew linearly (34 ms at 60k → 352 ms at 300k). Under load it failed rather than slowed: 50 concurrent searches → 15 hard pool timeouts, 100 → 66. GiST KNN returns the nearest N straight from the index, so cost is bounded by the LIMIT: broad "chateau" went 22 ms → 0.26 ms, and realistic queries measure 0.9–41 ms at 300k.

⚠️ **Operator and operand ORDER must match** — `column <->> query` and its commutator `query <<-> column` both plan an Index Scan (~4.9 ms); the mismatched pairings `column <<-> query` / `query <->> column` seq-scan the whole table (~116 ms over 60,001 rows) while returning correct rows. `<<->` is the declared commutator of `<->>` (pg_operator), so it is NOT a forbidden operator — it is usable only with the query on the left. Same operand-order trap as the GIN `<%`/`%>` pair. `<->>` is exactly `1 - word_similarity`, so ranking and typo tolerance are unchanged.

**The GIN indexes are REPLACED by covering B-trees**, not kept: a trigram index is the wrong structure for `=`, and measured on the REAL query the planner chose GiST (0.544 ms / 130 buffers) over a bare B-tree — only `(name_folded, id) INCLUDE (status)` wins on its own, as an Index Only Scan with zero heap fetches (0.125 ms / 4 buffers). Nothing issues a `%`/containment query, so GIN had no live consumer.

**The section below is retained as the rationale-of-record for the GIN form** — its three traps still apply to any `%`/`<%` query anyone adds later, and the two measurement traps at the end apply to *any* trigram benchmarking.

### 🔒 The trigram query form is load-bearing — get it right or the index does nothing

Measured on PG16 with 60k producers against the phase-1 GIN indexes:

| Predicate | Plan | Time |
|---|---|---|
| `$1 <% name_folded` | Bitmap Index Scan | 1.2 ms |
| `name_folded %> $1` | Bitmap Index Scan | 1.2 ms |
| `$1 %> name_folded` | Seq Scan | 140 ms |
| `name_folded <% $1` | Seq Scan | 140 ms |
| `word_similarity($1, name_folded) >= 0.3` | Seq Scan | never indexable |

Three distinct traps, all of which return *correct* rows and merely lose the index — so nothing fails visibly:

- **`word_similarity(...) >= 0.3` cannot use a trgm index in any operand order.** A function call is not an indexable operator. That form is what `prisma/migrations/20260705120000_moments_search_unaccent` documents, and it is correct *there* (moments search is always narrowed to one caller's few sessions first) — which makes it the likeliest thing to be copied into a table-wide catalog scan, where it degrades to scanning the entire catalog.
- **Operator and operand order must match.** `<%` takes the query on the left, `%>` takes the column on the left. Not commutative; the mismatched pairings seq-scan. "Column first" is *not* the rule — that is only true for `%>`.
- **The operators read a GUC that defaults to `0.6`,** not the 0.3 tuned against real data, so without setting it the search is silently stricter than intended and misses real typos.

Canonical form:

```sql
BEGIN;
SET LOCAL pg_trgm.word_similarity_threshold = 0.3;
SELECT id, name FROM producers WHERE $1 <% name_folded
ORDER BY word_similarity($1, name_folded) DESC LIMIT 20;
COMMIT;
```

🔒 **`SET LOCAL`, never a bare `SET`.** Verified: `SET LOCAL` reverts at COMMIT; a bare `SET` persists on the connection and leaks the threshold into every later query that reuses it from the pool. Avoiding that leak is precisely why the moments-search migration inlined `word_similarity()` rather than using the operator — `SET LOCAL` is what buys the index back without reintroducing the hazard. `word_similarity()` in `ORDER BY` is fine and wanted: the operator filters via the index, the function scores the survivors.

Also recorded in the phase-1 migration § 3 and `prisma/CLAUDE.md`.

#### Two traps found while measuring this, both of which make a plan LOOK wrong when it is right

Recorded because both cost real time during the phase-2 build and will otherwise cost it again for whoever next re-runs these plans:

- ⚠️ **`LIMIT n` with no `ORDER BY` makes the CORRECT form seq-scan.** The planner may stop after *n* rows, which prices a seq scan below the index. Measured: `WHERE $1 <% col LIMIT 20` planned a Seq Scan, while the same predicate *with* the real `ORDER BY word_similarity(...) DESC` planned a Bitmap Index Scan. Always measure the whole query, ORDER BY included. Relatedly, a non-selective query (10 %+ of the table matching) legitimately seq-scans on cost — plan shape is only meaningful for a selective one, so seed fixtures with *diverse* names rather than a repeated template.
- ⚠️ **On a freshly-loaded table the index loses even for the right form, until a VACUUM.** A GIN index buffers new entries in a *pending list* that only a vacuum merges into the index proper; straight after a bulk insert that list is large enough to price the index scan out. This reproduced as a test that failed on a fresh database and passed on a reused one. `ANALYZE` does **not** fix it — it refreshes statistics, not the pending list; `VACUUM ANALYZE` does. Production is unaffected (autovacuum runs continuously); it is a fixture artifact, but an expensive one to diagnose from scratch.

#### Deferred, with a measurement to make first: GiST for the unscoped top-20

The add-flow chooses a producer first, so the scoped product search is the hot path and it is cheap (an index probe on `product_producers_producer_id_idx`). The **unscoped, broad-name** search is the expensive shape — a common name matches thousands of rows, the GIN index returns them all, and the `LIMIT 20` discards nearly everything after sorting. Postgres documents GiST as supporting **distance-ordered** (`<->`) nearest-neighbour scans, which can beat GIN-filter-then-sort precisely when only a few nearest matches are wanted.

Not changed now, deliberately: it is an index-strategy swap whose win depends on the real catalog's name distribution, and the current numbers (~1,600 blocks / 83 ms for the worst case at 60k×60k) are not a problem yet. **Benchmark GiST `<->` ordering against real data before the catalog grows past a few hundred thousand rows**, and only then decide. The measurement, not the documentation, settles it.

Also worth revisiting at that point: whether `producerId` should be **required** for public add-time product search. The documented flow picks a producer first, and global product names are inherently ambiguous, so requiring it would remove the expensive shape entirely rather than optimising it.

#### The predicate has ONE definition, shared with its test

`trgmPredicateSql()` in `lib/catalogSearch.ts` is the single spelling of the indexed predicate: the runtime queries embed it, and § 1 of `scripts/tests/catalog-addflow-integration.mjs` `EXPLAIN`s it. 🔒 **That sharing is what makes the test real.** An earlier version explained a hand-written string that merely *looked* like the query, and mutation testing showed it stayed fully green through both the `word_similarity(...) >= x` swap and the operand-order swap — the two regressions the assertion exists to catch. If the predicate is ever inlined back into the query strings, the plan assertion silently stops testing anything.

### The flow

The five explicit branches of RFC § Add-a-wine flow. One `pg_trgm` matcher module over `nameFolded`, shared by add-time search, review-queue suggestions, and post-import rescans — there is no second matcher to drift. ⚠️ **REFINED (2026-07-26): one module and one set of normalization/scoring semantics, but TWO query SHAPES** — the interactive callers are KNN top-N; phase 4's bulk duplicate detection needs everything above a threshold, which top-N cannot express at any *n*. `scope` set explicitly at every write boundary (creation rejects a missing scope rather than relying on the column default). `productId`/`vintageId` mirrored through Redis per RFC § Redis-first link design, with all list writes going through `mutateWines` (KEEPTTL preserved). Blind redaction strips both IDs in `wineToWire`.

Provisional entries minted here are publicly searchable (RFC ruling 3) — subject to the uniform-record-presentation constraint recorded there. Public creation stays disabled until the **model-change phase** opens the fence (see the execution order above) — no longer until phase 3.

## Phase 3 — Review queue + merge machinery

Curator-gated, per the phase-1 permission map. Merge is pointer + lifecycle only; chains are kept and resolved transitively with a visited set and depth cap; cycle prevention resolves the full target path and writes the pointer in one transaction under deterministic row locks; every merge/unmerge writes `catalog_audit` in that same transaction. Suggestion policy carries the cross-producer prohibition and the attribute veto. Unmerge restores the loser's captured prior status.

## Phase 4 — Integration-schema migration

### 🔒 A FOLD VERSION BUMP IS A COORDINATED DEPLOY

**Raised by the catalog-maintenance side, 2026-07-26, and accepted.** `catalog_fold_v1` is a Postgres function name inside our schema — **it appears nowhere in the contract**, so nothing on a consumer's side can detect a bump. The versioned name makes divergence *diagnosable after the fact*; it does not prevent it.

⚠️ **The failure MAY be invisible, and exact-match agreement is ALWAYS at risk.** For the whitespace defects actually observed here, `pg_trgm` tokenises whitespace away so trigram search kept working and nothing looked broken. ⚠️ That is not general: a transliteration or token-boundary change WOULD alter trigram results too. The reliable statement is the narrower one — **every fold change threatens exact-match agreement (dedupe, the exact-match-only legacy backfill), and some fold changes will not show up in search at all.**

Three commitments:

1. **Announce a fold change BEFORE deploy, never after** — a hard release condition, not a courtesy.
2. 🔒 **Carry the fold identity in the import/pull handshake**, with a mismatch as a **HARD FAILURE**, not a warning. This is the one that **detects** divergence mechanically; the other two are discipline, and discipline is what failed twice in this workstream already. ⚠️ It does not *prevent* a bad deploy — it stops an exchange after the fact, which is why the announce-first condition stays. Design it into the contract below rather than retrofitting it.

   🔒 **ONE COMPOSITE IDENTITY, derived — never a literal, never a bare name.** Closed design:

   ```sql
   WITH defs AS (
     SELECT string_agg(md5(pg_get_functiondef(sig::regprocedure)), '|' ORDER BY ord) AS d
     FROM unnest(ARRAY['public.catalog_fold_v1(text)',
                       'public.catalog_fold_arr_v1(text[])',
                       'public.f_unaccent(text)']) WITH ORDINALITY AS t(sig, ord)
   ), dict AS (                                        -- 🔒 THE EXACT DEPENDENCY, not a template scan
     SELECT 'public.unaccent:' || coalesce(d.dictinitoption,'') || ':'
            || tn.nspname || '.' || t.tmplname AS k
     FROM pg_ts_dict d
     JOIN pg_ts_template t ON t.oid = d.dicttemplate
     JOIN pg_namespace tn ON tn.oid = t.tmplnamespace
     WHERE d.oid = 'public.unaccent'::regdictionary
   ), ext AS (SELECT extversion AS v FROM pg_extension WHERE extname = 'unaccent'),
      probes AS (
     SELECT string_agg(public.catalog_fold_v1(s), '|' ORDER BY ord) AS p   -- 🔒 SCHEMA-QUALIFIED
     FROM unnest(ARRAY['Château Margaux','Grüner Veltliner®','Cuvée № 5','Straß','Œnologie','Ølgod',
                       E'a  b', E'a\tb', E'a\u00a0b', E'a\u200bb', E'a\u200cb', '  x  ']
                ) WITH ORDINALITY AS t(s, ord)
   )
   SELECT 'fold1:' || md5(defs.d || '~' || ext.v || '~' || dict.k || '~' || probes.p)
   FROM defs, ext, dict, probes;
   -- ours, 2026-07-26: fold1:aff3f19f44ae1df7010843bf278b05cb
   ```

   Six design points, each closing a measured hole:

   - **Composite, not the wrapper alone.** ⚠️ **Measured: replacing `f_unaccent` left `md5(prosrc)` of `catalog_fold_v1` BYTE-IDENTICAL** (`b2c78d…` before and after). A wrapper hash cannot see its own dependency, so identical hashes could have produced different folds. ✅ **Then confirmed in the wild, which is stronger than the demo**: on first exchange the two sides disagreed (`aff3f19f…` vs `187f0d75…`) and decomposition isolated it to `f_unaccent` alone — theirs was one padded line, ours newline-plus-two-space-indent. Identical behaviour, different text, **`catalog_fold_v1` byte-identical throughout**. A single-function identity would have reported agreement. Realigned byte-for-byte; both sides now derive `aff3f19f44ae1df7010843bf278b05cb`.
   - **`regprocedure`, never `proname`.** ⚠️ **Measured: with a `decoy.catalog_fold_v1` present, a `proname` filter returns 2 rows.**
   - 🔒 **The PROBE CALL is schema-qualified too.** ⚠️ **Measured: with `search_path = decoy, public`, an unqualified `catalog_fold_v1(s)` resolved to the decoy and returned `'evil'`, changing the identity** (`a8870ae2…` vs the correct `a07363…`). Resolving the *definitions* unambiguously is not enough if the *probe invocation* is still search-path dependent — a hole the first version of check 3 could not see, because it never hijacked the path.
   - **`pg_get_functiondef`, not `prosrc`** — covers signature, return type, volatility, `STRICT`, `PARALLEL SAFE`. A body-only hash misses an attribute change that alters behaviour.
   - 🔒 **The dictionary lookup names the EXACT dependency** — `d.oid = 'public.unaccent'::regdictionary`, never a scan for dictionaries using the unaccent *template*. ⚠️ **Measured: an unused `decoy.unaccent` dictionary elsewhere in the database changed the identity while the fold was untouched** — a spurious hard-fail on a handshake whose whole point is that a mismatch blocks. The `regdictionary` cast also hard-errors if the dictionary is missing, which is the correct outcome. The template's qualified name and `dictinitoption` are serialized into the value.
   - 🔒 **Dictionary CONFIGURATION, not just extension version.** ⚠️ **Measured: pointing the `unaccent` dictionary at a different rules file changed the fold while all three function definitions AND `extversion` stayed byte-identical.** `pg_ts_dict.dictinitoption` is what moves (`rules = 'unaccent'` → `rules = 'verre_alt'`), so it is part of the identity.

   ⚠️ **THE PROBES ARE A FINITE SAMPLE, NOT A PROOF — and this was measured, not assumed.** In the dictionary-swap test above the rule added was for `Å`, which **none of the 12 probes contains**: a probes-only identity returned the ORIGINAL baseline `eef4d274…` and **missed the change entirely**. The dictionary component is what caught it. So:
   - **Source + dictionary hashes** are the load-bearing components — they cover *any* change to code or dictionary configuration.
   - **The probe vector is a cheap belt** against a behaviour change that somehow leaves both unchanged. It proves the sampled inputs agree; it does **not** prove the folds are equivalent.
   - An unprobed character whose behaviour changes without touching a definition, `extversion`, or `dictinitoption` would still slip through. Accepted: that requires an in-place edit of the rules file itself. **If that risk matters later, fingerprint the rules artifact** (e.g. a checksum of the file) rather than widening the probe list, which cannot close a gap of this shape.

   🔒 **Exactly ONE value on the wire. A mismatch — or any component missing — is a HARD FAILURE**, never a warning or a degraded mode.

   ⚠️ **"Cannot compute one at all" is the SAME failure as "computes a different one"** — recorded from how this actually failed in practice. `::regprocedure` **errors** when the function is absent, which is what the maintenance side hit before they had created `catalog_fold_arr_v1`. So the handshake must treat *missing or unparseable* identically to *mismatched*: **never absent-so-skip**, or a side that never created a component negotiates its way past the check. The strict cast is the desired behaviour, not an inconvenience.

   🔒 **The array helper is CONTRACT SURFACE even where it backs no column.** The maintenance side initially argued `catalog_fold_arr_v1` should stay off the wire as prod-internal, then reversed: scoping the identity to "functions both sides happen to have" makes it **negotiable per deployment**, which defeats a single opaque comparison. It is on the wire regardless of who calls it; their side has created it byte-identical, currently backing no column.

   🔒 **The handshake SUPPLEMENTS the `_v2`-plus-column-rewrite rule; it does not replace it.** The handshake detects divergence between two systems; the rewrite is what makes a deliberate change correct on ours. Both are required.

   **Adversarial checks, measured against a clean PG 17 migration** (baseline `fold1:aff3f19f44ae1df7010843bf278b05cb`):

   | # | Mutation | Result |
   |---|---|---|
   | 1 | `f_unaccent` body changed | **DIFFERS** |
   | 2 | `catalog_fold_arr_v1` changed | **DIFFERS** |
   | 3 | `decoy.catalog_fold_v1` + `search_path = decoy, public` | **SAME** — qualification holds |
   | 3c | …same, but with the probe UNqualified | **DIFFERS** `a8870ae2…` — the hole, reproduced |
   | 4 | Cosmetic reformat, identical output | **DIFFERS** — intended |
   | 5 | Dictionary `RULES` swapped; defs + `extversion` byte-identical | **DIFFERS** — caught by the dict component |
   | 5b | …same, with the dict component removed (probes only) | **SAME as baseline** — probes missed it |
   | 6 | Unused `decoy.unaccent` dictionary added | **SAME** — no false positive |
   | 7 | `public.unaccent` dropped | **hard ERROR** — missing component fails loudly |

   **Opaque, not structured/semver** — agreed both sides, and for a stronger reason than avoiding interpretation: **a fold has no compatible-change class.** Any change altering output for any input breaks stored values on both sides; any change that doesn't isn't a semantic version. There is nothing for structure to express.

   ⚠️ **Two senses of "change", kept distinct.** A cosmetic edit is **not a semantic version change** (output identical, no column rewrite owed) but it **does** break the **byte-identity contract** and so fails the handshake — by design. Byte-identity is already the rule on both sides (the maintenance-side migration reads *"VERBATIM from the app's migration — do not tidy it"*). Cost of that failure: a loud block and an hour diffing two bodies. Cost of the failure it replaces: silent catalog divergence.

   **Blast radius of a `_v2`, measured against `information_schema` rather than estimated** — **five generated columns, all on `producers` and `wine_products`**: `producers.name_folded`, `producers.region_folded`, `wine_products.name_folded`, `wine_products.region_folded`, `wine_products.grapes_folded`.

✅ **`wine_vintages` is NOT exposed** — it has no folded column at all, deliberately (search never touches vintages; see `20260726090000`). So a bump rewrites the **~320k searchable rows**, not the ~2.15M vintage rows. ⚠️ An earlier claim in this workstream said a bump would drag `wine_vintages` too — **wrong by ~7×**, caught by the data side. The conclusion is unchanged (before the fill is far cheaper than after) but the cliff is smaller than stated, which matters if the number is used to force a decision.


This is a **second migration phase**, not pure application code: service principals, import sessions/batches, ACK state, the purge ledger, and durable rescan work all require structural tables.

**Auth.** Catalog import/pull routes are **strictly bearer-only — no cookie fallback, no `resolveUser` call.** Once a bearer credential authenticates, CSRF is structurally irrelevant because the credential is not ambient. Note `lib/csrf.ts` already returns true for a genuinely-missing `Origin` (server-to-server callers pass today), so no exemption is needed — and 🔒 **do not tighten `isSameOrigin` globally here**: native auth is cookie-based and may legitimately omit `Origin`. Broader CSRF tightening is a separate cross-cutting review, not a rider on this phase.

**The contract**, per the RFC ruling 2: bearer service principal with narrow `catalog.pull` / `catalog.import` scopes resolving to a synthetic identity — never a user row, never escalatable into a session. Session OPEN declares expected counts by entity type; the single-flight lock lives on the session. One transaction per batch, all-or-nothing. The ACK commits in that same transaction and is readable by `GET`.

**Idempotency is keyed on `(sessionId, batchIndex)`, with the manifest hash stored and compared** — same/same replays the original ACK, same key with a different hash is a 409. Keep the **monotonic cycle sequence separate** from `(sessionId, batchIndex)`: the cycle sequence orders *sessions* against replay, the batch index orders *batches within* one session. Collapsing them into one "sequence" (as an earlier draft did) makes neither job well-defined.

**Finalize** verifies declared-vs-applied counts **exactly**, rejects a session with missing or extra batches, is idempotent, and **closes the session against later writes** — a closed session accepts no further batches.

### Exactly one lead

🔒 **This invariant needs three pieces, and the third is the one that gets skipped** — because the partial unique index *looks* like it covers the whole thing and doesn't. All three verified against Postgres 16:

1. **At most one:** `UNIQUE (product_id) WHERE role = 'lead'`. The composite PK on `(product_id, producer_id)` does **not** substitute — verified: it blocks duplicate pairs while allowing two different producers both marked `lead` (a test insert produced 2 leads on one product).
2. **At least one at creation:** product + lead link in one transaction; an import batch carrying a new product carries its lead row (below).
3. **At least one over time:** the first two hold only at creation. Afterwards, **deleting the sole lead OR demoting it `lead → collaborator`** leaves zero leads with nothing objecting. The demotion path is the easier one to miss — nothing is deleted, so a delete-focused guard never fires. Reject both; make replacement atomic.

⚠️ **`at least one` cannot be a declarative constraint.** "At least one child row exists" isn't expressible in Postgres — no `CHECK` can see other rows, and the partial unique index only bounds the upper side. So piece 3 lives in the write path or in a deferred trigger, and the index's existence must not be mistaken for coverage.

**RESOLVED at the phase-1 review: the `INITIALLY DEFERRED` trigger shipped** (Simon, 2026-07-24) — only that route lets the invariant be claimed as *database*-enforced, and it covers the phase-4 import path for free. The comparison is kept because the requirements in the right-hand column are what the shipped triggers must keep satisfying, and the ordering traps below still bind every caller:

| | Write-path enforcement | Deferred-trigger enforcement |
|---|---|---|
| Needs | **One mandatory helper** every link mutation routes through (the `mutateWines`/`identityStore` chokepoint pattern); **final-state validation** after the mutation, not per-statement; **product-row locking** so two concurrent edits can't each see a lead that the other is removing | `INITIALLY DEFERRED` (an immediate trigger blocks the legitimate swap); covers **deletion and demotion**; **permits product purge** when the parent product is deleted in the same transaction — otherwise the invariant blocks its own cleanup path; and covers **parent creation** too if the invariant is to be claimed as database-enforced |
| Costs | Discipline plus a CI gate to keep it the only path — bypassable by construction | More SQL, and the purge/creation carve-outs are easy to get subtly wrong |
| Gives | Clear error messages, testable in isolation | Genuinely unbypassable, including by a future path nobody remembered |

Note the asymmetry: only the trigger route lets us *say* "database-enforced". A write-path helper is enforcement by discipline, which is what the CI gate on `lib/identityStore.ts` exists to convert into something closer to structural.

Two ordering traps, both verified:

- **The prohibition is on separate transactions, not statement order.** With an *immediate* partial unique, promoting the new lead first **fails** — the old lead still exists (verified: `duplicate key value violates unique constraint "pp_one_lead"`). So within one transaction: remove or demote the old lead **first**, then either **insert a new link** or **promote an existing collaborator** to lead. The transient zero-lead state is invisible outside the transaction, and a failure rolls the whole swap back.
- ⚠️ **Replacement is not always an insert.** If the incoming lead is already a collaborator on that product — the common promotion case — inserting a second `(product_id, producer_id)` row **fails the composite PK** (verified: `duplicate key value violates unique constraint "pp_pkey"`). It must be an `UPDATE … SET role = 'lead'` on the existing row (verified to succeed). A replace path that only ever inserts is broken for exactly the case most likely to occur.
- **If piece 3 is enforced by a trigger, it must be `INITIALLY DEFERRED`.** An immediate trigger fires on the delete/demote and blocks the legitimate swap before the replacement is inserted.

🔒 **A new product must carry its lead producer link in the same transactional envelope as the product row.** The RFC requires every product to have exactly one `lead` (§ v1 data model), enforced for the at-least-one half by committing product + lead link together — which independent per-batch transactions would break, leaving a lead-less product visible between batches. So a batch containing a new product carries its `product_producers` lead row in that batch, or the import stages rows and links them at finalize. A batch that would commit a product without its lead is rejected.

**Batch ceiling: 1,000 rows AND 5 MB, whichever binds first, enforced server-side as a 413.** Both limits, because row size varies sharply by entity type — a batch of vintages is tiny, a batch of products with long text is not. Server-enforced so the caller cannot construct a batch that times out mid-apply. Throughput is not the constraint; the initial fill does not go through this endpoint.

**Fact rules, enumerated and enforced server-side at apply time** (never delegated to the caller's read-before-write, which a curator edit landing mid-flight would silently revert):

- **Scalar facts: per-field `COALESCE(existing, incoming)`** — existing non-null values are never overwritten.
- **Array facts (`grapes`) are the exception: an empty array is missing, so `{}` IS overwritten** by a non-empty incoming value (`CASE WHEN cardinality(existing) = 0 THEN incoming ELSE existing END`). ⚠️ **PRODUCT GRAIN ONLY.**
- 🔒 **Vintage grapes follow the OPPOSITE rule, and conflating them would destroy data.** `wine_vintages` carries `grapes` + `grapes_override` (`20260726090000`). When `grapes_override` is **true**, the array is an ASSERTION — including `{}`, which means "this vintage genuinely has none listed" — and import must **never** fill it, exactly as it never fills a curator-locked field. When the flag is **false** the row is inheriting and its array is empty by CHECK, so there is nothing to fill either. Net: **import never writes vintage grapes as an enrichment**.

  🔒 **The transition matrix is the contract** — "an explicit override update" was undefined and unimplementable:

  | Existing | Incoming | Result |
  |---|---|---|
  | `override=false` | `override=true` + grapes | Set both — unless curator-locked |
  | `override=true` | anything | **Never** overwritten automatically |
  | any | `override=false` | No enrichment; array must be empty |
  | any | `override=true`, grapes **omitted** | **Reject** — omission must not become "genuinely none" |
  | any | `override=false`, grapes non-empty | **Reject** — the CHECK forbids it |

  The first row is what lets a vintage discovered after its row exists acquire its real composition; the fourth is what stops an omitted field silently minting a false known-empty assertion. The product's enrichable-`{}` rule above does not carry down a grain. See § Arrays are non-null — `{}` is the only representation of unrecorded, so the scalar rule would freeze every grape-less row permanently. **Wire normalization — `wine_products` ONLY:** a missing or null incoming product `grapes` normalizes to `{}` at the boundary, so the apply step never sees null for a non-null column. ⚠️ **This does NOT extend to `wine_vintages`.** There, a missing `grapes` alongside `grapes_override = true` is a **reject** (matrix row 4) — normalizing it to `{}` would manufacture a "genuinely none" assertion the caller never made. Same wire field, opposite handling, because the two grains give `{}` different meanings.
- Curator-locked fields are skipped *even for the fill* — including a locked `{}`, which **on `wine_products`** is the only way an empty array becomes authoritative. ⚠️ **On `wine_vintages`, `grapes_override = true` is a second route** and needs no lock: the flag makes the array authoritative *including* `{}`. Import never enriches an overriding vintage at all (§ Fact rules matrix).
- **On insert the server assigns `status = 'confirmed'` and `linksTo = null` itself.** Neither field is accepted from the caller on insert, and neither is ever updated by import afterwards. (Seed rows land `confirmed` per RFC § Seed; lifecycle transitions are staff actions.)
- Purged IDs are never re-insertable.
- Finalize **enqueues** the post-import rescan — the finalize ACK means "batches applied", never "rescan done".

🔒 **The finalize rescan must be durably scheduled.** This repo has **no general-purpose queue** (no bullmq/pg-boss/graphile; the only async primitives are Deplo.io `scheduledJobs` and `prisma/maintenance/*.sql`). So finalize writes an outbox/status row that a scheduled worker drains — never a fire-and-forget promise, which dies with the request.

### EAN conflict → deferred

**The ACK marks a product as `deferred` when one of its EANs conflicts** — by product identity, not merely a conflict count. The caller's journal is per-entity with no way to express "product applied except one EAN", so it withholds that product's journal entry and re-sends next cycle; a count alone wouldn't tell it *which* products to withhold, and it would advance a hash for something that didn't fully apply and never retry.

Three things this needs to be well-defined, all of them absent from the first draft:

- **The product and its other facts DO commit.** Only the conflicting EAN link is withheld. The batch is not rolled back — an unrelated barcode collision must not block a legitimate product update, and the caller's re-send is idempotent against the already-applied facts.
- **The conflict becomes a durable staff-review item**, written in the apply transaction — not merely a line in a response the caller may never read again. It records the EAN, the incoming product, and the product currently holding it. Resolution is a staff action (re-point, reject, or purge), consistent with "an already-assigned EAN is never automatically reassigned".
- 🔒 **Retry terminates on resolution, and a deferral is idempotent until then.** Re-sending an unresolved conflict returns `deferred` again *without* creating a duplicate review item (keyed on `(ean, incomingProductId)`); once staff resolve it, the next cycle applies cleanly and the caller's journal advances. Without this the loop is silent and permanent: the caller re-sends every cycle, the server re-detects every cycle, and nothing ever surfaces for a human.
- 🔒 **A `rejected` resolution is terminal and must be persisted as such.** The three staff resolutions are not symmetric: re-point and purge *change the data*, so the next retry simply succeeds — but **rejecting the proposed EAN leaves the conflict exactly as it was**, so a naive implementation returns `deferred` forever and the caller can never advance. So a rejection is stored as a durable terminal verdict on `(ean, incomingProductId)`, and subsequent retries return an **acknowledged rejection** — distinct from `deferred` — which tells the caller to advance its journal *without* attaching that EAN. Re-proposing the same pairing later is a no-op, not a fresh review item; a staff member can clear the verdict if they change their mind.
- 🔒 **A verdict-cleared event carries the composite key `(ean, incomingProductId)` — never the EAN alone.** The verdict is per-pairing: the same barcode may be rejected for product X and later legitimately proposed for product Y. An EAN-only event doesn't say *which* product's journal entry to invalidate, and invalidating every product that ever proposed that EAN would re-send rows whose verdicts still stand. Minimum payload is the affected incoming product; the full composite is preferable.

Documented upgrade if EAN conflicts turn out common rather than rare: per-EAN outcomes in the ACK plus a journal identity for EAN rows, making retry precise instead of whole-product. Not built now.

**Import never deletes** (RFC § Catalog maintenance).

### The pull leg

🔒 **`(updatedAt, id)` keyset does not fit every exported table, and cannot express deletion at all.** It works for the three entity tables (`producers`, `wine_products`, `wine_vintages`). It does not work for:

- **`product_producers`** — a composite-key join row with no `updatedAt`. A lead re-point or a removed collaborator is *invisible* to a keyset walk: nothing on any row's timestamp changes in a way the cursor can see, and a deleted join row has no row left to return.
- **`product_eans`** — keyed by EAN, not by our nanoid. An EAN re-pointed to a different product is a change to *which* product holds it; a walk ordered by entity id can't express that either.

So a keyset-only pull silently omits exactly the changes that matter most for identity — collaborator sets and barcode ownership. **The resolution is a unified change journal** carrying `(sequence, entityType, entityKey, operation)`, where `operation` covers insert / update / re-point / delete and `entityKey` is per-entity-type (nanoid for entities, the composite pair for join rows, the EAN for barcodes). The journal is the only mechanism that handles all five tables uniformly, expresses deletion, and earns the word "snapshot".

The per-table alternative — separate snapshot/cursor rules for each table, plus a tombstone row for every deletable join — is strictly more machinery for strictly less capability. **Recommendation: build the journal, not five cursors.** It is a phase-4 structural table, which is why phase 4 is a migration phase.

#### The journal sequence must be commit-ordered, not merely generated

🔒 **A plain `bigserial`/sequence is NOT sufficient, and using one produces a journal that looks correct while silently losing events.** Sequence values are assigned at INSERT time, not commit time, so:

1. Transaction A appends its event, receives sequence 10, and pauses (slow work, lock wait, anything).
2. Transaction B appends, receives 11, and commits. The pull consumer reads through 11 and advances its cursor.
3. A commits afterward. Event 10 is now **permanently behind the cursor** and will never be read.

The consumer did nothing wrong — it read in sequence order and advanced — which is what makes this failure quiet. Four requirements close it:

- **Every pull-visible mutation appends its journal event in the same transaction as the domain change.** An event written in a separate transaction can be lost, duplicated, or ordered independently of the change it describes.
- **Journal numbering is serialized in commit order** — a transactionally-held counter or an advisory lock taken for the append, so numbers are handed out in the order transactions actually commit. Not a plain sequence.
- **Initial synchronization establishes a consistent baseline plus a journal fence.** A journal is a change *feed*; it becomes a snapshot only when anchored to a known starting state. The baseline is taken once and the fence records the sequence it corresponds to.
- 🔒 **Every write path uses it — no exceptions.** Imports, user-minted catalog rows from the add-flow, curation edits, merge/unmerge, producer-link edits, EAN conflict resolutions, and purges. A single mutation path that skips the journal reintroduces exactly the silent-omission class the journal exists to eliminate, and it will be invisible in testing because the affected rows simply never appear.

⚠️ **Phase consequence:** that last requirement spans phases. The journal is a phase-4 table, but the write paths it must cover are built in phases 2 (add-flow) and 3 (merge/curation) — so phase 4 retrofits appends into code that already exists. Two ways to pay for it, and the choice belongs to whoever starts phase 2: route every catalog mutation through **one internal write helper** from the start, so phase 4 adds the append in a single place; or accept the retrofit and audit every mutation site when the journal lands. The helper is cheaper and turns "did we cover every path?" from an audit question into a structural one — the same reasoning as the `mutateWines` and `lib/identityStore.ts` chokepoints elsewhere in this codebase.

🔒 **Until the journal exists, pull is best-effort: incomplete for entity rows and blind to join-row and EAN changes. It must not be treated as authoritative for completeness.** Note that **import re-sending does NOT provide the recovery mechanism** — an earlier draft claimed it did, and that is wrong: re-send pushes the caller's rows *to* prod, whereas a missed row is one prod never handed *out*. The directions are opposite and nothing on the push side can recover a pull-side omission.
- **An explicit field allowlist** crosses the interface, **enumerated per entity** — not "everything on the row minus a denylist", so a future column is excluded by default rather than leaking the moment it is added. The enumeration lands with the phase-4 endpoint. 🔒 **Never included: user identity (`addedBy`/`curatedBy`), ratings, staff data, audit rows, and `scope`-restricted (`owned`) entries.** The catalog facts go out; who touched them does not.
- **Purge events key on `(entityType, entityId)`.** Prod keeps its own persistent purge ledger that both emits these events and rejects local resurrection of a purged ID.
  - 🔒 **PRECONDITION ON THIS PHASE: seed the manual-deletion ledger into the purge ledger BEFORE accepting any import session or establishing the initial baseline/fence.** `docs/dev/catalog-manual-deletions.md` is the append-only record of catalog rows deleted by hand during the correction-channel window (the accepted gap between the fence opening and this phase existing — see `wine-catalog.md` § Seed + the truncate fence). Those deletions fired outside the application write path, so **no change-journal event exists for them**, and absence is never read as deletion. Required order: (1) idempotently seed every `applied`, unreconciled entry into the persistent purge ledger; (2) let that ledger emit the deletion; (3) reject any later import carrying a seeded id; (4) mark the file entry `reconciled` only after the durable seed succeeds. ⚠️ **Emitting to a deletion feed is not sufficient** — an import arriving first could recreate the row, which is why this is a precondition on baseline creation rather than a post-import cleanup. Note the database does not always prevent the original delete: `product_producers.product_id` is an intentional `Cascade`, so a product referenced only by its join rows deletes successfully.

## Phase 5 — Legacy backfill + product pages

The exact-match-only backfill of RFC § Legacy backfill — the sole exception to "links are never set by strings", never fuzzy, with the unmatched remainder feeding the provisional review path. Plus the reusable UI from `feature/wine-product-pages` (local and on origin): the web product page, the aggregate query re-pointed at vintage→product roll-up with transitive `linksTo` resolution, and the mobile screen.

## Owed tests — and WHEN each must happen

Both were identified during the phase-2 review and deliberately deferred. Neither blocks the phase-2 merge (creation is gated off, so no user reaches these paths); both block later milestones, so the timing is recorded rather than left to memory.

| Test | Must happen BEFORE | Why then |
|---|---|---|
| **Interleaved concurrent-PATCH** | `CATALOG_PUBLIC_ENABLED` opens — i.e. with the model-change phase, not phase 3 | Two users editing one wine concurrently is only reachable once people can actually link wines. The rule is implemented and unit-tested (`applyIdentityEditRule` + the `linkIsDeliberate` splice), but never driven through two real overlapping requests. ⚠️ The interleaving must be forced at a real synchronisation point — a `sleep`-based race that happens not to collide passes for the wrong reason. |
| **1M-row load test** (p50/p95/p99, errors, DB CPU/IO, pool queue time) | the FIRST CATALOG FILL | Every scale step so far has changed a conclusion: 60k was fine, 300k exposed the linear-candidate problem, 500k exposed the equality plan. The fill is the first time real volume exists, so measuring after it is measuring an outage. ⚠️ Run against **staging, not a dev sandbox** — absolute numbers do not transfer across CPU, disk, and a managed Postgres with its own `max_connections`. Budget for a fix, not just a measurement. |

Related, and cheap to fold into the load test when it runs: `DATABASE_CONNECTION_LIMIT` / `DATABASE_POOL_TIMEOUT` / `DATABASE_STATEMENT_TIMEOUT_MS` are opt-in and currently unset (`docs/dev/deployment.md`), so the load test is also where their values get chosen rather than guessed.

## 🔒 RULED: the per-event fields move OFF `wines` (own phase, plan first)

**Decision (Simon, 2026-07-25).** The intended end state is that a rating carries the EVENT (who, which session, their photo, score, notes) and links directly to the catalog — the per-event columns currently on `wines` (`session_id`, `added_by_identity_id`, `added_by_display_name`, `image_url`, `revealed_at`) do not stay there. This REVERSES the RFC's two-grain split, which kept a `wines` row per bottle-per-tasting.

**Sequencing ruled: merge phase 2 as-is, then do the model change as its own phase, PLANNED FIRST.** Nothing in phase 2 makes the change harder — the `wines.productId`/`vintageId` link columns and the add-flow survive it; the per-event fields simply relocate. Halting phase 2 would discard finished, reviewed work for no gain.

**Scope measured at decision time:** only two FKs point at `wines` (`ratings.wine_id`, `bookmarks.wine_id`), but dozens of files reference it (43 touch the table directly; 148 mention "wine" in some form). The schema move is small; the code surface is not. Cheapest while every `wines.product_id` is NULL — which is true today. ⚠️ **NOT while "the catalog is empty"**: the ruled execution order puts the fill BEFORE this phase, so the catalog is populated by the time it runs (same correction as `wine-catalog-model-change.md` § Why now). The `product_id`-is-NULL and code-accretion arguments carry the timing on their own; catalog emptiness never did.

### ✅ PLANNED — see [`wine-catalog-model-change.md`](wine-catalog-model-change.md)

**The plan is written and review-approved** (three Codex rounds; seventeen findings, all verified against the code and resolved). It is the spec-of-record for this phase. Not started — no code, no schema.

Both questions this section raised are answered there:

1. **"Unmatched" is resolved by removing the case.** Minting a catalog entry requires producer + name + type, and every wine on a table gets an entry — because the *only* way to add one is to pick an existing entry or mint a new one. Anonymous users may pick but never mint (server-enforced), so the vague-entry path closes rather than being tolerated.
2. **The fence collision is resolved by ruling the fence comes down first.** `CATALOG_PUBLIC_ENABLED` opens **before** phase 3's review queue exists (Simon, reversing the earlier phase-2/3 boundary) — the volume is negligible at current scale, and waiting for a full curator UI to collect a few dozen wines is cost for no benefit. Entries minted in that window are still `provisional` and still queued; the queue must *record* them from day one even though nobody can act on them yet.

**The model in one line:** the catalog is identity; a new **occurrence** row is one encounter with one bottle (session *or* standalone check-in); a rating references its occurrence and derives catalog identity through it; bookmarks point at product + optional vintage.

⚠️ **Two consequences that reach beyond this phase**, both detailed in the proposal:
- **Persistence changes shape.** A session is Redis-only until a registered user joins, then promotes one-way to Postgres-authoritative under an advisory lock. Root `CLAUDE.md`'s "anonymous sessions stay Redis-only" stays true; the promoted case is new.
- **The native app takes a hard cutover.** Bookmark endpoints change identity, so the version gate must cover the changed endpoints before deploy — a release condition, not owed work.

## Queued next (2026-07-25)

Three items sequenced after phase 2, in dependency order. None is started; recorded here so the ordering and the blocking relationship are explicit.

0. 🔒 **`VACUUM ANALYZE` the catalog tables is an EXPLICIT STEP of the first fill, not an afterthought — and `ANALYZE` alone is NOT enough.** Re-validated against the shipped GiST + covering-B-tree design (the original rationale here was about a GIN pending list, and GIN is gone):
   - **The reason is the VISIBILITY MAP, not statistics.** An *index-only* scan can only skip a heap fetch for pages the visibility map marks all-visible, and only `VACUUM` builds that map. ⚠️ **The PLAN SHAPES below are the durable finding; the timings are fixture-specific** (one 60k table, one machine) and an independent run reproduced the same three plans with different absolute numbers. Do not quote the milliseconds as a target. Measured on a freshly bulk-loaded 60k table, the exact-name equality query planned: **no vacuum** → a Bitmap scan examining all 60,000 `producers_status_idx` entries; **`ANALYZE` alone** → a GiST index scan, still avoiding the covering index; **`VACUUM ANALYZE`** → the intended **Index Only Scan with 0 heap fetches**. The gap is large enough to matter on the query the phase-5 legacy backfill depends on, and it is the plan regression — not a particular latency — that this step exists to prevent.
   - **GiST KNN search is unaffected** — measured 0.4 ms unvacuumed, so ordinary catalog search does not need this. The equality path does.
   - So the fill runbook ends with `VACUUM ANALYZE producers; VACUUM ANALYZE wine_products; VACUUM ANALYZE product_producers;` before the catalog is considered live. ⚠️ `gin_clean_pending_list()` no longer applies to anything — there are no GIN indexes on the catalog tables. Autovacuum reaches this state eventually; "eventually" is not a launch state.

1. **Legal attributions surface — 🔒 BLOCKS THE FIRST CATALOG FILL, and it is a LICENCE OBLIGATION, not a courtesy.** A config-driven attributions/legal page, live in **both** the web app and the native app, rendering entries supplied as **deploy configuration** rather than hardcoded. Some licences the catalog relies on **legally require naming the source**, so shipping catalog data without this surface is a licence breach — which is what makes it a hard release gate on the initial seed rather than a phase-4 nicety.
   - 🔒 **Attribution is CORPUS-level, never per-record.** Naming sources on this surface satisfies the licence; attaching a source id/URL/slug to a catalog row does not, and is separately forbidden (RFC § Data-provenance rule, as scope-corrected). Config shape follows from that: a list of `{ source, licence, url }` entries describing the CORPUS, with no join back to individual rows.
   - Because the entries are deploy configuration, adding or changing a source is an ops change, not a release — which is the point, since licence terms can change independently of the app.
2. **Service principal for the catalog-maintenance tooling.** A rotatable credential with narrow `catalog.pull` / `catalog.import` scopes. 🔒 **Explicitly NOT a staff role** — `staff_roles` covers humans, and machine maintenance must never impersonate one (RFC § Catalog maintenance: "never a human user or admin role"). On CSRF, see § Phase 4 § Auth, which is the decision of record: `lib/csrf.ts` already returns true for a genuinely-missing `Origin`, so **no exemption is required** — what the threat model has to settle is whether a bearer-only route should call `isSameOrigin` at all, given it is a no-op for the intended caller and would reject a legitimate proxy that injects an `Origin`. 🔒 `isSameOrigin` must not be tightened globally as a rider (native auth is cookie-based and may legitimately omit `Origin`).
3. **The import/pull endpoint.** Contract is § Phase 4 above.
   - 🔒 **Size the import path for BATCH COUNT, not row count** (data side, 2026-07-26). Measured shape of the first fill: ~54k producers, ~265k products, ~265k product-producer links, **~2.15M vintages** — about **2,700 batches** at the 1,000-row ceiling. Two consequences: (a) the SEARCHABLE tables stay near 320k rows, comfortably inside what has been load-tested, so search risk is low; (b) the vintage table **dominates import cost while never being searched**, so batching, resume and ACK overhead is driven by a table that carries no query load. Optimising the import for search-table size would be optimising the wrong thing.
   - 🔒 **TWO YEAR BOUNDS EXIST, AND THEY MUST NOT BE ALIGNED** (2026-07-26). `validateYear` bounds at `1900 .. currentYear + 1`, evaluated **at call time**. The import contract bounds at `1900 .. ACQUISITION_YEAR + 1`, a constant **frozen per import batch**. Same shape, different clock, both deliberate. ⭐ The general rule, worth reusing anywhere a normalizer has a range: *a bound that moves with the wall clock makes a normalizer whose output depends on when it ran.* A frozen bound guarantees the same input bytes normalize identically forever, so a re-run years later reproduces today's value; a call-time bound cannot promise that, and does not need to, because it gates a decision rather than fixing a value. 🔒 **The divergence is one-directional and therefore safe:** the import contract admits a SUBSET of what promotion accepts, so no import can fail promotion on this rule. It is deliberately NOT symmetric — a user-entered 2028 is legitimate at encounter grain in 2028 and is not something a frozen-clock import could carry. **Recorded so nobody re-derives it:** through 2026 both read `1900..2027` and agree exactly; from 2027-01-01 the call-time bound widens and the frozen one does not. That is not drift.
   - ⚠️ **IMPORTED PRODUCERS ARE NOT FINAL — `confirmed` means "we believe this", not "this is settled"** (2026-07-26). Two producers identical by name and country can be *different companies*, and the import contract states this is a recurring class rather than a tail case: enough records that producer merges are a steady workload, not an occasional event. Cases detectable by mechanical rule are resolved before import, so what arrives is the residual that no cheap rule catches — which means arriving records are not low-confidence, they are records where the cheap checks already passed and a human is the remaining instrument. ✅ **Verified against this tree — all three requirements already hold, no code change needed:** `linksTo` is a plain nullable self-FK (`schema.prisma`) with **no origin and no status predicate anywhere** in schema or `lib/`, so imported rows are in merge scope by construction; `confirmed` is never treated as terminal — it appears in four code paths (`ADD_TIME_STATUSES`, `REVIEW_STATUSES`, the search status filter, and `LINKABLE_STATUSES`) and **every one is an INCLUSION list that treats it identically to `provisional`**; nothing anywhere excludes it from merge, edit or curation; wire format and table shapes are untouched. ⭐ **The one real consequence is phase-3 REVIEW-QUEUE SIZING:** the queue was scoped as "approve or reject user submissions", and a steady *continuous* trickle of producer merges on imported records is a different workload — it argues for merge being a first-class queue surface rather than an occasional curator action. ⚠️ **Honest caveat:** the merge machinery is UNBUILT. `linksTo` exists and tombstone resolution is implemented + tested in the search path (transitive, visited-set, depth-capped), but nothing writes a tombstone yet — that ships with phase 3. "Reachable" today means structurally unobstructed, not exercised.
   - ✅ **RULED (2026-07-26): the post-import rescan is a SECOND query shape in the same module.** It re-runs the suggestion query, which is **KNN top-N** — it ranks and always returns *n* candidates. Bulk duplicate detection wants the opposite: *everything above a threshold*. Shared fold, shared scoring, shared module — separate interactive top-N and bulk threshold queries. Recorded so the rescan is not built on the assumption that the add-time matcher transfers unchanged. Two structural pieces worth restating, because both are easy to get wrong in a way that looks fine:
   - **Pull must be driven by the unified change journal, not per-table keyset cursors.** A `(updatedAt, id)` keyset cannot express `product_producers` changes (composite key, no `updatedAt`, and a deleted join row leaves nothing to return) nor `product_eans` re-points (which change *which product* holds a barcode). See § The pull leg.
   - **An import batch must reject a new product arriving without its lead-producer link in the same batch**, since independent per-batch transactions would otherwise leave a lead-less product visible between batches. The deferred trigger enforces this at COMMIT, so the batch boundary is what has to line up.

## 🔒 PART-OPEN: the add flow has no way to say "non-vintage"

**Raised during catalog review, 2026-07-26. Input-layer destruction fix IN REVIEW; the explicit control is ruled and deferred to the model change (see the phase split below).**

The write path is correct and locked: `year = null` means the NV row **exclusively**, never "year unknown", and an unknown year links at product grain instead. The API honours all three states — `year` absent / `null` / a number.

⚠️ **But no client can produce `year: null`.** There is no control that says "non-vintage" — the vintage input is a free-text field, so the best a user holding a non-vintage Champagne can do is TYPE the token (which the web forms always accepted and the mobile ones did not). That is exactly how the literal `NV` token ends up stored as free text in `wines.vintage`, and why the legacy backfill needs a literal-token case at all.

Consequences while this stands:
- **Blank keeps meaning two different things** — "unknown" and "non-vintage" — which the model deliberately separates.
- **The NV row is reachable by API only**, so no user-driven path can create or select it.

The fix is an explicit NV control beside the year field, sending `year: null` rather than an empty string. Small, but it is a *product* decision about the add form, not a schema one — recorded here rather than assumed.

🔒 **The control is RULED (Simon, 2026-07-26): a checkbox beside the year field.** Ticking it clears and disables the year input, and an info bubble to the right of the "NV" label explains that it means a non-vintage release — a release without a year. A checkbox (not free text) is what lets a client send a real `year: null` instead of a string the server has to parse, and the two states can't both be set.

**Split into two phases**, because the control has no catalog destination until the occurrence row exists (nothing calls `/api/catalog/entries`; the add flow the control would write through is what the model change rebuilds):

- 🚧 **Phase A — IN REVIEW (not merged): stop the destruction.** The free-text vintage string is no longer destroyed by the input layer. `@verre/core` `vintageText.ts` is the one place that knows the rule, shared web↔native: `filterVintageInput` (per-keystroke, lets an NV-token *prefix* through so the token is typeable) + `normalizeVintageText` (boundary: scan result, submit, store write). Its allowlist deliberately matches the backfill's spelling in `wine-catalog.md` § "Token handling" — a case-insensitive EXACT match on four tokens — `NV` / `N.V.` / `NV.` / `non-vintage` — trimmed of surrounding whitespace, with internal punctuation never stripped and never a substring match (`NV Selection` is a wine name). Pinned by `scripts/tests/vintage-text-units.ts` (CI: `check-vintage-units.yml`), which fails against the bare `\D` strip, against substring matching, and against collapsing the typing filter into the boundary normalizer. Fixed surfaces:
  - **Label scanning** (`AddWineModal.tsx`) — the `\D` strip that blanked a scanned `NV`; the extraction prompt now also names NV as an acceptable value. The parsed model JSON is also treated as **untrusted**: it is `Record<string, unknown>`, coerced by `@verre/core` `scanText`/`scanVintage`. The two are deliberately asymmetric — **only `vintage` accepts a number** (and only an exact 4-digit year, 1000..9999; a conventional `"vintage": 2019` previously reached the normalizer as a number and threw, failing the whole scan, while a negative `-2019` would have had its sign stripped and been stored as `2019`). Textual fields accept strings only, since a numeric producer or grape is a malformed response rather than a reading of the label.
  - **Mobile session add *and edit*** (`moments/session/[code]/add.tsx` — ONE component serving both modes via its `mode` prop), **check-in create** (`feed/check-in/index.tsx` + the `rate.tsx` submit), and **check-in edit** (`feed/edit/details.tsx`) — the per-keystroke `\D` strip plus a `number-pad` keyboard that made `NV` literally untypeable. ⚠️ The check-in **edit** surface was the worst of these: it was *destructive*, not merely restrictive — on an existing NV check-in the first text change blanked the vintage (the strip removed every character) and saving then PATCHed the empty value.
  - **Both web forms** (`AddWineModal.tsx`, `CheckinModal.tsx`) — their text inputs never stripped, so `NV` was always typeable there (which is how such rows exist), but their **submit** boundaries sent the raw field. Both now canonicalize, so every official client sends the same form the server stores.
  - 🔒 **Every SERVER persistence boundary** (`lib/session.ts`, `POST /api/checkins`, `PATCH /api/checkins/[id]`) — these previously `.slice(0, 4)`'d, so a direct (non-official) client could persist `N.V.`, a partial year, or `NV S`. The server is the authority; the clients normalize for UX parity, not correctness.
  - 🔒 **The catalog-link comparator** (`applyIdentityEditRule`) — it must model what the write ACTUALLY stores, including type handling. Two measured defects: a `.slice(0,4)` compare cleared a correct link on an edit that only canonicalized (`N.V.` → `NV`), and a `String(v)` coercion kept the link for a NUMERIC `2019` while the write stored `''` (blank vintage, retained vintage-grain link).
  - ⚠️ **The add-vs-edit payload shape.** The mobile session form omitted empty optionals. On ADD that is right; on EDIT an omission means *unchanged*, so a cleared field silently kept its old value — and for vintage the server wrote `''` anyway while the comparator read the omission as unchanged, leaving a blank vintage still linked at vintage grain. An edit now sends every editable field explicitly, empty string included.
  - **Wiring is CI-gated** (`scripts/check-vintage-wiring.mjs`): every required call site is asserted individually, unlisted vintage surfaces are discovered by walking the client trees, and the digit-strip / number-pad patterns are forbidden. ⚠️ The first version asserted only that a file *mentioned* the helper — review proved three bypasses that all passed, because a deleted submit call left the import (and, in `AddWineModal`, the scanner's unrelated call) satisfying it. A file-level mention is not a call site.
- ⏳ **Phase B — with the model change: the checkbox itself.** Lands with the occurrence row, wired to send `year: null` at catalog grain. Until then `year: null` stays API-only and the free-text string is what carries the fact.

⚠️ **Acceptance scope for phase B — every surface with a vintage input, not just one form**: `components/wine/AddWineModal.tsx`, `components/social/CheckinModal.tsx`, and the three mobile screens named above (four surfaces, since the session form serves both add and edit).

🔒 **Related correction:** an earlier note in this workstream described the vintage form as "showing the product's grapes with a change affordance". **That UI does not exist** — it is the intended shape for the vintage-grape override (§ per-vintage grapes), not a description of anything shipped. The API contract is built and tested; every client surface above is unbuilt. Nothing calls `/api/catalog/entries` yet.

## Open inputs

- **Tim's user id** — needed only when the bootstrap grant is actually run, which is a direct-DB `INSERT` per the runbook in `prisma/CLAUDE.md` (there is no seed script and no committed id; prod and local ids differ). Nothing in phase 1 is blocked on it, since no admin surface exists until phase 3. **Tier: `admin`** — Simon and Tim are both DESIGNATED admins (Simon, 2026-07-25, reaffirming the original ruling after the permission map narrowed `admin` to hard-purge and role-granting). Whether the grant has actually been made in a given environment is operational state, not a repository fact — check `staff_roles` in that environment rather than trusting this file.
