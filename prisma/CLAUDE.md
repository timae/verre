# prisma/ — Schema and migrations

Local rules for `prisma/*`. Root CLAUDE.md still applies; this is overlay context for schema work.

## Migration workflow

Apply schema changes to the database (Prisma is the single source of truth):

```bash
# Local dev: create a new versioned migration, applies it, regenerates client.
npx prisma migrate dev --name <description>

# Production: applied automatically by Deploio's deploy job (.deploio.yaml).
# Manually triggerable when needed: npx prisma migrate deploy
```

`prisma migrate dev` produces a versioned SQL file in `prisma/migrations/<timestamp>_<name>/migration.sql` that gets committed to git. On the next deploy, Deploio's deploy job runs `npx prisma migrate deploy`, which applies any pending migrations idempotently. The migration succeeds or the deploy is rolled back; the previous release keeps serving production until you fix the issue.

`prisma db push` is **no longer the canonical workflow** — it bypasses migration history. Only use it during early local exploration where you don't yet care about reproducibility, and never against production.

## 🔒 Editing a migration after it has been applied

**Reported by the catalog-maintenance side (2026-07-26), reproduced and extended here.** Prisma records a sha256 `checksum` per applied migration in `_prisma_migrations`. Editing an already-applied `migration.sql` — even adding a comment — diverges the file from that record.

**What each command actually detects** (measured, not assumed):

| Command | Detects an edited applied migration? |
|---|---|
| `prisma migrate status` | **No** — reports "Database schema is up to date!" |
| `prisma migrate deploy` | **No** — reports "No pending migrations to apply." |
| `prisma migrate dev` | **Yes** — *"was modified after it was applied"*, and demands a reset |
| `scripts/check-migration-checksums.mjs` | **Yes** |

⚠️ **`deploy` is the one that runs in production**, and it is blind. So on any shared database there is no first-party command that answers *"do the applied migrations still say what they said?"*

**Three lifecycle states, and the rule differs by state:**

1. **Local, never shared** — editing is fine **provided you reset and reapply** (`prisma migrate reset`). `migrate dev` enforces this itself.
2. **Applied to shared / staging / production** — 🔒 **never edit in place.** The edit is invisible to `status` and `deploy`, so the repo silently stops describing what every such environment actually ran.
3. **Already edited after sharing** — restore the original bytes; put the correction in a **new migration** or in the docs. Do not reconcile the checksum.

This is why the stale comment in `20260725090000_wine_catalog_schema` (about "no known-empty state in v1") was deliberately left uncorrected — state 2.

⚠️ **This is the ONLY tool that answers the question, and it is wired into NO workflow** — a documented runbook step, not a gate. Consequence, recorded 2026-08-11: **an out-of-band `ALTER` on production is caught by nothing automatic.** Every "live" gate we have (contract-shape, the three catalog integration suites) runs against a scratch database rebuilt from the migration chain in CI, so it verifies what the *migrations* produce, never what prod actually holds. `prisma migrate diff` and the ten `check-*.mjs` gates read files only. Nothing spans both sides. See the RFC § Which gate reads what.

**Verifier:**

```bash
DATABASE_URL=… node scripts/check-migration-checksums.mjs
```

Uses Node's `crypto` (⚠️ not `sha256sum`, which is absent on macOS), joins by `migration_name` rather than output order, and takes `DATABASE_URL` explicitly (⚠️ `psql` does **not** read `.env` the way Prisma does). Exits non-zero on a mismatch or a recorded migration whose file is gone. Pending local migrations and rolled-back/unfinished rows are reported separately and are **not** failures. Verified against all four cases: clean → pass; comment added to an applied migration → fail; pending local migration → reported pending; rolled-back row → classified, not failed.

## Destructive schema changes — never automate

Routine, additive schema changes (new columns with defaults, new tables, new indexes, widening varchars, additive foreign keys) flow through the normal migration pipeline and apply automatically on deploy.

**Destructive changes** require explicit human confirmation:

