# Catalog wine attributes: colour, sparkling, style

**Status: SHIPPED (2026-11-09)**: PR #106, merge `e63bc79`, migration `20261109120000_catalog_colour_sparkling` applied on prod 2026-11-09 11:13 UTC, contract v2. Reported to the catalog-maintenance side the same day with the definitions measured on prod; they confirmed them against their pins. ⚠️ **Their dessert/fortified release is still held, on their side:** their own entries are being converted from the single style value to colour / sparkling / style first, and they announce before anything new reaches us. ⚠️ **Heads-up from them:** `colour` will be NULL on part of the catalog, mostly sparkling and dessert/fortified wines, so nothing may assume a colour is present (recorded for the model change, `wine-catalog-model-change.md` § 9).

**As built (deltas from the plan below):** the migration takes `LOCK TABLE wine_products IN ACCESS EXCLUSIVE MODE` right after the `lock_timeout`, so the refusal reads a table nothing can write to before the CHECKs land; its predicate is the negation of the style CHECK rather than a list of the five old tokens (equivalent under the FK). ⚠️ The refusal's message does **not** reach the deploy output: Prisma prints only "current transaction is aborted" for any failure in the file (measured on the one-off scratch run), so the count and values are in the Postgres server log. The migration header says so. The contract gate's style-vocabulary warning no longer hardcodes the stale 6,455 count.

## Why

A catalog product describes its kind with one `style` token today: `red | white | rose | spark | nonalc` (seeded in `20260514183437_rewire_phase1_schema`). That single axis conflates three independent facts: what colour the wine is, whether it is sparkling, and whether it is a dessert or fortified wine. A sparkling rosé or a sweet sparkling wine cannot be expressed, and `nonalc` is an alcohol fact masquerading as a style (the schema comment on `WineProduct.style` already calls it transitional, "ABV/alcohol attributes are the intended direction").

The catalog-maintenance side has built against a three-attribute shape, and it holds about 6,570 dessert/fortified products that our vocabulary cannot store (the 6,455 recorded on `CategoryStyle` is an older count).

## The shape (on `wine_products` only)

| column | type | values |
|---|---|---|
| `colour` | `varchar(16)` NULL | `red`, `white`, `rose`; NULL = unknown |
| `sparkling` | `boolean NOT NULL DEFAULT false` | no unknown state |
| `style` | unchanged column, narrowed | `dessert`, `fortified`, NULL |

Alcohol-free is expressed by `abv`, which `wine_products` and `wine_vintages` already carry (0–25 CHECK).

### Rulings (Simon, 2026-11-09)

- **The name stays `colour`.** In TypeScript "colour" also means presentation colour (`withColours` in `lib/flavours.ts`, the mobile `useFlavourColors`); the clash is accepted because `colour` is the correct wine term and must match on both sides.
- **No orange.** Orange/skin-contact wine is `white`. Vin jaune and vinho verde get no values either.
- **`sparkling` NOT NULL is accepted.** A wrong default is corrected by an edit (the creator freely; a proposal once others have rated the entry, model-change § 3), not by enrichment.
- **Real ABVs.** The catalog-maintenance side sends ABV as measured (a 0.5% de-alcoholised wine stays 0.5). Verre derives "alcohol-free" with a threshold, decided when the user side moves to the catalog.
- **What a user must supply when minting an entry is decided at the model change.** The model-change ruling "producer + name + type" predates this split. Imported entries are valid with colour NULL, sparkling false and style NULL either way.

## Scope: the catalog now, user wines at the model change

**Measured on prod 2026-11-09:** producers, products, vintages and EANs are all 0, and no `wines` row has a `product_id`. No client (web `components/`, `app/` pages, `apps/mobile/src`) references `productId`, `vintageId` or `/api/catalog`; the catalog routes 404 for non-staff while `CATALOG_PUBLIC_ENABLED` is off. So the catalog side of this change is schema plus three library files, with no user-visible surface.

**`wines` is NOT changed.** It holds 140 rows (red 56, white 44, spark 28, rose 6, nonalc 3, NULL 3; measured 2026-11-09) and keeps the old tokens until the catalog model change (`wine-catalog-model-change.md`), which replaces it with occurrences whose identity attributes live on the catalog entry (§ 1). Migrating it now would build the new shape twice, and it is where the risk is:

