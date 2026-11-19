# Wine catalog: the model change

**Status:** proposal, not started. Planned before any code, per the ruling in
`wine-catalog-implementation.md` § "RULED: the per-event fields move OFF `wines`".
**Refreshed for build 2026-11-18** (§ 0): reconciled with the shipped Redis rehydration,
public user ids, usernames, wine-photo retention and the profile lists; the catalogue is
loaded; new rulings recorded; build order in § 12.

**What this is.** Today a `wines` row is a bottle-at-a-tasting: it carries both what the
wine *is* (name, producer, vintage) and what happened at that event (which session, who
brought it, the photo, whether it has been revealed). This proposal separates those. The
catalog becomes the identity of a wine; a new **occurrence** row carries the event; a
rating carries one person's experience of it.

**Review status.** Three review rounds (Codex): seven findings on the first draft, five on
the revision, five on the convergence pass — all verified against the code, all accepted
and resolved. § 11 records them. No decisions are outstanding.

This reverses the RFC's two-grain split, which kept a `wines` row per bottle-per-tasting.
It does not reverse anything else in the RFC — catalog identity, merge reversibility, the
no-find-or-create rule and the blind-redaction rule all stand and are load-bearing here.

**Why now.** Every `wines.product_id` is NULL, and the volume of legacy rows needing
hand-disposition is small — both only grow. The measured scope is small at the schema
level (two FKs point at `wines`) and large at the code level, so the cost is dominated by
code that accretes over time. Re-measured 2026-11-18 (tracked files, migrations and docs
excluded): **34 files touch `wines` directly** (19 runtime: 8 in `app/api`, 11 in `lib`;
6 operator scripts; 2 schema-check scripts; 7 suites), **46 with the 12 runtime files
that write it through helpers** (`mirrorLineup`, `ensurePromoted`, `hostLineupWrite`,
the wipes, account deletion). July's "43" did not say what it counted. The legacy `type`
token is read or written in about 14 server, 3 `@verre/core`, 17 web and 27 app files;
the axis helpers have **40 call sites** (`resolveAxes` 15, `resolveAxesColoured` 9,
`fillFlavourZeros` 12, `gateAndFillFlavors` 4).

⚠️ **CORRECTED (2026-07-26): this argument previously opened with "the catalog
tables are empty", which the ruled execution order makes FALSE by the time this
phase runs.** The fill lands BEFORE the model change (§ 7), so the catalog is
populated here. Nothing else in the timing argument depended on emptiness — the `product_id`-is-NULL and code-accretion points stand on their own —
but the phrase mattered because it was also being read as a claim about the seed
being clean. It is not: see § 6's `link` verdict (to a delivered catalog entry,
ruled 2026-11-09; an earlier pointer here named a § 7 verdict that was never
written), which exists precisely because the catalog is populated at
curation time. The related precondition at § 2 ("pick an existing entry" is a dead
end against an empty catalog) is the reason the order is what it is, and is
unaffected.

---

## 0. Refresh for build (2026-11-18)

This section records what changed between the July review and the build. The sections
below are edited in place to match; where a ruling stands unchanged it is not repeated.

### 0.1 State at hand-off