- Dropping a column or table.
- Renaming a column (Prisma sees this as drop + add).
- Type changes that risk data loss (e.g. text → integer).
- Adding `NOT NULL` to a nullable column when NULLs exist.
- Anything Prisma would prompt about with "type 'y' to confirm" or any migration that would need `--accept-data-loss`.

For destructive changes:

1. Surface what data would be lost. Be specific.
2. Prefer a non-destructive sequence first: stop writing to the column → wait → drop in a follow-up. The "expand-then-contract" pattern.
3. If destructive is unavoidable and the user confirms: take a Postgres dump first (`pg_dump`), write the migration explicitly, push during a window the user can monitor.
4. Never use `--accept-data-loss` casually. If Prisma asks for it, that's a flag to stop and reconsider, not a flag to add.

This rule applies regardless of how much "easier" it would be to just drop and recreate. Lost user data doesn't come back from a `git revert`.

## Generated columns + constraints Prisma can't express (wine catalog)

`20260725090000_wine_catalog_schema` is in two halves: Prisma-generated DDL, then raw SQL for what the datamodel can't express. The two halves are **coupled**, and the coupling is what keeps them honest — `migrate diff` ignores what it cannot *model* (functions, CHECKs, triggers, partial uniques, `NULLS NOT DISTINCT`) but **not** what it can *see*.

**Five columns are `GENERATED ALWAYS AS (…) STORED`**: `producers.name_folded`/`region_folded`, `wine_products.name_folded`/`region_folded`/`grapes_folded`. They are the single normalization path for fuzzy matching, so display and fold cannot drift.

🔒 **The fold is TWO VERSIONED FUNCTIONS** (`20260725220000_catalog_fold_whitespace`): `catalog_fold_v1(text)` for scalars and `catalog_fold_arr_v1(text[])`, which delegates to it element-wise. **Four** scalar generated columns name `catalog_fold_v1`; `grapes_folded` names `catalog_fold_arr_v1`. The **two** query-side operands (`trgmOrderSql`, `findProducerByExactName`) name `catalog_fold_v1`. The unversioned predecessor `f_unaccent_arr` is DROPPED in the same migration — leaving it callable would let a future column bind to a mutable name.

Order: **delete the invisibles `scrub` deletes** (U+200B/200E/200F/2028/2029/FEFF, bidi controls — ZWNJ/ZWJ preserved for Persian/Arabic/Hindi ligatures) → map enumerated Unicode whitespace to ASCII space → collapse runs → trim → `f_unaccent` → lower. ⚠️ The delete step exists because `SCRUB_RE` (`lib/textSafe.ts`) strips those characters app-side: without it the SAME raw name folds differently depending on whether it arrived through the app or an import. Pinned by an app/DB parity assertion (`catalog_fold_v1(raw) = catalog_fold_v1(scrub(raw))`).

⚠️ **VERSIONED IN THE NAME, and that is load-bearing.** Replacing an `IMMUTABLE` function's body does **NOT** recompute existing `STORED` generated values — Postgres trusts the immutability contract and never re-runs it. A semantic change is therefore `catalog_fold_v2` **plus a column rewrite**, never an edit to the v1 body; editing in place leaves stored folds silently disagreeing with freshly-written ones.

🔒 **The four blank-name CHECKs are CONTRACT SURFACE, and changing one is a contract event.** `20260725220000` § 3 moved them from `btrim(x) <> ''` to `catalog_fold_v1(x) <> ''` — strictly stronger, so a value of only zero-width or control characters that used to insert now fails. That shipped with no surface and no version bump because "shape" was undefined in the import contract; it now is (the **rejection-surface test** — root CLAUDE.md and the RFC § Catalog write ownership). ⚠️ **A stricter predicate is an AVAILABILITY change, not a matching one**: rows become non-insertable, and an import batch is all-or-nothing, so one unedited name rolls back the batch. Enforced by `scripts/check-catalog-contract-checks.mjs` against the committed snapshot `prisma/catalog-contract-checks.json`, wired into `check-schema.yml`. Regenerate a deliberate change with `--write` against a migrated DB; a new **or changed** constraint lands as `UNCLASSIFIED` and fails the gate until scoped — scope is a property of the *transition*, so it is re-earned rather than inherited.