- Every surface computes structure axes from the wine's `type` (= `wines.style`), the Compare aggregate client-side (`packages/core/compareAggregate.ts`), and TestFlight builds in the field send and read those tokens.
- Cached lineups in Redis carry `type`; `upsertLineup` (`lib/session.ts:720`) writes `style = w.type` back to Postgres. A narrowed `wines.style` would make `bestEffortMirror` swallow the CHECK failure (silent record drift) and fail promotion outright (`lib/session.ts:642`).

Consequences, accepted:

- `category_styles` keeps `wine/red`, `white`, `rose`, `spark` and `nonalc`, because `wines` references them. A CHECK on `wine_products.style` is therefore what binds catalog rows; the composite FK alone would still accept `red`.
- Adding `wine/dessert` and `wine/fortified` to `category_styles` makes them FK-valid on `wines` too. Nothing can write them there: every user path validates against a hardcoded five-token list (`lib/session.ts:502`, `app/api/checkins/route.ts:229`, `app/api/checkins/[id]/route.ts:149`), and no runtime code reads `category_styles`.

## Migration

One hand-written, transactional migration (`BEGIN … COMMIT`: Prisma does not wrap migration SQL, see `20260811215655_catalog_category_constraint`), opening with `SET LOCAL lock_timeout = '5s'` before the first `ALTER`, as the earlier catalog migrations do:

1. **Refuse if any `wine_products` row holds an old style value** (`red`, `white`, `rose`, `spark`, `nonalc`), with a `DO` block that names the count. **Nothing is translated.** Prod measured 0 catalog rows, and the only writer is a staff-only endpoint with no UI, so translation code would be untested code guarding an empty table. Converting existing values belongs to the user-wine migration at the model change (see Deferred). The CHECKs in step 4 would refuse such a row anyway; the `DO` block makes the failure legible, like the "catalog is not empty" guard in `20260725220000_catalog_fold_whitespace`.
2. `ALTER TABLE wine_products ADD COLUMN colour varchar(16)`, `ADD COLUMN sparkling boolean NOT NULL DEFAULT false` (a constant default is metadata-only on PG 11+).
3. `INSERT INTO category_styles` `('wine','dessert','Dessert Wine',60,true)` and `('wine','fortified','Fortified Wine',70,true)`.
4. Add `wine_products_colour_check` (`colour IS NULL OR colour IN ('red','white','rose')`) and `wine_products_style_check` (`category <> 'wine' OR style IS NULL OR style IN ('dessert','fortified')`). 🔒 **The style CHECK is scoped to wine.** A future category must stay "INSERT into `categories`, then its styles into `category_styles`", never a migration (`schema.prisma:670`, `prisma/CLAUDE.md` § category); other categories are constrained by the composite FK alone.

**On failure** (the refusal, or a lock timeout): Prisma records the migration as failed, and every later deploy aborts with P3009 until it is resolved. Recovery follows `20260725140000_catalog_fold_order` (header, step 3): clear the cause, confirm nothing was applied (the transaction guarantees it), then `npx prisma migrate resolve --rolled-back <name>` and redeploy.

`schema.prisma` gains `colour String? @db.VarChar(16)` and `sparkling Boolean @default(false)` on `WineProduct` (hand-applied: `prisma format` reformats ~200 unrelated lines). The `WineProduct.style` and `CategoryStyle` comments are updated (the vocabulary, the transitional CHECK, the stale count).

## Code

- **`lib/catalogWrite.ts`** (`NewProductInput`, `createProduct`): accept `colour` and `sparkling`, and validate in the app so a bad value is a `CatalogValidationError` (400), never a constraint 500. **Omitted and invalid are different**: an omitted field takes its default (`colour` and `style` null, `sparkling` false); a present field of the wrong type is rejected. `colour`: one of the three values or null. `sparkling`: a strict boolean. `style`: for category `wine`, `dessert | fortified` or null; other categories are left to the composite FK, matching the scoped CHECK. A value from the old style vocabulary (`red`, `spark`, …) is rejected, not mapped: the endpoint has no callers yet, so there is no old client to keep working.
- **`lib/catalogAddFlow.ts`** (`:258`): pass the RAW `style`, `colour` and `sparkling` from `productFields` into `createProduct`. Today `:259` turns a non-string `style` into null, so `style: 42` would bypass the validator and succeed (Codex review, 2026-11-09).
- **`lib/catalogSearch.ts`**: add `colour` and `sparkling` to `ProductMatch` and to both product SELECTs (`:464`, `:512`).
- **README API table** (`/api/catalog/entries`, line 305): document the product fields.

Nothing outside these files changes. Copying product attributes onto a user's wine (a request from the other side) has no caller yet; it arrives with the add-flow client in the model change.

