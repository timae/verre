# Wine catalog: the model change

**Status:** proposal, not started. Planned before any code, per the ruling in
`wine-catalog-implementation.md` § "RULED: the per-event fields move OFF `wines`".

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
level (two FKs point at `wines`) and large at the code level (43 files touch the
table), so the cost is dominated by code that accretes over time.

⚠️ **CORRECTED (2026-07-26): this argument previously opened with "the catalog
tables are empty", which the ruled execution order makes FALSE by the time this
phase runs.** The fill lands BEFORE the model change (§ 7), so the catalog is
populated here. Nothing else in the timing argument depended on emptiness — the `product_id`-is-NULL and code-accretion points stand on their own —
but the phrase mattered because it was also being read as a claim about the seed
being clean. It is not: see § 7's fourth disposition verdict (`link to an existing
catalog entry`), which exists precisely because the catalog is populated at
curation time. The related precondition at § 2 ("pick an existing entry" is a dead
end against an empty catalog) is the reason the order is what it is, and is
unaffected.

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
(`app/api/checkins/route.ts:302`). There is no check-ins table and never was.

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
| `grape` | Catalog entry | What the wine is |
| `category`, `style` | Catalog entry | Same |
| `region`, `country`, `description`, `vinification` | Catalog entry | Same |
| `session_id` | Occurrence | Per-event; null for standalone |
| `added_by_identity_id`, `added_by_display_name` | Occurrence | Who brought this bottle, this time |
| `revealed_at` | Occurrence | Per-tasting blind state |
| `image_url` | Occurrence + rating + catalog | Three layers, see § 4 |
| `purchase_url` | Occurrence | Per-event — covers standalone too |
| `product_id`, `vintage_id` | Occurrence | The link *is* the row's purpose |
| *(position)* | Occurrence | New — has no durable home today |

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

⚠️ **The anon restriction has a precondition.** "Pick an existing entry" is a dead end
against an empty catalog. The restriction is therefore switched on when the first catalog
fill has happened — not when this model change ships. See § 7.

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
catalog removes the need for that orphaning entirely.

**Context is derived, not stored** (Simon's ruling). Opening a saved wine shows your
ratings of it — which tells you when and where you had it, and stays correct if you drink
it again. Nothing extra to store. A saved wine you have never rated shows no context,
which is right, because there is none.

`app/api/me/bookmarks/route.ts` already resolves session context via ratings rather than
`wines.session_id`, and its header comment names this as the future direction. That part
is already built.

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
  merge the pair (keep the earlier `saved_at`), not fail.

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

---

## 6. Migration

**Production holds 130 `wines` rows. Roughly 35 are real wines.** The rest is test exhaust
from before there was a test environment — `a` ×6, `fghfg`, `Wine in S2`, `S3 reclaim test
wine`, `Impression 1–4`, `Crockford verify wine`.

**This is a hand-curated conversion, not an algorithm.** At this volume every row can be
read by a human, which is both cheaper and more accurate than any matching rule. It also
means the catalog gets a clean seed rather than junk that curators inherit.

⚠️ **"Unreferenced" is not the same as "junk".** 58 rows have no rating and no bookmark,
but some of those are real wines whose session was deleted — `Riesling Kabinett / Robert
Weil`, `Blaue Libelle / Andreas Tscheppe`, several Sardinian producers. The rule is "keep
what is a real wine, drop what is test litter", and only a human reading the list can tell
the difference.

### 🔒 Deleting a wine cascades to its ratings and bookmarks

**Verified (F5):** `ratings.wine_id` and `bookmarks.wine_id` are both
`onDelete: Cascade` (`prisma/schema.prisma:460`, `:509`). A `DELETE FROM wines` for
anything classified as litter **silently takes user data with it**.

This is not hypothetical in the real data. `MxR-tJewUQAo01VyP6Co5` is named `"test"` and
has 1 rating **and** 1 bookmark. Several rows named `"a"` carry ratings. A label that looks
synthetic is not evidence that nothing references the row.

**Rules for the migration, all three mandatory:**

1. **Per-row disposition, written down before anything runs.** Every one of the 130 rows
   gets an explicit verdict — convert / drop / needs-a-look — reviewed as a list, not
   decided inside a `WHERE` clause.
2. **A referenced row is never dropped as a side effect.** If a referenced row is genuinely
   litter, its ratings and bookmarks are deleted *explicitly and named*, as a separate
   confirmed step. Never silently, via cascade.
3. **The delete statement asserts what it did.** `GET DIAGNOSTICS ROW_COUNT` against the
   expected count, inside a transaction that rolls back on mismatch. This is the same
   lesson as the phase-1 runbook guard: **verify what the statement did, not what the
   state looks like afterwards** — state can always be satisfied by pre-existing state.

Dropping the litter is optional. Leaving it unconverted and unreferenced costs nothing;
deleting it wrongly costs user data. When in doubt, leave the row.

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
claimed they did. `app/api/checkins/route.ts:294` deliberately leaves it null and stores
the user's photo in `rating_images` (`:358`), with a comment giving the reason: a
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

**Converted entries enter the review queue like any other user-minted entry.** Duplicates
among them are resolved by merge, never by pre-collapsing — the same 🔒 rule.

**Existing wine ids are inherited by the occurrences they become.** This costs nothing at
migration time and keeps every stored address, deep link and cached mobile screen
resolving. Worth doing regardless of the app situation below.

---

## 7. Sequencing

```
attributions page ✅ → first catalog fill → model change → review queue
     (SHIPPED PR #93)      ← NEXT
```

- **Attributions page** — ✅ **SHIPPED (PR #93, 2026-07-27).** A config-driven page in web and
  native naming the catalog's data sources. Some licences legally require this, so shipping
  data without it is a breach. ⚠️ Standing rule, not a one-time tick: a source ADDED to the
  corpus later must have its entry shipped before its data does.
  Hard gate on the fill. Corpus-level, never per-record.
- **First catalog fill** — loading real wine data into the empty tables. Ends with
  `VACUUM ANALYZE` on the catalog tables as an explicit runbook step, not an afterthought.
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

**Why the fill must precede the model change:** once anonymous users can only pick existing
entries, an empty catalog means they cannot add anything at all. If the fill slips, ship
the model change with the anon restriction switched off — it is a flag, not a redesign,
and it decouples this work from the data timeline.

### The app

TestFlight has shipped; roughly five testers, using the app mainly during tastings.

`lib/clientVersion.ts` is built and live: the app sends `X-Verre-Client:
<platform>/<version>/<update>`, the server compares against `NATIVE_MIN_VERSION_IOS` /
`NATIVE_MIN_VERSION_ANDROID` and returns **426 with a store link**. It is
environment-variable driven, so the floor is raised without a deploy.

Two caveats:
- It is currently wired only to `app/api/auth/native/*`. That is a good chokepoint — a
  stale app hits auth on launch — but **confirm it fires for an already-signed-in app that
  does not re-authenticate**, before relying on it.
- The header is self-reported. Fine for helping honest clients update; not a defence.

Plan: raise the floor when this ships, inherit the wine ids anyway, and tell the testers.

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
| `apps/mobile/src/lib/api/sessions.ts:294` | Same set, for the native save toggle |
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
client reaching the changed bookmark endpoints is *known* to misbehave. The version gate is
currently wired only to `app/api/auth/native/*` (`lib/clientVersion.ts`), so a client that
never re-authenticates never sees the 426.

**Ship condition — both must hold before deploy:**

1. Verified that the gate fires for an **already-signed-in** native client, **or** the gate
   extended to every endpoint this phase changes (bookmarks POST/GET/DELETE, session wines,
   ratings).
2. `NATIVE_MIN_VERSION_IOS` / `NATIVE_MIN_VERSION_ANDROID` raised past the last
   pre-cutover build.

If neither holds, the cutover ships a silent break rather than an update prompt. That is
the failure this gate exists to prevent.

An occurrence with no catalog link cannot be bookmarked under the new model — there is no
catalog identity to store. That path returns a clear error rather than silently succeeding.

---

## 8. Where the hard part is

Not the schema. Three places.

### 8a. Persistence: one state machine, two modes

🔒 **A session is in exactly one of two persistence modes, and the transition is one-way.**

```
  REDIS-ONLY  ──[promotion, under session lock]──▶  POSTGRES-AUTHORITATIVE
  (no sessions row)                                 (sessions row exists)
```

🔒 **Mode is determined by whether the Postgres `sessions` row exists — never by the
current caller's login state.** This is the rule that makes the transition race-free, and
it is a change from today, where `wines/route.ts:142` decides persistence from
`if (session?.user)` on each request.

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

**The race this closes:** today `visit/route.ts:76` creates the Postgres session while
`wines/route.ts:142` independently decides persistence per-request from the caller's login
state. A wine add running concurrently with a promotion can miss *both* the snapshot copy
and the later Postgres write, and vanish.

Promotion runs **under a per-session advisory lock** (`pg_advisory_xact_lock`, keyed on the
session code hash), as one transaction. The established precedent for this primitive is
`lib/staffRole.ts:154` — the last-admin guard, which takes the lock **first, before any row
lock**, and whose migration comment (`20260725090000_wine_catalog_schema/migration.sql:867`)
explains the choice: the resource being protected is a *predicate over rows*, not a row.
⚠️ Follow its lock-ordering invariant (advisory first, then rows) — the staff-role path
documents a deadlock that inverted ordering produced.

1. Take the lock. Re-check whether the `sessions` row exists — if so, another request
   already promoted; release and proceed as Postgres-authoritative.
2. Create the `sessions` row.
3. **Copy every occurrence currently in Redis** into Postgres, preserving ids, order and
   `revealed_at`.
4. Initialise `wines_revision`.
5. Commit, then rewrite the cache stamped with the new revision.

🔒 **Occurrence mutations take the same lock.** That is what makes step 3 atomic with
respect to a concurrent add: the add either completes before promotion (and is copied) or
blocks until promotion commits (and then writes to Postgres directly). It cannot fall
between.

⚠️ Promotion must be **idempotent and one-way**. A second promotion attempt is a no-op, and
no path ever deletes the `sessions` row to return a session to Redis-only.

#### 🔒 Staleness is not self-detecting — the cache carries a revision

**Verified defect in the first revision.** It claimed a failed cache write "self-heals on
the next read". It does not: `getWines` (`lib/session.ts:250`) is three lines —
`redis.get`, parse, return — with no validity check. A key holding ten bottles when the
eleventh failed to cache stays stale until TTL.

- `sessions` gains a monotonic `wines_revision`, bumped in the same transaction as any
  occurrence mutation.
- The cached blob stores the revision it was built from.
- `getWines` compares them. Equal → serve cache. Missing, unparseable, or behind →
  **rebuild from Postgres, write back, serve.**

Costs one extra read per session-wines request; measure before assuming it is acceptable
(§ 9). What is *not* acceptable is the current shape, where a stale cache is
indistinguishable from a fresh one.

#### 🔒 Occurrence ids are client-generated

**RULED** (was left as two options; now decided). The client mints the occurrence id — a
nanoid, as today — and sends it.

This is required for retry-safety: ids are minted server-side today
(`lib/session.ts:442`), so a lost response followed by a retry creates a **second**
occurrence — and since two identical bottles in one lineup are legal (§ 1), the duplicate
is indistinguishable from a deliberate one.

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

`app/api/session/[code]/wines/reorder/route.ts:34` is a pure `mutateWines` call today — the
permutation is validated and committed entirely inside the Redis WATCH/MULTI transform, and
Postgres is never touched. Once Postgres owns `position`, **reorder becomes a Postgres
transaction** and the cache is rewritten from the committed result.

⚠️ **Qualified by mode.** In **Redis-only** sessions `mutateWines` remains the ordering
authority, exactly as today — there is no Postgres row to arbitrate. In **promoted**
sessions it writes the cache but is **no longer where conflicts are resolved**; that moves
to the database. Same split for reveal, hide-all and reveal-all, all Redis-only mutations
today.

**Divergence rule:** where cache and authority disagree, **Postgres wins and the cache is
rebuilt.** No merge, no last-writer-wins heuristics.

#### The bug this fixes

`app/api/session/[code]/wines/[wineId]/reveal/route.ts:44` documents that the Postgres row
may not exist when a host reveals a wine — because `pgUpsertWine` fires only when a
logged-in user acts, never on the wine merely existing. Keying on the session row rather
than the caller closes this for every promoted session.

⚠️ It remains open for fully anonymous sessions, which have no Postgres row by design. That
is the accepted cost of the two-mode model.

#### 🔒 The lifecycle matrix

What survives each destructive or identity-changing event. Rows are events; a blank means
untouched.

| Event | Occurrence | Rating | Bookmark | Snapshot strings | S3 objects |
|---|---|---|---|---|---|
| **Session expiry** (Redis-only) | Expires with TTL | Redis ratings expire with TTL | None exists | — | 🔒 **None exists, by invariant** — images are rejected in this mode |
| **Session expiry** (promoted) | Survives | Survives | — | Survives | Retained |
| **Session soft-delete** | Survives; `session_id` retained, pointing at the tombstone | Survives | — | Survives | Cover reclaimed; occurrence photos retained |
| **Catalog merge** | Link follows the pointer at read time | Unchanged | Unchanged | Unchanged | — |
| **Catalog hard purge** | `vintage_id` and/or `product_id` nulled; row survives | Survives | Survives; snapshot renders it | 🔒 **Load-bearing** — the only thing left to display | Retained |
| **Account deletion** | Session occurrences tombstone; standalone cascade | Per the existing split rule | Cascade | Retained on tombstoned rows | Reclaimed via explicit `reclaimImage` |
| **Occurrence delete** | Gone | Cascade | — | Gone | Capture → commit → reclaim after |

⚠️ **The purge row is why snapshots exist** on both occurrences (§ 5a) and bookmarks
(§ 5a). Every other row survives on its catalog link; the purge row has none.

⚠️ **S3 reclaim is never implied by a cascade** — every deletion path needs explicit
`reclaimImage()` calls, per the standing invariant in root `CLAUDE.md`.

#### Error handling

⚠️ **`pgUpsertWine` is called inside a silent `catch {}`** at every call site
(`wines/route.ts:145`, `rate/route.ts:166`, `wines/[wineId]/route.ts:156`,
`bookmark/route.ts`). Acceptable for a best-effort archive; **not** acceptable for
authoritative state — a swallowed failure becomes a bottle that is on the table but not in
the database. Every write path needs its error handling revisited as part of step 2 above.

This is the first real slice of the "durable sessions" direction already recorded as a
future goal. Worth framing that way rather than as a local fix.

**It also fixes two existing gaps for free:** reveal state gets a guaranteed row, and pour
order gets a durable home. Order currently lives only as the array order in Redis —
`lib/sessionFeedWines.ts:118` documents the resulting divergence as a known deviation, and
`POST /wines` accepts a `position` argument that is resolved transiently and never stored.

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

---

## 9. Owed work

Carried from phase 2, both now due:

- **Interleaved concurrent-PATCH test** — gates opening the catalog fence, which this
  phase now does.
- **1M-row load test** — gates the first catalog fill. Run against staging; sandbox
  absolutes do not transfer, and it is where the pool env vars get chosen.

### 🔒 Release conditions — deploy is blocked until all hold

1. **Version gate covers the changed endpoints** (§ 7) — verified firing for an
   already-signed-in native client, or extended beyond `auth/native/*`. Hard cutover makes
   this a correctness condition, not a courtesy.
2. **Min-version floor raised** past the last pre-cutover build.
3. **Attributions surface live** (§ 7) — licence obligation, gates the catalog fill.
4. 🔒 **Any `catalog_fold_*` version change has been ANNOUNCED to the catalog-maintenance side before deploy** — never after. A bump desynchronises exact-match agreement between the two sides, and search MAY not reveal it (it did not for the whitespace defects observed; a transliteration change would). The version appears nowhere in the contract today. See the implementation plan § Phase 4.
5. **Promotion protocol tested under concurrency** (§ 8a) — an add racing a promotion must
   land in Postgres, never vanish. This is the T1 race; it cannot be verified by
   inspection.

### Owed work — new from this phase

- Revisit error handling on every `pgUpsertWine` call site (§ 8a).
- Decide whether the merge resolver warrants a CI gate (§ 8b).
- Make `tx` required on the three mint helpers — raised in phase 2, deferred, and cheaper
  to do while touching this code than later.
- **Cache-revision reconstruction must be a tested code path**, not a claimed property
  (§ 8a) — including the stale-cache case, which is the one the first revision got wrong.
- **Purge extension needs its own test**, covering both the bookmark collision and the
  purged-bookmark-renders case (§ 5a).
- **Idempotent create needs a test that actually retries** (§ 8a) — a duplicate occurrence
  from a retry is indistinguishable from a legitimate duplicate bottle, so this cannot be
  verified by inspection.
- **Measure the cache-revision read cost** before assuming it is acceptable (§ 8a).

## 10. Open

- **Terms of Service** for promoting user photos to catalog entries (§ 4). Not scheduled.
- **Naming.** "Occurrence" is the working name for the entity throughout this document.
  The table name and the user-facing vocabulary are separate decisions — "occurrence" is
  precise but not a word the UI should use.

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