🔒 **The snapshot hashes every FUNCTION a CHECK calls, because `pg_get_constraintdef` records the call and not the callee.** ⚠️ Measured: `CREATE OR REPLACE`-ing `gtin_check_digit_ok` to return a constant made `product_eans` accept check-digit-invalid barcodes while the constraint reprinted byte-identically and the gate said "22 constraints match". Dependencies are resolved via `pg_depend` (never by parsing predicate text — that fails open) and hashed with `pg_get_functiondef`; an absent record fails the gate.

🔒 **The five GENERATED COLUMNS carry the same blind spot, and it bites harder.** `generation_expression` records the *call*: swap the fold body and the expression is byte-identical while every new row is keyed differently. ⚠️ Measured — after a swap, `Château X` stored `name_folded = 'CHÂTEAU X'` instead of `chateau x`, silently re-keying `producers.name_folded`, the producer matching key. Worse than the CHECK case because Postgres never recomputes STORED values, so old and new rows disagree with no error. The snapshot records all five columns + their fold hashes (via `pg_depend` → `pg_attrdef`). ⚠️ `grapes_folded` depends on `catalog_fold_arr_v1`, which **no CHECK references** — it was entirely uncovered until this landed.

⚠️ **These four predicates are now FOLD-DEPENDENT, which is what makes the fold-identity handshake load-bearing rather than a separate concern.** Before `20260725220000` they were facts about Postgres builtins either side could reason about alone; they are now facts about `catalog_fold_v1`, so their *meaning* changes if the fold diverges — not merely what they match. The handshake was pulled forward out of phase 4 for exactly this reason (2026-08-11).

🔒 **Whitespace is canonicalized in the DATABASE, not the app.** The app trims (`requiredName` → `scrub`), but that guarantee is TypeScript-only and every non-app writer bypasses it — direct SQL, the import path, any seed tool. ⚠️ `btrim` strips **only ASCII spaces** and PG's `\s`/`[[:space:]]` do **not** match U+00A0, so `btrim` alone is not a whitespace normalizer: `btrim(E'x\t')` and `btrim(E'x ')` both keep the character. The blank-name CHECKs route through the fold for the same reason — before this migration a tab-only, newline-only or NBSP-only name passed `btrim(name) <> ''`. Pinned by `catalog-schema-integration.mjs` § 1b (11 fold-equal variants + 4 must-stay-distinct + a round-trip + paired rejects; verified to fail under three mutations, including the plausible btrim-only partial fix).

🔒 **The fold lowercases LAST** (corrected in `20260725140000_catalog_fold_order`, preserved by v1). `f_unaccent` is `unaccent` with no `lower()`, and **some unaccent expansions produce capitals**, so lowercasing first lets uppercase survive into the folded value: `f_unaccent(lower('Cuvée № 5'))` → `cuvee No 5`, `f_unaccent(lower('Toro Loco®'))` → `toro loco(R)`. ⚠️ **Trigram search never reveals this** (pg_trgm lowercases internally) — what breaks is every **exact-equality / prefix / dedupe** comparison on a folded column, which is case-sensitive: `'Cuvée № 5'` and `'Cuvee No 5'` folded UNEQUAL. That hits `findProducerByExactName` and, critically, the phase-5 **exact-match-only legacy backfill**. Pinned by `catalog-addflow-integration.mjs` § 1.

- **Never write them.** The generated client exposes them as optional inputs, but Postgres rejects any value with `428C9` ("cannot insert a non-DEFAULT value" / "can only be updated to DEFAULT"). A loud runtime error, not silent drift.
- Their `@default(dbgenerated("…"))` strings in `schema.prisma` must match the migration expression **character-for-character**. The check-schema gate does catch a mismatch (verified: corrupting one produced `[*] Altered column grapes_folded (default changed from …)`).
- ⚠️ **Widening a folded source column fails the deploy.** `ALTER COLUMN "name" SET DATA TYPE VARCHAR(300)` — the kind of additive change the destructive-changes rule above says flows through automatically — raises `cannot alter type of a column used by a generated column`. To widen `producers.name`, `wine_products.name`, or either `region`: drop the generated column, alter the type, re-add the generated column, in one hand-written migration.