- **The catalogue is loaded on prod** (committed 2026-11-18 10:17:39 UTC, `VACUUM
  ANALYZE` done): 49,180 producers, 257,019 products, 1,962,433 vintages, 257,019
  product–producer links, 0 EANs, all `confirmed`. `CATALOG_PUBLIC_ENABLED` is unset and
  no client calls catalogue search or link. The attributions surface is live (PR #93).
- **The undo window is open** until the first real link through the new add-flow (the
  catalogue-maintenance side keeps its redo exception until then). The first link closes
  it: they are told, and from then on the catalogue changes only by review and merge;
  a manual delete goes in `docs/dev/catalog-manual-deletions.md` before the SQL.
- **The Redis rehydration shipped** (releases A, B, C): a Postgres-backed moment is
  Postgres-authoritative for authorization and membership, Redis is its rebuildable
  cache, every durable writer runs inside the session mutation contract
  (`lib/sessionMutation.ts`). Much of § 8a shipped in that form; § 8a now says, item by
  item, what is done, done differently and still owed.
- **Also shipped since July:** public user ids (`lib/publicIds.ts`), usernames,
  wine-photo retention D8/D9, the post gate and the one outside-the-moment rule
  (`lib/outsideView.ts`), the profile lists (`lib/profileLists.ts`, `lib/profileTiles.ts`),
  the proxy-wide version floor (`proxy.ts`, `lib/clientVersion.ts`). § 0.3 lists what each
  means here.
- **Prod's schema differs from the migration chain** in seven baseline-era tables
  (bookmarks, ratings, session_members, sessions, user_badges, users, wines):
  `timestamp` vs `timestamp(6)`, `now()` vs `CURRENT_TIMESTAMP`, four uniques that are
  CONSTRAINTS on prod but INDEXES in the chain (`bookmarks_user_id_wine_id_key` among
  them), and `ratings_score_check` exists only on prod. This change rewrites exactly
  wines, ratings and bookmarks, so it is rehearsed on prod's schema (§ 6a), not on the
  chain.

### 0.2 Rulings taken 2026-11-18 (Simon)

- **New entry fields:** producer + name + the type picker (red / white / rosé →
  `colour`; sparkling → `sparkling`, colour unknown) + an **optional abv**. 🔒 **The abv is
  the fact; "non-alcoholic" is derived from it** (Simon, 2026-11-19, superseding the
  picker's alcohol-free → `abv = 0`): `abv ≤ 0.5` reads as non-alcoholic (the EU / Swiss /
  US class of de-alcoholised wine), and the value is still shown ("0.5 %"), so a delivered
  0.5 is never rounded to 0. The person types the abv and never picks "non-alcoholic":
  the alcohol-free choice leaves the picker **in this change** (steps 4 and 7). Legacy
  alcohol-free bottles (`style = 'nonalc'`) read as abv 0 (what the picker meant). The
  bottle's snapshot keeps the abv (§ 1). Catalogue data never writes 0 to mean
  "alcohol-free, value unknown" (the step 1b feedback asks for the label value or empty). The flow
  lets someone **find the producer first** and create only the wine under it, and **add
  a missing vintage to an existing wine**. Both are existing add-flow branches
  (`lib/catalogAddFlow.ts` branch 3 and branch 2); they need screens, not server work.
  This closes § 2's reopened point.
- **One craving per wine, remembering where it was first craved** (§ 5): "you can only
  crave once, but check in many"; the bookmark points at the catalogue wine and keeps the
  first place as its source ("you craved it here"); "where you had it" aggregates your
  check-ins and moments. A first craving made on a blind bottle stays out of your
  Cravings until the reveal; an already-craved wine changes nothing.
- **Web scope: a plain working picker** — search, pick or create, inside today's
  modals; Saved shows each wine once with its vintages. No new web screens; the web is
  slated for redesign.
- **§ 10 does not block:** the app keeps its words (an *impression* in a moment, a
  *check-in* on its own); "occurrence" is a word in code only. No photo moves onto a
  catalogue entry in this phase, so the Terms of Service wait.
- **Search capacity: no bigger database plan.** Find whether the ceiling is our side or
  the queries, and optimise before opening (§ 9).
- **Rehearsal data:** a copy of prod's real rows with people reduced to bare ids and
  rating notes blanked (§ 6a).

### 0.3 What the shipped features mean here

| Feature | What it means for this change |
|---|---|
| **Public user ids** | Occurrence provenance stays the INTERNAL identity (`u:<int>` / `a:<uuid>` / `d:<uuid>`, CHECK `wines_added_by_identity_id_chk`); it leaves the server only through `wineToWire` + `buildAdderLookup` (public id, a miss dropped). Any new person-bearing field on an occurrence, bookmark or proposal follows `lib/publicIds.ts`, and a new user-facing route joins § 18 of `scripts/tests/you-profile-integration.mts`. |
| **Usernames** | Nothing inside a moment carries a username, occurrence provenance included (`buildAdderLookup` selects `{id, name, publicId}`; reverse canary `usernames-section.mts`). A proposal's proposer outside a moment would follow the emission rule (`app/api/CLAUDE.md`). |
| **Wine-photo retention D8/D9** | The predicate ("no rating and no bookmark references the wine", `app/api/session/[code]/route.ts` DELETE and `lib/accountDelete.ts`, written out twice) moves onto occurrences. It keeps its bookmark half because a bookmark keeps its source pointer (§ 5). The wine DELETE and PATCH reclaim without it, by design (the host removes the bottle). |
| **Post gate + `lib/outsideView.ts`** | The `w` alias becomes the occurrence (`revealed_at`, `added_by_identity_id`). A craving finds its moment through its source occurrence, as today (`cravingSessionIdSql`: `w.session_id`, else that occurrence's session ratings), so the blind / hidden-line-up rule keeps working; a craving whose source is hidden for its owner is LEFT OUT of the owner's lists (§ 5; today it shows as a blind row). A craving with no source (its bottle deleted, or a later save from a product page) has no moment: shown on your own list, dropped from someone else's (today's rule, `lib/profileLists.ts:245`). |
| **Profile lists, tiles** | Impressions join ratings → occurrence; display fields come from the catalogue entry, else the snapshot. "Both had" stays *same occurrence* (both rated that bottle at that moment); a product-level "both had" is new aggregation, not part of this change. Cravings key on the bookmark id (shared with Moment Visibility step 3, § 7). Tile pools read occurrence photos; pins are URLs and keep working. |
| **Blind redaction** | The line-up item carries catalogue identity under ONE key that `redactWine` replaces wholesale (it spreads `...rest`, so a flat new field leaks by default). Catalogue ids, names, grapes, region and a catalogue photo are all label identity; so are the snapshot's name, producer and vintage. 🔒 `colour` and `sparkling` stay on a blind row, as `type` does today (`lib/wineRedaction.ts:53-59`): the taster needs them for the axes, and they are what a pour shows anyway. |

---

## 1. The shape

Four things, each with one job.

| | What it is | Grain |
|---|---|---|
| **Catalog entry** | What the wine *is* | Product, optionally a vintage under it |
| **Occurrence** | An encounter with a bottle | One per bottle per event |
| **Rating** | One person's experience of one occurrence | One per person per occurrence |
| **Bookmark** | "I want this wine" | One per person per product+vintage |

Everything user-individual links to the catalog. That is what makes aggregation possible
— all ratings of one wine roll up to one entry — and what lets a profile show "your
ratings of this wine, across every time you had it".

### Occurrence replaces "lineup"

🔒 **One entity covers both a bottle at a tasting and a standalone check-in** (F4). The
first draft called this a "lineup row" and had no home for standalone check-ins, which
today create a `Wine` row plus a `Rating` with `origin: 'standalone'`
(`app/api/checkins/route.ts:313` creates the wine row). There is no check-ins table and never was.

An occurrence is *one encounter with one bottle*. It comes in two kinds:

| | Session occurrence | Standalone occurrence |
|---|---|---|
| Session | set | null |
| Position in the lineup | set | — |
| Revealed-at | set for blind tastings | — |
| Who brought it | set | the poster |
| Photo of the bottle | optional | optional |
| Purchase link | optional | optional |

The kind is already expressible: `ratings.origin` carries `'session' | 'standalone'`
today, and the same distinction moves onto the occurrence. Session-only fields are null
for standalone occurrences — the same shape `wines` already has, where `session_id` is
nullable.

⚠️ **`session_id IS NULL` does not mean standalone, today or after** (verified
2026-11-18): three paths ORPHAN session bottles — the session DELETE
(`app/api/session/[code]/route.ts:268`), account deletion's empty-moment wipe
(`lib/accountDelete.ts:520`) and the ban-with-delete of a banned adder's bottles
(`lib/sessionWipe.ts:167`). So the occurrence gets an explicit **`origin`**
(`'session' | 'standalone'`, CHECK), and every reader that classifies an occurrence uses
it. 🔒 **Nullable until the contract step** (review r1 B1): the previous release keeps
running during the rolling deploy and writes wine rows without it (`upsertLineup`, the
check-in create, promotion), so a `NOT NULL` in the expand step fails every logged-in
rate, save, promotion and check-in until the old instances are gone. A `BEFORE INSERT`
trigger sets it from `session_id` when the writer leaves it NULL (correct at insert time:
orphaning is always a later UPDATE); `SET NOT NULL` lands in § 12 step 9. Backfill:
`session` when `session_id` is set or any rating of the row has `origin = 'session'`,
`standalone` when its rating has `origin = 'standalone'`. What is left (no session and
no rating: a deleted check-in leaves its wine row behind,
`app/api/checkins/[id]/route.ts:659-663`, and so does an orphaned bottle nobody rated) is
unreferenced by construction; the migration marks it `session` when its id is a legacy
13-digit id (`id ~ '^[0-9]{13}$'`: the old session add path minted `Date.now()` ids,
`lib/session.ts:139` as of 2026-05-10, and standalone wines only exist since the
2026-05-14 rewire, with hex-21 or nanoid ids) or when it has an adder or a position, else
`standalone` (the check-in shape). Measured on prod (re-survey, 2026-11-18): without the
id clause the guess labels 53 orphaned session bottles `standalone` (they predate both
adder and position); with it the 67 rows resolve as 63 `session` and 4 `standalone`
(check-ins whose rating was deleted), 124 and 26 in all. ⚠️ The guess can still be wrong
for a post-rewire session bottle whose adder account deletion nulled
(`lib/accountDelete.ts:429`) and that predates positions, so the verdict list (§ 6)
carries the computed origin as a column and a human confirms it. The orphaning
itself stays as built (the lifecycle matrix in § 8a is corrected to match).

**Table name.** The occurrence keeps the physical table `wines` during this change.
Renaming it breaks the previous release for the length of the rolling deploy (its every
statement names `wines`) and touches the prod-drifted constraints for no gain; the Prisma
model may be called `Occurrence` with `@@map("wines")`. A rename, if wanted, is its own
later migration.

🔒 **Each check-in is its own occurrence** (Simon's ruling, F4). Drinking the same wine in
January and again in June produces two occurrences, each with its own photo and purchase
link. This matches current behaviour, and it keeps "an occurrence" meaning the same thing
in both contexts. The alternative — one occurrence per user per wine with many ratings —
was rejected: it would force photo and purchase link onto ratings and make the entity mean
something different standalone than in a session.

### The catalog link, at two grains

🔒 **An occurrence stores `product_id` plus an optional `vintage_id`** — the same two-grain
link `wines` carries today, for the same reason: `wine_vintages.year = null` means the
non-vintage bottling exclusively, never "year unknown". A wine whose year nobody knows
links at product grain with `vintage_id` null. Valid states are (set, set), (set, null),
(null, null); the existing CHECK and composite FK carry over unchanged.

🔒 **A rating references its occurrence, and derives catalog identity through it.** Ratings
do **not** carry their own `product_id`/`vintage_id`. Two links to the same wine can drift
out of step; one cannot. It also makes photo fallback and provenance unambiguous when the
same wine appears twice in one tasting.

🔒 **Two occurrences in one session may reference the same catalog entry.** Two bottles of
the same wine at one tasting is legitimate (a magnum and a standard, two vintages side by
side, or simply a duplicate). There is no dedupe check today and none is added — the
occurrence is the unit, not the catalog link.

### Where the fields go

| Field on `wines` today | Destination | Why |
|---|---|---|
| `name`, `producer`, `vintage` | Catalog entry **+ snapshot on the occurrence** | Identity lives in the catalog; the occurrence keeps a display snapshot so an unlinked or purged row still renders (§ 5a) |
| *(new)* `colour`, `sparkling` | **Snapshot on the occurrence** (+ catalog entry) | Closes § 9's snapshot gap: an unlinked or purged occurrence keeps its Bubbles axis and its colour mark. Copied from the entry at link time; legacy rows derived from `style` in the migration (`spark` → sparkling, `red`/`white`/`rose` → colour, `nonalc` → neither) |
| *(new)* `abv` | **Snapshot on the occurrence** (+ catalog entry: the vintage's abv, else the product's) | Ruled 2026-11-19 (Simon): an unlinked or purged occurrence keeps its abv and so its derived non-alcoholic mark (§ 0.2); without it the legacy alcohol-free rows would lose the mark when step 9 drops `style`. `DECIMAL(4,2)` NULL, 0 to 25 like the catalogue. Copied from the entry at link time; the migration backfills `nonalc` → 0 and leaves every other legacy row NULL |
| `grape` | Catalog entry | What the wine is |
| `category`, `style` | Catalog entry | Same. `style` stays on the row until the contract migration (§ 12 step 9) as the legacy source of the snapshot |
| *(new)* `origin` | Occurrence | `session` / `standalone`; `session_id IS NULL` is ambiguous (orphaning, above) |
| `region` | Catalog entry (`wine_products.region`) | Same. The occurrence keeps its stored value as history |
| `country` (of origin), `description`, `vinification` | **New catalogue columns on `wine_products`** (Simon, 2026-11-18: the catalogue had no place for them; `producers.country` is the company's home, never the wine's origin). Contract below | A contract change, announced to the catalogue-maintenance side before the push (§ 9 condition 3a). The occurrence keeps its stored values as history; nothing is dropped in step 9 |
| `session_id` | Occurrence | Per-event; null for standalone |
| `added_by_identity_id`, `added_by_display_name` | Occurrence | Who brought this bottle, this time |
| `revealed_at` | Occurrence | Per-tasting blind state |
| `image_url` | Occurrence + rating + catalog | Three layers, see § 4 |
| `purchase_url` | Occurrence | Per-event — covers standalone too |
| `product_id`, `vintage_id` | Occurrence | The link *is* the row's purpose |
| *(position)* | Occurrence | ✅ Shipped with the rehydration (`wines.position`, renormalized on every mirror) |

### The new catalogue columns: contract v3 (ruled 2026-11-19, Simon)

Step 2 implements exactly this. Measured basis: the step 1b data-health assessment
(rehearsal = prod's catalogue, cross-checked on staging, 2026-11-19).

| Column | Type | Rule |
|---|---|---|
| origin country (name open, below) | `VARCHAR(2)`, NULL = unknown | ISO 3166-1 alpha-2, uppercase, CHECK against the full list |
| `producers.country` (existing) | `VARCHAR(2)` | the same CHECK, added in the same version |
| `description` | `VARCHAR(1000)`, NULL or not blank | plain English text |
| `vinification` | `VARCHAR(1000)`, NULL or not blank | plain English text |

- **Name: open.** The catalogue-maintenance side is asked first whether it already carries
  a product-level origin and under what name; we take theirs if so, otherwise
  `wine_products.country`. Step 2 needs the answer before its migration is written.
- 🔒 **The origin is where the wine is from, never the producer's home**: never filled from
  `producers.country` and never a read-time fallback to it (estimated: about 778 products
  sit under a producer of another country, by a heuristic that infers a region's country
  from its producers). A blend across countries is NULL.
- 🔒 **The country CHECK is the FULL code list** (the 249 codes of `COUNTRY_CODES`,
  `packages/core/src/countries.ts`), inline in the CHECK, not a format test. From the
  release on, a code outside it refuses the whole delivery (an import batch is
  all-or-nothing): the catalogue-maintenance side cleans its codes before it builds, and the
  feedback says so. The flush's replacement loads BEFORE the CHECK exists, so a bad code in
  it would instead fail step 2's migration on prod: we check the replacement against the
  list before loading it there.
  Adding a code is a migration and a contract event. A parity test pins the CHECK's list to
  `COUNTRY_CODES` both ways (as the username format CHECK is pinned). On `producers.country`
  it is a stricter predicate on an existing column, so a contract event too; measured on the
  loaded catalogue: 68 codes in use, all valid, 13 producers NULL.
- **`description` / `vinification`**: not blank through the fold (`catalog_fold_v1(x) <> ''`,
  the `region` pattern); plain sentences (no links or URLs, no markup, the `scrub` character
  set, newlines only between paragraphs, NFC, trimmed); **English only** (another language
  stays NULL for now); product grain (a vintage-level override would be a later additive
  column). Language and the no-URL rule are not database-enforced: our post-delivery check
  lists violations before a prod load.
- **Licence**: both texts come only from sources the attributions surface covers, or are
  written by the catalogue-maintenance side; never copied producer or retailer copy. A new
  source ships its attribution entry first (§ 7). Attribution stays corpus-level.
- All three are enrichable scalars (fill NULL only) and may be named in `curator_locked`.
  All three are label identity on a blind row (stripped like `wines.country` today).
- **Delivery**: the columns don't exist on prod until the release, so their values come as a
  separate file loaded after migrate by a guarded one-off update (§ 7, catalogue flush).

**Purchase link stays per-event** (Simon's ruling). A Swiss shop is not a property of a
wine; it is where *this person* bought *this bottle*. The catalog reserves the field but
never populates it. The same reasoning applies to anything else that is true of a bottle
for a person rather than of the wine — flag such fields at review rather than defaulting
them onto the catalog.

---

## 2. Who can write to the catalog

**Registered users only.** An anonymous participant cannot create a catalog entry —
enforced server-side, not in the client.

**Anonymous users can still add wines to a tasting**, but only by picking an entry that
already exists. They can join, add, rate and see everything; they just cannot mint new
shared identity. This keeps unauthenticated writes out of shared reference data, which is
what the catalog fence exists to protect.

🔒 **The user makes every identity judgement; the server never does.** The add flow
searches, shows matches, and mints a new entry only when the user explicitly picks "none
of these". This is the RFC's no-find-or-create rule and it is not negotiable here — the
auto-dedup model was reviewed and rejected in PR #82 precisely because it collapsed
distinct wines silently and irreversibly.

**Minting requires producer + name + type.** Today a wine needs only a name, so "the
orange one" is a valid entry. As a permanent catalog row it is unfindable and unmergeable.
Three required fields is a keystroke of friction, not a barrier.

✅ **RULED (Simon, 2026-11-18), closing the 2026-11-09 reopening** ("type" predated the
colour / sparkling / style split, `catalog-colour-sparkling.md`): a new entry needs
**producer + name + today's type picker**. Behind the picker: red / white / rosé set
`colour`; sparkling sets `sparkling = true` with colour unknown; alcohol-free sets
`abv = 0` with colour unknown. A sparkling rosé or an alcohol-free red cannot be said
in the picker; the entry is still valid and a curator or a delivery fills the rest.
Imported entries stay valid with colour NULL, sparkling false and style NULL.
**The flow offers the two partial creations first**: find the producer and create only
the wine under it (add-flow branch 3), and add a missing vintage to an existing wine
(branch 2). Both exist server-side (`lib/catalogAddFlow.ts`); only branch 4 mints a
producer.

✅ **The anon restriction's precondition is met** ("pick an existing entry" was a dead
end against an empty catalog): the fill is loaded, so the restriction is on from the
first deploy of this change.

🔒 **Guests search from inside the moment (Simon, 2026-11-18; review r1 B2).** Picking
needs a search, and `GET /api/catalog/search` answers 401 to anyone not signed in
(`app/api/catalog/search/route.ts:26`, on purpose: no open enumeration channel). Without
more, a guest who hosts or brings bottles could add none. So a **moment-scoped search**:
under `/api/session/<code>/…`, behind the entrance gate (`openSessionFor`, so a wrong
code pays the wrong-code budget like every moment route), for a caller who may add
bottles to THAT moment (host, cohost, provider: the same test as the wine POST),
budgeted per user when signed in (`rl:catalog-search`, shared with the global route so
the two don't stack) and **per IP when a guest** (guest identities are re-minted per
join, the `catalogLinkRateKey` reasoning): starting value 60 a minute per address (one
venue's guests share an address, but only hosts and bringers search), set against step
1's numbers and recorded in `app/api/rate-limits.md`. Same query, same response shape as the global
search, no status or adder fields. Effect, accepted: anyone who creates a guest moment
can search the catalogue (it is open by ruling; this only widens who may search it, at a
bounded rate). Guests still never create an entry.

🔒 **Picking an existing vintage needs a read path** (Codex r1): product search returns no
vintages (`lib/catalogSearch.ts`), and the only way to get a vintage id today is the
add-flow's branch 2, a signed-in POST that may create one. So both search routes (the
global one and the moment-scoped one) answer a vintage lookup for a chosen product: ids
and years (NV included), nothing else, same gate, same budget, same generic denials.
Selecting an existing vintage then needs no create request; ADDING a missing vintage is
branch 2 and stays registered-only.

🔒 **This precondition is WHY the execution order is fill-first, and it is the reason a
reorder was rejected.** Running the model change against a genuinely empty catalog would
buy a clean seed, but switching on pick-existing before the fill leaves anonymous users
unable to add anything at all. That is a correctness objection, not a cost one. It also
means the "why now" argument at the top of this doc must NOT be read as a claim that the
catalog is empty when this phase runs — it isn't (see the correction there).

---

## 3. Editing a shared entry

Modelled on Untappd's attested permission model (creator edits, others report, moderators
clean up, claimed entries lock), plus one guard for the case Untappd does not document.

- **The creator edits freely** — until someone else's rating points at the entry.
- **After that, edits become proposals.** The change does not appear until a curator
  approves it.
- **Curator-locked fields** stay locked to everyone, as today.
- **Identity-changing edits are not edits at all.** Changing producer, name or year means
  "this was the wrong wine" — it breaks the link and requires an explicit re-link through
  the add flow. Already specified in the RFC; it removes the dangerous half of user
  editing, leaving genuinely cosmetic corrections.

### Change proposals are their own table

A proposal is not a state of an entry — several can be outstanding on one entry at once,
from different people. It has nowhere to live on the entry row itself.

🔒 **Curation is per-entry, not per-proposal** (Simon's ruling). The queue shows a catalog
entry with all of its outstanding proposals gathered together, and the curator resolves
them as one decision. Conflicts between two proposals touching the same field become
visible by construction.

#### What a proposal row holds (F7)

⚠️ **Correction to the first draft.** It claimed per-entry review makes conflicts "visible
by construction". That is true *between two proposals*, but not against everything else
that can land mid-review — an import batch, a creator edit, another curator, or a new
proposal arriving while the queue page is open. Per-entry grouping is necessary and not
sufficient.

A proposal row therefore holds:

| Field | Why |
|---|---|
| Entry (product / producer / vintage + id) | What it targets |
| Proposed field values | The change |
| **Base version or snapshot of the fields it touches** | Detects the entry moving under the reviewer |
| **Status** — `pending` / `accepted` / `rejected` / `superseded` / `withdrawn` | A proposal has a lifecycle |
| Proposer, proposed-at | Attribution |
| **Resolver, resolved-at, accepted values as applied** | What was actually committed, which may differ from what was proposed if the curator edited it |

🔒 **`withdrawn` exists because the SENDER can retract, and that forces proposal identity
to be sender-referenceable** (constraint accepted 2026-08-18 — full semantics in the RFC
§ *Merge-suggestion policy*, under the tombstone-delivery contract). An upstream proposer
may revise or drop an identity decision after sending and before review; without a
withdrawal path the queue holds a live assertion nobody stands behind. Two consequences
for this table: the id minted here must be exposed to the proposer rather than kept
internal to the queue, and a withdrawal is a **terminal state, not a row delete** — the
audit trail must still show the assertion was made, the same reasoning that makes merges
tombstones. Withdrawing a proposal already in ANY terminal state — `accepted`, `rejected`,
`superseded`, or `withdrawn` — is an acknowledged no-op: a staff decision that has been
applied is never rescinded by the sender, and the `withdrawn → withdrawn` case is what
makes a withdrawal retry-safe when its response is lost. An **unknown** id is a hard error,
and means no row exists — never a row in a terminal state.

🔒 **`withdrawn` is terminal on THIS ROW, never on the entity pair it targets.** A pair
whose proposal was withdrawn can be re-proposed later on fresh evidence, and that new
proposal is a new row reviewed on its own merits. Scoping the terminal state to
`(entityType, loserId, survivorId)` instead would make every future proposal for that pair
an acknowledged no-op forever, failing silently — the trap the EAN `deferred` machinery
already has, where `rejected` is durable on the pair and reconsideration needs BOTH a staff
member clearing the verdict AND a `verdict-cleared` delivery to the sender — who otherwise
cannot observe the clear, and so never re-proposes (RFC § *Merge-suggestion policy*). That
delivery is unbuilt, so the EAN trap is open today. The per-row status
in the table above is what avoids it; keep it that way.

🔒 **Resolution is one transaction** covering the entry update and every proposal included
in that review. A partial apply — entry changed, proposals still `pending`, or two of five
resolved — is the failure mode this exists to prevent.

🔒 **And the status transition must be CONDITIONAL on the current status, under a row
lock.** Once the sender can withdraw (above), `pending → withdrawn` and
`pending → accepted/rejected` race. Committing the entry mutation atomically with the
status is necessary but not sufficient: without a conditional transition, a withdrawal can
stamp `withdrawn` while the review transaction is applying its merge, leaving a retracted
proposal that changed the catalog anyway. Exactly one transition wins.

🔒 **The two losing responses must DIFFER.** A withdrawal that loses to a completed review
gets the acknowledged no-op above — nothing the sender believed is now false. But a **staff
review that loses to a withdrawal must return an explicit "no longer pending — withdrawn",
never apparent success**: a curator who clicks Apply and sees success will believe the
merge landed when it did not, and will not re-check. Neither case is an *error* — both
parties acted correctly on the state they could see — but only one of them can be answered
with silence.

**Stale-base handling:** if the entry changed since a proposal's base version, the curator
is *shown the conflict*, not silently overridden. The decision stays human; the mechanism
only guarantees they see it.

**Recording the accepted values** matters because a curator may accept a proposal in
modified form. Storing what was proposed *and* what was applied is what makes the audit
trail answer "why does this entry say that".

Consequences to build for:
- The proposer must be able to see their own edit pending, or they will submit it again.
- Approval lands in the existing catalog audit trail with the proposal as the reason.
- This grows the phase-3 review queue from "approve or reject new entries" to "…and
  proposed changes". Same screens, same verdict vocabulary, roughly double the surface.

---

## 4. Photos

Three layers, most specific wins:

**rating photo → occurrence photo → catalog photo**

- The **catalog** entry may have a photo. It need not.
- The person who **brings a bottle** to a tasting may add their own photo of it.
- Each **taster** may attach their own photos to their rating.

Display — in the feed, on a profile, in a session — resolves down the ladder to the most
specific photo available. No photo is ever lost, only outranked.

🔒 **No new photo features in this phase** (Simon's ruling). The ladder describes where the
photos that already exist belong — it is not a backlog. Nothing new is added for attaching
photos, and the migration's job is to put existing ones in the right layer without loss
(§ 6).

**Deferred, deliberately:** promoting a user's photo to the catalog entry. That requires
Terms-of-Service work granting the rights, which is separate and not scheduled. The field
is reserved and left unpopulated, exactly like the purchase link. Note the ladder means
this is not urgent — a catalog entry with no photo already displays the occurrence or
rating photo, so wines look right without any promotion having happened.

---

## 5. Bookmarks

**Bookmarks point at the catalog directly** — `product_id` plus an optional `vintage_id`,
the same two grains as an occurrence. Not at an occurrence: "saved" means *I want this
wine*, not *I want that bottle from that evening*.

🔒 **Dedup: one bookmark per (user, product, vintage), with `NULLS NOT DISTINCT`**
(Simon's ruling, F2). A product-grain save and a vintage-grain save of the same wine are
**two rows**, because they mean different things — "this wine, whichever year" versus "the
2022 specifically". The NV bottling is its own row, since NV is a real vintage row rather
than a null.

**Displayed as one wine with its vintages underneath.** The saved list shows a wine once;
the years you saved sit under it. That keeps the list clean and makes it a record of
*which vintages you rated well* — which is information the collapsed-to-one-row
alternative would have thrown away.

`NULLS NOT DISTINCT` is required, not incidental: a plain unique on
`(user_id, product_id, vintage_id)` would let a user accumulate unlimited product-grain
bookmarks of the same wine, since each null compares distinct. The catalog already uses
this form on `wine_vintages (product_id, year)`.

Today a bookmark points at a bottle-at-a-tasting, so saving the same Barolo at two
tastings produces two bookmarks, and `@@unique([userId, wineId])` does not dedupe them
because the wine ids differ. The wine row is also deliberately orphaned rather than
deleted when its session goes, purely to keep the bookmark resolving. Pointing at the
catalog removes that reason for orphaning (the orphaning itself stays, § 1: it keeps the
ratings' grouping).

**Context is derived, not stored** (Simon's ruling). Opening a saved wine shows your
ratings of it — which tells you when and where you had it, and stays correct if you drink
it again. Nothing extra to store beyond where it was first craved (below). A saved wine
you have never rated shows no context, which is right, because there is none.

`app/api/me/bookmarks/route.ts` already resolves session context via ratings rather than
`wines.session_id`, and its header comment names this as the future direction. That part
is already built.

🔒 **A craving is one per wine and remembers where it was first craved (Simon,
2026-11-18).** "You can only crave once, but check in many": one bookmark per
`(user, product, vintage)`, the ruling above, unchanged. It points at a catalogue wine
(only legacy unconverted and purged rows have none, § 5a); **"you craved it here"** is the place it was first craved (a bottle in a moment, a
check-in, someone else's post: all occurrences), kept as the bookmark's source
(`wine_id`, nullable from now on). **"Where you had it"** is never stored: it aggregates
your check-ins and moments of that wine (your ratings, § 5 above). On any later moment,
bottle or post of that wine you see that you already crave it (a per-viewer `craved`
flag in the line-up view and the feed, computed wine-level).

🔒 **Blind, in Simon's words**: "If the first time craving happens on a blind wine, we
hide it in the cravings list unless revealed. If it is already in the cravings list,
nothing changes in the cravings list except that the aggregate of where you had this does
not show it yet." Made exact, with the rules that keep it from hinting what a blind bottle
is:

- **Hidden while its source is hidden for you.** A craving whose source is hidden for its
  owner by the outside-the-moment rule (`outsideViewSql`: redacted OR hidden line-up;
  `lib/outsideView.ts`) is left out of Cravings, Saved, their counts, badges and every
  wine-level `craved` flag, for the owner, and for any viewer of the owner's list (the
  viewer term stays, `lib/profileLists.ts`). It shows once its source is revealed for
  the owner (a reveal, or the moment over by its record dates). "Where you had it"
  applies the same rule to the blind bottle itself.
- 🔒 **On a bottle hidden for you, the crave button is neutral** (the one addition to
  Simon's description, needed because "you already crave it" on "Wine N" names the
  wine): it always offers Crave, and the answer is the same whether a new craving was
  stored (hidden) or the wine was already craved (nothing changes). No un-crave there
  until the reveal. Decided by the live rule (`lib/sessionState.ts`, the one that
  redacts the bottle on the moment screen), under the contract's locks, before any other
  refusal ("not in the catalogue yet" included), so no answer depends on the hidden
  bottle's link.
- **A craving from a place you can see re-points a craving whose source is still hidden
  for you**: if you crave wine P on a visible bottle or post while your craving of P
  is sourced from a still-hidden bottle, the craving's source moves to the visible place
  and it shows. 🔒 A re-point is a DELETE + INSERT in one transaction (new id,
  `saved_at = now()`, a fresh snapshot, the new source and its `source_session_id`): Cravings sort and page on `saved_at` and the id
  (`lib/profileLists.ts`) and Saved shows `saved_at`, so a moved row keeping its old date
  would sit where the blind craving was made and say the hidden bottle was P (review r7).
  Answer, count, position, date and id then match a fresh craving of P exactly.
- **Deleting a bottle** keeps the cravings first made there, losing "you craved it here"
  AND their stored moment (both pointers cleared together, Codex r2: a moment pointer
  without its bottle would read `revealed_at` as NULL and hide a craving that was
  visible); EXCEPT a craving whose source is still hidden for its owner (`outsideViewSql`),
  which goes with the bottle (with no source left, nothing could keep its label hidden).
  🔒 **Mechanism (Codex r1): the source FK KEEPS `ON DELETE CASCADE`.** The new wine
  DELETE first detaches (`wine_id = NULL`) the cravings sourced from that bottle that
  are visible to their owner, in the same transaction, then deletes; the hidden ones
  cascade. The deploy job runs migrations BEFORE the previous release stops serving
  (`.deploio.yaml`), so a `SET NULL` FK would leave an old instance's wine DELETE
  stranding hidden cravings as source-less (visible) rows; with the FK unchanged the old
  code keeps today's behaviour and the new code adds only the detach.
- 🔒 **A craving keeps its MOMENT itself** (`bookmarks.source_session_id`, written with the
  source, backfilled at migration from the bottle's session, else its ratings' session;
  Codex r1). `cravingSessionIdSql` reads it first. A bottle that is orphaned (ban with
  delete, reconciliation) or loses its last rating (a rating reset, a kick wipe) then
  changes nothing: the outside rule still finds the moment and the bottle's
  `revealed_at`, and a still-blind moment keeps the craving hidden until it is revealed
  or over. No pre-orphaning cleanup is needed (it replaces review r7/r8's rule).
  Residual, named: a legacy bookmark whose bottle is ALREADY orphaned with no rating left
  backfills no moment and shows, as it does today.
- **Re-linking a bottle** (an identity edit, § 3): a craving sourced from it whose source
  is still hidden for its owner (`outsideViewSql`) follows the bottle to the new wine (or disappears into an
  existing craving of that wine, which shows nothing new while it is hidden); a visible
  craving stays on its wine and loses "you craved it here" and its stored moment
  together.
- **Collisions** (the purge's vintage-null, the conversion's merges, a re-link into an
  existing craving): keep the visible row, else the earlier `saved_at`.
- **Badges** count visible cravings only (the raw `bookmark.count` at
  `lib/badgeService.ts:115` changes); a hidden one counts after its reveal. No crave path
  awards badges or XP in its own answer (today only the rate POST calls
  `checkAndAwardBadges`); keep it that way, or the answer becomes the oracle.
- **`craved` is never emitted on a row redacted for the viewer**, by whichever rule
  redacts that surface: the live rule in the moment, the outside rule in the feed and on
  profiles (a feed "Wine N" must not light up because the viewer craves P). Craving from
  someone else's POST goes through the post gate (`viewerCanSeePosts`) and the outside
  rule for the caller, the same neutral answer when the post's bottle is redacted for
  them.
- **The old by-wine routes go**: `DELETE /api/session/[code]/wines/[wineId]/bookmark`
  (`deleteMany` by wine id, no participant check) and `DELETE /api/me/bookmarks/[wineId]`
  would be an un-crave on a hidden bottle; removal is by bookmark id only, and refused
  (the neutral answer) while the craving's source is hidden for the caller.
- **Residuals, named** (review r7): (1) *live-hidden, outside-visible*: the live rule has
  no "moment over by dates" term (`lib/sessionState.ts`), the outside rule does
  (`lib/outsideView.ts`); in a moment that is over but unrevealed, the neutral crave stores
  a craving that shows at once, labelled. No new leak (the outside rule already shows
  that label), but the button stays neutral there. (2) *Lost blind craves*: with P already
  craved visibly, craving "Wine N" (= P) stores nothing; if the host then re-links N to
  Q, the user does not crave Q after the reveal. (3) A visible craving disappears from
  the list if its source's moment is later switched to blind or to a hidden line-up;
  craving the wine anywhere visible re-points it. (4) The cohost case below.
- **Residual (4), the cohost**: a cohost sees labels in the moment (the live rule bypasses cohosts)
  but the outside rule bypasses only the strict host and the adder, so a cohost's
  craving made in an unrevealed blind moment stays out of their Cravings until that
  moment's reveal, and its button on that bottle shows the wine-level state the outside
  rule allows. Inconvenient, not a leak.

This replaces, before any code, the held-save design that review rounds two to six
refined (`held_for_reveal`, per-bottle rows, convert-on-conflict): Simon's model keeps the
database's one-per-wine unique and needs no marker, no conversion and no collision rule
beyond "keep the visible row". The kept `bookmarks_user_id_wine_id_key` (one per user per
source) is implied by it and is dropped in § 12 step 9 with `DROP CONSTRAINT IF EXISTS`
and `DROP INDEX IF EXISTS` (a CONSTRAINT on prod, an INDEX in the chain).

---

## 5a. Hard purge must not destroy user history

⚠️ **Correction to the first draft, which claimed catalog entries are "never deleted"
(F3).** That is false. Ordinary lifecycle never deletes — merge is a pointer, not a
delete — but the RFC defines an exceptional, audited **staff hard purge** that does remove
rows, resolving every inbound reference in one transaction.

Today purge is survivable because references are indirect: it runs
`UPDATE wines SET product_id = NULL` and the ratings hanging off those wines are
untouched. Once ratings-via-occurrences and bookmarks point at catalog rows directly, the
same purge would either be blocked by the FKs or destroy user history.

🔒 **Ruling: purge clears or redirects catalog references; it never deletes an occurrence,
a rating or a bookmark.** Concretely, extending the existing purge transaction:

- **Vintage purge** — `UPDATE occurrences SET vintage_id = NULL` and the same on
  `bookmarks`, retaining `product_id`. The wine stays linked at product grain, exactly as
  `wines` does today.
- **Product purge** — null `product_id` on occurrences and bookmarks after its vintages are
  purged. The occurrence survives as an unlinked historical record.
- **Bookmark collision** — nulling `vintage_id` can collide with an existing product-grain
  bookmark for the same user under the `NULLS NOT DISTINCT` constraint. The purge must
  merge the pair, not fail, keeping the visible row, else the earlier `saved_at` (§ 5).

This makes the **historical snapshot on the occurrence load-bearing.** An occurrence keeps
its own `name` / `producer` / `vintage` strings — not as denormalised catalog data, but so
a purged or never-linked occurrence still renders as something a user recognises. Without
it, a purge would leave blank rows in someone's history.

#### 🔒 Bookmarks need the same snapshot, and conditional uniqueness

**Verified gap (F3).** The first revision gave occurrences a snapshot but not bookmarks —
so a product purge nulling `bookmarks.product_id` leaves a `(null, null)` row with nothing
to render. A bookmark on a wine the user never rated has no rating to derive context from
(§ 5), so there is no fallback. Worse, two purged bookmarks from one user both collapse to
`(null, null)` and **collide** under `NULLS NOT DISTINCT`.

Two changes, both required:

- **Bookmarks carry a display snapshot** — `name` / `producer` / `vintage` captured at save
  time. Same rationale as the occurrence snapshot: it is what makes the row survivable.
- **Uniqueness applies only while `product_id IS NOT NULL`** — a partial unique index
  rather than a table constraint. A purged bookmark is historical, not a save target, so it
  is exempt from dedup. `NULLS NOT DISTINCT` still governs the vintage grain within a live
  product.

⚠️ Note the two nulls mean different things and the index must not conflate them:
`vintage_id IS NULL` = "this wine, any year" (a live, meaningful save);
`product_id IS NULL` = "the catalog row is gone" (a historical remnant).

**Alternative considered and not taken:** having purge leave a catalog tombstone rather
than nulling references. It keeps every reference resolvable, but it defeats the point of a
hard purge — the row is meant to be *gone*, typically for legal or abuse reasons. Snapshots
achieve renderability without retaining the purged identity.

The `NoAction`/`Restrict` FKs stay as the backstop: a purge that forgets a reference class
fails and rolls back rather than half-applying.

🔒 **Every FK this change adds INTO the catalogue is `NO ACTION`, never `CASCADE`**
(agreed with the catalogue-maintenance side, 2026-11-18; same as `wines` today,
`prisma/schema.prisma` `Wine.product` / `Wine.vintage`). Per FK: `bookmarks.product_id →
wine_products.id` NO ACTION; `bookmarks (vintage_id, product_id) → wine_vintages (id,
product_id)` NO ACTION (the composite form `wines` uses, so a vintage of another product
is unrepresentable) plus the `(vintage_id IS NULL OR product_id IS NOT NULL)` CHECK; the
occurrence keeps `wines_product_id_fkey` and `wines_vintage_id_product_id_fkey` as they
are. A **CI pin** reads `pg_constraint` on a migrated database and fails unless every FK
whose target is one of the five catalogue tables is `NO ACTION`, the one exception being
the catalogue-internal `product_producers.product_id` (`CASCADE` by ruling,
`prisma/CLAUDE.md`). It lists FKs from the catalog, not from a fixed list, so a future
table that links into the catalogue is covered the day it lands.

---

## 6. Migration

**Production held 130 `wines` rows in July and 150 at the re-survey (2026-11-18: 69 with
ratings, 4 with cravings, 81 with neither, 93 without a moment, 0 linked). About 60 are
real wines.** The rest is test exhaust from before there was a test environment — `a` ×6,
`fghfg`, `Wine in S2`, `S3 reclaim test wine`, `Impression 1–4`, `Crockford verify wine`.

⚠️ **Re-survey before the list is drawn up (2026-11-18).** The July prod survey's headline
"unreferenced = 0" is WRONG: its predicate compared LEFT JOIN counts with `= 0`, and a
NULL never equals 0, so no row was ever counted (the per-row counts, which used
`coalesce`, are right and list about 55 rows with neither rating nor bookmark). The
re-survey fixes the predicate, adds the rows since July, and, now that the catalogue is
loaded, proposes **link candidates** per kept row (the add-flow's own KNN order, top 5
products and producers). Read-only; Simon runs it on prod from his Mac.

🔒 **The conversion is an operator step, not migration SQL.** The migration (§ 12 step 2)
is generic: columns, backfills that follow from the rows' own data (`origin`, the
snapshot's colour / sparkling, bookmark snapshots). The per-row verdicts name prod rows
and prod catalogue ids, so they live in a reviewed verdict file outside the repo and are
applied after the deploy by a guarded script: one transaction, every statement's
`ROW_COUNT` asserted against the list, links written to the occurrence AND to the
bookmarks sourced from it, mints through `lib/catalogWrite.ts` only. Until it runs,
legacy rows are valid unlinked occurrences and their bookmarks render from their
snapshot. ⚠️ **The first link it writes closes the undo window** (§ 0.1): the
catalogue-maintenance side is told before it runs.

Two lists are owed to the catalogue-maintenance side from the conversion (July rulings,
re-checked 2026-11-18, not written in until now):
- **The mint list**: every entry minted during the conversion, entity type + id. They
  record it as minted on our side, which protects it from re-minting; nothing on our side
  knows an entry's origin, so the list is load-bearing.
- **The flagged-link list**: a kept row whose delivered entry disagrees with our string
  (an accent, a name) is linked as is or flagged; flagged rows go to them as a plain list,
  not as change proposals (that table is phase 3). The occurrence's snapshot keeps our
  string either way. A LONG list is itself a finding (systematic disagreement).

🔒 **Ruled 2026-11-18 (Simon), from researching the conversion's rows:**
- **Corrections to a DELIVERED entry go on that list, never into the row.** Missing
  grapes or region, a wrong colour, a name variant: we send them; the conversion writes
  nothing into an entry the catalogue-maintenance side delivered (two writers over one row
  before review and locking exist would let their next delivery and ours disagree).
- **The conversion may mint entries no row of ours references**, when a person sourced
  them (first case: a producer's own press kit, which also showed a missing wine). They go
  on the mint list like every other mint.
- **What a mint copies from such a source is facts in our own words** (grapes, region, how
  the wine is made), never the source's prose, and nothing vintage-specific on the
  product. The source is kept in our records and on the lists, never on the entry
  (attribution is per collection, never per record).

**This is a hand-curated conversion, not an algorithm.** At this volume every row can be
read by a human, which is both cheaper and more accurate than any matching rule. It also
means the catalog gets a clean seed rather than junk that curators inherit.

🔒 **Link first, else mint (Simon, 2026-11-09).** A human links each kept wine to a
*delivered* catalog entry where one exists; only the rest are minted as provisional
entries. And **no existing wine is linked or minted before the first catalog delivery**:
the structural change may ship earlier (§ 7, the anon-restriction-off fallback), but the
conversion waits for the data.

⚠️ **This supersedes the automatic backfill** of RFC § Legacy backfill and
implementation-plan phase 5 (exact-match auto-link, remainder provisional), which
disagreed with this section and never said what happens when a converted wine matches a
delivered entry. The exact-match rules no longer link anything on their own; a human
decides every link. The RFC's vintage-string cases (year / NV token / anything else →
product grain) still describe how a kept wine's vintage text resolves, and its "never
mints" rule bounded an automatic pass, not a human mint through the ordinary path.

⚠️ **"Unreferenced" is not the same as "junk".** In July 58 rows had no rating and no
bookmark, and some of those read as real wines whose session was deleted (`Riesling
Kabinett / Robert Weil`, `Blaue Libelle / Andreas Tscheppe`, several Sardinian producers).
At the re-survey (2026-11-18) it is 81 rows, those named wines each carry a standalone
rating, and 14 of the 81 still sit on a moment's line-up (two of them real bottles; the
other 67 are the orphans below). The rule is "keep what is a real wine, drop what is test litter", and only a
human reading the list can tell the difference.

### 🔒 Deleting a wine cascades to its ratings and bookmarks

**Verified (F5):** `ratings.wine_id` and `bookmarks.wine_id` are both
`onDelete: Cascade` (`prisma/schema.prisma:460`, `:509`). A `DELETE FROM wines` for
anything classified as litter **silently takes user data with it**.

This is not hypothetical in the real data. In July `MxR-tJewUQAo01VyP6Co5`, named
`"test"`, had 1 rating **and** 1 bookmark (both gone by 2026-11-18, so it is now among
the orphans the conversion deletes); six rows named `"a"` still carry ratings. A label
that looks synthetic is not evidence that nothing references the row, and a reference
count is only true on the day it is read: the conversion re-reads it in its own
transaction.

**Rules for the migration, all three mandatory:**

1. **Per-row disposition, written down before anything runs.** Every row (150 at the
   2026-11-18 re-survey; rows added later get a verdict before the run)
   gets an explicit verdict — link (to a named delivered entry) / mint (a provisional
   entry) / drop / needs-a-look — reviewed as a list, not decided inside a `WHERE` clause.
2. **A referenced row is never dropped as a side effect.** If a referenced row is genuinely
   litter, its ratings and bookmarks are deleted *explicitly and named*, as a separate
   confirmed step. Never silently, via cascade.
3. **The delete statement asserts what it did.** `GET DIAGNOSTICS ROW_COUNT` against the
   expected count, inside a transaction that rolls back on mismatch. This is the same
   lesson as the phase-1 runbook guard: **verify what the statement did, not what the
   state looks like afterwards** — state can always be satisfied by pre-existing state.

🔒 **Ruled (Simon, 2026-11-18; was "dropping is optional, when in doubt leave the row"):
the 67 orphans are deleted by the conversion**: rows with no moment, no rating and no
craving, which no screen shows. Every other row is kept, test rows with ratings and test
moments' line-ups included. Verified on the rehearsal (§ 6a): only `ratings` and
`bookmarks` reference `wines`, neither references these rows, and no tile pin or other row
shares their 3 photos (reclaimed after the commit). The conversion re-asserts all of it at
run time, under the three rules above.

### 🔒 Existing photos must survive the migration

**Ruled (Simon).** No new photo features are built in this phase — the three-layer ladder
(§ 4) is the target model, not a feature backlog. But the photos that exist today are real
user content and **must land in the right layer, not be dropped**.

Two homes exist in production, and both carry over:

| Today | Written by | Destination |
|---|---|---|
| `wines.image_url` | Session wine adds | **Occurrence photo** (§ 4, middle layer) |
| `rating_images` (many, ordered by `sort_order`) | Session rating photos **and every standalone check-in photo** | **Rating photos** (§ 4, top layer) — unchanged, they already hang off `ratings` |

`rating_images` needs no migration: it references `ratings.id`, which is untouched. Only
`wines.image_url` moves, and it moves to the occurrence that inherits that wine's id — so
the S3 key stays valid and no bytes are copied or re-uploaded.

⚠️ **Correction — standalone check-ins do NOT use `wines.image_url`.** A previous revision
claimed they did. `app/api/checkins/route.ts` deliberately leaves it null (`:323`, the
reason at `:309`) and stores the user's photo in `rating_images` (`:372`), with a comment giving the reason: a
cascade-delete of the rating would otherwise leave a dangling S3 pointer on a surviving
bookmarked wine. So a check-in photo is already in the layer this proposal wants it in, and
needs no migration at all.

⚠️ **This constrains the litter-dropping rule above.** A row classified as test litter may
still carry an `image_url` whose S3 object is referenced. Dropping it must follow the
standing **capture / commit / reclaim-after** ordering: capture the URL set before the
transaction, delete rows, commit, then reclaim S3 — never reclaim first, or a rollback
leaves the row present and the bytes gone.

Three things in the real data that an automated conversion would get wrong:

- **`Vénénum / Aurelien Lefort` and `Vénénum / Aurélien Lefort`** — one wine, accents
  differ. The folded-name column handles this, which is a useful confirmation that the
  fold-order fix earned its keep.
- **`Blaue Libelle Plus / Sauvignon Blanc`** — the producer field contains a grape. The
  sibling row has it right (`/ Andreas Tscheppe`). An automated pass would mint a producer
  called "Sauvignon Blanc".
- **Vintages that are not years** — `222`, `3333`, `11`, `1780`, `3000`. Catalog
  validation rejects these correctly; all are test rows, but confirm before discarding.

Also worth a human eye: `Mâcon-Village` vs `Mâcon-Villages "Les Sardines"` (same producer,
arguably one product), and `Soif Blanc / Kleines Gut / 2024` appearing twice.

**Minted entries enter the review queue like any other user-minted entry.** Duplicates
among them are resolved by merge, never by pre-collapsing — the same 🔒 rule.
"Pre-collapsing" means an automatic match (Simon, 2026-11-18): rows a PERSON judged to be
the same wine in the verdict list share one new entry, and a new producer is created
once; a later merge covers what the list missed. 🔒 **A linked wine missing our year
gets the year added** (ruled the same day; the add flow's missing-vintage branch, an NV
vintage for an NV token), so the mint list owed to the catalogue-maintenance side carries
vintages too.

**Existing wine ids are inherited by the occurrences they become.** This costs nothing at
migration time and keeps every stored address, deep link and cached mobile screen
resolving. Worth doing regardless of the app situation below. With the table kept (§ 1)
it is literal: the row IS the occurrence, `ratings.wine_id` and the Redis rating keys
`s:{C}:r:{identity}:{wineId}` need no rewrite.

**Existing bookmarks** keep `wine_id` as their source (§ 5), take `product_id` /
`vintage_id` from that wine's link (NULL for every row today) and a snapshot from it.
The conversion then links them with their wine. Two bookmarks of one user whose wines
link to the same entry collide under the new uniqueness: the conversion merges them as
the purge does (§ 5a: keep the visible row, else the earlier `saved_at`), and says so in
its count.

### 6a. Rehearsal on prod's schema

The migration rewrites wines, ratings and bookmarks: three of the seven tables where prod
differs from the chain (§ 0.1). A rehearsal on a chain-built database would pass on
exactly the differences that can fail a deploy (a `DROP INDEX` of what is a CONSTRAINT on
prod fails the deploy; `ratings_score_check` exists only on prod). So:

1. **Schema**: a read-only `pg_dump --schema-only --no-owner --no-privileges` of prod
   (step 0 used `.local/catalog-model-change/prod-schema-2026-11-18.sql`, identical to the
   2026-11-17 dump) restored into a throwaway local Postgres 17, re-dumped from prod by
   Simon on the day of the final rehearsal (prod may have moved).
2. **`_prisma_migrations`**: copied from prod as DATA (the 48 rows with their names,
   checksums, `finished_at` and the one rolled-back row), so `prisma migrate deploy`
   sees exactly prod's applied set and applies only the new migrations;
   `scripts/check-migration-checksums.mjs` then passes against the repo.
3. **Catalogue**: the data-only handover dump (`.local/handover/`, the build that
   loaded prod) restored into the five tables, then `VACUUM ANALYZE`.
4. **Rows (ruled 2026-11-18)**: a copy of prod's sessions, wines, ratings,
   rating_images, bookmarks, feed_items, session_members and session_bans, exported by
   Simon with a script that reduces people to bare ids and blanks rating notes. `users`
   rows keep `id` and `public_id`; `name` and `email` are `NOT NULL` on prod, so they get
   placeholders (`user-<id>`, `user-<id>@example.invalid`), every other personal column
   NULL or its default. The other places a person's name, words or whereabouts sit get
   placeholders or blanks too, by an enumerated column list in the export script:
   `ratings.rater_name` and `notes`, `wines.added_by_display_name`, `sessions.name` /
   `host_name` / `address` / `description` / `link`, feed text, and every check-in
   location (`feed_items.venue_name`, `city`, `country`, `lat`, `lng`; Codex r1; prod's
   `feed_items` has no free-text column). As built (step 0): moment codes and image URLs
   are replaced by salted stand-ins that keep every join and equality (a code is a join
   credential, and covers uploaded before 2026-11-11 carry it in their URL), and a wine's
   own free text (description, vinification, purchase link) by placeholders. Wine names stay (they are
   the conversion's input). The load runs with triggers off on the throwaway database
   only for `users` (`ALTER TABLE users DISABLE TRIGGER USER`, then `ENABLE`):
   `users_public_id_mint` would otherwise mint a new `public_id` on every insert, and the
   username hold triggers would fire. Not `session_replication_role = replica`: that also
   switches off foreign keys and the catalogue's constraint triggers, so dangling rows
   would load silently and the suites would run on states prod cannot hold (review r3).
   After the load, anti-join checks confirm every FK target exists, and every sequence is
   `setval`ed to its table's max id. ⚠️ The reference rows come from migrations, not from a
   schema-only dump: `categories` and `category_styles` are exported with the rows (or
   re-inserted from their migrations) BEFORE the wines and the catalogue load, whose FKs
   need them (review r4). 🔒 This order is authoritative over the numbering above:
   reference rows, `users`, the catalogue (item 3; its `added_by` / `curated_by`
   reference users), then the rest of item 4 (review r5, r6). Deleted after the rehearsal.
5. **Pass criteria**: `migrate deploy` exits 0; the deploy-time backfills match the counts
   the re-survey predicts; **the PREVIOUS release's suites pass on the expanded database**
   (the rolling-deploy test: old code against the new schema); the backfills re-run after
   that pass and change only what the old code wrote meanwhile (they are idempotent, and
   on release day they re-run once the old instances are gone: an old writer leaves
   `sparkling = false` on a `spark` row and a bookmark with no snapshot); the conversion
   script's dry run and real run match the verdict list; the FK pin passes; the new
   suites pass against it. 🔒 The chain-built CHECK snapshot gates are NOT run against
   the rehearsal (prod carries `ratings_score_check`, which the chain does not, and the
   gate rejects any extra CHECK; Codex r1). Instead an explicit before/after diff of
   `pg_constraint` on the rehearsal: every constraint present before the migration is
   present after, and the new ones are exactly the expected list. The old-release
   suites are the compatibility check, the CI gates stay the shape check.
6. **As built (step 0, 2026-11-18)**: `.local/catalog-model-change/rehearsal-build.sh`
   (export: `rehearsal-export.sql`). Two facts the build found: (a) the server must be
   `postgres:17.11` on Debian with a libc `C.UTF-8` database (prod's minor and locale):
   Alpine's musl stores the collation as `C`, and 17.12 adds a `pg_attver` option to every
   new column; either one fails the catalogue loader's fingerprint. (b) 🔒 **A schema-only
   dump does not round-trip prod's 16 varchar `IN (…)` CHECKs**: prod stores
   `ANY ((ARRAY['a'::varchar, …])::text[])`, the dump prints that, and re-parsing the
   printed text stores `ANY (ARRAY[('a'::varchar)::text, …])`, the same predicate in
   other text. The build re-creates them from the `IN` form, then requires a re-dump of the
   rehearsal to equal the prod dump line for line. With that, the loader's own report
   equals prod's (build, counts, content digest, schema fingerprint, fold identity). The
   `pg_constraint` before/after diff above therefore compares prod's own CHECK text.
   After the step-0 review, the build (c) runs as a non-superuser role limited to 20
   connections, like prod's (a migration that needs a superuser must fail here, not on
   deploy), on a loopback-only port, and (d) re-exports every loaded table and requires it
   byte for byte equal to its file. `--reset` restores the last build from a template copy.
   The export keeps its salt inside the server session (the first run sent it as a literal,
   so its files were re-keyed locally with a salt that never left the machine).

---

## 7. Sequencing

```
attributions page ✅ → first catalog fill ✅ → model change → review queue
     (SHIPPED PR #93)      (prod 2026-11-18)     ← NEXT
```

- **Attributions page** — ✅ **SHIPPED (PR #93, 2026-07-27).** A config-driven page in web and
  native naming the catalog's data sources. Some licences legally require this, so shipping
  data without it is a breach. ⚠️ Standing rule, not a one-time tick: a source ADDED to the
  corpus later must have its entry shipped before its data does.
  Hard gate on the fill. Corpus-level, never per-record.
- **First catalog fill** — ✅ **DONE on prod, committed 2026-11-18 10:17:39 UTC**, then
  `VACUUM ANALYZE` (§ 0.1). Every later delivery goes through the phase-4 import path,
  and none comes before it exists, with ONE exception: the flush below.
- **Catalogue flush** (Simon, 2026-11-18; mechanics ruled 2026-11-19) — one full replacement
  with the catalogue-maintenance side's fixes applied (the step 1b feedback), while nothing
  links to the catalogue. **Before release day, on prod's current schema**: the handover's
  load guard refuses any migration list but the one it was built for (measured), so a
  delivery built now cannot load after the release's migrate. The load gets a replace mode
  inside its one transaction (refuse if any row outside the five tables points into them,
  if any such foreign key is not NO ACTION / RESTRICT on delete, or if the catalogue has
  audit rows or rows added on our side; delete; load; the existing asserts), then
  `VACUUM (FULL, ANALYZE)` (rehearsed 2026-11-19 by reloading the same content: without it
  the tables stay at double size). Links held only in Redis (a guest moment's bottle can
  carry a `productId`) are invisible to that check: before the prod load we scan the live
  line-ups for catalogue ids in the removed / merged lists. Ids stay stable for every entity that persists; removed and merged ids
  come as lists and are never reused. The three new columns' values come as a second file,
  loaded after migrate by a guarded one-off update (ours). **Timing (Simon, 2026-11-19):**
  the replacement is TARGETED for Fri 2026-12-04, the columns file may follow, and the
  final rehearsal is the only hard stop: if the replacement misses it, the release ships on
  today's catalogue and corrections wait for review; if the columns file does, they ship
  empty and the same update fills them later. Build step 2 starts on the
  catalogue-maintenance side's answer about the origin column's name (no date set); step
  1b stays open alongside until both files are in and checked.
- **Model change** — this document.
- **Review queue** — the curator screens (phase 3).

**The catalog fence comes down before the review queue exists** (Simon's ruling,
reversing the earlier phase-2/3 boundary). With a handful of testers doing occasional
tastings the volume is negligible, and waiting for a full curator UI to collect a few
dozen wines is real cost for no benefit.

🔒 **Consequence that must be built for:** entries minted during that window are still
`provisional` and still queued — they simply wait longer for a human. The queue must
*record* unreviewed entries from day one, even before anyone can act on them. Otherwise
there is no way to tell afterwards which entries were never reviewed.

⚠️ **`status = 'provisional'` alone is not that record** (2026-11-18): a delivery into a
user-created entry may move it to `confirmed` (ruled 2026-11-12), and then nothing says
that no curator ever looked at it; `lib/catalogWrite.ts` writes no audit row at creation.
So every user mint also writes a **review item** (entity type + id, reason `user-mint`,
created at; resolved at / by stay empty until phase 3) in the same transaction, from
`lib/catalogWrite.ts`. It is its own table, not a column on the five catalogue tables,
so it does not change the shared contract.

**Why the fill must precede the model change:** once anonymous users can only pick existing
entries, an empty catalog means they cannot add anything at all. If the fill slips, ship
the model change with the anon restriction switched off — it is a flag, not a redesign,
and it decouples this work from the data timeline.

### The app

TestFlight has shipped; roughly five testers, using the app mainly during tastings.

✅ **The version floor is proxy-wide (shipped with public user ids; re-verified
2026-11-18).** The app sends `X-Verre-Client: <platform>/<version>/<update>`;
`proxy.ts` runs `clientVersionGate` on **every `/api/*` call**, so an already-signed-in
app polling a moment gets the 426 without re-authenticating, and `apiFetch`
(`apps/mobile/src/lib/apiFetch.ts:39`) sends it to the update screen. The native-auth
wrapper keeps it as a belt. The July caveat ("wired only to `auth/native/*`") is closed.
- 🔒 **The floor is in CODE**: `CODE_FLOOR_IOS` (`lib/clientVersion.ts:22`, `0.1.5`
  today); the effective floor is `max(NATIVE_MIN_VERSION_IOS, CODE_FLOOR_IOS)`. An env
  var loads at boot, so setting it after the deploy would be a second rolling release;
  the floor is raised in code, in the same change as the breaking wire change. Android
  has no code floor (env only).
- The floor compares the NATIVE version; an over-the-air JS update does not lift a
  binary over it. This release needs a new native build anyway (Moment Visibility's
  universal link needs associated domains).
- **The web twin**: `WEB_WIRE_GENERATION` (`2`) sent as `X-Verre-Web`; `proxy.ts`
  bounces a SIGNED-IN moment call without it (an old tab reloads through `/join/<code>`).
  It covers `/api/session/<code>/*` only. ⚠️ **A guest tab open across the deploy is not
  bounced** (review r1 M3; `proxy.ts:52`: a guest has no decoded token, and bouncing with
  `X-Vr-Auth: invalid` would make the old `sessionFetch` drop its guest token). It would
  post adds with no id and no link and read line-ups without `type`. So the server
  answers a moment WRITE that lacks the new generation and the app header with one
  `409` and NO `X-Vr-Auth`, so the guest token survives (not 403 or 429, which the old
  tab maps to a permission or rate message). ⚠️ The old tab does not show the server's
  text: its add modal shows a fixed "Could not save wine", its rating "Save failed (N).
  Try again." (`components/wine/AddWineModal.tsx`, `WineModal.tsx:488-493`). Residual,
  accepted: an old guest tab fails its writes with that generic error until it reloads;
  its reads keep working. The `REMOVED_PATH` exemption (`proxy.ts:33`: leave and
  removed-state) stays, or an old removed tab's "Delete my ratings" would be refused. The
  test harness's hard-coded `X-Verre-Web: 2` (`.local/test-env/scripts/_lib.sh`) moves
  with the bump. And the converse during the rollout: a NEW signed-in tab reaching an OLD
  instance is bounced once (the old proxy accepts only `2`) and reloads: residual. An old
  signed-in tab's `/api/checkins` post (outside `MOMENT_PATH`) fails the new validation
  (no link) with a plain 400: named residual. ⚠️ An old `/me/saved` tab open across the deploy
  still calls `/api/me/bookmarks` with the old join; accepted residual, on the condition
  that it can only read wrong until reloaded: the new `/api/me/bookmarks/[id]` DELETE takes
  a bookmark id parsed strictly (`lib/parsePathId.ts`), so the old tab's wine-id DELETE is
  a 400/404, never a deletion of something else. Bump the generation in this change.
- The header is self-reported. Fine for helping honest clients update; not a defence.
- **Consequence for the colour / sparkling split (§ 9):** no shipped build reaches the
  new server, so nothing needs a derived legacy `type` on the wire or legacy writes.
  What still carries the old shape is DATA: Redis line-ups cached before the deploy
  (anonymous moments have no record to rebuild from) are read tolerantly.

Plan: raise the floor when this ships, inherit the wine ids anyway, and tell the testers.

#### 🔒 One forced update, shared with Moment Visibility (Simon, 2026-11-15)

The rest of Moment Visibility (steps 1a, 1b, 2, 3, go-live) ships under the SAME floor
raise as this cutover. What the shared release must hold (Moment Visibility itself is
planned in its own proposal):

- **The floor rises in the deploy that carries MV step 1a**, not at MV's flag flip: 1a is
  live without its flag (blind rows of the feed and of Impressions lose their wine id,
  every feed row gains `ratingId`), and an old build matching by wine id opens the wrong
  blind row. This cutover is breaking from its first deploy too. One deploy, one floor.
- **The app build both need** carries: this change's line-up, check-in, bookmark and
  craving shapes; MV step 2's switches, reading a 404 from `GET …/visibility` as
  "feature off" (the flag flips later); Cravings keyed on the **bookmark id** (MV step 3
  re-keys Cravings on it, this change moves bookmarks off the wine: one new row shape for
  both, never two cutovers); no wine id, catalogue id or catalogue photo on a blind row.
- **Shared schema surfaces**: both migrations touch `sessions` and
  `prisma/session-record-checks.json`; MV 1a's scrub test fails on any non-NULL column of
  a tombstoned session, so `sessions.lineup_revision` (§ 8a) is nullable and joins both
  delete scrubs. Migration timestamps are ordered at rebase. ⚠️ MV's proposal carries a
  `sessions.look_rev` bumped on line-up writes; its step-1 plan dropped it (T2) and brings
  it back only if MV 1b's measurement asks for a cache. If it returns, the line-up events
  bump ONE counter (this change's `lineup_revision`) and `look_rev` covers only what the
  line-up revision does not (settings, wipes); decide there, never two counters for the
  same event.
- **Order on release day**: the TestFlight build is uploaded and processed beforehand but
  not yet given to testers → the expand migrations (MV 1a's and this change's) →
  `scripts/rehydration-precheck.mts` on prod, read by Simon (every record-only row, § 8a)
  → the server and web code with `CODE_FLOOR_IOS` raised, in a quiet window (no moment in
  use) → **every serving instance verified on the cutover build** (a build id the server
  reports; Codex r1: an old instance accepts a newer app and would serve it old shapes,
  `lib/clientVersion.ts`, `proxy.ts:50`) → the build released to testers (the
  gap is minutes; old builds see the update screen meanwhile) → the warm-up
  reconciliation (§ 8a.0) → the conversion (§ 6) → MV's go-live runbook and flag, later.
  The version number is Simon's call.
- 🔒 **The fence opens WITH the code** (review r1): every new bottle must link, and while
  search is staff-only nobody else could add one. So the new code's gate defaults to
  OPEN (`lib/catalogGate.ts`), and `CATALOG_PUBLIC_ENABLED=false` becomes the kill switch
  (it closes search, the moment-scoped search and entry creation again; adding then
  needs staff). No env change, no second restart on the day, no gap. Its conditions (the
  interleaved test, the search-capacity decision) are met BEFORE the day. Setting the env
  before the push instead would open the OLD code's catalogue endpoints for the length of
  the rollout. `docs/dev/deployment.md` § `CATALOG_PUBLIC_ENABLED` changes with it.

#### ⚠️ Inheriting ids is not sufficient on its own (F6)

Occurrences inheriting `wines.id` keeps **URLs** resolving — `/session/ABC/impression/xyz`
still finds something. It does **not** fix the endpoints whose *meaning* changes.

The concrete case: `app/api/session/[code]/wines/[wineId]/bookmark/route.ts:24` takes a
session wine id and persists it as `bookmarks.wine_id`. Under this proposal bookmarks key
on product + vintage. An old client posts an occurrence id to an endpoint that now expects
catalog identity. Ratings have the same boundary.

⚠️ **This is a response contract, not a write shim (F4).** The first revision proposed
translating bookmark POSTs and stopped there. That is not sufficient — existing clients
consume bookmark **responses** as occurrence ids in three distinct ways, all verified:

| Call site | What it does with `wine_id` |
|---|---|
| `components/session/SessionShell.tsx:241` | Builds a `Set` of ids to drive the in-session save toggle |
| `apps/mobile/src/lib/api/sessions.ts:299` | Same set, for the native save toggle |
| `components/me/SavedClient.tsx:59` | Cross-matches bookmarks to ratings — its comment calls `wine_id` "the only stable join key" |

Returning catalog ids to those clients silently breaks all three: the toggle shows the
wrong state, and the saved view stops matching ratings to bookmarks. DELETE has the same
problem in reverse.

🔒 **RULED: hard cutover** (Simon — the testers get an update either way). Full
compatibility would mean synthesising an occurrence id that no longer has a stable meaning,
and that fiction leaks; maintaining it across three read paths, a write path and a delete
path is not worth it for five testers who use the app mainly at tastings.

### 🔒 RELEASE GATE: the version gate must cover the changed endpoints

**This is a deployment condition, not owed work.** Hard cutover means a stale signed-in
client reaching the changed bookmark endpoints is *known* to misbehave. ✅ The July
concern (gate wired only to `app/api/auth/native/*`) is closed: `proxy.ts` gates every
`/api/*` call (above).

**Ship condition — both must hold before deploy:**

1. ✅ The gate fires for an **already-signed-in** native client (proxy-wide). Re-checked on
   the release build.
2. **`CODE_FLOOR_IOS` raised in code** past the last pre-cutover build, in the cutover's
   own deploy (an env var is read at boot; § 7 above). Android: `NATIVE_MIN_VERSION_ANDROID`
   if an Android build is in anyone's hands.

If neither holds, the cutover ships a silent break rather than an update prompt. That is
the failure this gate exists to prevent.

An occurrence with no catalog link cannot be bookmarked under the new model — there is no
catalog identity to store. That path returns a clear error rather than silently succeeding.

---

## 8. Where the hard part is

Not the schema. Three places.

### 8a. Persistence: one state machine, two modes

#### 8a.0 What the rehydration already shipped (verified against the code, 2026-11-18)

The rehydration (`redis-rehydration.md` § 3, § 5.4) built most of this section's
machinery for the whole session; it left the occurrence CONTENT authority to this change
by name (§ 3 "best-effort mirrors": *"Turning a content-mirror failure into a request
failure with Redis compensation is the authoritative-write matrix of the model change"*).

| Item in this section | Status | Where / what remains |
|---|---|---|
| Two modes, keyed on the `sessions` row, never the caller | ✅ shipped | `ctx.row` inside the contract, read `FOR UPDATE` under the advisory lock |
| Promotion under a lock, one-way, idempotent, copying ids, order, reveal state | ✅ shipped differently | `ensurePromoted` (`lib/session.ts`) inside the mutation contract (fenced Redis lock → `pg_advisory_xact_lock(hashtext('session:'‖code))` → live row `FOR UPDATE`); also copies bans and a member row per registered `u:`, sets lifespan `unlimited`, checks `session_tombstones`. Still owed: initialise `lineup_revision` in that transaction |
| Occurrence mutations take the same lock | ✅ shipped | every wine writer runs in `withSessionMutation` |
| Durable `position` | ✅ shipped | `wines.position`, renormalized on every mirror (rehydration § 4.6) |
| Reveal state always has a row in a promoted session | ✅ shipped | the mirror runs on every list write, keyed on `ctx.row` (the reveal-route bug below is closed) |
| `pgUpsertWine` in silent `catch {}` | ✅ gone | replaced by `mirrorLineup` inside the contract; what remains best-effort is `bestEffortMirror` (a SAVEPOINT) around the line-up content |
| NX to create, XX + `KEEPTTL` to update, lint-gated | ✅ shipped | the revision REPLACE below is an `XX` write |
| **Content authority in a promoted session** | ❌ owed | today Redis-first: `mutateWines` decides on the cached array, `mirrorLineup` projects it under a SAVEPOINT, a failed mirror is logged and repaired by the next list write. This change makes it record-first (matrices below) |
| **Revision-stamped line-up** | ❌ owed, and `s:{C}:gen` does not replace it | below |
| Client-generated ids, insert-only create, 409 | ❌ owed | ids are minted server-side (`lib/session.ts:519` `existing?.id \|\| nanoid()`) |
| Redis-only sessions cannot attach images | ❌ owed | `addWineToSession` uploads for any caller today |
| Image attach separate from create, S3→DB reclaim | ❌ owed | today the image rides the POST / PATCH body; `reclaimIfUnreferenced` covers a refused add |
| Reorder / reveal / hide-all decided by Postgres in a promoted session | ❌ owed | today `mutateWines` + mirror, as everything else |

🔒 **A cutover hazard this creates** (not in the July text): before the deploy, a promoted
session's cache can hold a bottle whose best-effort mirror failed, so the record lacks
it. The first record-first read would rebuild the line-up FROM THE RECORD and drop that
bottle and orphan its Redis ratings. Closed by construction, not by deploy order
(review r1 B3): a NULL `lineup_revision` means "not reconciled", and the first contract
that meets it with a present cache copies cache → record strictly before anything may
replace the cache (§ 8a, Staleness). The operator script (extending
`scripts/rehydration-precheck.mts`, which compares cache and record already) does the
same ahead of time, dry run first, listing both directions (cache-only bottles to
copy, record-only rows to orphan).

🔒 **The cached line-up keeps the OLD fields until the contract step** (review r2): during
the rollout, an old instance's rate or bookmark POST mirrors the WHOLE cached array into
the record strictly (`rate/route.ts:157`, `bookmark/route.ts:53`), writing `style` from
`w.type` and the links from flat `w.productId` / `w.vintageId` (`lib/session.ts:745-761`).
If the new projection dropped those fields, one rating on an old instance would null
every link of that moment, and record-first would make it permanent. So `WineMeta` in
Redis stays a superset: flat `productId`, `vintageId`, `grape`, `region`, `country`,
`description`, `vinification` and a legacy `type`, written correctly by the new code;
the catalogue `entry` exists only on the WIRE, built in `wineToWire`. 🔒 **`style` until
step 9** (review r3, r4): for a row with a stored `style`, the Redis `type` IS that
`style` verbatim (so `nonalc` survives, which no colour / sparkling pair can express),
derived from colour / sparkling (§ 9's last colour bullet) only when `style` is NULL.
**Every new-code statement that sets `colour` or `sparkling` sets `style` in the same
statement**: the derived token when the stored one no longer derives to the new pair,
else unchanged (so an unrelated edit of a `nonalc` row keeps `nonalc`). A LINK always
rewrites `style` from the entry's pair, so a linked `nonalc` row loses the token even when
the pair is unchanged; the alcohol-free fact is the entry's `abv` (product or vintage,
both carry it), which the runtime link reads and never writes. So the `nonalc` badge
count (`lib/badgeService.ts:101`, `w.style = 'nonalc'` today) becomes "the token OR the
effective entry's `abv = 0`", or linking would regress `type_nonalc_5` / `type_all`.
The conversion's links set the snapshot from the entry, as every link does. An old instance's PATCH replaces
the object wholesale and mirrors `style` but not `colour` / `sparkling`
(`[wineId]/route.ts:167`, `addWineToSession` returns only the old keys); so the backfill
re-run, and only it ("style wins" is never a read rule), re-derives the pair where
`derive(colour, sparkling) IS DISTINCT FROM style` — one direction only, with `''` ≡
NULL and `nonalc` or any unknown token ≡ "neither" — never the reverse, which would erase
the colour of a sparkling rosé (`spark` derives no colour). A test
drives the OLD `upsertLineup` over a new-projected blob and asserts no row changes, with
a fixture that fills all fifteen compared columns, a `nonalc` row, and a `revealed_at`
written by new code (millisecond vs microsecond precision).

🔒 **A session is in exactly one of two persistence modes, and the transition is one-way.**

```
  REDIS-ONLY  ──[promotion, under session lock]──▶  POSTGRES-AUTHORITATIVE
  (no sessions row)                                 (sessions row exists)
```

🔒 **Mode is determined by whether the Postgres `sessions` row exists — never by the
current caller's login state.** This is the rule that makes the transition race-free.
✅ Shipped by the rehydration: the mirror decides on `ctx.row` under the locks (the July
text pointed at a per-request `if (session?.user)` that no longer exists). The TRIGGER
of promotion stays "a logged-in caller acted" (`ensurePromoted` is called by the
wine add, rate, visit and bookmark routes, before their own contract).

| | Redis-only | Postgres-authoritative |
|---|---|---|
| Trigger | Session created, nobody logged in | First registered user joins or acts |
| Authority for occurrences | Redis | **Postgres** |
| Redis role | The data | Rebuildable cache |
| Lifetime | 48h TTL, then gone | Durable |
| Reverses? | 🔒 **Never** | — |

**Why not uniform.** A fully anonymous tasting has no registered participant, so nothing
reads its occurrences afterwards — no profile, no history, no aggregation. Anonymous users
can only *pick* existing catalog entries (§ 2), never mint them, so such a session creates
no catalog rows either. Writing it to Postgres would buy nothing and would change the
product's ephemerality promise. **Root `CLAUDE.md`'s "anonymous sessions stay Redis-only"
stays true as written.**

#### 🔒 Promotion protocol

**The race this closed** (July wording; the cited lines are gone): `/visit` created the
Postgres session while the wine add independently decided persistence per request from
the caller's login state. A wine add running concurrently with a promotion can miss *both* the snapshot copy
and the later Postgres write, and vanish.

✅ **Shipped as `ensurePromoted` (`lib/session.ts`) inside the session mutation contract**
(`lib/sessionMutation.ts`; `lib/CLAUDE.md` § Session mutation contract): fenced Redis lock
`lock:session:{CODE}` → `pg_advisory_xact_lock(hashtext('session:' || code))` → the live
row `FOR UPDATE`, in that order (the lock-order rule, never a Redis lock while holding an
advisory one). Inside: re-check the row (another request promoted → no-op), check
`session_tombstones` (a committed delete is not promoted back), create the row
(`unlimited`), copy the cached line-up with ids, positions and `revealed_at`, the bans,
and a member row per registered `u:`; projection after COMMIT rewrites meta from the
record and re-stamps every key's TTL. One-way and idempotent as specified.

What this change adds to it: **initialise `lineup_revision` in the creating transaction
and stamp the projected line-up with it**, and copy the line-up through the same
record-first insert the create uses (so a copied bottle and an added one are one code
path).

🔒 **Occurrence mutations take the same locks** (shipped): an add either completes before
promotion (and is copied) or waits until promotion commits (and then writes to Postgres
directly). It cannot fall between. ⚠️ A FAILED promotion leaves the session Redis-only
and the add proceeds in Redis-only mode (`wines/route.ts:125`, best-effort by design; the
next logged-in act retries). Correct under the two-mode model; the concurrency test
(§ 9) covers the add racing a promotion, not a promotion failing.

#### 🔒 Staleness is not self-detecting — the cache carries a revision

**Verified defect in the first revision.** It claimed a failed cache write "self-heals on
the next read". It does not, and it still does not after the rehydration (re-verified
2026-11-18; `getWines` no longer exists, its successors behave the same):
`openSession` / `loadLiveWines` (`lib/sessionRehydrate.ts:523-543`) serve any present
blob; the rebuild writes the line-up `NX` (`:425`), so even a forced rebuild keeps a
present stale one; a projection that fails after COMMIT only deletes META
(`scopedInvalidate`), and a process killed between COMMIT and its projection invalidates
nothing. Today that is harmless because content is Redis-first (the cache is never BEHIND
the record, only ahead of it). Under record-first content each of these leaves a stale
line-up for the cache's lifetime, which is `unlimited` for every promoted moment.

🔒 **`s:{C}:gen` is not the revision.** The publication generation fences a rebuild's
PUBLISH against lease-less writers (a rebuild that read the record before their change
cannot publish over it). It lives in Redis only; the record never learns it, so it cannot
tell that a present line-up is behind the record. The two have different jobs and both
stay.

- `sessions` gains **`lineup_revision integer NULL`** (nullable so the session-delete
  scrub can NULL it, which Moment Visibility's scrub test requires; `integer`, not
  `bigint`, so a session row that reaches a serialised object never carries a `BigInt`),
  bumped `COALESCE(lineup_revision, 0) + 1 … RETURNING` in the same transaction as every
  occurrence mutation of that session.
- 🔒 **NULL means "not reconciled"** (review r1 B3). Every promoted session starts NULL at
  the deploy, and its cache may hold a bottle the record lacks (§ 8a.0). The first
  contract that meets a NULL revision with a PRESENT cache reconciles BOTH ways, then
  stamps 1: cached bottles the record lacks are copied in strictly (today's mirror, not
  best-effort), and record rows of that session the cache does not list are ORPHANED
  (`session_id = NULL`, ratings kept, the ban-wipe treatment; review r2). The second half
  matters: `mirrorLineup` deliberately leaves the rows of a DELETE whose mirror failed
  (`lib/session.ts:782-785`), so without it the first projection from the record would
  put a deleted bottle back, ratings attached. With no cache it stamps 1 from the record,
  and a cold session cannot tell such a row from a live one. ⚠️ Nor can a warm one
  always (review r3): a cache restored BEHIND the record (a Redis failover) makes a live,
  rated bottle look exactly like a failed-DELETE leftover. So the human gate is on prod,
  before the code that orphans: `scripts/rehydration-precheck.mts` (it reports both
  directions, `onlyInRecord` included) runs between the expand migration and the code
  deploy, and Simon reads every record-only row (the script reports ids, and only for warm
  sessions with a present line-up; the release adds a names lookup and re-runs it
  immediately before the push; a failover after that last run is the named residual).
  Orphaning happens before the mirror
  re-ranks unlisted rows (`lib/session.ts:790-794`); the photo follows the D8 predicate;
  cravings sourced from an orphaned row keep their source and their stored moment
  (`source_session_id`, § 5) and stay hidden until the outside rule allows; nothing is
  deleted. Only a non-NULL revision may REPLACE a cache from the record.
  So the order of the deploy and the operator script no longer matters: the script is a
  warm-up that does the same reconciliation ahead of the first poll, with a dry run that
  reports what it will copy. Promotion stamps 1 in its creating transaction.
- The cached line-up carries the revision it was built from in a **sibling key**
  (`s:{C}:wrev`), written in the SAME fenced `MULTI` as the line-up. Never inside the
  blob: the previous release during the rolling deploy and about ten raw readers parse
  `s:{C}:wines` as `WineMeta[]`.
- The line-up read (`openSession`, `loadLiveWines`, and every contract that reads the
  line-up to decide) compares it with the record: one primary-key read of
  `lineup_revision`. Equal → serve. Missing, unparseable or behind (record non-NULL) →
  **rebuild the line-up from the record as a fenced REPLACE** (`XX KEEPTTL` under the
  lease, not `NX`), then serve. Ahead (the cache names a revision the record never
  committed: an `EXEC` that landed before a failed COMMIT) → the same REPLACE.
- Redis-only sessions have no record and no revision: unchanged.
- 🔒 **Every writer of a promoted session's bottles bumps** (review r1 M2), not only the
  five routes in the matrix below: the ban-with-delete (`lib/sessionWipe.ts:164-173`), the
  brought-by reassign (`lib/session.ts` `reassignProvenance`), account deletion's
  provenance updates and its Lua rewrite of the cached line-up (`lib/accountDelete.ts`,
  the `d:` migration), `wipeEmptySession` (`lib/accountDelete.ts:520`), the operator
  scripts `scripts/rekey-session-images.mts`, `scripts/rekey-user-images.mts` (rewrites
  `wines.image_url` across sessions) and `scripts/backfill-lineup-positions.mts`, the
  session DELETE's orphaning (it ends the
  session, so it scrubs rather than bumps). A standalone check-in's occurrence has no
  session and no revision. A **census gate** (the `scripts/check-username-writes.mjs`
  pattern) lists every `INSERT` / `UPDATE` / `DELETE` on `wines` and every write of
  `k.wines(…)`, and fails on one not in its expected list, so a new writer cannot forget
  the bump. ⚠️ Correction to the paragraph above: the cache can already be BEHIND the
  record today for provenance (a reassign is record-first; the rebuild's `patchedWines`
  exists to repair it, `lib/sessionRehydrate.ts:426`).

Costs one extra indexed read per line-up read (the moment screen polls every 5 s per
participant); measure on staging before assuming it is acceptable (§ 9). What is *not*
acceptable is the current shape, where a stale cache is indistinguishable from a fresh
one.

🔒 **Keep it off the poll's round trips (step 1, 2026-11-18; both consultations agree).** The
read itself is negligible (≈ 0.02–0.1 ms on staging); its cost is one round trip plus app CPU
per statement (≈ 0.3–0.85 ms in the sandbox, about twice that throttled to ⅛ core), on an app
that one ⅛-core instance caps near 20–26 requests a second (§ 9). So: for a signed-in caller of
a promoted moment add `s.lineup_revision` to `readGrant` (`lib/sessionGrant.ts`), which already
reads the `sessions` row by code on every request (`lib/identity.ts:228`), and fetch `wrev` in
`openSession`'s existing `MGET`: zero extra statements. A guest of a promoted moment has no
database read on a poll today, so the guest pays one; whether to memo it per code for a second
or two is open (Fable: yes, writers re-read under their lock; Codex: a cross-request memo weakens
stale detection), decided in step 3. Writers: the bump is the contract's row-lock statement
(`UPDATE … RETURNING` in place of `SELECT … FOR UPDATE`), not a statement of its own; reorder is
one `UPDATE … FROM unnest()` touching only moved rows; `lineup_revision`, `position` and
`revealed_at` stay out of every index (HOT updates).

#### 🔒 Occurrence ids are client-generated

**RULED** (was left as two options; now decided). The client mints the occurrence id — a
nanoid, as today — and sends it.

This is required for retry-safety: ids are minted server-side today
(`lib/session.ts:519`, `existing?.id || nanoid()`), so a lost response followed by a retry
creates a **second** occurrence — and since two identical bottles in one lineup are legal
(§ 1), the duplicate is indistinguishable from a deliberate one. The rule holds in BOTH
modes: in a Redis-only session the add's pure transform finds the id in the cached array
and returns it unchanged when session and adder match, else rejects with 409. Standalone
check-ins mint their occurrence the same way (`app/api/checkins/route.ts:313` mints a
server id today), keyed on the client id.

Chosen over an idempotency-key column because it adds no schema, and because it makes the
S3 key known *before* the row exists, which the image protocol below depends on.

🔒 **Create is INSERT-only — never an upsert.**

> Create uses `INSERT … ON CONFLICT DO NOTHING`; it never updates an existing occurrence.
> On conflict, return the existing occurrence **unchanged** only when its session and adder
> identity match the caller's request. Otherwise return **409**.

⚠️ **Why this is an authorization rule, not just a correctness one.** Occurrence ids are
visible to every participant. An upsert-on-client-id would let a provider POST another
provider's existing id in the same session and overwrite their bottle — bypassing the
ownership check that `PATCH /wines/[wineId]` enforces. Insert-only closes that: the only
thing a conflicting POST can do is return someone else's row (when identity matches — i.e.
a genuine retry) or fail.

Server-side validation also required: the id must match the expected nanoid shape.

🔒 **A reply that returns an EXISTING row goes through the viewer's redaction** (Codex r1):
the add's echo is a plain `wineToWire` today (`wines/route.ts:173`, "the adder just typed
the bottle"), which is right for a fresh insert only. A retry that returns the stored
occurrence may return what a host changed since (a re-link under Blind for Everyone, or
under a hidden line-up), so it answers with an identity-free acknowledgement (the id
and "already added"), and the client re-reads the line-up through the GET, which
applies every rule. Not `buildWineEcho`: it passes `echo: true`, which skips the
hidden-line-up gate (`lib/sessionState.ts:225`, `:290`; Codex r2). Test: an adder's
bottle re-linked by the host under Blind for Everyone, and again under a hidden
line-up, then the adder retries its POST.

🔒 **A check-in retry replays the WHOLE check-in** (Codex r1): a check-in is an
occurrence, a rating and a feed item in one transaction (`app/api/checkins/route.ts`),
and nothing stops a second standalone rating of one occurrence today (`feed_items.rating_id`
is unique, the rating is not). So: one rating per standalone occurrence (a partial unique
on `ratings (wine_id) WHERE session_id IS NULL`, checked against prod by the re-survey
first), and an `ON CONFLICT` on the client occurrence id returns the existing check-in
(occurrence, rating, feed item) when the caller owns it, else 409. Tests: concurrent
retries, and a response lost after COMMIT, end with exactly one of each.

#### 🔒 Redis-only sessions cannot attach occurrence images

> Redis-only sessions cannot attach occurrence images, matching the existing anonymous
> cover-photo restriction. Image attachment requires promotion to Postgres-authoritative
> mode.

**This follows an existing rule rather than inventing one.** `app/api/session/route.ts:115`
already rejects a cover photo from an anonymous session, and its comment states the exact
reason: *"an anonymous session has no Postgres row, so its Redis TTL expiry would orphan
the S3 bytes with no deletion path."* The same reasoning applies verbatim to occurrence
photos.

⚠️ **This is a behaviour change** — anonymous wine-image uploads are currently possible, so
the invariant is *newly* enforced, not merely documented. The alternative (a dedicated
ephemeral S3 prefix with an enforced lifecycle policy) is considerably more machinery for
a path where nothing durable is being kept anyway.

🔒 **Nothing but an explicit `reclaimImage()` call ever deletes S3 bytes.** Redis TTL does
not. Transaction rollback does not. Cascade delete does not. Every rule below exists
because of that.

#### 🔒 Mutation matrix — Redis-only mode

Redis is the authority. No revision, no cache semantics — there is nothing to be a cache
*of*.

| Mutation | Write | S3 | On failure |
|---|---|---|---|
| **Create** | `mutateWines` (WATCH/MULTI) | 🔒 Image rejected — see above | 4xx/5xx, nothing written |
| **Edit** | `mutateWines` | 🔒 Image rejected | 4xx/5xx, no change |
| **Delete** | `mutateWines` | None to reclaim, by invariant | 4xx/5xx, no change |
| **Reorder** | `mutateWines` — remains the ordering authority in this mode | — | 4xx/5xx, no change |
| **Reveal / hide-all / reveal-all** | `mutateWines` | — | 4xx/5xx, no change |
| **Image attach** | 🔒 **Rejected — 403, promote first** | — | — |

#### 🔒 Mutation matrix — Postgres-authoritative mode

**Validation always runs first** — including image validation (MIME allow-list, magic
bytes, size cap), so an invalid payload is a 400 before anything is written.

| Mutation | Authoritative write | Cache | S3 | On authority failure | On cache failure | Retry |
|---|---|---|---|---|---|---|
| **Create** | `INSERT … ON CONFLICT DO NOTHING` + bump revision, one txn | Rewrite, stamped | — (see image attach) | 4xx/5xx, nothing written | 200; next read rebuilds | Same session + adder → return existing; else **409** |
| **Edit** | Update occurrence + bump | Rewrite, stamped | Reclaim replaced image **after** commit | 4xx/5xx, no change | 200; next read rebuilds | Idempotent by field values |
| **Delete** | Delete occurrence + bump | Rewrite, stamped | Capture URLs before txn, reclaim **after** commit | 4xx/5xx, no change | 200; next read rebuilds | Idempotent (already gone → 200) |
| **Reorder** | Update `position` for all + bump, one txn | Rewrite, stamped | — | 4xx/5xx, no change | 200; next read rebuilds | Idempotent (absolute order) |
| **Reveal / hide-all / reveal-all** | Update `revealed_at` + bump | Rewrite, stamped | — | 4xx/5xx, no change | 200; next read rebuilds | Idempotent (absolute state) |
| **Image attach** | Upload to S3 → write URL to occurrence + bump | Rewrite, stamped | 🔒 **Reclaim the new object if the Postgres write fails** | Object reclaimed; occurrence unchanged | 200; next read rebuilds | Same key → overwrite in place |

🔒 **Image attach is a separate operation from create.** Creating an occurrence succeeds or
fails on its own; the image is applied afterwards against the known id, and its failure
never rolls back or duplicates the occurrence. The client may retry the image alone.

🔒 **The S3→DB failure rule** closes the orphan: if the object uploads but the Postgres
pointer write fails, **reclaim the newly-uploaded object** before returning the error.
Without this, every failed attach leaks bytes nothing references. This is the mirror of the
existing capture/commit/reclaim-after rule for deletes.

#### 🔒 Ordering authority moves with the data

July text, updated: the reorder runs `hostLineupWrite` (`lib/sessionRoute.ts`): the
permutation is decided inside the fenced `mutateWines` transform and then mirrored to
Postgres best-effort (`lib/sessionRoute.ts:163`); Postgres decides nothing. Once Postgres owns `position`, **reorder becomes a Postgres
transaction** and the cache is rewritten from the committed result.

⚠️ **Qualified by mode.** In **Redis-only** sessions `mutateWines` remains the ordering
authority, exactly as today — there is no Postgres row to arbitrate. In **promoted**
sessions it writes the cache but is **no longer where conflicts are resolved**; that moves
to the database. Same split for reveal, hide-all and reveal-all, all Redis-only mutations
today.

**Divergence rule:** where cache and authority disagree, **Postgres wins and the cache is
rebuilt.** No merge, no last-writer-wins heuristics.

#### The bug this fixes — ✅ closed by the rehydration

The July text cited `reveal/route.ts:44` (the Postgres row might not exist when a host
reveals a wine, because the old `pgUpsertWine` fired only on a logged-in act). The
rehydration's mirror keyed on `ctx.row` closed it for every promoted session. Fully
anonymous sessions have no row by design, the accepted cost of the two-mode model.

#### 🔒 The lifecycle matrix

What survives each destructive or identity-changing event. Rows are events; a blank means
untouched.

| Event | Occurrence | Rating | Bookmark | Snapshot strings | S3 objects |
|---|---|---|---|---|---|
| **Session expiry** (Redis-only) | Expires with TTL | Redis ratings expire with TTL | None exists | — | 🔒 **None exists, by invariant** — images are rejected in this mode |
| **Session expiry** (promoted) | Survives | Survives | — | Survives | Retained |
| **Session soft-delete** | Survives, ORPHANED (`session_id = NULL`, as built; `origin` keeps it a session occurrence) — corrected 2026-11-18, the July row said "retained" | Survives (keeps its `session_id`, the grouping signal) | Survives with its source | Survives | Cover reclaimed; occurrence photo kept while a rating or a bookmark's source references it (D8), else reclaimed after commit |
| **Ban with delete-their-bottles** | Survives, orphaned (`lib/sessionWipe.ts:167`); leaves the line-up | Others' ratings survive; the target's go per the ban scope | Others' cravings keep their source and stored moment and stay hidden until the outside rule allows (§ 5); the target's own cravings sourced in that moment are deleted (`lib/sessionWipe.ts:144-145`) | Survives | No wine-photo reclaim (as built) |
| **Catalog merge** | Link follows the pointer at read time | Unchanged | Unchanged | Unchanged | — |
| **Catalog hard purge** | `vintage_id` and/or `product_id` nulled; row survives | Survives | Survives; snapshot renders it | 🔒 **Load-bearing** — the only thing left to display | Retained |
| **Account deletion** | Session occurrences: provenance tombstoned (`d:` / `'[deleted]'`), as built; standalone ones as `lib/accountDelete.ts` handles their wine rows today (the build re-reads it) | Per the existing split rule | The user's own cascade | Retained on tombstoned rows | The user's own uploads reclaimed via explicit `reclaimImage`; a surviving moment's occurrence photos kept (D8/D9) |
| **Occurrence delete** (host removes the bottle) | Gone | Cascade | Cravings first made there keep their wine and lose "craved it here" (source `SET NULL`); one whose source is still hidden for its owner is deleted in the same transaction (§ 5) | Gone | Capture → commit → reclaim after |

⚠️ **The purge row is why snapshots exist** on both occurrences (§ 5a) and bookmarks
(§ 5a). Every other row survives on its catalog link; the purge row has none.

⚠️ **S3 reclaim is never implied by a cascade** — every deletion path needs explicit
`reclaimImage()` calls, per the standing invariant in root `CLAUDE.md`.

#### Error handling

✅ **`pgUpsertWine` and its silent `catch {}` are gone** (the rehydration replaced them with
`mirrorLineup` inside the contract). What remains is the deliberate best-effort form:
`bestEffortMirror` (a SAVEPOINT, logged) around the line-up content in the wine add /
edit / delete / reorder / reveal routes. In a promoted session this change removes it for
occurrence content: the Postgres write is the decision and a failure fails the request.
Two routes also mirror the line-up today only to make the FK row exist before their own
insert (the rate POST and the bookmark POST, both strictly, not best-effort); under
record-first the row exists from the create, and those calls go.

This is the first real slice of the "durable sessions" direction already recorded as a
future goal. Worth framing that way rather than as a local fix.

**Two gaps it was to fix are already closed** (✅ by the rehydration): reveal state has a
guaranteed row, and pour order is stored (`wines.position`, written by every mirror,
`lib/session.ts:753`; `POST /wines`'s one-shot `position` lands in it through the array).
What remains is the stale comment in `lib/sessionFeedWines.ts` (§ 9).

### 8b. Merge resolution is on every read path

🔒 **Reads follow the pointer; merges never rewrite ratings** (Simon's ruling —
reversibility was chosen with intent). A merge points one entry at another and destroys
nothing, so a curator's mistake on an entry that thousands of ratings hang off is
recoverable.

The cost is that every aggregate — profile pages, wine pages, rating averages — must
resolve merges before it counts anything. Under this model merges become common, since
every user-minted entry is a duplicate candidate.

⚠️ **Forgetting the resolution step fails silently**: the same wine appears twice on a
profile, or an average quietly excludes half its ratings. This is exactly the recurring
defect class from phases 1 and 2 — a guard that looks correct against a fresh fixture.
**Mitigation: one shared resolver that every aggregate goes through, not discipline at
each call site.** Same reasoning as `lib/profileVisibility.ts` and `lib/catalogWrite.ts`;
consider a CI gate like `check-identity-writes.mjs` if call sites proliferate.

#### 🔒 Collaborator links must resolve too — a named gap, recorded before it bites

**As built, multi-producer is writable but invisible, and the two halves disagree about
merges.** The write path is complete: `createProduct` (`lib/catalogWrite.ts`) takes
`collaboratorIds` and writes `role: 'collaborator'` rows, `lib/catalogAddFlow.ts` parses
and validates them off the request body ("branch 5"), and the one-lead partial unique
plus the deferred at-least-one-lead trigger enforce *one lead, 0..n collaborators*. But
**every read is lead-only** — there are exactly **three**, and all three need a decision:

1. `lib/catalogSearch.ts` — the scoped/unscoped search join (`AND pp.role = 'lead'`).
2. `lib/catalogSearch.ts` — the survivor re-read join, same predicate.
3. `lib/catalogAddFlow.ts` — branch 2 (adding a vintage to an EXISTING product) selects
   `producers: { where: { role: 'lead' } }` and returns `producers[0].producerId` in the
   response. **Name its semantics alongside search**: does branch 2 keep returning the
   lead, or surface collaborators too? Silence here repeats the § 8b problem.

So a collaborator link today displays nowhere and makes a product findable under no
second name.

Two consequences for whoever makes collaborators readable:

- **(a) Any NEW collaborator read surface must resolve producer tombstones**, the same way
  the existing paths do. This is not hypothetical: the catalog-maintenance side reports
  producer merges as a **continuous stream**, so on the day collaborators become visible,
  some will already point at merge tombstones. A surface that skips the resolver shows a
  dead alias — the § 8b silent-failure class, one layer down.
  ⚠️ Note precisely where the gap is *not*: inside `searchProducts` the alias machinery
  is already role-agnostic (`groupIds` filters `pp.producer_id` irrespective of role, and
  the `resolveEffectiveIds` pass resolves whatever producer id the join returned). The
  blocker for widening THAT join is result **shape**, not merge resolution — `ProductMatch`
  carries one producer and the join guarantees one row per product, so admitting
  collaborators fans a product into N rows and the survivor map would keep an arbitrary
  one. Decide the shape (producer list per row, or row per link) before touching it.
- **(b) The intent is ruled; the MECHANISM is blocked on a conflict with the RFC.**

  **Ruled (catalog-maintenance side, 2026-08-18) — the INTENT.** A merge proposal covers
  ALL of the producer's links, regardless of role. The proposal asserts the two producers
  are one company, so a collaborator link must not be left behind pointing at a tombstone
  — precisely the (a) risk. This much is settled and is not in question below.

  🔒 **BLOCKED: as stated, the rule was "re-point the loser's links onto the survivor,
  collapsing PK collisions". That contradicts the RFC's merge model and must NOT be
  implemented that way.** Recorded rather than silently reconciled, because the conflict is
  the decision:

  - RFC § *Merge = pointer + lifecycle only*: a merge sets the loser's `status = linked`
    and `linksTo`, and **"Nothing else. No facts, producer links, or child rows are copied
    into the survivor — copying would contaminate it after an unmerge."**
  - The same section: **"unmerge is a single pointer update"**. Re-pointing join rows makes
    unmerge a multi-row restoration, and a *destructive* collapse makes it irreversible —
    a dropped collaborator row has nothing left to restore.
  - `lib/catalogSearch.ts:395` already DEPENDS on links staying with the loser: it scopes
    on the *effective* producer precisely because "the products stay children of the loser
    (nothing re-parents)". Re-parenting would invert that comment's premise.

  **The reconciliation that does not fight the model:** the RFC already resolves this class
  of problem at READ time, via the effective-entity chain — the same mechanism that makes
  ratings resolve without moving rows. A collaborator link on a merged producer should
  resolve through `linksTo` when read, exactly as a lead link does. That satisfies the
  maintenance side's intent (no link stranded on a tombstone) with **no write at all**, so
  reversibility is untouched. Consequence (a) is then not merely compatible with this
  ruling — it *is* the implementation of it.

  **What still needs deciding**, and belongs with the proposal-path design rather than here:
  whether a *read* that resolves two links to the same effective producer de-duplicates
  them for display, and with which role. The maintenance side's ranking — **lead beats
  collaborator** — is the right answer for that presentation choice, and their case table
  holds as a DISPLAY rule:

  | Loser `L` | Survivor `S` | Resolves to |
  |---|---|---|
  | lead | collaborator | lead |
  | collaborator | lead | lead |
  | collaborator | collaborator | collaborator |
  | lead | lead | cannot arise on ONE product — the partial unique forbids two leads |

  🔒 **The one-lead invariant is untouched either way**, and the last row is why: two leads
  on one product cannot coexist (`product_producers_one_lead_idx`, partial unique
  `ON (product_id) WHERE role = 'lead'`), so no de-duplication can remove a product's only
  lead.

  🔒 **STORED vs RESOLVED cardinality must stay EXPLICIT in the read contract** (agreed
  with the catalog-maintenance side, 2026-08-18 — a requirement on whatever surface ships,
  not a caveat). Where a product links both `L` and `S`, the stored row count and the
  resolved count differ, and under the read-time model **the stored rows never change** —
  so the two numbers coexist permanently rather than converging after a migration. Any
  field, count, or API shape exposing "the producers of this product" must make clear which
  of the two it is; a bare `producers.length` that silently means one or the other is the
  defect this rule exists to prevent. The resolved count being lower is correct — they were
  one company all along.

  ⚠️ **If a future ruling DOES choose write-time re-pointing over read-time resolution**,
  it is a substantive lifecycle change that must explicitly supersede § *Merge = pointer +
  lifecycle only*, state what unmerge restores, and update the `catalogSearch.ts:395`
  premise. Two ordering traps then apply, because **only the at-least-one-lead trigger is
  deferred — the partial unique and the composite PK are IMMEDIATE**: (1) remove or demote
  the old lead *before* promoting the new one, or the partial unique fires while both
  exist; (2) promotion of an existing collaborator is an `UPDATE … SET role`, not an
  `INSERT`, or the composite PK fires. Both are documented in the phase-1 migration
  (`20260725090000_wine_catalog_schema`, § exactly-one-lead) and in the implementation
  plan § *Exactly one lead*.

✅ **The merge fence is CLOSED (catalog-maintenance side, 2026-08-18).** Pointer-only is
accepted as the app-side constraint: **merge proposals carry identity, never link
mutations**, and each side then implements that identity according to its own persistence
requirements. Nothing is open from their side on merges. Two items remain OURS to decide,
both named above and neither blocked on them:

- **Branch 2's response shape** — does `catalogAddFlow` keep returning the lead's id, or
  surface collaborators, once a read surface exists?
- **The stored-vs-resolved distinction** in whatever read contract ships (the 🔒 above).

**Standing agreement with the catalog-maintenance side (2026-08-18):** they will not emit
collaborator links until a read surface exists, regardless of what the API permits, and a
second producer per product would arrive as a contract question before any data. So the
fence does not need to defend against them. If the API is ever changed to reject
`collaboratorIds` in the meantime, it must **reject loudly, never drop the field** — same
reasoning as the parser refusing a malformed array instead of filtering it
(`catalogAddFlow.ts`).

### 8c. The rating upsert is hand-written SQL

`app/api/session/[code]/rate/route.ts` writes ratings via a raw
`INSERT … ON CONFLICT` keyed on `(user_id, wine_id, session_id)`, with `CASE`-based
preservation of omitted aroma fields. Re-pointing ratings touches this SQL, not just
Prisma calls.

⚠️ Raw SQL is invisible to `tsc` and to the build. Per the standing rule, verify any change
by driving the **actual** query string through Prisma — never a hand-typed reconstruction.

**2026-11-18:** with the table kept and ids inherited (§ 1, § 6), the conflict key
`(user_id, wine_id, session_id)` and its partial unique stay as they are; what changes in
this route is the strict `mirrorLineup` it runs first (`rate/route.ts:157`) to make the FK
row exist, which goes (§ 8a Error handling), and the flavour gate keyed on `wine.type`
(`:123`), which reads the occurrence's colour / sparkling instead. Raw `ratings.wine_id`
SQL sits in 14 runtime files; none needs a rewrite for the key, all of them for any
catalogue field they display.

---

## 9. Owed work

Carried from phase 2, both now due, because this change OPENS the fence:

- **Interleaved concurrent-PATCH test** — gates `CATALOG_PUBLIC_ENABLED`. Two real
  overlapping requests editing one wine, forced at a real synchronisation point (the
  contract's `mutationHooks` exist for this), never a `sleep`.
- **Search capacity (was "the 1M-row load test"; moved by Simon on 2026-11-15 from "before
  the fill" to "before the public switch")**. Measured on staging (`bevtest`, Nine, the
  same plan as prod, the real catalogue; read-only from the sandbox):
  - 2026-11-15: 13 searches/s with one at a time, about 23/s with 10 at once, flat at
    about 25/s from 25 to 100 at once while waits grow (p95 1 s at 10, 7 s at 100);
    0 errors.
  - ⚠️ **Correction (Codex r1, verified): these numbers are NOT the public workload.** The
    public route requires a producer for a product search (`app/api/catalog/search/route.ts:71`,
    "Choose a producer first"); the unscoped product search, 118 of the 200 searches in
    the measured mix and the expensive one, is reachable by staff only (the phase-3
    queue). The public flow is a producer search (≈16 ms server time) then a scoped
    product search (≈2 ms), plus the vintage lookup. The ceiling below is an INTERNAL
    workload; step 1 re-measures with the public producer-first mix and the guest route,
    and the release decision rests on that.
  - 2026-11-18 (`.local/catalog-model-change/load-probe.mts`): **our client was not the
    limit** (one process at 10–11% CPU reached the same ≈27/s). Per search, server-side:
    product search 104 ms mean / ~4,500 blocks over 3 statements (max 191 ms; a short
    typo, "Piont Noir", read 17,765 blocks); producer 16 ms; exact and scoped ≈2 ms;
    mix mean 67 ms. 27/s × 67 ms ≈ 1.8 s of server time per second, so the server runs
    about two searches at a time; which resource binds is not measured.
  - 🔒 **Ruled (Simon, 2026-11-18): no bigger plan.** Before the switch: find whether the
    queries can be made cheaper (the product search's three statements, the GiST
    trigram signature length — `gist_trgm_ops` is at its default, the broad-typo
    block counts), re-measure, then decide. An index change on a catalogue table is on
    the data side's announce list. Prod is taken to behave as staging (same plan;
    Simon).
  - 🔒 **Two independent consultations first (Simon, 2026-11-18)**: a Fable agent at
    high effort and Codex, separately, each given the raw measurements and the code
    rather than our hypotheses, on optimising performance and efficiency: search, and
    the runtime costs this change adds (the revision read on every line-up poll,
    record-first writes, projecting the line-up from the record). Their answers and our
    hypotheses are then measured together (§ 12 step 1).
  - ⚠️ **Connections**: staging's database login allows **20 connections**
    (`rolconnlimit`); the app's pool is physical cores × 2 + 1 per instance when
    `DATABASE_CONNECTION_LIMIT` is unset (`lib/prisma.ts`; the probe's 19-connection
    processes hit `53300 too many connections` once three ran at once). Prod is the same
    plan, so the same limit is assumed (Simon), and `DATABASE_CONNECTION_LIMIT` is sized so every instance during a rolling
    deploy, the migrate job and the scheduled jobs fit under it. This is a standing
    risk today, not only a catalogue one. **Prod facts (2026-11-18):** the re-survey
    measured the role limit (20) and `max_connections` (256) on prod; the app is one
    replica of size `micro` (⅛ core, 256 MiB), and `DATABASE_CONNECTION_LIMIT` is NOT set
    (Simon). So the pool is sized from `/proc/cpuinfo`, which in a container normally
    lists the host's CPUs, not the ⅛-core quota (not measured on Deplo.io): one instance's
    pool can exceed the limit on its own. And ⅛ core bounds the app tier itself, which the
    probe (database only) did not measure.
  - ✅ **Step 1 (2026-11-18): measured, changed, decided.** Two independent consultations (a
    Fable agent at high effort, then Codex at xhigh, each from a copied bundle without our
    hypotheses) and our hypotheses, measured together; reports and logs in the local planning
    notes. **The public flow on staging** (read-only from the sandbox, pool 6; 150 flows of
    3 producer searches as the name is typed, 2 scoped product searches, 1 vintage lookup):
    producer 12.7–14.9 ms / 587 buffers (it reads nearly the whole producer GiST, so it grows
    with the catalogue, not the LIMIT), scoped 1.4 ms, vintage lookup (planned query, the
    existing `(product_id, year)` index) 0.2 ms warm / 5 ms cold; **about 240 calls (40 flows)
    a second at 6 in flight**, p95 52 ms, 0 errors. **The app tier binds first:** the real route
    in a container capped at ⅛ core / 256 MiB (this branch's standalone build, rehearsal
    database) saturates at 15–23 requests a second for ANY route, an empty-answer request
    included: ≈ 5–6 ms of CPU per authenticated request (auth, user, rate limit, Next; ≈ 20–26
    a second by that CPU), about double the unthrottled cost; measured on the sandbox's CPU, not Deplo.io's, and Nine's
    docs do not say whether micro can burst. **Changed:** ties re-ranked among the rows the
    KNN scan returns (exact folded match, score, two-way similarity; on staging the right
    producer first from two words 116 → 127 of 150, from a typo 98 → 112), plus an exact-name
    arm in the same statement (on the B-tree), so an exact name is offered even when more than
    60 names contain it ("Tenuta" was never offered); merge resolution only when a row or its
    producer is `linked`, the alias group in one statement (scoped search 5 → 2 statements,
    unscoped 3 → 1; one at a time 46 → 66 calls a second); idle pool connections kept 5 minutes
    with TCP keepalive (a reconnect from ⅛ core costs ≈ 100 ms and 20 ms of CPU); ONE pool per
    process (the production build had made one per chunk: 12 connections for a limit of 6). **Measured and not changed:**
    a longer GiST signature (producers no gain; products −13–16 % buffers on the staff-only
    path), a query-length cap (the slow public calls are short typos), the exact-name plan
    (staging plans GiST because a not-all-visible fraction of `producers` costs a whole heap
    page in the index-only estimate; nothing calls it at runtime; a range spelling fixes it if
    phase 5 needs it). No index change, so nothing to announce. Typing debounce and coalescing
    belong to the picker (step 4 / 7). **Decided (Simon, 2026-11-18): open on micro and watch
    Deplo.io's CPU, move to mini when it sits near the limit; `DATABASE_CONNECTION_LIMIT=6`**
    (`docs/dev/deployment.md`). **A Redis cache of search results: measured, not planned**
    (Simon): a hit costs 0.04–0.07 ms of app CPU against 0.4–0.65 ms for the Postgres search,
    but after the statement cut a search request costs the same app CPU as one that runs no
    search (≈ 6 ms on ⅛ core), so it would save database time the database has to spare, and
    every catalogue change (imports and merges included) would have to invalidate it. The
    fixed ≈ 6 ms per signed-in request is the real lever: its own proposal, later (Simon).

### 🔒 Release conditions — deploy is blocked until all hold

1. ✅ **Version gate covers the changed endpoints** (§ 7) — the proxy gates every
   `/api/*` call. Re-checked on the release build (an old build polling a moment sees the
   update screen) because it is cheap.
2. **`CODE_FLOOR_IOS` raised in code** to the build that carries both this change and
   Moment Visibility (§ 7), in the same deploy as MV step 1a and this cutover.
3. ✅ **Attributions surface live** (PR #93). Standing: a source added later ships its
   entry before its data.
3a. 🔒 **Announced to the catalogue-maintenance side BEFORE the push** (Deplo.io applies
   migrations on deploy): this change adds FKs into the catalogue (§ 5a), adds three
   columns to `wine_products` (origin country, `description`, `vinification`, § 1 contract
   v3; they also enter the pull scope as wine facts), adds the full-code-list CHECK to
   `producers.country` (§ 1), possibly a search index (§ 9), and
   makes the first real link, which closes the undo window. The agreed announce list: any change
   to the five catalogue tables or their constraints / indexes / triggers / functions, to
   `catalog_fold_v1` / `f_unaccent` / the unaccent extension, a Postgres major upgrade, an
   encoding / locale change, ownership or grants on the five tables.
3b. 🔒 **FK pin green** (§ 5a): every FK into the five tables `NO ACTION` except
   `product_producers.product_id`.
3c. **Rehearsal passed on prod's schema** (§ 6a), and the warm-cache reconciliation dry run
   (§ 8a.0) reports what it will copy.
4. 🔒 **Any `catalog_fold_*` version change has been ANNOUNCED to the catalog-maintenance side before deploy** — never after. A bump desynchronises exact-match agreement between the two sides, and search MAY not reveal it (it did not for the whitespace defects observed; a transliteration change would). The version appears nowhere in the contract today. See the implementation plan § Phase 4.
5. **Promotion protocol tested under concurrency** (§ 8a) — an add racing a promotion must
   land in Postgres, never vanish. This is the T1 race; it cannot be verified by
   inspection. The rehydration's cutover suite drives such races through
   `mutationHooks`; extend it rather than write a second harness.
6. **Interleaved concurrent-PATCH test run, and search capacity decided** (✅ capacity decided
   2026-11-18, above; the PATCH test is step 4), before
   release day: the fence opens with the code (§ 7), because a closed fence means only
   staff can add a bottle.

### Owed work — new from this phase

- ✅ ~~Revisit error handling on every `pgUpsertWine` call site~~ — the calls are gone;
  what replaces this item is removing `bestEffortMirror` from occurrence content in
  promoted sessions (§ 8a).
- Decide whether the merge resolver warrants a CI gate (§ 8b).
- ✅ ~~Make `tx` required on the three mint helpers~~ — already so (`lib/catalogWrite.ts`
  `createProducer` / `createProduct` / `createVintage` take a required `tx`; Codex r1).
- **Cache-revision reconstruction must be a tested code path**, not a claimed property
  (§ 8a) — including the stale-cache case, which is the one the first revision got wrong.
- **Purge extension needs its own test**, covering both the bookmark collision and the
  purged-bookmark-renders case (§ 5a).
- **Idempotent create needs a test that actually retries** (§ 8a) — a duplicate occurrence
  from a retry is indistinguishable from a legitimate duplicate bottle, so this cannot be
  verified by inspection.
- **Measure the cache-revision read cost** before assuming it is acceptable (§ 8a).
- **The warm-cache reconciliation at cutover** (§ 8a.0) — a dry run that lists every
  promoted session whose cached line-up differs from its record, then the strict copy.
- **Tolerant reading of pre-deploy Redis line-ups** (legacy `type`, no revision, no
  catalogue key) — tested with a captured old-shape blob, not a hand-written one.
- **The FK pin** (§ 5a) and the **review item on every user mint** (§ 7).
- **Had a sip** (`app/api/checkins/route.ts`, web only): a copy is never catalogue-linked
  today; under "every new bottle links" it copies the source's link server-side.
- Stale comment: `lib/sessionFeedWines.ts:66-75` says the line-up order "has no PG
  mirror"; `wines.position` exists. Fix while touching it.

### Owed from the colour / sparkling / style split (2026-11-09)

The catalog side shipped in `20261109120000` (`catalog-colour-sparkling.md`); `wines` was
left on the old `style` tokens on purpose, because this phase replaces it. Everything
below lands here:

- **User-side split.** Bubbles from `sparkling` instead of `style === 'spark'` across the
  axis helpers (40 call sites, measured 2026-11-18: `resolveAxes` 15,
  `resolveAxesColoured` 9, `fillFlavourZeros` 12, `gateAndFillFlavors` 4; plus one
  `=== 'spark'`, one SQL `style = 'spark'` in `lib/badgeService.ts`, three hard-coded
  `'spark'` constants and three hard-coded five-token allow-lists). ✅ **No derived
  legacy `type` on the wire and no legacy writes**: the floor blocks every shipped build
  (§ 7). Still owed for DATA: Redis line-ups cached before the deploy carry `type`
  (read tolerantly: `type` → the snapshot's colour / sparkling), and `upsertLineup`'s
  `style = w.type` goes with the record-first write. Badges: `type_spark_*`,
  `type_nonalc_5`, `type_all` (needs a `nonalc` rating), `tannic_titan` (`redCount`),
  `mineral_hunter` (`uniqueStyles >= 5`); `unique_styles_8` stays unearnable (5 styles
  against 8). Count from the occurrence's snapshot (it is always set), so a badge does
  not move when a curator fills a colour later; lifetime counters never decrement.
- ✅ **Snapshot gap closed** (§ 1): the occurrence's snapshot carries `colour` and
  `sparkling`.
- **Conversion rulings** — link first, else mint, and nothing before the first delivery:
  § 6.
- **`nonalc` → `abv = 0`** for existing user wines, filled only where no ABV is recorded
  (Simon, 2026-11-09: 0 is a valid alcohol level, and it keeps the alcohol-free fact,
  which NULL would lose). The catalog-maintenance side sends ABV as measured (a 0.5%
  de-alcoholised wine stays 0.5); the alcohol-free threshold is decided here.
- **Retiring the old pairs.** Once `wines` no longer carries `style`, delete
  `wine/red | white | rose | spark | nonalc` from `category_styles` (an announced
  vocabulary change). `wine_products_style_check` then duplicates the FK and may be
  dropped, which only loosens.
- ✅ **Minting requirements** after the split: ruled 2026-11-18 (§ 2).
- **`colour` may be NULL; never assume it.** The catalog-maintenance side expects it
  absent on part of the catalog, mostly sparkling and dessert/fortified wines. So the
  legacy `type` the Redis line-up keeps for the rollout (§ 8a, not on the wire) maps a
  non-sparkling wine with no colour to empty, never to a guessed colour, and sparkling
  maps to `spark` whatever the colour; badges that count by type or colour, and any colour filter or
  label, need an "unknown" state.

## 10. Open

✅ **Neither blocks this phase** (Simon, 2026-11-18).

- **Terms of Service** for promoting user photos to catalog entries (§ 4). Not scheduled;
  nothing in this phase promotes a photo.
- **Naming.** "Occurrence" is the working name in code and docs only. The app keeps its
  words: an *impression* in a moment, a *check-in* on its own. The table keeps its name
  for now (§ 1).

---

## 11. Review findings and resolutions

🔒 **The sections above are canonical. This ledger records only what was found and where it
was answered** — it deliberately does not restate rulings, because a second copy drifts.

**Round one** — seven findings on the first draft, all verified against the code.

| # | Finding | Answered in |
|---|---|---|
| F1 | "Postgres authoritative" had no write protocol, and contradicted itself on anonymous sessions | § 8a — ⚠️ **superseded by R1/R5**: the original answer (anonymous sessions get Postgres rows) was reversed |
| F2 | "Catalog entry" too imprecise as an FK target | § 1 |
| F3 | "Never deleted" contradicted the RFC's hard purge | § 5a |
| F4 | Standalone check-ins had no home in the model | § 1 |
| F5 | Migration could cascade-delete referenced rows | § 6 |
| F6 | Inheriting ids does not preserve endpoint semantics | § 7 — ⚠️ **superseded by R4**: translation was recommended, then reversed to hard cutover |
| F7 | Change proposals lacked concurrency and lifecycle | § 3 |

**Round two** — five findings on the revision. Three were defects *introduced* by that
revision.

| # | Finding | Answered in |
|---|---|---|
| R1 | "Cache self-heals on next read" is false; protocol covered only creation | § 8a |
| R2 | Create is not retry-safe (server-minted id); image failure undefined | § 8a |
| R3 | Purged bookmarks become unrenderable and collide; field table contradicted § 5a | § 5a, § 1 |
| R4 | Bookmark compatibility is a response contract, not a write shim | § 7 |
| R5 | An FK requires the parent row to exist, not to be retained forever | § 8a |

**Round three** — five findings. All were unresolved *decisions* or contradictions rather
than new defects.

| # | Finding | Answered in |
|---|---|---|
| T1 | Redis→Postgres transition still race-prone; persistence keyed on caller identity | § 8a — promotion protocol under advisory lock; mode keys on the `sessions` row |
| T2 | Version gate called "not a blocker" while hard cutover is ruled | § 7 — now an explicit release gate |
| T3 | Idempotency left as two options | § 8a — **ruled: client-generated ids** |
| T4 | Image S3→DB failure rule missing; standalone-photo claim factually wrong | § 8a mutation matrix; § 6 correction (verified at `checkins/route.ts:294`) |
| T5 | Ledger contradicted the final rulings | This section — restated as pointers, with supersessions marked |

**Rulings taken during review** (Simon): bookmarks dedup on `(user, product, vintage)` with
`NULLS NOT DISTINCT`, displayed as one wine (§ 5); each check-in is its own occurrence
(§ 1); hard cutover (§ 7); fully anonymous sessions stay Redis-only (§ 8a).

⚠️ **Pattern worth naming.** R1 and R3 were both cases of writing a property that was
wanted rather than one that was verified — the same defect class the phase-1 and phase-2
notes flag as recurring: *a guard that looks correct because nothing tested the case where
it fails.* Both were caught by review, not by drafting. For the implementation phase this
argues for the tests listed in § 9 being written **before** the code they cover.

**Refresh review, round one (2026-11-18)** — three blockers, seven majors, verified
against the code; two needed rulings (Simon: guests search inside the moment; blind
saves are held per bottle and stay out of Cravings until the reveal).

| # | Finding | Answered in |
|---|---|---|
| B1 | `origin NOT NULL` in the expand step breaks the previous release's writers | § 1 (nullable + insert trigger, NOT NULL in step 9), § 6a (old suites on the new schema) |
| B2 | Guests can pick only through a search they are refused | § 2 (moment-scoped search) |
| B3 | The cutover hazard depended on deploy order | § 8a (NULL revision = not reconciled) |
| M1 | Product-grain saved state is a blind-identity oracle | § 5 (blind saves per bottle) |
| M2 | The record-first matrix missed writers | § 8a (every writer bumps; census gate) |
| M3 | Old guest tabs are not bounced | § 7 (one 4xx for old-shape writes) |
| M4 | The kept `(user, wine_id)` unique can swallow a save after a re-link | § 5 (re-link moves saves; explicit conflict) |
| M5 | Web changes scheduled after the server steps that break them | § 12 (web per step) |
| M6 | Moment Visibility's `look_rev` could double the counter | § 7 (one counter per event) |
| M7 | The rehearsal's people-stripped users can't satisfy prod's NOT NULLs | § 6a |
| minors | blob vs sibling key, fence gap, `bigint` in JSON, colour / sparkling on blind rows, origin guess, stale lines, step inconsistencies | § 8a, § 7, § 0.3, § 1, § 12 |

**Refresh review, round two (2026-11-18)** — no blockers; three majors, each left open by
a round-one fix, verified against the code.

| # | Finding | Answered in |
|---|---|---|
| 1 | Reconciling cache → record only would bring deleted bottles back (`mirrorLineup` leaves failed-DELETE rows) | § 8a (two-way: record-only rows orphaned) |
| 2 | An old instance's whole-array mirror would null every link if the cached shape changed | § 8a.0 (the Redis line-up stays a superset until step 9; `entry` on the wire only) |
| 3 | A blind save never becomes a wine save (duplicates, re-link oracle, backfill, toggle source) | § 5 (`held_for_reveal`, effective-wine grouping, per-viewer `saved`) |
| minors | old-tab message never shown, gate pin, scrub scheduling, rehearsal triggers and names, writer list, guest budget, consultation independence, contradictions | § 7, § 2, § 6a, § 9, § 12; the build plan |

**Refresh review, round three (2026-11-18)** — no blockers; two majors, both left open by
round-two fixes, verified against the code.

| # | Finding | Answered in |
|---|---|---|
| 1 | A held blind save still leaked through wine-level operations (a sibling bottle's flag, removing the craving, un-saving "Wine N") | § 5 (one rule: invisible to every wine-level operation while redacted; NULL wines group by id; badges stay raw; existing saves marked) |
| 2 | The Redis superset left `style` undefined: `nonalc` and old-instance type edits would be lost | § 8a.0 (`style` written until step 9, wins on disagreement; full fixture) |
| minors | the orphaning ran before a human saw the list (failover case), rollout residual, rehearsal FK checks, consultation bundle outside the repo, the spec's writer list | § 8a, § 7, § 6a; the build plan |

**Refresh review, round four (2026-11-18)** — no blockers; two majors in round-three
wording, verified against the code (`lib/outsideView.ts` bypasses only the strict host and
the adder; the live rule bypasses cohosts too).

| # | Finding | Answered in |
|---|---|---|
| 1 | "Redacted for the owner" was two predicates; a taster made cohost got a stuck save | § 5 (classification live, visibility outside-view, per-bottle addressing unconditional) |
| 2 | The `style` rule was circular; a re-link's colour could be undone | § 8a.0 (every colour write sets `style`; one-direction re-run) |
| minors | non-held saves of a re-hidden bottle, Q5f scope, reference rows in the rehearsal, precheck scope | § 5, § 6a, § 8a; the survey |

**Refresh review, round five (2026-11-18)** — no blockers, one major (functional, not a
leak): a cohost's save of a blind bottle was classified normal, occupied the dedup unique
while hidden, and a later save of the same wine went nowhere. Answered in § 5 (held when
either rule hides it; convert on conflict); minors (`outsideViewSql` not `redactedSql`,
owner AND viewer, the helper's shape and its read cost, `nonalc` on a link, load order,
three more tests) in § 5, § 8a.0, § 6a and the build plan.

**Refresh review, round six (2026-11-18)** — no blockers, one major of round five's class
through two other writers (the re-link move and the purge merged collisions without
saying which row survives). Answered in § 5 (one collision rule for every writer) and
§ 5a; minors (un-save and grouping after a reveal, stale wording, `nonalc` on a link and
its badge, the helper scoped to the line-up, concurrency pinned, § 6a order, docs to
update) in § 5, § 8a.0, § 6a and the build plan.

**Saved-wine model replaced (Simon, 2026-11-18, after round six).** Rounds two to six
each found one more path the held-save design had to follow. Simon's model replaces it
(§ 5): one craving per wine with its first source, hidden while that source is hidden,
a neutral crave button on a bottle hidden for you. The held-save rows in the tables
above are superseded by it; round seven reviews the replacement.

**Refresh review, round seven (2026-11-18), on the replacement model** — no blockers; two
majors in its written rules (a re-pointed craving kept its old date and id; orphaning
un-hid a still-hidden craving), answered in § 5; minors (`craved` on redacted feed rows,
the crave-from-post path, the old by-wine DELETE routes, badges named, wording, four
named residuals, the ban row) in § 5, § 6, § 8a and § 12.

**Refresh review, round eight (2026-11-18)** — CONVERGED (no blocker or major). Six minors
applied: the § 8a orphaning sentence, the orphan rule for rated bottles too, the source
FK's `SET NULL` moved to the code push (step 5), the crave POST's order, LEFT JOINs for
source-less cravings, stale § 5 wording. Next: Codex.

**Codex, round one (2026-11-18)** — two blockers, nine majors, one minor, verified
against the code; one ruling (Simon: description, vinification and country of origin
become catalogue columns).

| # | Finding | Answered in |
|---|---|---|
| 1 | A `SET NULL` source FK is unsafe while the old release still serves after the migration | § 5 (the FK keeps CASCADE; the new DELETE detaches visible cravings first) |
| 2 | A retry returning the existing occurrence leaks a re-link through the plain echo | § 8a (existing-row replies through `buildWineEcho`) |
| 3 | Orphaned sources and last-rating deletions un-hide cravings | § 5 (`bookmarks.source_session_id`) |
| 4 | `description`, `vinification`, `country` have no catalogue destination | § 1 (new catalogue columns, announced; history kept) |
| 5 | No read path for an existing vintage | § 2 (vintage lookup on both search routes) |
| 6 | The build could reach an old instance | § 7 (every instance verified before the build goes out) |
| 7 | A partial unique cannot be a Prisma `@@unique` | build plan step 2 |
| 8 | The chain CHECK gates cannot pass on prod's schema | § 6a (an explicit before/after constraint diff) |
| 9 | A check-in retry could duplicate the rating and post | § 8a (whole check-in replay; one rating per standalone occurrence) |
| 10 | The export kept check-in locations | § 6a |
| 11 | The capacity numbers measured a staff-only query | § 9 (correction; re-measure the public flow) |
| 12 | Stale lines (position, reorder, `tx`) | § 1, § 8a, § 9 |

**Codex, round two (2026-11-18)** — no blockers; three majors, verified: the
existing-row reply went through `buildWineEcho`, which skips the hidden-line-up gate
(now an identity-free acknowledgement); detaching a visible craving left its moment
pointer (both pointers now cleared together); two pre-orphaning deletion sentences
contradicted the stored moment (removed). Minor: the Prisma `@@unique` line and the
pour-order paragraph. All in § 5, § 8a and the build plan.

**Codex, round three (2026-11-18)** — CONVERGED, no findings. The refresh is review-complete
(Fable rounds one to eight, Codex rounds one to three); build prompts per step are written.

---

## 12. Build order (2026-11-18)

Ten steps plus 1b (slid in 2026-11-18). The detailed plan (scope per step, tests, what is irreversible, release
conditions carried) is kept locally with the planning notes; this list is the order of
record. Every step leaves the branch green (build, lint, every `check-schema.yml` suite,
mobile `tsc`); the web adapts in the same step where its wire changes; the app follows
in step 7 and its build is cut once.

| Step | What | Ships |
|---|---|---|
| 0 | Prep: prod re-survey, prod facts (connection limit), anonymised export, rehearsal database, draft verdict list | nothing (operator + `.local/`) |
| 1 | Search capacity and runtime efficiency: two independent consultations (Fable high, Codex) first, then find whether the queries can be made cheaper, change them (and an index, announced, if that is the answer), re-measure on staging, size the connection pool | independent of the other steps; shipping it before release day is Simon's push decision |
| 1b | Data health (Simon, 2026-11-18): assess the loaded catalogue and write the feedback for ONE full replace with the fixes applied (the flush, while nothing links to it), the new columns' contract (§ 1, ruled 2026-11-19), the flush mechanics (§ 7: before release day); the step closes when both delivered files are in and checked | no code; the replacement loads on prod before release day (Simon runs it; it refuses if anything links) |
| 2 | Expand migration: `origin` (nullable + insert trigger), snapshot colour / sparkling, `sessions.lineup_revision`, bookmark product / vintage / snapshot / nullable source, review items; CHECK snapshots; the FK pin; the previous release's suites pass on it | additive, before the code |
| 3 | Occurrence persistence: record-first writes in promoted sessions (every writer, census-gated), revision-checked reads with NULL = not reconciled, client ids, insert-only create, image attach on its own, no images in Redis-only sessions, tolerant old blobs, the old-tab write refusal, the warm-up script; the web sends ids and attaches images in this step | release day |
| 4 | The catalogue on every write: pick or create (registered only), the moment-scoped search for guests, required fields, the review item, snapshot, colour / sparkling axes and badges, the line-up's catalogue key and its redaction, the merge resolver, the gate's default flipped open, the interleaved-PATCH test; the web's plain picker lands in this step, and the suites get catalogue fixtures | release day |
| 5 | Reads and cravings: one craving per wine with its first source, the blind rules of § 5 (hidden while the source is hidden, neutral button, re-point, delete / orphan / re-link rules), Cravings keyed on the bookmark id, Saved, profile lists and tiles, feed, outside view, D8, purge, account deletion; the web's Saved and crave button in this step | release day |
| 6 | Web closing pass: the NV checkbox in both modals, a headless browser pass over add / save / blind (the wire changes landed with their server steps; `WEB_WIRE_GENERATION` is bumped in step 3) | release day |
| 7 | App: design first (ADRs), then the picker, check-in create / edit, NV checkbox, saves and Cravings, client ids, image attach | the build |
| 8 | Release, shared with Moment Visibility: rehearsal, announcement, build, deploy order, floor, reconciliation, conversion, data side told (the fence opens with the code) | operator |
| 9 | Contract migration, a later release: `origin` NOT NULL, drop `style` and `category` (the content columns stay as history), the old `(user, wine_id)` unique, retire the old `category_styles` pairs (announced) | later |
