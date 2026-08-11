# Proposal: Wine product catalog (redesign)

**Status:** **Phase 1 (domain schema) SHIPPED** on `main` as `4bc14c5` (PR #86, 2026-07-25) — the four catalog tables, `product_eans`, the `wines` link columns, `staff_roles`/`staff_role_audit`, and `catalog_audit` all exist. **Phase 2 (add-flow + fuzzy search) is BUILT and gated OFF**: the five add branches, the one `pg_trgm` matcher, and the Redis/Postgres link mirroring are implemented, but `CATALOG_PUBLIC_ENABLED` keeps creation staff-only. ⚠️ **The "until phase 3" release boundary is SUPERSEDED** (2026-07-25): the fence now opens with the **model-change phase**, which comes before phase 3 — see `wine-catalog-model-change.md` § 7. That proposal also **reverses this file's two-grain split**: per-event fields move off `wines` onto a new *occurrence* row, ratings reference the occurrence and derive catalog identity through it, and bookmarks point at product + optional vintage. Everything else here — catalog identity, merge reversibility, no find-or-create, blind redaction — stands and is load-bearing there. Phases 3–5 pending — see `wine-catalog-implementation.md`. This file remains the **rationale-of-record for the model**; where it and the shipped schema differ, the migration wins (as-built deltas are noted in the plan). Design history: revision 3 — absorbs the Codex review (2026-07-23, CHANGES_REQUESTED), the follow-up review (2026-07-24), and the PR #85 comment thread as amended (the source-id/region-id refinements are withdrawn; linksTo flatten-on-write is superseded by chains-with-transitive-resolution). Supersedes the flat `wine_products` model in PR #82 (converted to draft — kept only as the reference for its reusable UI: the web product page, the aggregate query, and the mobile screen).

## Context

PR #82 shipped public wine product pages backed by a flat `wine_products` table with **auto-dedup-on-write**: a normalized `producer + name + vintage` string key drove a `find-or-create + fill-nulls` on every wine write. Review (Simon, 2026-07-22) rejected the *model* — not the pages — because auto-dedup silently and irreversibly collapses distinct entries, assumes every entry is shared reference data, and bakes vintage into identity.

**The invariant everything hangs on:**

> An entry is created **distinct**. Combining entries is a separate, deliberate, **reversible** action — a **merge**. The string/fuzzy match is only a **suggestion** that surfaces likely duplicates for confirmation; it is **never** an automatic find-or-create hook.

This doc specifies the **Foundation-first v1**: the correct identity + lifecycle spine, `shared`-scope only, with the schema deliberately leaving room for the deferred ownership/organization axis so it lands additively (no re-key).

## Catalog write ownership

Catalog reference data arrives through the app-owned, authenticated import contract (§ Catalog maintenance); it is curated before it reaches the app. Consequences:

- The shapes of **`producers`, `wine_products`, `wine_vintages`, `product_producers`, `product_eans`** (plus the `wines.productId`/`wines.vintageId` link columns) are **part of the versioned import contract**. Any change to these shapes is a contract change: surfaced explicitly and shipped with a contract version bump — never made silently.

  ### 🔒 What "shape" means — the rejection-surface test

  ⚠️ **This was undefined until 2026-08-11, and the ambiguity is the root cause of the one silent contract change this workstream has shipped.** "Shape" read as columns-and-types, so `20260725220000` § 3 swapped four CHECK predicates from `btrim(x) <> ''` to `catalog_fold_v1(x) <> ''` — strictly stronger — with no surface and no bump. Neither side had tooling that would have noticed. The definition below is the fix; the CI gate under § Enforcement is what makes it stick.

  **Shape is: columns, types, nullability, defaults, keys, uniqueness, foreign keys — and CHECK constraints, by the test below.** Not every CHECK: a blanket rule adds churn without signal.

  > **A constraint is CONTRACT surface iff a payload valid under the old predicate can be REJECTED under the new one.**

  Classification of the 22 CHECKs on the five tables (derived from `pg_get_constraintdef`, not transcribed — see the committed snapshot):

  | Scope | Constraints | Why |
  |---|---|---|
  | **contract** (16) | `name_not_blank` ×2, `region_not_blank` ×2, `abv_range` ×2, `year_range`, `grapes_override`, `status` ×3, `scope`, `role`, EAN format, EAN check-digit, `seen_order` | Reject a conforming payload |
  | **structural** (6) | `linked_pointer` ×3, `no_self_link` ×3 | Internal lifecycle; no conforming payload violates them |

  The catalog-maintenance side applied this same test to the 15 constraints they don't yet carry and split them 9/6 along exactly this line — independent agreement that the boundary is drawable in practice, not only in principle.

  🔒 **A stricter predicate is an AVAILABILITY change, not a matching change.** This is the part that makes CHECKs matter more than the original framing suggested. A fold change alters which rows *match*; a CHECK change alters which rows are *insertable* — and because an import batch is one all-or-nothing transaction, a single name nobody edited can roll back the entire batch.

  ⚠️ **"Strictly weaker" is a documented low-risk class, not an exemption.** A weakened predicate rejects nothing new, so it is not an availability risk on the import path — but it means the app now accepts rows the maintenance side may still be filtering out, which is divergence pointing the other way. Every predicate change is announced; only the risk note differs.

  🔒 **The four fold-dependent CHECKs are why § Fold identity is load-bearing, not a separate concern.** Before `20260725220000` these predicates were facts about Postgres builtins that either side could reason about alone. They are now facts about `catalog_fold_v1`, so their *meaning* — not merely what they match — is a function of the fold being byte-identical on both sides.

  **The six-row canary.** Measured by the catalog-maintenance side against the ~70k producer rows staged for the first fill: **0** fold to `''`; **0** fold to a form with no alphanumeric; **6** fold to a form with no ASCII `a–z0–9` — two Greek, three Russian, one Ukrainian, all legitimate. So the entire blast radius of a fold change against the two `name_not_blank` CHECKs is those six rows, and only for a change adding transliteration or an ASCII-only step. They are a **fixed canary set**: any proposed `catalog_fold_v1` change is evaluated against them before it ships. (Verified independently here on PG 16: non-Latin names fold non-empty and carry Unicode alnum but no ASCII alnum, so today they pass. ⚠️ Note a punctuation-only name like `&-.` also folds non-empty and therefore *passes* `name_not_blank` — the CHECK rejects blank, not meaningless.)

  ### Enforcement

  🔒 **The mechanism is a gate, not a comment.** Three separate rules in this workstream — never edit a `_v1` body, change both sides of a fold together, never change a contract shape silently — were all correct, all documented, and none enforced; two were violated anyway.

  `prisma/catalog-contract-checks.json` is a committed snapshot of every CHECK on the five tables, generated from a migrated database (`node scripts/check-catalog-contract-checks.mjs --write`). `scripts/check-catalog-contract-checks.mjs` diffs it against `pg_get_constraintdef` in CI (`check-schema.yml`) and fails the build on any added, removed, altered, or unclassified constraint — escalating the message when the constraint is `contract`-scoped or fold-dependent.

  It compares Postgres' **canonical reprint**, so a cosmetic reformat of migration SQL does not fire — the inverse of the fold handshake, which compares raw source text because there byte-identity *is* the contract. It diffs `structural` constraints too: the rejection-surface test decides whether a change is a *contract event*, not whether the gate *watches*. Scoping the gate to contract-only would make the snapshot negotiable per change.

  🔒 **Scope is re-earned on every change; it is not a permanent label.** The rejection-surface test asks about a **transition**, so `--write` resets any constraint whose predicate moved back to `UNCLASSIFIED` and the gate fails until a human re-applies the test. Without this, a `structural` constraint edited into a rejecting one would inherit `structural` and pass CI — the classification laundering itself through a regenerate. A changed `contract`-scoped constraint additionally prints a **contract-version event** at regenerate time, when a human is present to act on it.

  🔒 **The snapshot records predicate FUNCTION dependencies, not just predicate text.** `pg_get_constraintdef` records the *call*, not the callee — so replacing a helper's body changes the accepted payload set while the constraint reprints character-for-character. ⚠️ **Measured (2026-08-11): swapping `gtin_check_digit_ok` to return a constant made `product_eans` accept check-digit-invalid barcodes — permanent identity keys — while the gate reported "22 constraints match".** Every function a contract CHECK depends on is now resolved via `pg_depend` (never by parsing predicate text, which fails open) and hashed with `pg_get_functiondef`. An absent dependency record **fails** the gate rather than passing: absent means unverified, not none.

  Two constraints' predicates are function-backed: the four `name_not_blank`/`region_not_blank` CHECKs (via `catalog_fold_v1`) and `product_eans_check_digit` (via `gtin_check_digit_ok`). The fold has the cross-system identity handshake; the GTIN helper had **no** equivalent, and now both are covered locally. A useful side effect: a `catalog_fold_v1` body swap is caught by this gate too, independently of whether the handshake has run.

  🔒 **The same blind spot exists on GENERATED COLUMNS, and it is worse there.** Raised by the catalog-maintenance side (2026-08-11) and reproduced here: `generation_expression` records `catalog_fold_v1((name)::text)` — the *call*. Replace the fold body and the expression stays byte-identical while every subsequently-written row is keyed differently. ⚠️ **Measured: after a body swap, `Château X` stored `name_folded = 'CHÂTEAU X'` instead of `chateau x`** — `producers.name_folded` is the producer matching key for the entire catalog, silently re-keyed on next write. Worse than the CHECK case because Postgres does **not** recompute STORED generated values, so old and new rows disagree with nothing raising an error.

  The snapshot therefore records all five generated columns with their expression **and** their fold body hashes, resolved via `pg_depend` through `pg_attrdef`. ⚠️ Four are incidentally covered by the fold-backed CHECKs, but **`grapes_folded` uses `catalog_fold_arr_v1`, which no CHECK references** — it was entirely uncovered, and relying on the incidental overlap would have left it that way. An absent `generatedColumns` block fails the gate, same as an absent dependency record.

  The catalog-maintenance side independently designed the same mechanism — committed `pg_get_constraintdef` snapshot, CI diff, explicit accepted-divergence list requiring a stated reason — before seeing this one, and is building the equivalent on their side. Verified green against this branch at `1422219`: their pinned prod predicates unchanged, nothing here moves the contract.

  ### Declared divergence — `abv_range` (2026-08-11)

  🔒 **The maintenance side does NOT adopt `abv_range 0..25`, and this is accepted.** Their table is multi-category by design and holds spirits; 0..25 would make 1,466 rows unstorable. They keep a wide local fence and treat our 0..25 as an **export-boundary rule** — nothing violating it may be sent — enforced as a pinned count of exactly how many held rows our predicate would refuse, with the gate failing if that number moves. Same shape as the year resolution: wide fence locally, our rule at the boundary. **A promise turned into a mechanism**, which is the only form a cross-side commitment can take.

  ⚠️ **One detail does not transfer, and it matters if the number is ever reconciled.** They describe their local fence as `0..100`. On *our* column that bound would be **unreachable decoration**: `abv` is `DECIMAL(4,2)`, so the type caps magnitude at 99.99 and a `<= 100` CHECK could never fire. Verified on PG 16 — inserting `135` raises `numeric field overflow` from the type and never reaches the CHECK, while `40` (a pomace brandy) is refused by the CHECK itself. So our 25 is the bound that actually bites and their 100 is doing real work only because their column is wider. The two numbers are not comparable as written; the comparable statement is "each side's fence is the widest value its column can hold, and 0..25 is the boundary rule."

  ### 🔒 Found while verifying that divergence: `category` is not actually constrained

  ⚠️ **`wine_products.category` accepts ANY value whenever `style` is NULL.** The only thing constraining it is the composite FK `(category, style)` → `category_styles`, which is **MATCH SIMPLE** — it skips the check entirely when any column is null, and `style` is nullable by design. Measured on PG 16:

  | Insert | Result |
  |---|---|
  | `category='spirit', style='grappa'` | rejected (FK fires) |
  | `category='spirit', style=NULL` | **accepted** |

  This is the **same trap already documented twice** in this codebase — the `vintageId`/`productId` pair carries an explicit `CHECK (vintage_id IS NULL OR product_id IS NOT NULL)` precisely because the composite FK is MATCH SIMPLE, and `20260725090000` § warns about it in prose. It was simply never applied to `category`.

  It corroborates the maintenance side's own finding from the ABV measurement — 30 rows carrying a `wine` category while being pomace brandies at 35–50% ABV — from the opposite direction: **they have wrongly-categorised rows, and we would not reject them on `category` even though `spirit` is not a category we define.** A style-based export filter does not keep grappa out of a wine catalogue, and neither does our category column today. The category clause is load-bearing, not tidy.

  📋 **Not fixed here** (this branch is the contract-shape gate). The fix is a CHECK pinning `category` to the defined set, or a NOT NULL on `style`; both are schema changes needing their own migration and a decision on the extensible-category direction (`wines.category` is documented as intended to extend to beer/spirits later, so pinning to `'wine'` alone would foreclose that). Sequencing: it belongs with the model change, before the fence opens.

  🔒 **EVERY CLAIM THIS GATE MAKES HAS A STAGED FAILURE BEHIND IT.** Adopted from the maintenance side (2026-08-11) after they found their own gate compared constraint *names* and never predicates — it claimed to catch in-place edits and did not, because a drop test had been staged and read as proof of the general claim. Staging the missing cases then found a second bug *in their fix*.

  ⚠️ **The same method immediately found a bug here**, in a behaviour that had only been reasoned about: `foldDependent` was carried from the prior snapshot entry and **dropped whenever the constraint changed**, so editing a fold-backed CHECK silently removed its marker and the next change to it would no longer print the fold-divergence warning — the gate quietly shedding a safety property while staying green. Fixed by **deriving** the marker from the recorded dependencies instead of carrying it, which also gives a newly-added fold-backed constraint the marker for free. **A property that is copied forward can desync from what it describes; a property that is derived cannot.**

  Staged failures currently behind the gate: predicate changed; predicate function body swapped; fold body swapped; array-fold body swapped; generated column dropped; generated-column block absent; dependency record absent; structural constraint edited into a rejecting one; contract constraint changed; new unclassified constraint; unmigrated database. Each is verified to exit non-zero, and the baseline plus every restore is verified to exit zero — a gate that never passes is as useless as one that never fails.

  ⚠️ **Nothing has shipped against this contract yet** — the first import has not run, so no consumer holds an earlier shape. The payload resulting from the migrations below is therefore declared **contract v1**; the table is *migration history explaining how v1 was reached*, not a series of version bumps. (The GiST/GIN index swap is not a wire-contract change at all — it is listed for completeness of the schema story.) The first real bump will be the first change made **after** an import has run.

  **How v1 was reached:**
  | Migration | Change |
  |---|---|
  | `20260725140000` | fold order corrected (`lower(f_unaccent(x))`) |
  | `20260725160000` | GiST KNN + covering B-tree replace GIN |
  | `20260725220000` | fold becomes `catalog_fold_v1`; whitespace canonicalized; `f_unaccent_arr` dropped |
  | `20260725220000` § 3 | 4 blank-name CHECKs: `btrim` → `catalog_fold_v1` |
  | `20260726090000` | `wine_vintages.grapes` + `grapes_override` added |

  ⚠️ **The § 3 row was added retroactively (2026-08-11).** It is the same migration as the row above it, listed separately because it is a *distinct* contract change that went unrecorded: the fold row describes matching, the § 3 row describes **rejection**. Both landed before the first import, so both are still v1 rather than bumps — but the omission is exactly the class of silence the rejection-surface test now closes.

  ⚠️ The import contract must carry vintage-level grapes as **two fields**, not one: sending `grapes: []` alone is ambiguous between "inherit" and "none listed". Absent `grapes_override` (or `false`) means inherit and the array MUST be empty — a CHECK enforces it.
- Imported entries arrive already curated. The app-side **review queue exists for user-added entries only** (confirm / merge / reject); merges and `linksTo` exist only here, where tasting data lives.
- Prod persists **no source identifiers of any kind** on catalog rows (see the provenance rule — which is about PER-RECORD provenance and does not override licence attribution, handled at corpus level).

## 🔒 Data-provenance rule (hard)

**Never store any source-provenance field in the DB** — no source URLs, slugs, source ids, or source region ids — and never expose source provenance **per record**. The catalog's identity is **our own IDs** (nanoid PKs, like the rest of the schema): prod holds Verre IDs + clean catalog facts only. Refreshes arrive through the import contract as upserts keyed on **our** catalog IDs; the app never needs any other key.

⚠️ **Scope correction (2026-07-25): this rule is about PER-RECORD provenance, and it does not override a licence.** An earlier phrasing said "never expose source provenance on any surface", which read as forbidding attribution outright — and some licences we rely on **legally require naming the source**. Those obligations are met at the **corpus level**, on the attributions/legal surface (✅ SHIPPED, PR #93 — `lib/attributions.ts`, `/legal/attributions`, and the native You → About screens), never by attaching a source field to a row. The two are not in conflict once the distinction is explicit:

| | Allowed | Forbidden |
|---|---|---|
| **Per record** | our IDs + clean facts | any source id, URL, slug, or "came from X" column |
| **Corpus level** | naming sources + licence text on the attributions surface | — |

The reason the per-record rule stands independently of licensing: a source id on a row is a join key back into someone else's identity space, which re-couples our catalog to theirs and outlives whatever agreement allowed it. Attribution costs us nothing and is often required; per-record provenance buys nothing and is a lasting entanglement.

## v1 data model

Four catalog tables plus two link columns on the existing `wines`. All PKs are 21-char nanoids (`VarChar(21)`, matching `wines.id`). Enumerated columns are `varchar` + `CHECK` (house convention — no PG enums).

**`producers`** — first-class maker. Producer means the **label/brand identity users see and search for**, not necessarily the legal producing house (a future label-brand → legal-house relationship is additive). Generic product names ("Réserve", "Brut") are **producer-scoped** — they collide constantly across producers and never merge across them.
- `id`, `name` (display, accents preserved), `nameFolded` (generated — see naming), `country`, `region` + `regionFolded` (transitional, see region/grape), `website`, `status`, `linksTo` (nullable self-FK), `curatorLocked`, `addedBy` (nullable FK → users, `SetNull`), `curatedBy` (same), timestamps.

**`wine_products`** — the product (groups vintages). The primary mergeable entity.
- `id`, `name` + `nameFolded`, `category` (`wine` today; extensible), `style` (nullable; composite FK `(category, style)` → `category_styles`, like `wines`; values red/white/rosé/`spark`; `nonalc` is **transitional** — supported for v1 compatibility but not locked as permanent style identity, since ABV/alcohol attributes are the intended direction; dessert/fortified deferred), `abv` (nullable `Decimal` — every API response must coerce via `Number()` per the wire-format trap), `grapes` (**non-null** `text[]`, default `{}`) + `grapesFolded` (generated `text[]`, element-wise through the same fold helper), `region` + `regionFolded` (optional override of producer region; see region/grape), `scope`, `status`, `linksTo`, `curatorLocked`, `addedBy`/`curatedBy` (`SetNull`), timestamps.
- **`grapes` is non-null and `{}` means "no grapes recorded".** Prisma cannot model an optional scalar list, so `{}` is the sole representation of unrecorded and is therefore **enrichable**; there is no known-empty state **on this table**, and a deliberate empty becomes authoritative only via `curatorLocked`. (`wine_vintages` DOES have one, via `grapes_override` — see the vintage grain.) See the implementation plan § Arrays are non-null.
- **`scope`** (`shared` | `owned`) is reserved for the deferred ownership axis. **Every write boundary sets `scope` explicitly** — creation paths reject a missing scope rather than relying on the column default, so a future `owned` entry can never leak to public because a caller omitted the field.

**`product_producers`** — many-to-many product ↔ producer with `role` (`lead` | `collaborator`). **Every product has exactly one `lead`** (plus 0..n collaborators). **Exactly-one-lead takes three separate pieces, not two** — see the implementation plan § Exactly one lead for the enforcement detail and the ordering traps:

1. **At most one** — a partial unique index on `(product_id) WHERE role = 'lead'`. The composite PK does *not* give this (verified: it blocks duplicate *pairs* while happily allowing two different producers both marked `lead`).
2. **At least one at creation** — product + its lead link commit in one transaction, and an import batch carrying a new product carries its lead row too.
3. **At least one over time** — deleting the sole lead **or demoting it to collaborator** leaves zero leads. Both are rejected; replacement is atomic (and may be a promotion, not only an insert).

The single-producer case is simply lead-with-no-collaborators. A collaboration is one product with 2+ links, set at creation — NOT a merge.

**`wine_vintages`** — the rating grain. Carries `grapes` + `grapes_override` as well as `abv`: blend proportions shift year to year and a producer may drop a variety outright in a difficult vintage, so a product-only composition cannot record what is actually in the bottle. 🔒 **The flag is required, not stylistic** — Prisma returns `[]` for BOTH `NULL` and `{}` on a scalar list (measured), so a nullable array cannot distinguish "inherit the product's" from "genuinely none listed" in any application read path. Effective value is `CASE WHEN grapes_override THEN vintage.grapes ELSE product.grapes END`, never `COALESCE`. Added by `20260726090000_vintage_grapes_override` — ⚠️ **a versioned-contract change**, see § Data contract.
- `id`, `productId` (FK), `year` (nullable), `abv` (nullable per-vintage override), `status`, `linksTo`, `curatorLocked`, `addedBy`/`curatedBy` (`SetNull`), timestamps.
- **`year = null` means the non-vintage instance exclusively — never "year unknown".** An unknown-year rating links at product level instead (see below), so NV rows stay clean.
- 🔒 **Year is validated at three layers, deliberately asymmetric — and the import path only ever meets one of them.**

  | Layer | Rule | Where |
  |---|---|---|
  | Encounter text | structural grammar only; no range | `@verre/core` `normalizeVintageText` |
  | Route boundary | `1900..current+1` | `validateYear`, `lib/catalogWrite.ts` |
  | DB constraint | `1800..2200` | `wine_vintages_year_range_check` |

  The DB bound is a **garbage fence** — deliberately wide, catching a typo'd `20255`. The plausibility rule is a **route-boundary rule**, tighter and clock-relative, because "plausible" moves with the calendar and a CHECK cannot. 🔒 **And the import path has no route boundary** — imports do not call `validateYear`, so imported vintages are governed by `1800..2200` alone.

  ⚠️ **That last clause is the one that matters, and its absence is what made this exchange necessary.** The layering was documented at `lib/catalogWrite.ts:200-203` and at the constraint itself — both places the catalog-maintenance side has no reason to read. Documented in the code is not documented in the contract.

  Consequence, surfaced by the maintenance side (2026-08-11): their own extraction fence was `1900..current+1` evaluated against the wall clock, narrower than ours in both directions. One direction is safe — they can only send a subset of what we accept. The other is not: a legitimate 1850 fortified, or a 2028 entry, is something the app can hold and they could not store. They are **widening to `1800..2200` to match the DB fence** and keeping the tighter rule at extraction time, frozen to the source rather than the clock. Done while the table is still empty.

  ⚠️ **Do not "align" the three layers.** A range in the shared write normalizer was tried and reverted — it runs on every edit resend, so it blanked stored out-of-range values the moment a user touched any other field. The out-of-range round-trip pins in `scripts/tests/vintage-text-units.ts` fail if it is reintroduced.
- **Uniqueness: one row per year and one NV row per product** — `UNIQUE NULLS NOT DISTINCT (product_id, year)`, or equivalently two partial unique indexes (non-null years; the null NV row). A plain compound unique would allow multiple null-year rows. Raw-SQL migration (Prisma can't express either form).
- Additionally `UNIQUE (id, product_id)` — redundant with the PK, but it enables the composite-FK integrity check on `wines` below.

**`wines.productId` + `wines.vintageId`** — the existing per-session/per-checkin `wines` instance links to the catalog at **two grains**, because `year = null` is NV-only:

| State | `productId` | `vintageId` |
|---|---|---|
| Known vintage (or NV row chosen) | set | set |
| Known product, unknown year | set | null |
| Legacy / unmatched | null | null |

- `vintageId` set with `productId` null is invalid — enforced by `CHECK (vintage_id IS NULL OR product_id IS NOT NULL)` (the composite FK below is MATCH SIMPLE, so it alone would not catch this: it skips checking whenever any column is null). A chosen vintage **must belong to the stored product** — enforced structurally by a composite FK `(vintageId, productId)` → `wine_vintages (id, product_id)` (checked exactly when both are set), alongside the plain FK on `productId`.
- Set by the add-flow from an **explicit user choice** or a freshly-minted provisional — never by a string match (sole exception: the legacy backfill, § below).
- **Catalog deletion is never implicit — with one declared exception.** Eight of the nine forward FKs into catalog tables (`wines.productId`, `wines.vintageId`, `wine_vintages.productId`, `wine_vintages.linksTo`, `producers.linksTo`, `wine_products.linksTo`, `product_producers.producerId`, `product_eans.productId`) are declared `NoAction`/`Restrict`; **`product_producers.productId` is the sole intentional `Cascade`**, so a product referenced only by its own join rows deletes successfully and cascades them — ordinary lifecycle never deletes rows, and an `ON DELETE SET NULL` on the composite FK would wrongly null *both* columns when only the vintage disappears. The exceptional hard-purge operation (§ Lifecycle) performs the exact transitions itself, in one transaction:
  - **Vintage purge:** re-point or clear inbound vintage `linksTo` (tombstones pointing at the purged row), `UPDATE wines SET vintage_id = NULL` for the purged vintage — `productId` is retained (the wine stays linked at product grain) — then delete the vintage row.
  - **Product purge:** purge its vintages first (`wine_vintages.productId` is `Restrict`, which forces this ordering), delete its `product_producers` rows, re-point or clear inbound product `linksTo`, then `UPDATE wines SET product_id = NULL`, then delete the product row.
  - **Producer purge:** only valid once no `product_producers` row references it — its products are re-pointed to another producer (respecting exactly-one-lead) or purged first — plus inbound producer `linksTo` re-pointed or cleared; then delete the producer row.
  - **General rule:** purge resolves *every* inbound reference — same-grain `linksTo`, child rows, join rows, `wines` links — inside the one transaction. The `Restrict` FKs are the backstop: a purge that forgets a reference class fails and rolls back rather than half-applying.
- Both link columns stay **mutable** on the wine instance and vintage/product identity is never denormalized onto `ratings` — this keeps a future user-correction **re-link** feature (moving one mis-recorded instance to the right vintage) possible without schema change. Not a v1 feature; just not foreclosed.
- `ratings` hang off `wines` unchanged; aggregation rolls `ratings → wines → vintage → product`, resolving `linksTo` transitively.

**Account deletion:** `addedBy`/`curatedBy` null out via `SetNull`; community catalog rows are **never** cascaded by a user deletion. `lib/accountDelete.ts` needs no catalog-row handling beyond what `SetNull` gives, but its tests should pin that.

### Display vs folded names

`name` preserves the display form verbatim — accents, and whatever spacing the user typed; `nameFolded` is the **matching key** (`catalog_fold_v1(name)`, as shipped) used by every fuzzy query. One value cannot serve both jobs. The folded value is produced by **one mandatory database-side normalization path** — a generated column — so no write path can make display and fold drift. ⚠️ **Whitespace canonicalization belongs in that path too** (`20260725220000_catalog_fold_whitespace`): app-side trimming is real but is TypeScript-only, and the import path bypasses it. See `prisma/CLAUDE.md` for the function's ordering and the versioning rule. ⚠️ **The fold lowercases LAST.** `f_unaccent(lower(…))` was the phase-1 form and it is wrong: some unaccent expansions produce capitals, so lowercasing first leaves uppercase in the "folded" value (`'Cuvée № 5'` → `cuvee No 5`) and two spellings of one name compare unequal. Corrected in `20260725140000_catalog_fold_order`; details in `prisma/CLAUDE.md`. Two indexes go on `nameFolded` (raw-SQL migration): a **GiST** trigram index for the KNN ordering that search uses, and a **covering B-tree** for folded equality. GIN was dropped — it is the wrong structure for `=` and nothing issues a containment query.

### Field grain

- **Producer**: brand name, country, base region, website.
- **Product**: name, category, style, base ABV, grapes, optional region override.
- **Vintage**: year, per-vintage ABV override, per-vintage **grape override** (`grapes` + `grapesOverride`).
- **Product↔producer**: M:N with role.

### Region + grape: transitional strings, reserved entities

v1 stores region and grape with the same display/fold split as names: `region` (`varchar`, accented display) + `regionFolded` (generated, lowercase-last) on `producers` and `wine_products`; `grapes` (`text[]`, display) + `grapesFolded` (generated `text[]`, each element folded through an immutable SQL helper wrapping the same lowercase-last path). All folded values are database-generated — no write path can make display and fold drift. Both fields are **explicitly transitional**: the final design is first-class **Verre-owned entities** — a region tree (country → region → subregion → appellation) and a **grape-variety tree** (descendants, synonyms/aliases) — landing additively as new tables + join tables **without changing any producer/product/vintage ID**. No source-side structured region/grape identifiers are persisted to build from (provenance rule); the trees are built later against Verre identity.

### Curator-locked fields

Fill-null enrichment cannot distinguish "unknown" from "a curator deliberately cleared an incorrect value." Each catalog row carries `curatorLocked` (a list of field names, e.g. `text[]`): a locked field's null is authoritative — the import path never fills it and read-time group coalescing never fills it. Set/cleared by curators only.

**This covers array fields too, and on `wine_products` it is the only mechanism available.** A scalar has NULL to mean unrecorded, so an unlocked non-null scalar is already safe from enrichment. `wine_products.grapes` is non-null (see § v1 data model), so `{}` means unrecorded and is enrichable by default — **a locked `{}` is the only way "this product genuinely has no grapes listed" becomes authoritative.** ⚠️ **`wine_vintages` is the exception**: its `grapes_override` boolean carries the known-empty state directly, so a vintage asserting "genuinely none" needs no curator lock. The flag exists because a nullable array could not express it — Prisma returns `[]` for both `NULL` and `{}` on a scalar list.

## Lifecycle

`status`: `provisional` | `confirmed` | `linked` | `archived` | `rejected` (varchar + CHECK).

Structurally enforced on every catalog table: `CHECK ((status = 'linked') = (links_to IS NOT NULL))` and `CHECK (links_to <> id)` — a tombstone always has a pointer, a pointer always means `linked`, and no row links to itself. Merge and unmerge update status, pointer, and the audit record **atomically in one transaction**, so a partial write can never produce an unreadable tombstone.

| Status | Search / add-suggestions | Pages / links | Notes |
|---|---|---|---|
| `confirmed` | yes / yes | yes | normal entry; seed + curator-confirmed |
| `provisional` | yes, ranked below confirmed / yes | yes | every user-minted entry starts here |
| `linked` | resolves to survivor | resolves to survivor | merge tombstone; transitive |
| `archived` | findable / **excluded** | fully intact | discontinued; ratings/history keep working |
| `rejected` | hidden / hidden | row + FKs retained | curator junk verdict; **not blocked by existing `wines` references** — links keep resolving, the entry just leaves the public catalog |
| *(hard purge)* | — | — | **not a status**: an exceptional, audited staff moderation deletion (abuse/obscenity) with explicit reference handling — exact column transitions + ordering in § v1 data model. Never part of merge, never reachable via import. |

- A merge **survivor cannot be `rejected`** while tombstones still point at it — unmerge/resolve the linked group first.
- "Flagged/reported" is a separate orthogonal signal, not a status (an entry can be `confirmed` *and* flagged).
- **One ID for life.** An entry keeps exactly one nanoid forever — through confirmation, merge, unmerge, archive. Nothing ever re-mints. This is the invariant that keeps every `wines` link safe across all future maintenance.
- **Authority (v1):** confirm / merge / unmerge / reject / edit-confirmed / purge are staff powers. The account-level role axis that carries them is **`staff_roles`** (`admin` | `curator`, shipped in phase 1; resolver + permission map in `lib/staffRole.ts`) — distinct from session roles (host/cohost/provider). Note the permission map reserves `admin` for hard-purge and role-granting; the rest are curator-level. Machine maintenance never impersonates a human role (§ Catalog maintenance).

### Merge = pointer + lifecycle only

- Merge sets the loser's `status = linked` and `linksTo = <target>`. **Nothing else.** No facts, producer links, or child rows are copied into the survivor — copying would contaminate it after an unmerge.
- **Chains are kept, not flattened.** With A→B then B→C, flattening A to A→C would break single-update unmerge (clearing B→C could not restore A→B). Reads resolve the chain transitively with a **visited set and a depth cap**, so corrupt data fails safely instead of looping.
- **Concurrency-safe cycle prevention:** writes reject self-links and cycles by resolving the full target path and writing the pointer **in one transaction** under deterministic row locks (or an entity-type-scoped advisory lock) — an unlocked preflight lets concurrent A→B and B→A both pass.
- **Empty losers are tombstones too.** A loser with zero ratings still becomes a weightless `linked` row — never a delete — so every merge is uniformly reversible. If ancient tombstones ever accumulate enough to matter, sweeping them is a separate later maintenance op (mirroring the session soft-delete cleanup), never part of merge.
- **Read-time group fact-coalescing:** where the survivor is missing a fact, reads may resolve across the linked group — the survivor's own non-null value always wins; a curator-locked null stays null; compatible linked values may fill the read; conflicting linked values stay unresolved (null). Ratings and aggregate membership resolve through the same effective-entity chain without moving rows.
- **Ratings never move.** They stay on their original `wines`/vintage and resolve through the pointer at read time — so the survivor shows every merged entry's ratings and **unmerge is a single pointer update**.

### Unmerge: restoration + audit

Clearing `linksTo` is one row update, but it must also choose the restored lifecycle state: the merge record captures the loser's **prior status**, and unmerge restores exactly that (a pre-merge `provisional` does not come back `confirmed`). Every merge and unmerge writes an app-side **`catalog_audit`** row — `entityType` (producer|product|vintage), `entityId` (the loser), `targetId` (the merge target; null for non-merge actions), `action`, `priorStatus`, `actor`, `createdAt`, optional `reason` — **in the same transaction** as the status/pointer update, so repeated merge/unmerge cycles are always reconstructible. The same table records confirm, reject, archive, lock-field, and purge actions. (App-only bookkeeping, not part of the import contract.)

### Product × vintage merges compose

If product A is merged into B, **A's vintages remain children of A** — nothing re-parents. Aggregates resolve the *effective* product transitively without moving ratings or vintages. If both branches contain the same year, the product page shows **one logical year** grouping the distinct underlying vintage rows — a render-time grouping, never a destructive consolidation. Collapsing two same-year vintage rows for real is a separate, explicit **vintage merge** (`linksTo` at vintage grain, same semantics), which a curator may do after the product merge — the two operations compose but neither implies the other.

**Vintage-merge eligibility (uniform rule):** two vintage rows may merge iff their years match (or both are the NV row) **and** they resolve to the same *effective* product — same stored `productId`, or stored products linked into one effective product. Cross-effective-product vintage merges are forbidden, mirroring the producer rule one level up.

### Merge-suggestion policy

The fuzzy signal is deliberately conservative — **false splits are acceptable; false merges are the expensive failure**:

- Uncertain pairs stay distinct. No confidence → no suggestion.
- **Cross-producer product merges are forbidden.** Product suggestions require the **complete effective producer set — roles included — to match** (each linked producer resolved through its `linksTo` first). A collaboration `{A, B}` and a collaboration `{A, C}` share a producer but are NOT mergeable; neither is `{A}` with `{A, B}`. Duplicate producers are resolved first; products under genuinely different producer sets remain distinct.
- **Attribute veto:** conflicting `style` or `abv` (where both values exist) kills a suggestion.
- Strong identifiers (e.g. a shared EAN, § below) may **raise** confidence — they never make matching destructive.

### Vintage curation is lightweight

The review queue's merge unit is the **producer/product** grain. Vintages don't need the heavyweight duplicate queue: under an explicitly chosen product, a missing vintage is accepted directly when the year is plausible (≈1900..current year + 1) or null for the NV instance. The `(product_id, year)` uniqueness constraint is what prevents duplicates at this grain; vintage dedup (rare) is a lighter merge with the same `linksTo` semantics, gated by the vintage-merge eligibility rule above (matching year/NV + same *effective* product).

## Add-a-wine flow

Search-first, three-level, and **one fuzzy MODULE**: add-time search, review-queue suggestions, and post-import rescans share one `pg_trgm` implementation over `nameFolded` — one fold, one scoring function, no second matcher to drift (the old TS/SQL-parity CI-gate debt is struck). 🔒 **Two query SHAPES within it** (ruled 2026-07-26): the interactive callers are **KNN top-N** (rank, return *n*); post-import bulk duplicate detection needs **everything above a threshold**, which top-N cannot express at any *n*. Explicit branches so an absent vintage or product can never mint a duplicate at the wrong grain:

1. **Existing producer → existing product → existing vintage** — pick it; `wines.productId + vintageId` set. No new catalog row.
2. **Existing product, missing vintage** — user supplies a plausible year (or NV) → mint the vintage row directly under that product (lightweight rule above). Unknown year → link at **product level** (`vintageId` null); the year can be supplied later.
3. **Existing producer, missing product** — mint a `provisional` product (+ vintage or product-level link) under that producer.
4. **Nothing matches** — mint a `provisional` producer + product (+ optional vintage), all distinct.
5. **Collaboration** — a product may take 2+ producer links at creation (`product_producers`), lead + collaborators.

Provisional entries are immediately usable and ratable. User-minted provisionals enter the app-side **review queue**, where the same fuzzy query surfaces likely duplicates for a curator to confirm, merge (reversibly), or reject. Nobody is blocked from adding; nothing auto-collapses.

### Identity-changing wine edits

Wine-instance fields (`name`, `producer`, `vintage`) are **historical snapshots** — they do not derive from live catalog facts. But an edit that changes the instance's *identity* (producer, name, year) must not silently retain a now-incompatible link: the edit path **clears `productId`/`vintageId` unless the editor explicitly re-links** through the same add-flow search. Cosmetic edits (photo, description, typo-level name fix confirmed against the same catalog entry) keep the link.

## Redis-first link design

Active session wines live in Redis (`s:{CODE}:wines`, 48h+ TTL) and archive to Postgres incrementally. The catalog link must survive that whole path:

- **Storage:** `productId`/`vintageId` are optional fields on the Redis wine JSON, set by the add-flow at wine-create. All list writes go through `mutateWines` (KEEPTTL preserved as always).
- **Mirroring:** every path that writes a `wines` row from Redis state — rate/visit archival, wine edits, brought-by reassignment, session archive — carries both fields verbatim. Wine-edit paths must round-trip fields they don't touch; the identity-changing-edit rule above is applied in the edit handler before the mirror.
- **Anonymous sessions:** anon sessions stay Redis-only, so links live and die with the session like every other wine field. If a logged-in participant's action archives a wine, the link archives with it — anon-added wines keep their links through archival.
- 🔒 **Blind redaction:** catalog IDs are label identity. `wineToWire`'s blind redaction strips `productId` and `vintageId` from every redacted payload, exactly like name/producer — a catalog ID in a blind payload is a lookup oracle for the label. (Whether an unrevealed blind wine's *provisional catalog row* is publicly searchable was a separate decision — **RESOLVED: the catalog stays open**, § Open decisions — RESOLVED ruling 3. 🔒 That ruling is contingent on catalog records being visually indistinguishable by state to end users; a surface exposing `status`, `createdAt`, or adder identity in public catalog search reopens it.)

## Legacy backfill (migration-only exception)

Existing `wines` rows predate the catalog. A one-time backfill links them — the **sole exception** to "links are never set by strings", and it is exact-match-only, never fuzzy:

- Auto-link only a **unique exact** producer + product match (folded-name equality, not similarity).
- 🔒 **The vintage string resolves in THREE cases, not two** (data side, 2026-07-26). The two-case rule filed the literal token `NV` as garbage and dropped a real non-vintage fact to product grain — and prod already holds one: `Blanc de Blancs | Charles Heidsieck | NV`.
  1. **Parseable plausible year** → that vintage row.
  2. **Literal NV token** (`NV`, `N.V.`, `NV.`, `non-vintage`, case-insensitive) → the **NV row** (`year = null`), which is a positive fact, not an absence.
  3. **Anything else** — garbage, unreadable, **or blank** → product level, no vintage row.
  ⚠️ **Blank stays in case 3 deliberately.** It is genuinely ambiguous between "unknown year" and "NV", so the safe default is to under-claim and let a human promote it later. **Never infer NV from the style** — a sparkling wine is not thereby non-vintage.
- Ambiguous rows are never fuzzy-linked; they stay `(null, null)`. ⚠️ **This is about PRODUCER/PRODUCT identity, not the vintage string.** An unparseable vintage after an EXACT product match does not strand the row — it stays **product-linked** (`productId` set, `vintageId` null), which is case 3 above.
- 🔒 **Token handling:** scrub + trim, then a **case-insensitive exact allowlist** — **four tokens**: `NV`, `N.V.`, `NV.`, `non-vintage`. Not a substring or prefix test — `"NV Selection"` is a wine name, not a non-vintage marker. Trim surrounding whitespace before matching; never strip internal punctuation. ⚠️ `NV.` was missing from an earlier statement of this list and from the first client implementation; the client normalizer (`@verre/core` `normalizeVintageText`) and this allowlist MUST hold the same four, or a token one side accepts is one the other files as garbage.
- 🔒 **The backfill NEVER MINTS a missing year or NV row.** It links to vintages that already exist under the matched product; if the year (or the NV row) is absent, the row links at product grain. Minting from a legacy string would be creating catalog identity from a string match, which is the one thing this exception does not license.
- The unmatched remainder is not stranded forever: it feeds the same **provisional review path** (surfaced as link-suggestions for curators/users), rather than remaining permanently outside the catalog.

## Catalog maintenance (import/refresh contract)

Ongoing catalog writes have **one owner — the app**: an internal authenticated import path. Nothing else holds prod DB credentials. The one-time initial seed against a completely fresh catalog is the sole direct exception (fenced below).

- **Identity:** machine writes authenticate as a dedicated, **rotatable service principal** with narrow catalog-write scope — never a human user or admin role.
- **Batches:** stable-ID keyed (our nanoids), resumable, idempotent. Each batch carries a manifest (hash + counts) and a **monotonic sequence number**; stale replays are rejected. An import concludes with an **explicit finalize**.
- **Explicit ACK:** each batch's application is confirmed by an explicit acknowledgement; the caller may treat only ACK'd batches as applied, and a failed/unacknowledged batch is re-submittable idempotently. Without this, a mid-batch failure could be recorded as applied caller-side while prod never applied it — and diff-based retry would never re-send it.
- **Fact rules — enforced server-side at apply time**, not delegated to the caller's read-before-write (otherwise a curator edit landing between the caller's read and write is silently reverted):
  - **`status` and `linksTo` are never accepted from the caller and never updated by import.** On insert the **server itself** assigns `status = 'confirmed'` and `linksTo = null`; on update neither field is touched. ("Lives only in the INSERT arm" described where the value is written, which read as though the caller supplied it — the point is that the value is server-assigned.) Lifecycle transitions are staff actions only.
  - Existing non-null facts are never overwritten automatically — per-field `COALESCE(existing, incoming)` semantics in the write itself. **Product array facts are the exception**: `wine_products.grapes` is non-null, so an empty array is the only representation of *unrecorded* and IS enrichable by a non-empty incoming value (a locked `{}` still wins). ⚠️ **Vintage grapes invert this** — under `grapes_override = true` the array is an assertion, including `{}`, and is never enriched. See the implementation plan § Arrays are non-null.
  - Null facts may be enriched **unless curator-locked** — the `curatorLocked` exclusion applied server-side.
- **Abort fence:** a batch whose change volume is unexpectedly large (relative to catalog size / declared counts) trips an abort instead of applying.
- **Import never deletes.** Absence from a batch is never deletion, and the import path has no delete operation at all — removing a catalog row is exclusively the audited staff **hard purge** (§ Lifecycle), which the import identity is not authorized to perform. An upstream retraction arrives as an explicit retraction record that only **flags** the entry for staff review (toward `archived`/`rejected`/purge, decided by a human).
- **Post-finalize rescan:** finalize triggers an async rerun of the same `pg_trgm` suggestion query over open provisionals × newly confirmed entries — catching the race where a user minted provisional X before the equivalent confirmed Y existed.

### Seed + the truncate fence

The initial seed runs once against a fresh catalog and mints our nanoids; all seed rows land `confirmed`. **Truncate + reload is valid only while the catalog is fresh — before any `wines.productId`/`vintageId` exists. After the first user link it is forbidden, permanently**, and enforced: the seed script refuses to run if `SELECT 1 FROM wines WHERE product_id IS NOT NULL OR vintage_id IS NOT NULL LIMIT 1` returns a row. **Once the import path is live (phase 4)**, all later refreshes are ID-keyed upserts through it — update in place, insert new, never delete-and-recreate — so identities and every user link survive every refresh. Before then, see the window below.

⚠️ **CORRECTED (2026-07-26): "all later refreshes go through the import path" has a WINDOW where it is false, and the window is a known accepted gap rather than an oversight.** `CATALOG_PUBLIC_ENABLED` opens **with the model-change phase**, so users can link wines — which permanently kills truncate+reload — while the import/pull endpoint is **phase 4**, two phases later. Between those two points a seed defect has **no designed correction channel**: truncate is forbidden (a user has linked), and the import path does not exist yet.

🔒 **RULED (2026-07-26): accept the window explicitly as manual-and-rare.** At the scale this window covers a manual fix is tractable, and pulling phase 4's endpoint forward means pulling a whole subsystem (session OPEN, per-batch transactions, ACK-in-transaction, idempotency on `(sessionId, batchIndex)`) plus delaying the fence. A narrower correction-only upsert path was also rejected: it is a second write path with a scheduled death date, and throwaway code that ships to prod stops being throwaway.

**What a manual fix in that window owes**, sorted by what it does — only one case matters. A manual fix bypasses the app write path, so **no change-journal event fires** (the journal appends in the same transaction as the domain change, and hand-written SQL is outside that transaction by construction — that is what "same transaction" means, not a journal gap):

| manual operation | reaches the pull leg? |
|---|---|
| `UPDATE` a fact | ✅ safe — the first pull is a consistent baseline and carries the corrected value regardless |
| re-point (`linksTo`, an EAN moved between products) | ✅ safe, same reason |
| **`DELETE`** | 🔴 **permanently invisible — hand over `(entityType, entityId)` out of band** |

🔒 **The delete case does not self-heal at phase 4.** The baseline simply lacks the row, and deletion is never inferred from absence (a missing row and a not-yet-pulled row are indistinguishable *by design* — inferring deletion from absence is how merged entities resurrect). So a deleted entity would be believed to exist, permanently, with nothing to contradict it. Unlike a mint note, which is a stopgap until phase 4 can carry it, for deletes the out-of-band note is the ONLY carrier, forever.

⭐ **The FK posture narrows this, but NOT uniformly — there is one deliberate `Cascade`.** Enumerated from `schema.prisma`, forward sides only:

| Referencing row | → target | `onDelete` |
|---|---|---|
| `wines.product_id` | `wine_products` | `NoAction` |
| `wines.(vintage_id, product_id)` | `wine_vintages` | `NoAction` |
| `producers.links_to` | `producers` | `NoAction` |
| `wine_products.links_to` | `wine_products` | `NoAction` |
| `wine_vintages.product_id` | `wine_products` | `NoAction` |
| `wine_vintages.links_to` | `wine_vintages` | `NoAction` |
| `product_producers.producer_id` | `producers` | `NoAction` |
| `product_eans.product_id` | `wine_products` | `NoAction` |
| **`product_producers.product_id`** | **`wine_products`** | **`Cascade`** ⚠️ |

The `Cascade` is intentional and documented at the column: a purge deletes the product's join rows inside its own transaction, and the deferred lead-producer trigger carves out the parent-gone case (otherwise the lead invariant would block its own cleanup). The producer side stays `NoAction` — a producer purge is valid only once no join row references it.

**So the guarantee is narrower than "nothing cascades":** deleting a **producer** or a **vintage** fails loudly if anything still points at it, and deleting a **product** fails loudly for every reference *except* its own `product_producers` join rows, which go with it by design. So a manual `DELETE` of a **producer** or **vintage** that is still referenced cannot quietly succeed. ⚠️ A **product** can: if its only remaining references are its own `product_producers` join rows, the delete succeeds and cascades them. That case is the one the ledger below has to catch, because the database will not stop it. Keep both the FK and the note: the FK stops the careless case, the note carries the deliberate one, and neither substitutes for the other.

**The note's procedure — durable location, owner, and consumption step.** An accepted gap with no executable procedure is not a procedure:

| | |
|---|---|
| **What** | `(entityType, entityId)` per deleted catalog row — nothing else is required |
| **Where** | `docs/dev/catalog-manual-deletions.md` — tracked, append-only, already in the repo. Not chat, not a ticket comment, not a gitignored file: the carrier has to outlive the incident and stay greppable years later |
| **Owner** | whoever performs the manual fix. 🔒 **The entry is committed BEFORE the destructive SQL runs** (`planned`), then advanced to `applied` after — a Git document and a database deletion cannot be atomic, and a deletion whose record was forgotten afterwards is invisible forever. A `planned` entry for a deletion that never happened is harmless; the reverse is not |
| **Consumed by** | phase 4, as a **precondition on accepting any import session or creating the initial baseline**: each id is seeded idempotently into the persistent purge ledger (which emits the deletion and rejects resurrection of that id), and only then is the entry marked reconciled — kept, never removed, since the log is append-only history. Emitting to a feed alone is insufficient: an import arriving first could recreate the row. See the implementation plan § Phase 4 purge events. |
| **Why append-only** | absence and not-yet-pulled are indistinguishable by design, so a removed entry is indistinguishable from one that never existed |

⚠️ Until phase 4 exists there is no automated consumer, which is exactly why the durable location matters: the log is the only thing bridging the window.

## EAN

Barcodes are **product-grain**: `product_eans` (`ean` → `productId`, unique on ean), part of the import interface. In matching, a shared EAN is a confidence-raising signal only (§ merge-suggestion policy), never an auto-merge key — an EAN already held by another product is a conflict for staff review, never an automatic reassignment.

**Moved into v1** (was "reserved, Phase 2"): prod carries EANs, and they give a hard identity key for deduping user adds instead of leaning on fuzzy name match alone. Ships in phase 1 of the implementation plan. Column semantics (string preserving leading zeros, write-once `firstSeen`, monotonic `lastSeen`, app-side confidence) and the deferred-ACK conflict protocol: see the plan § EAN semantics + § EAN conflict → deferred.

## Open decisions — RESOLVED (2026-07-24)

All three are ruled; nothing in this doc is blocked. Implementation plan: `docs/dev/proposals/wine-catalog-implementation.md`.

1. **Account-level user roles → a separate `staff_roles` table.** Not `users.role`. That column is dead (`@default("taster")`, read by nothing; the heavily-used `SessionMember.role` is the unrelated *session* axis) and it stays — `prisma/CLAUDE.md` is corrected to record it as dead and point here, rather than carrying a destructive migration in a catalog PR. A privilege bit on `users` would sit on the hottest table in the app, reachable by every existing `prisma.user.update` and by Better Auth's own writes into `users`; a separate table has no existing write path at all (the same safe-by-construction reasoning as the `lib/identityStore.ts` credential chokepoint). Shape: `userId` + `role` (`admin` | `curator`, varchar + CHECK) as PK, `grantedBy` (`SetNull`), `grantedAt`. **`admin` implies `curator`** — the resolver answers a curator check affirmatively for an admin grant, so each person needs one row. Account deletion cascades the grant; history survives independently in the audit table. Gated work (review queue, merge/reject/purge) is unblocked.
2. **Import endpoint → bearer service principal + synchronous apply, ACK written in the apply transaction.** No per-batch HMAC (a second secret with its own rotation story, against a threat that TLS to our own host already covers — the manifest hash gives transit-corruption detection); no mTLS (the termination story fights the platform). Full contract in the implementation plan § Phase 4; the load-bearing amendments over a naive synchronous design are: the ACK row commits in the *same* transaction as the rows and is readable by `GET` on the sequence (a 200 alone re-opens the hole it exists to close, when the response is lost to a timeout or a deploy restart); idempotency keyed on `(sessionId, batchIndex)` with the manifest hash stored and compared, replaying the original ACK on same/same and returning 409 on same-key/different-hash, so it is a mistake-detector rather than a dedup convenience (the monotonic cycle sequence stays separate — it orders *sessions* against replay, while the batch index orders *batches within* a session); an explicit session **OPEN** declaring expected counts by entity type (a per-batch abort fence cannot work — batch 1 doesn't know the session total, so a "% of catalog" fence would only fire after most of the damage landed); and one transaction per batch, all-or-nothing, without which the idempotency key means nothing. Gates only the import path.
3. **Blind-session provisional discoverability → accept and document. The catalog stays open.** No suppression marker, no expiry sweep. Stripping catalog IDs from blind payloads (§ Redis-first link design) is locked and unchanged — this decision is only about catalog-side search. **The exposure is bounded by uniform record presentation:** catalog records are visually indistinguishable by state to end users — no provisional badge, no "recently added", no adder attribution — so a participant cannot filter to entries minted during their session, and finding one label among a catalog of that size requires already suspecting it. 🔒 **This ruling is contingent on that property.** A future surface that exposes `status`, `createdAt`, or adder identity in public catalog search — a "recently added" filter, a provisional badge — reopens this decision and must re-derive it.

## Deferred (Phase 2+), but schema-ready now

`owned` scope; the **organization** entity + membership roles; **ownership sets** `(ownerType: user|org, ownerId)`; per-entry **view/edit grants** (public|granted); **producer verification/claiming** + producer-scoped edit authority (authoritative on factual fields, zero control over community ratings/aggregates, cannot hide/delete a rated `shared` entry); **co-owner consent** (joint-account: reversible-alone / destructive-needs-all); scope promotion `owned → shared` (one-way trapdoor that permanently surrenders delete/hide); label-brand → legal-house producer relationships; region + grape entities/trees. (`product_eans` was here; it moved into v1 — see § EAN.) The `scope` column + merge/lifecycle machinery are shaped so these land as additive tables + columns, not a re-key.

## Carry-forward

- **Reusable from #82:** the web product page, the aggregate query (re-pointed at vintage→product roll-up + transitive `linksTo` resolution + expiry parity), the mobile screen, the review-fix regression tests.
- **Struck:** the #82 "TS/SQL fuzzy-parity CI gate" debt — there is exactly one matcher (`pg_trgm` over `nameFolded`), no TS twin.

## Resolved decisions (ledger)

- Source ids / region ids in prod — **no** (2026-07-23; withdraws the earlier keep-opaque-ids refinement).
- `linksTo` chains — **keep + resolve transitively** (supersedes the earlier flatten-on-write comment).
- Merge unit — product primary; vintage additions lightweight, vintage merges a lighter case of the same machinery (matching year/NV + same effective product).
- `year = null` — NV exclusively; unknown-year links at product grain (hence `wines.productId`).
- Region/grape v1 — transitional strings; Verre-owned trees later, additively.
- Dessert/Fortified styles — deferred; `nonalc` transitional.