**`wine_vintages_product_year_key` is `UNIQUE NULLS NOT DISTINCT (product_id, year)`** — one row per year *and* only one NV (null-year) row per product. The `@@unique([productId, year], map: …)` in `schema.prisma` is **deliberately weaker than what ships** (Prisma has no `NULLS NOT DISTINCT` syntax); it attests the constraint exists and the migration supplies its strength. 🔒 **Never change that line's column list.** Prisma would emit `DROP INDEX` + `CREATE UNIQUE INDEX`, and the recreated index would lose `NULLS NOT DISTINCT` — silently permitting unlimited duplicate NV rows. On prod (where `@@unique` materialises as a table CONSTRAINT) the emitted `DROP INDEX` hard-fails instead, converting a silent regression into a failed deploy — but don't rely on that. Removing just the `map:` is only a `RenameIndex` and is safe.

**🔒 Catalog search orders by a GiST KNN distance; equality is served by a covering B-tree.** Add-time search uses `col <->> catalog_fold_v1($1)` with a `LIMIT`, so the index returns the nearest rows directly and cost is bounded by the limit rather than by how many rows match. ⚠️ **Operator and operand ORDER must match** — `column <->> query` and its commutator `query <<-> column` both plan an Index Scan (~4.9 ms); the mismatched pairings `column <<-> query` / `query <->> column` seq-scan the whole table (~116 ms over 60,001 rows) while returning correct rows. `<<->` is the declared commutator of `<->>` (pg_operator), so it is NOT a forbidden operator — it is usable only with the query on the left. Same operand-order trap as the GIN `<%`/`%>` pair. `<->>` is exactly `1 - word_similarity`, so ranking and typo tolerance match the GIN `<%` form this replaced.

**Why it replaced the GIN `<%` filter:** `<%` at threshold 0.3 is not *selective* — the candidate count scales 1:1 with the catalog. Measured on PG16: a "selective" multi-word producer name still admitted 25,691 rows (8.5% of a 300k catalog), the **heap recheck** dominated (22 ms of a 163 ms query), and latency grew linearly with catalog size — 34 ms at 60k, 352 ms at 300k. Under load it became an outage rather than a slowdown: 50 concurrent searches produced 15 hard pool-timeout failures, 100 produced 66. The 0.3 threshold is now applied as a **post-filter** on the handful of rows KNN returns, which also removes the `SET LOCAL pg_trgm.word_similarity_threshold` GUC — and with it the interactive transaction that pinned a pool connection for each in-flight search.

**The GIN indexes are REPLACED by covering B-trees**, not kept: a trigram index is the wrong structure for `=`, and measured on the REAL query the planner chose GiST (0.544 ms / 130 buffers) over a bare B-tree — only `(name_folded, id) INCLUDE (status)` wins on its own, as an Index Only Scan with zero heap fetches (0.125 ms / 4 buffers). Nothing issues a `%`/containment query, so GIN had no live consumer. GiST costs roughly 2x the size and more write maintenance; both were measured as immaterial against the phase-4 batch ceiling. Canonical query + the full rationale: `lib/catalogSearch.ts` and `20260725160000_catalog_gist_knn`.

**Audit tables are append-only in the database, not by convention.** `staff_role_audit` and `catalog_audit` carry triggers rejecting `UPDATE`/`DELETE` and overwriting any supplied `created_at` with the server clock (blocking mutation alone still permits backdated inserts). Rows are written only as part of the transaction that changes what they describe. **Restricting the runtime DB role to `SELECT`/`INSERT` on these two tables is the stronger control and is an operator-level change, not a migration** — the triggers stop the application role, not a superuser.

