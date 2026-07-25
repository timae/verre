# Wine catalog — implementation plan

**Status:** **Phase 1 SHIPPED** on `main` as `4bc14c5` (PR #86, 2026-07-25); phases 2–5 pending. Companion to `wine-catalog.md` (the RFC, spec-of-record for the *model*); this doc is the *build* — phase order, the rulings that unblocked it, and the amendments the plan must carry.

**Starting phase 2?** Read § Phase 2 first — the trigram query form is the thing most likely to be got wrong, and it fails SILENTLY by being slow rather than wrong. Note the GIN `<%` form documented there was **superseded by a GiST KNN order** on scale grounds; the superseded section is kept because its traps still apply to any similarity query. Then `prisma/CLAUDE.md` for the schema invariants Prisma cannot express. Phase 1's branch has been merged and deleted; work from `main` on a new `feature/…` branch.

The RFC's three open decisions are resolved (see its § Open decisions — RESOLVED). This plan absorbs those rulings plus a review pass whose amendments are recorded inline, each at the phase that must honour it.

## Phase order at a glance

| Phase | Name | Ships |
|---|---|---|
| 1 | Domain-schema migration | `staff_roles` + `staff_role_audit`, the four catalog tables, `product_eans`, `wines` link columns, `catalog_audit`, raw SQL |
| 2 | Add-flow + fuzzy search | The five add branches, one `pg_trgm` matcher (GiST KNN), Redis link mirroring |
| 3 | Review queue + merge machinery | Curator surfaces, merge/unmerge, suggestion policy |
| 4 | Integration-schema migration | Import + pull contract, and the tables they need |
| 5 | Backfill + product pages | Legacy exact-match backfill, reusable UI from `feature/wine-product-pages` |

**Release boundary — phases 2 and 3 go public together.** Phase 2 is implemented and tested independently, but public catalog creation stays disabled until phase 3's reject/merge/audit path works. The distinction that decides this: an *unreviewed provisional* is a valid steady state, whereas *publicly searchable user-authored content with no moderation path* is an unreviewable one — if phase 3 slips there is no supported way to handle abuse, junk, duplicate accumulation, or mistaken entries, and "phase 3 is next" is sequencing intent, not an operational guarantee. Early matcher tuning comes from dogfooding or shadow telemetry, not public creation: search activity produces candidates, but curator decisions produce the same/distinct labels that are actually useful. If early external testing is wanted, expose it to a limited cohort behind a kill switch.

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
4. **`wines.productId` + `wines.vintageId`** — nullable, plain FK on product, composite FK `(vintageId, productId)` → `wine_vintages (id, product_id)`, plus `CHECK (vintage_id IS NULL OR product_id IS NOT NULL)`. All catalog-referencing FKs `NoAction`/`Restrict`.
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

🔒 **`grapes` is a non-null `text[]`, and `{}` means "no grapes recorded" — there is no known-empty state in v1.** Verified against the toolchain: Prisma cannot model an optional scalar list (`String[]?` → *"Optional lists are not supported. Use either `Type[]` or `Type?`"*), and the repo is on Prisma 6.x. Postgres itself holds `NULL` vs `{}` fine, so this is a representation limit rather than a database one — but backing a nullable array through raw SQL would mean reads bypassing the Prisma client, which is real drift for a distinction nothing in v1 consumes (matching vetoes on conflicting `style`/`abv`, never on grape absence). If known-empty ever becomes load-bearing, the additive fix is a `grapesKnown` flag alongside the non-null array.

**Arrays therefore need their own missingness rule, and it is not the scalar one:**

- **Scalar facts keep the strict `IS NULL` rule** below — unchanged.
- **`{}` counts as missing and IS enrichable** by a non-empty incoming value. A rule treating `{}` as a user-asserted "known none" would block legitimate enrichment on every grape-less row in the catalog, so no such rule exists here.
- **A deliberately-empty array is protected by `curatorLocked`**, exactly as a deliberate scalar NULL is. That lock is the only thing that makes an empty array authoritative; absent a lock, empty means unrecorded.

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

**Status: built, not yet public.** The five add branches, the one matcher, the Redis + Postgres link mirroring, and the blind-redaction strip are implemented; `CATALOG_PUBLIC_ENABLED` (`lib/catalogGate.ts`) keeps creation closed to everyone but staff until phase 3, per the release boundary above. Code: `lib/catalogSearch.ts` (search), `lib/catalogWrite.ts` (the mutation chokepoint), `lib/catalogGate.ts` (the fence), `app/api/catalog/{search,entries}`. Tests: `scripts/tests/catalog-addflow-integration.mjs`, wired into `check-schema.yml`.

### ⚠️ SUPERSEDED: the GIN `<%` form below was replaced by a GiST KNN order

**What ships now:** `col <->> lower(f_unaccent($1))` ordered with a `LIMIT`, against `producers_name_folded_gist_idx` / `wine_products_name_folded_gist_idx` (`20260725160000_catalog_gist_knn`). The 0.3 threshold is a **post-filter** on the returned rows, so there is no GUC and no interactive transaction.

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

The five explicit branches of RFC § Add-a-wine flow. One `pg_trgm` matcher over `nameFolded`, shared by add-time search, review-queue suggestions, and post-import rescans — there is no second matcher to drift. `scope` set explicitly at every write boundary (creation rejects a missing scope rather than relying on the column default). `productId`/`vintageId` mirrored through Redis per RFC § Redis-first link design, with all list writes going through `mutateWines` (KEEPTTL preserved). Blind redaction strips both IDs in `wineToWire`.

Provisional entries minted here are publicly searchable (RFC ruling 3) — subject to the uniform-record-presentation constraint recorded there. Public creation stays disabled until phase 3 (see the release boundary above).

## Phase 3 — Review queue + merge machinery

Curator-gated, per the phase-1 permission map. Merge is pointer + lifecycle only; chains are kept and resolved transitively with a visited set and depth cap; cycle prevention resolves the full target path and writes the pointer in one transaction under deterministic row locks; every merge/unmerge writes `catalog_audit` in that same transaction. Suggestion policy carries the cross-producer prohibition and the attribute veto. Unmerge restores the loser's captured prior status.

## Phase 4 — Integration-schema migration

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
- **Array facts (`grapes`) are the exception: an empty array is missing, so `{}` IS overwritten** by a non-empty incoming value (`CASE WHEN cardinality(existing) = 0 THEN incoming ELSE existing END`). See § Arrays are non-null — `{}` is the only representation of unrecorded, so the scalar rule would freeze every grape-less row permanently. **Wire normalization:** a missing or null incoming `grapes` normalizes to `{}` at the boundary, so the apply step never sees null for a non-null column.
- Curator-locked fields are skipped *even for the fill* — including a locked `{}`, which is the only way an empty array becomes authoritative.
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

## Phase 5 — Legacy backfill + product pages

The exact-match-only backfill of RFC § Legacy backfill — the sole exception to "links are never set by strings", never fuzzy, with the unmatched remainder feeding the provisional review path. Plus the reusable UI from `feature/wine-product-pages` (local and on origin): the web product page, the aggregate query re-pointed at vintage→product roll-up with transitive `linksTo` resolution, and the mobile screen.

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
3. **The import/pull endpoint.** Contract is § Phase 4 above. Two structural pieces worth restating, because both are easy to get wrong in a way that looks fine:
   - **Pull must be driven by the unified change journal, not per-table keyset cursors.** A `(updatedAt, id)` keyset cannot express `product_producers` changes (composite key, no `updatedAt`, and a deleted join row leaves nothing to return) nor `product_eans` re-points (which change *which product* holds a barcode). See § The pull leg.
   - **An import batch must reject a new product arriving without its lead-producer link in the same batch**, since independent per-batch transactions would otherwise leave a lead-less product visible between batches. The deferred trigger enforces this at COMMIT, so the batch boundary is what has to line up.

## Open inputs

- **Tim's user id** — needed only when the bootstrap grant is actually run, which is a direct-DB `INSERT` per the runbook in `prisma/CLAUDE.md` (there is no seed script and no committed id; prod and local ids differ). Nothing in phase 1 is blocked on it, since no admin surface exists until phase 3. **Tier: `admin`** — Simon and Tim are both DESIGNATED admins (Simon, 2026-07-25, reaffirming the original ruling after the permission map narrowed `admin` to hard-purge and role-granting). Whether the grant has actually been made in a given environment is operational state, not a repository fact — check `staff_roles` in that environment rather than trusting this file.