## Contract

`wine_products` is a contract table (root CLAUDE.md § Wine catalog; RFC § Catalog write ownership).

- Narrowing `style` rejects payloads that were valid before, so `wine_products_style_check` is **contract**-scoped by the rejection-surface test, and so is `wine_products_colour_check` (it defines what the import may send). Regenerate `prisma/catalog-contract-checks.json` with `--write`, scope both, bump `contractVersion` 1 → 2.
- `styleVocabulary` gains `wine/dessert` and `wine/fortified`. This is the ours-then-theirs order the `CategoryStyle` comment and `20260811215655` require: our vocabulary grows first, then their export filter flips.
- No function changes, so the fold identity handshake is untouched.
- `curatorLocked` is read by nothing in this repo yet (the import path is phase 4, unbuilt). A curator who deliberately leaves `colour` unknown sends `curatorLocked ∋ 'colour'`; never filling a locked field becomes an obligation on that path. `sparkling` has no unknown state, so it needs no lock semantics.

## Tests

- `catalog-schema-integration.mjs`: on a wine product, reject `colour = 'orange'`, `style = 'red'` and `style = 'spark'`, reject `sparkling = NULL`; accept `style = 'dessert'`, `'fortified'` and NULL with colour NULL. Pin the wine scoping: a declared non-wine pair (insert a test category + style, rolled back) is accepted. Pin that `wines` still accepts `style = 'red'` (the deferral is deliberate, and a later edit must not narrow `wines` by accident). The existing `wines` fixture with `style 'red'` (`:877`) stays valid.
- `catalog-addflow-integration.mjs`, through the REAL dispatcher (`mintEntries`, the dispatcher block near `:1613`): a non-string `style` or `colour` and a non-boolean `sparkling` raise `CatalogValidationError` with nothing committed; omitted fields take their defaults; valid values persist; search returns `colour` and `sparkling`.
- **The refusal, once, during the build (not a CI suite).** CI applies the whole chain to an empty database before any fixture exists (`check-schema.yml:83`), so it cannot reach this path. On a scratch database: migrate to the previous migration, insert one wine product with `style = 'red'`, apply this migration, and confirm it refuses and leaves no column, vocabulary row or CHECK behind.
- Run every `check-schema.yml` suite against a local Postgres before pushing.

## Rollout and report-back

Deplo.io applies the migration on merge (merge equals apply). The window where old code meets the new schema only affects staff catalog creation with a legacy style, which is negligible. After deploy we send the catalog-maintenance side:

- the migration name and the deploying `main` commit;
- the constraint and column definitions **as measured on prod** (`pg_get_constraintdef`, `information_schema.columns`), not copied from the file;
- the `category_styles` rows;
- the token counts on `wine_products` (zero), and the `wines` counts as "converted at the model change".

Their release waits for that message.

## Deferred to the model change

Recorded here so it is not lost; the model-change proposal should absorb it when built.

- **User-side split.** Bubbles from `sparkling` instead of `style === 'spark'` across ~25 `resolveAxes` / `fillFlavourZeros` call sites (server, `@verre/core`, web, mobile); keep emitting a derived legacy `type` and accepting legacy writes for TestFlight builds; Redis cached lineups; badges (`type_spark_*`, `type_nonalc_5`, `type_all`; `unique_styles_8` is already unearnable, 5 styles against a threshold of 8).
- **Snapshot gap.** Occurrences keep only a name/producer/vintage snapshot (model-change § 1, § 5a). An unlinked or purged occurrence would lose the Bubbles axis on its ratings unless the snapshot also carries `sparkling`.
- **Conversion rulings (Simon, 2026-11-09).** Each kept wine is hand-linked to a delivered catalog entry where one exists, otherwise minted as a provisional entry; and no wine is linked or minted before the first catalog delivery. This reconciles model-change § 6 (hand-curated conversion) with RFC § Legacy backfill / implementation phase 5 (exact-match auto-link), which disagree today.
- **`nonalc` → `abv = 0`** for existing user wines (Simon, 2026-11-09: 0 is a valid alcohol level, and it keeps the alcohol-free fact, which NULL would lose). Filled only where no ABV is recorded.
- **Retiring the old pairs.** Once `wines` no longer carries `style`, delete `wine/red | white | rose | spark | nonalc` from `category_styles` (an announced vocabulary change). `wine_products_style_check` then duplicates the FK and may be dropped, which only loosens.
- **Minting requirements** for user-created entries after the split (see Rulings).