**The last admin cannot be removed by any path.** A `BEFORE DELETE OR UPDATE OF role` trigger on `staff_roles` refuses any change leaving zero admins — covering **deletion and demotion**, since demoting the sole admin deletes nothing and a delete-only guard never fires. A separate `BEFORE DELETE ON users` trigger appends the cascade's revoke audit row (`actor_id` NULL, reason `'account deletion'`) so an account deletion still leaves history; it hangs off `users`, not `staff_roles`, because on `staff_roles` it fired for *every* role-row deletion and stamped deliberate revokes as account deletions too. All trigger bodies are schema-qualified (`public.…`) with a pinned `search_path`, so a same-named TEMP table cannot shadow the tables they read. Both the trigger and `lib/staffRole.ts` take the **same** advisory lock — `hashtext('verre:staff_roles:admin')`; if those two keys ever diverge, each path serializes only against itself and the delete-vs-revoke race reopens (it produced zero admins in 8/10 trials before the fix). Consequence: **a sole admin cannot delete their own account** until they grant admin to someone else.

**Bootstrap + recovery is a direct-DB INSERT — deliberately not a script and not an endpoint.** Granting a role requires `staff.grantRole` (admin-only), which is a chicken-and-egg for the first admin and for the locked-out case. An in-app "recover admin access" route would *be* the privilege-escalation hole, so recovery requires DB access — already the highest trust level in the system. That is also what makes the database's unconditional last-admin refusal tenable: there is always an escape hatch, so the guard never needs an in-app override.

Ids are environment-specific (prod ≠ local), so nothing is committed. Run per environment, substituting the real id for `<id>`.

🔒 **These two recipes are EXECUTED BY `scripts/tests/catalog-schema-integration.mjs`** (§ 18), which extracts them from this file by the `-- @recipe:` markers below and runs them against a real database. That is deliberate: three successive prose versions of the promotion guard shipped subtly broken while every suite stayed green, because documented SQL had no gate. Edit these blocks and the test runs your edit — so keep the markers intact, keep `<id>` as the only placeholder, and expect CI to fail if a recipe stops being correct.

```sql
-- @recipe:bootstrap
-- 🔒 ONE TRANSACTION. The audit row is NOT optional: a grant without it leaves
-- no record of who created the first admin, which is the one fact this table
-- exists to answer. Wrapping both makes a half-applied bootstrap impossible.
BEGIN;
  INSERT INTO staff_roles (user_id, role) VALUES (<id>, 'admin');
  -- actor_id NULL + reason 'bootstrap' is the documented pairing for
  -- system-minted privilege (no human granted it). created_at is server-forced.
  INSERT INTO staff_role_audit (subject_id, role, action, actor_id, reason)
  VALUES (<id>, 'admin', 'grant', NULL, 'bootstrap');
COMMIT;
-- @endrecipe

-- @recipe:promote
-- Promoting an existing curator to admin. ONE statement, inside a DO block.
--
-- 🔒 THE VERIFICATION MUST USE THIS STATEMENT'S OWN AFFECTED-ROW COUNT. Two
-- earlier versions of this recipe were both silently wrong, so the shape below
-- is deliberate:
--   1. Checking "is the user now an admin" passes for someone who was ALREADY
--      an admin — a mistyped id pointing at an existing admin committed with no
--      audit rows written at all.
--   2. Counting matching audit rows in the TABLE passes on a re-run, because it
--      sees the rows the FIRST successful promotion left behind. Reproduced:
--      promote a curator, run the recipe again against the now-admin user, and
--      it commits happily on the two historical rows.
-- `ROW_COUNT` is scoped to the statement just executed, so it cannot be fooled
-- by history or by prior state. Everything is in one DO block because ROW_COUNT
-- is only readable inside PL/pgSQL, immediately after the statement.
--
-- Also resets granted_by/granted_at: the row is REPLACED (user_id is the PK), so
-- keeping the curator grant's provenance would misattribute the admin grant.
DO $$
DECLARE
  promoted int;
BEGIN
  UPDATE staff_roles
     SET role = 'admin', granted_by = NULL, granted_at = now()
   WHERE user_id = <id> AND role = 'curator';
  GET DIAGNOSTICS promoted = ROW_COUNT;
  IF promoted <> 1 THEN
    RAISE EXCEPTION
      'no curator grant for user <id> (updated % rows) — wrong id, or already an admin?',
      promoted;
  END IF;
  -- Both halves, or the audit implies the person held admin AND curator at once.
  INSERT INTO staff_role_audit (subject_id, role, action, actor_id, reason)
  VALUES (<id>, 'curator', 'revoke', NULL, 'superseded by admin'),
         (<id>, 'admin',   'grant',  NULL, 'bootstrap promotion');
END $$;
-- @endrecipe

-- Inspect current grants (ids only — resolve names in the app; don't dump PII
-- into operator logs).
SELECT user_id, role, granted_by FROM staff_roles ORDER BY role, user_id;
```

Everything after the bootstrap goes through the in-app path (`lib/staffRole.ts` `grantStaffRoleAs` / `revokeStaffRoleAs` / `demoteToCuratorAs`), which audits both halves of a transition and enforces authorization inside the write transaction.

⚠️ **`wine_products.category` is NOT constrained when `style` is NULL** (found 2026-08-11, not yet fixed). The composite FK `(category, style)` → `category_styles` is **MATCH SIMPLE**, so it skips the check whenever either column is null — and `style` is nullable. Measured: `category='spirit', style='grappa'` is rejected; `category='spirit', style=NULL` is **accepted**. Same trap the `vintageId`/`productId` pair already guards against with an explicit CHECK (see the RFC § and `20260725090000` §), just never applied here. The fix is a CHECK pinning `category` to the defined set or a NOT NULL on `style` — both need their own migration and a decision on the extensible-category direction, so it is sequenced with the model change. Don't assume `category = 'wine'` in query or import code until then.

**A `WineProduct` can never be created in a single statement.** Deferred constraint triggers enforce "every product has exactly one lead producer" at COMMIT, including at creation — so a bare `prisma.wineProduct.create()` always raises `has no lead producer`. Product + its `product_producers` lead row must commit in one `$transaction`. That is the invariant working, not a bug. Swap ordering traps (demote-then-promote; promotion is an UPDATE, not an INSERT) are documented in the migration's § 6.

## 🔒 `product_producers.product_id` is ON DELETE CASCADE — deliberately

**Ruled 2026-07-26 (Simon): we KEEP it.** Recorded because the data side's mirror
of this schema uses `RESTRICT` on both `product_producers` FKs, and a shared-contract
reading would otherwise treat ours as the accident. It is the opposite: theirs is
Prisma's default for a required relation (never a decision); ours is a decision with
a comment in `20260725090000_wine_catalog_schema/migration.sql` explaining it.

**Why it must stay CASCADE:** the staff hard-purge deletes a product and its join
rows in one transaction. The exactly-one-lead constraint trigger is `DEFERRABLE
INITIALLY DEFERRED` (fires at COMMIT) and its carve-out in
`catalog_product_requires_lead` returns quietly when the parent product is already
gone. That whole design assumes the join rows disappear WITH the product. Switching
to `RESTRICT` would force the purge to sequence deletes by hand — which is precisely
what the cascade exists to avoid.

**Not a hole to accept:** a `product_producers` row cannot outlive its product, so
removing it alongside is cleanup, not loss. (The producer survives; what goes is the
fact that *this* producer made *this* product — worthless once the product is purged.)

⚠️ For the record, our catalog FK shape is **9 forward FKs, 8 `NoAction`, 1 `Cascade`**
— the single `Cascade` is this one. An earlier claim that "every catalog-referencing
FK is NoAction" was false and is corrected in `e2b9247`.

## Schema check (build-time)

`.github/workflows/check-schema.yml` runs `prisma migrate diff` and fails the build if `schema.prisma` and the migrations directory disagree. Don't bypass — either generate the migration via `prisma migrate dev` or roll back the schema change.

The same workflow then applies the real migration chain to a disposable database and runs the **contract-shape gate** (`check-catalog-contract-checks.mjs` — diffs every CHECK on the five catalog tables against the committed snapshot; runs first because it reads schema only and should fail fast) plus three suites covering what `migrate diff` cannot see (it ignores objects it can't model): `catalog-schema-integration.mjs` (CHECK bodies, deferred lead triggers, `NULLS NOT DISTINCT`, audit immutability, the bootstrap recipes in this file), `staff-role-concurrency.mjs` (the last-admin race across the app and DB paths), and `catalog-addflow-integration.mjs` (the phase-2 add-flow, plus a **query-plan** assertion — the trigram predicate's wrong spellings return correct rows and merely lose the index, so nothing else can catch them).

## `prisma/maintenance/` — recurring SQL (NOT migrations)

`prisma/maintenance/*.sql` holds idempotent housekeeping SQL run on a schedule via `prisma db execute --file`, distinct from `prisma/migrations/`:

| | `prisma/migrations/` | `prisma/maintenance/` |
|---|---|---|
| Runs | once, in order, tracked in `_prisma_migrations` | recurring, on a schedule, untracked |
| Triggered by | deploy job (`migrate deploy`) | a `scheduledJob` cron in `.deploio.yaml` |
| Gates the deploy | yes (`migrate deploy` failure fails the release) | no (a scheduled-job failure never fails the release) |
| Purpose | schema + one-shot data migrations | recurring idempotent housekeeping (e.g. retention pruning) |

So a maintenance file MUST be idempotent and safe to re-run any number of times — it is NOT a versioned one-shot. Don't put schema changes here (those are migrations). Current file: `cleanup-revoked-sessions.sql` (prunes `user_sessions` revoked >90 days, daily). pg_cron isn't available on Nine's managed Postgres, but Deplo.io's native `scheduledJobs` (cron, same image + env as the app) is — the job `cd /migrate`s like the deploy job. Wired in `.deploio.yaml`; see `docs/dev/deployment.md`.

## Phase 2 data migration (rewire) — historical

`prisma/migrations/20260515011038_rewire_phase2_data/migration.sql` backfilled the new `feed_items` model from the (then-existing) `checkins` tables. Idempotency was guarded via a `_migration_checkpoints` scratch table — both that table and the source `checkins*` tables were dropped in phase 4 (`20260516125827_rewire_phase4_drop_checkins`). The migration file remains in history for audit; do not re-run it. Re-run / partial-failure recovery within its deploy window: `prisma migrate resolve --rolled-back <migration_name>` was the documented escape hatch. Full deploy story (scale to 0 replicas, push merge commit, Deploio runs `prisma migrate deploy`, scale back up): `docs/dev/proposals/rewire.md` §5 + §6 phase 2.

## Schema notes for future features

Columns that exist in the schema but are not yet wired to UI:

- `users.role` — **dead column.** Defaults to `'taster'` and is read by nothing. Don't wire it, don't branch on it, don't extend its value set: account-level staff powers live in `staff_roles` (see below). Not dropped yet — the drop is a destructive migration deliberately left out of the catalog build. (Note the unrelated `SessionMember.role`, which carries the *session* axis `host|co_host|provider|taster` and is heavily used.)
- `wines.category` — extensible drink type beyond wine (beer, spirit, kombucha)

## What doesn't exist (don't invent it)

- **Staff tier lives in `staff_roles`, never on `users`.** Ruled 2026-07-24 for the wine catalog (`docs/dev/proposals/wine-catalog.md` § Open decisions — RESOLVED). Grants are rows: `userId` + `role` (`admin` | `curator`), `grantedBy`, `grantedAt`; `admin` implies `curator`. **Never ship `if (user.role === 'admin')`** — `users.role` is dead (above), and a privilege bit on `users` would sit on the hottest table in the app, reachable by every existing `prisma.user.update` and by Better Auth's own writes into that table. Resolve staff powers from a **fresh DB read** on every check — never cached into a JWT or session, same reasoning as the 🔒 never-cache-`auth()` invariant in `lib/CLAUDE.md`: a cache TTL is a window where a revoked privilege still resolves. A new privileged tier beyond `admin`/`curator` still gets surfaced + threat-modeled first.
