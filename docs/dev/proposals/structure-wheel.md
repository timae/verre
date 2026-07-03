# Structure Wheel — proposal

**Status:** **SHIPPED end-to-end** — Expand (PR #56) → data migration (PR #59, `49aa684`) → Contract
(PR #60, `bf9adc0`, 2026-06-29; legacy `FL_*`/`detectFL` deleted) all merged to main, plus the palette
VALUES + native input (PR #62, 2026-07-02) **and §7's multi-taster range view = the native compare
screen 02d (PR #64, `82192d1`, 2026-07-02)** — see §7 for the as-built rulings. Nothing in this
proposal remains to build; the §10 leftovers are parked on OTHER features (profile redesign, badge
revamp, the separate alcohol-attribute proposal, the future aroma tree). Kept in place as the
rationale-of-record per the proposals lifecycle.
Headline corrections from review: this is
**not** "only data changes" — two hard-coded SQL aggregates (profile, badges) duplicate the descriptor
keys (§2, §6a/§6b); the missing-vs-zero render is a real Build-1 decision (§6d); a destructive
migration needs an expand→migrate→contract rollout (§8); and **alcohol is becoming a drink attribute
(`nonalc` retired as a style) in a SEPARATE proposal** (§1, §1a) — this build only makes `resolveAxes`
tolerant of the legacy `nonalc` style.

The flavour wheel becomes a **structure wheel**: the rated axes move from *flavour descriptors* (dark
fruit, oak, citrus…) to *structure intensities* (Sweetness, Acidity, Body, Finish, Aroma, Flavour,
Tannin, …). The **input mechanics** (tap/drag intensity, 0–5 ladder) are reused as-is.

> **What this is NOT: "only the data changes."** That was the first-draft framing and it is wrong,
> because the reconfiguration is wider than the `flavors` column. The column needs no schema change, and
> the **single-wheel** renderers are unchanged (missing-vs-zero is handled by compute at the call site,
> §6d, DECIDED) — but **`RadarChart` does change** for the compare overlay (per-series open-path, option
> C, §10 #1), and `PolarChart` + native `FlavourWheel` stay untouched. Beyond renderers: the descriptor
> keys are duplicated in **two hard-coded SQL aggregates** (the user flavour profile and the badge
> engine — §2, §6a/§6b) that break on migration, AND the destructive data migration forces an
> **expand→migrate→contract rollout** (§8). Read the risk framing before the model; the work lives in
> the aggregates, the migration, the rollout, and the one scoped `RadarChart` change.

"Aroma" here is an **intensity** axis — *how strong the smell is*, 0–5. The separate aroma
**descriptor** layer (*what* the smells are — the aroma tree) is deliberately **out of scope**.
The old descriptor data is its future seed (§4).

---

## 1. The model

### Axis set is per-category; type only refines within a category

There is **no universal axis set**. Each drink category owns its own complete set of axes. Wine
happens to include everything; other categories prune or swap (cheese has no sweetness, coffee
swaps in bitterness). `wines.category` is the resolution key.

> **Schema constraint (review fix).** `wines.category` is **not** free-text/unwired — `(category,
> style)` carry a live **composite FK to `category_styles`** (`prisma/schema.prisma:348-352`,
> seeded in `20260514183437_rewire_phase1_schema`). The only seeded `wine` styles are **`red`,
> `white`, `rose`, `spark`, `nonalc`** — there is **no `orange` style** (see the orange note below),
> and any new category (`coffee`, `cheese`) must first seed `category_styles` rows or the FK rejects
> the insert. `resolveAxes` keys on the `{red, white, rose, spark}` styles for its axis sets;
> **`nonalc` still exists as a style today** and `resolveAxes` must tolerate it defensively (§1a) until
> it's retired by the separate alcohol-attribute proposal (§1 nonalc box).

**Wine — one set for every type (red / white / rosé / sparkling):**

```
Sweetness · Acidity · Body · Finish · Aroma · Flavour · Tannin
```

**`spark` appends:**

```
… · Bubbles
```

`red`/`white`/`rose` get the 7-axis base set; `spark` adds Bubbles. Nothing else is pruned by type.
The reason is perceptual, not chemical: **skin-contact ("orange") whites** carry real tannin; a
low-tannin white just sits at Tannin = None, which is valid data. We do not prune an axis because it's
*usually* absent — absence is a rating, not a reason to hide the axis.

> **Orange wine (review fix).** "Orange" is **not** a distinct `style` in the schema and the FK
> won't accept one without a new `category_styles` row. The good news: under the no-pruning rule it
> doesn't *need* to be — an orange wine is `style = white` (or its own seeded style if added later)
> whose taster simply rates Tannin non-zero. So orange wine is the *justification* for offering
> Tannin on every type, but it is **not** a new `resolveAxes` branch. If a dedicated `orange` style
> is wanted for filtering/labels, that's a separate additive `category_styles` seed, out of scope
> here.

> **`nonalc` — DIRECTION CHANGE (Simon, 2026-06-28): alcohol becomes a drink ATTRIBUTE, not a style;
> `nonalc` stops being a `style` value.** Supersedes the earlier "one `nonalc` style + Bubbles" ruling
> (now obsolete). The future model: a wine carries an **alcohol field** (ABV `%`, plus low-alc / no-alc
> ticks). A no-alc still wine is `style = white` + no-alc ticked; a low-alc sparkling is `style =
> spark` + low-alc ticked. Alcohol is orthogonal to type — exactly as it should be, and consistent
> with §1's "ABV is metadata, not an axis." **Consequence for the structure wheel:** `resolveAxes`
> keys on `style ∈ {red, white, rose, spark}` with Bubbles on `spark` only — `nonalc` simply isn't a
> style any more, so the wheel has no `nonalc` branch to answer for. Clean.
>
> **But the alcohol-attribute change is its own work, OUT OF SCOPE here.** It is **not** "just an axis
> question" — verified, `nonalc`-as-a-style is woven through ~10 files (the wine-add allow-list in 3
> places `lib/session.ts:416` + `app/api/checkins/*`, `lib/wineTypeColors.ts`, the AI label-extraction
> prompt in `AddWineModal.tsx`, HoF icons, and **two badges** `type_nonalc_5` "Beyond the Vine" +
> `type_all`), and there is **no ABV/alcohol field in the schema today** — it's net-new. Removing
> `nonalc` as a style is also a **second destructive migration** with a real data-loss caveat: existing
> `style = 'nonalc'` rows can't recover their original type (still vs sparkling), so they'd default to
> one. **All of that — the alcohol field, the no-alc/low-alc ticks, the `nonalc`-style retirement
> migration, the badge rewrites — is a separate proposal.** This doc only assumes the *end state*
> (`nonalc` not a style) for `resolveAxes`; until that lands, see the transition note in §1a.

**Axis order:** the list above for now. Tannin is already part of the base wine set (last in the
list); only **Bubbles** is appended (for `spark`). Reorder later if a better grouping
emerges — order is
purely presentational (wedge position) but locks once data ships,
so it's a deliberate "later" not a "never".

**Future categories** (illustrative, not in this build): coffee/beer/tea → drop Sweetness/Tannin,
add Bitterness; spirits → add Warmth. Each is one new entry in the registry (§3).

### 1a. `nonalc` transition — the wheel must tolerate the OLD style until alcohol-attribute lands

The `nonalc` ruling above describes the **end state** (alcohol is an attribute; `nonalc` isn't a
style). But that retirement is a **separate, later proposal** (§1 nonalc box), so while the structure
wheel is being built and for some time after, **`style = 'nonalc'` rows still exist in prod** and the
wine-add allow-list still accepts `nonalc`. `resolveAxes` must therefore **not break on a `nonalc`
wine in the interim**:

- **`resolveAxes` handles `nonalc` defensively** — map it to the base wine set (the same 7 axes; no
  Bubbles, matching its current still-wine treatment). This is a one-line fallback, not a real branch,
  and it disappears when the style is retired. **Do not assume `nonalc` is already gone** — that's the
  end state, not the state during this build.
- The structure-wheel build neither adds nor removes the `nonalc` style. It just makes the axis
  resolver tolerant of it. The actual retirement (allow-list edits, the `nonalc`-style data migration,
  the alcohol field + ticks, the badge rewrites) is the separate proposal's job.

### Scale ladder — unchanged

`0 None · 1 Faint · 2 Light · 3 Medium · 4 Strong · 5 Intense`. The ladder already exists as
`none/faint/light/medium/bold/intense` — the change is the word `bold → Strong`.

> **Reword is NOT one file (review fix).** "bold" is duplicated across **five** surfaces, and the
> reword conflicts with frozen design copy:
> - `components/rate/IntensityHelp.tsx:4` — the canonical `INTENSITY` array. ⚠️ `bold` is also a
>   **key** in the `DESCRIPTIONS` record (lines 6-13); rename both in lockstep or the popover breaks.
> - `components/rate/FlavorChips.tsx:168` — imports `INTENSITY`, follows automatically. ✓
> - `components/wine/RatingPane.tsx:330` — a **second hard-coded copy** (`INTENSITY_LABELS`, used in
>   an `aria-label`). Not imported; the reword misses it unless explicitly changed.
> - `apps/mobile/src/lib/scoreWords.ts:21` — the **native** copy, title-cased (`'Bold'`), consumed
>   by `intensityWord()`.
> - **Design freeze conflict**: the Vero handoff (`.local/design/…`) locks the word as `4 Bold`, and
>   `apps/mobile/CLAUDE.md` says handoff UI copy is **final**. **DECIDED (Simon, 2026-06-28): change to
>   "Strong" — Simon signs off the design-copy override** (§10 #13). Edit all 5 surfaces.

### ABV / Alcohol is metadata, not an axis

Alcohol is never a rated wheel axis. Per the §1 `nonalc` direction change, alcohol's future home is a
**drink attribute** — an ABV `%` field plus low-alc / no-alc ticks on the wine — which also retires
`nonalc` as a `style`. That attribute work is a **separate proposal** (not this build); the structure
wheel only needs alcohol to stay out of the axis set (it always was) and to tolerate the legacy
`nonalc` style in the interim (§1a).

---

## 2. The column is a no-op; the *consumers* are not

`ratings.flavors` is a free-form `JSONB` map of `{ key: integer 0–5 }`, shared by session and
standalone ratings. Structure axes are simply **different keys** in that same map; the 0–5 integer
scale is *already* the structure ladder; the chart **renderers** map over whatever axis array they're
handed. So **the column needs no schema migration** — the `flavors` type, the `Decimal` score
pipeline, and the write routes are structurally untouched.

> **⚠️ "Almost a no-op" was wrong (review fix — this is the headline).** The descriptor key list is
> **duplicated in two hard-coded SQL aggregates outside `lib/flavours.ts`**, and both silently break
> the instant the §4 migration runs:
>
> 1. **User flavour profile** — `lib/profileFlavor.ts:13-16` hard-codes `FL_KEYS = [floral, citrus,
>    stone, tropical, herbal, oak, body, tannin, acid, sweet]` and interpolates them into a
>    score-weighted-mean SQL aggregate (`getProfileFlavor`, used by `/api/users/[id]` and the `/u/[id]`
>    SSR via `profileLoad.ts`). **6 of those 10 keys are in the DUMP set** — after migration they
>    return `null`/0 forever, and the three new structure axes never appear. The file's own comment
>    warns *"A schema migration would need to touch this list too."* The profile wheel becomes mostly
>    dead axes the day migration runs. **See §6a — it also raises a real product question (mixed pre/
>    post-migration history) the rest of this doc must not hide.**
> 2. **Badges** — `lib/badgeService.ts` runs a live aggregate reading `oak`, `floral`, `earth`, and
>    `avg_fruit` (= `citrus+stone+tropical+red_fruit+dark_fruit`). **All four are dropped.** Four
>    badges (`oak_addict`, `floral_fanatic`, `earth_mover`, `fruit_bomb`) become **unearnable until the
>    badge revamp** (§6b/§10 #11 — temporarily, not forever); `tannic_titan`/`acid_freak` survive (those
>    keys are kept) — so the facet category *half*-breaks, which is worse than a clean break.
>    Already-awarded `user_badges` rows persist (not revoked), but progression silently violates the
>    root-CLAUDE "protects badge progression"
>    invariant. **See §6b.**
>
> The **aggregate rewrites themselves are mandatory work** (in §3's change table, not optional). Their
> downstream questions are now mostly settled: switch *timing* is DECIDED (§10 #10, switch early) and
> orphaned-badge fate is DECIDED (§10 #11, defer). The one remaining **deferrable** downstream question
> (does NOT block PR 1) is the mixed-history product call (§6a → §10 #4, 🟢). The "no-op" thesis holds
> only for the
> *column*, never for the *read-side aggregates*.

---

## 3. Code changes (Build 1)

| What | Where | Change |
|---|---|---|
| Axis registry | `@verre/core` (new module) + re-export in `lib/flavours.ts` | `resolveAxes(category, type)` + `perRatingAxes(flavors, axes)`. In core so native input shares it; pure data (axis def is **`{ k, l, sub? }` — NO colour**, see the colour-home note below) + pure fns, respects core's platform-purity rule. `lib/flavours.ts` re-exports *from* core (correct dependency arrow — core must not import `lib/`) and joins the **web** palette on top. |
| Delete legacy — **⚠️ CONTRACT PR (PR 2), NOT Expand** | `lib/flavours.ts` | Remove `FL_RED/WHITE/SPARK/ROSE/FL`, `getFL`, `detectFL`, and the new `detectLegacyDescriptorFL` adapter. **Only after** the migration has run everywhere AND writes are registry-keyed (§6g) so no descriptor keys remain or can reappear. **Do NOT delete in PR 1** — the legacy sets are load-bearing for the Expand dual-read fallback (§8). |
| **Flavour profile aggregate** | `lib/profileFlavor.ts` | **(was missing — review fix)** Rewrite `FL_KEYS` → the structure axes. Without this the profile wheel flatlines 6 axes. **Plus the §6a product decision** on mixed pre/post-migration history. |
| **Badge aggregate** | `lib/badgeService.ts` + `lib/badges.ts` | **(was missing — review fix)** Rewrite the `getUserStats` flavour aggregate (drops `oak/floral/earth/avg_fruit`) so it doesn't crash, AND remove/guard the now-dead `badges.ts` eval predicates that read `stats.avgFlavorOak/Floral/Earth/Fruit` (§6b surface 3). **NO catalog reseed / re-key** — the 4 orphaned badges are DEFERRED (§10 #11); they just go temporarily unearnable. |
| Zero rule | `validateFlavors` (`lib/checkinValidation.ts`) | "drop zeros only when *every* value is zero." NOT a 3-line tweak — the current strip is a single-pass `if (v===0) continue` loop (`checkinValidation.ts:38`); this needs a two-pass restructure (scan for any non-zero, then keep-all-or-drop-all). Applies to **all 3 callers** (session rate + checkins POST + checkins PATCH), not just the rate path. See §5. |
| Ladder word | 5 surfaces (see §1 box) | `bold → Strong` across IntensityHelp + RatingPane copy + native `scoreWords.ts`; **design-copy sign-off needed** (handoff freezes "Bold"). |
| Render + input call sites | `RatingPane`, `CheckinModal`, `CheckinCard`, `SessionFeedCard`, `SavedWineModal`, `ProfilePanelRatings` (uses bare `FL`), `compare/page.tsx` (the **single-taster** path via `detectFL`) | **Two distinct axis-array rules (§6d):** an **input** surface hands the renderer the full `resolveAxes(category, style)` set (all axes to rate); a **read/render** surface hands it the axes *present in that rating's `flavors`* (absent → no spoke, present-0 → centre point). ⚠️ **Replace `detectFL`/`getFL`/`FL` with `detectLegacyDescriptorFL(row) ?? perRatingAxes(row, resolveAxes(...))` — NOT a bare `detectFL` ternary** (`detectFL` always returns an array → reintroduces the misclassification bug, §8). |
| Edit-path legacy transform (§6g) | `RatingPane`/`WineModal`, `CheckinModal`, native impression edit | **(write-keying consequence)** Before POST/PATCH, an edit surface must seed/save **structure keys only**, or transform a loaded legacy `flavors` to the kept structure subset (`body`/`acid`/`tannin`/`sweet`) — else registry-keyed writes 400 a no-touch re-save of a legacy row. |
| **Compare overlay** | `app/session/[code]/compare/page.tsx` (`overlayFL = FL`) + `RadarChart` | Two changes: (1) `overlayFL` derives from the data/registry, **not** hard-coded `FL` — single-taster path uses `detectLegacyDescriptorFL(row) ?? perRatingAxes(...)`; (2) **`RadarChart` gets a per-series open-path render** so each taster's polygon spans only its rated axes (DECIDED option C, §10 #1) — frame = union in registry order. (`RadarChart`'s `COLORS` are *per-taster series* colours, unaffected by the per-axis palette.) |
| Web renderers | `PolarChart` / `RadarChart` SVG | **`PolarChart`: no change** (DECIDED, §6d — axis-count-agnostic, plots `val=0` at hub; missing-vs-zero handled at the call site: absent → no spoke, present-0 → centre point, present-N → filled). **`RadarChart`: ONE scoped change** — the overlay polygon-builder gets per-series open-path rendering (§10 #1). Native `FlavourWheel` type untouched. |
| Palette | new | Per-axis structure colours — **design dependency** (Simon decides; ping when reached). Blocks web colours + native input. Does **not** cover the compare overlay's per-taster colours. **Colour HOME is decided (§3a): colour is per-platform presentation, NOT in the core registry** — web owns a `WEB_PALETTE` (`k → hex`) + a `withColours` join in `lib/flavours.ts`; native resolves axis colour from the user's active THEME at render time. The deferred decision is only the colour *values*, not where they live. |
| Native input | `apps/mobile` | **Build fresh** against `resolveAxes`. Native flavour input never existed (deferred "pending the palette brief" — verified: `impression/[wineId].tsx` carries `flavors` through saves untouched). Native flavour *rendering* DOES exist (`FlavourWheel`, dev-gallery) — inherits the same absent-vs-zero render note; the dev-gallery's hard-coded descriptor `SAMPLE` is a stale reference to update. |
| README | `README.md` API table + "flavour radar" prose | `flavors` body shape is unchanged but its **key meaning** changes (descriptors → structure); root routing rule requires the README update on ship. |

**No namespacing.** An earlier draft considered prefixing new keys (`st_*`) to avoid collisions with
old descriptor keys. Rejected: because the surviving structure keys (`sweet`/`acid`/`body`/`tannin`)
*are* the old keys, the migration is "keep these four, drop the rest" with no rename, and after it no
descriptor keys survive to collide with. **Caveat (review):** `validateFlavors` has **no key
allow-list** — it accepts any ≤32-char key. So a stale/old client POSTing a descriptor key at a
non-zero value would *resurrect* it into storage post-migration. **This is NOT an accepted residual —
it's addressed by the write-side key allow-listing in the rollout (§6g), which is part of this build**
(registry-keyed writes in the Expand PR, so the Contract PR's "no descriptor keys remain" precondition
stays true).

### 3a. Colour is per-platform presentation — NOT in the core registry (DECIDED, §10 #14)

The core axis definition is **`{ k, l, sub? }` — no colour field.** Colour is presentation, and
presentation is per-platform:

- **Core (`@verre/core`)** owns only the platform-neutral truth: *which axes exist* (`resolveAxes`),
  *their labels* (`l`), and *the input subtitle* (`sub`). It has no `c`/colour. This respects core's
  own platform-purity rule (the `index.ts` header: framework-neutral, no DOM) — a colour palette is a
  presentation concern, not domain logic.
- **Web (`lib/flavours.ts`)** owns the web palette: a `WEB_PALETTE` (`k → hex`) plus a `withColours(axes)`
  join that produces the renderer-facing `FlItem` (`{ k, l, c }`) the SVG charts consume. `FlItem` stays
  defined web-side (colour-bearing); `resolveAxes`/`perRatingAxes` are re-exported *from* core and the web
  call sites pass their output through `withColours`. (`perRatingAxes` is generic over the axis shape, so
  it composes either before or after the colour join.)
- **Native (`apps/mobile`)** resolves axis colour **from the user's active THEME at render time** — an
  axis has no single fixed colour, it's a function of `(axis.k, theme)`. Native reads `k`/`l`/`sub` from
  core and maps `k → colour` through its own theme system; it never reads a `c` from the registry.

**Consequence for the deferred palette decision (§3 palette row, §10 #5):** what's deferred is the colour
*values* (the web hex set + the native theme mappings), **not where colour lives.** The registry/axis
logic is unblocked by this — it carries no colour at all.

> **Why this matters for the "shared core" framing.** The axis *vocabulary* (keys + which axes a style
> has) is genuinely shared web↔native — it must be, it's the same `ratings.flavors` JSON. But the *visual
> treatment* (colour, layout, gestures, chart geometry) stays free to differ per platform — and colour
> specifically is theme-dependent on native. So "the registry is shared" is true for the data contract,
> false for the look. Keeping colour out of core is what makes both statements simultaneously honest.

---

## 4. Migration of existing data (old descriptors → structure)

The old vocabulary is **20 distinct descriptor keys** across the five legacy sets. Their fate:

```
KEEP (already structure axes, same key string, value carried over verbatim):
    body → body      acid → acid      tannin → tannin      sweet → sweet

DUMP + DROP (16 — no structure home; these are the aroma-tree seed, §4.2):
    dark_fruit  red_fruit  dried_fruit  tree_fruit  tropical  stone  citrus
    floral  floral_herb  herbal  mineral  oak  earth  spice  creamy  nutty

OMIT on migrated rows (never existed pre-redesign):
    finish · aroma · flavour
```

`finish`/`aroma`/`flavour` are **omitted, not zero-filled**, on migrated rows. Fabricating
`finish:0` would assert the taster perceived no finish when they were never asked — that contradicts
the core semantic that **None is a real perceived judgment**. A migrated row is therefore an honest
*partial* structure rating: the axes it has data for are filled, and the absent ones (`finish`/`aroma`/
`flavour`) are **not drawn at all** — no spoke, wedge, or label — per the key-presence render rule
(§6d).

### 4.1 The "all-descriptor row" outcome — corrected: they SURVIVE as empty orphans, they are NOT reaped

A rating that used *only* flavour-descriptor keys and never touched `body`/`acid`/`tannin`/`sweet`
collapses to `{}` after the strip.

> **Correction (review fix — the first draft had this backwards).** The engagement-deletion cascade
> is **application code** (`lib/engagementCascade.ts`) with exactly **two trigger sites** — the rate
> POST and the rating-reset DELETE. It is **never invoked by a raw SQL `UPDATE`**, and there is no DB
> trigger on `ratings` that fires it. So the bulk migration does **not** reap these rows. They
> **persist as `{}`-flavors rows** — potentially still carrying a `score` and/or `notes` (the cascade
> only ever deletes a row that is empty on *all three* axes: `score=0/NULL AND flavors='{}' AND notes
> empty`, `engagementCascade.ts:106-108`). A pure-descriptor row that *also* had a score or note is
> a perfectly valid rating and **should** survive; one that had a score of 0 and no note becomes an
> empty orphan that simply sits there until/unless that user later re-rates that wine through the
> POST path (which would then trip the cascade).

So the real questions are different from "do we accept a deletion":

1. **Rows with a score or note** → keep (correct — they're real ratings, just losing their aroma
   chips, which the §4.2 archive preserves).
2. **Rows that become fully empty** (`score` 0/NULL, no note, flavours now `{}`) → the migration
   leaves them as orphans. **Decide:** add an explicit `DELETE` step to the migration to reap them
   (replicating the cascade's predicate in SQL), or leave them. ⚠️ **"Leave them" is NOT cost-free at
   the UI layer:** such a row was *engaged before migration* (it had descriptor chips), so its session
   `feed_item` **was created and still exists** — and a lingering feed_item **renders an orphaned
   session card** in the feed and on the profile (it's only invisible *on the wheel*, not everywhere).
   That visible orphan card is the real argument for the eager reap; weigh it against the reap's
   complexity (§4.1 cascade-replication runbook).

**Count both populations first and show Simon** (the second is the one that matters):

```sql
-- (a) rows the migration empties of flavour data (descriptor-only)
SELECT count(*) FROM ratings
WHERE flavors <> '{}'::jsonb
  AND NOT (flavors ?| array['body','acid','tannin','sweet']);

-- (b) of those, the ones that become FULLY empty (the orphan candidates)
SELECT count(*) FROM ratings
WHERE flavors <> '{}'::jsonb
  AND NOT (flavors ?| array['body','acid','tannin','sweet'])
  AND (score = 0 OR score IS NULL)
  AND (notes IS NULL OR notes = '');
```

**Open decision (§10): "no delete" (recommended default) vs eager reap — and the reap is NOT a
one-liner.** A naïve `DELETE FROM ratings WHERE …` does **not** replicate what `engagementCascade`
does, because of three schema facts (all verified):

- **Session `feed_items` do NOT cascade from a rating delete.** `feed_items.ratingId` is **NULL for
  session posts** (they're keyed by `@@unique([userId, sessionId])`; only *standalone* posts set
  `ratingId`). So the `rating → feed_item` cascade FK never fires for session rows — the cascade has a
  **separate** `DELETE FROM feed_items … WHERE NOT EXISTS (other ratings)` statement
  (`engagementCascade.ts:117-129`). Raw SQL that forgets this **leaves orphaned session cards** in the
  feed/profile.
- **`rating_images` deletes in-DB but its S3 bytes leak.** `rating_images.ratingId` is
  `onDelete: Cascade`, so the rows vanish — but the **S3 objects** are reclaimed only by the cascade's
  explicit capture-then-`reclaimImage()`-after-commit loop (`engagementCascade.ts:70-74, 132-135`). A
  raw SQL delete strands the bytes.
- **The §4.2 backup dumps only `ratings`** — insufficient if the migration also deletes
  `feed_items` / `rating_images`. Those tables must be dumped too if an eager reap is chosen.

**Recommendation: NOT clear-cut — depends on the §8a orphan count.** These are *empty* rows, but per
the warning above a fully-empty orphan **keeps its session `feed_item`, which renders an orphaned card
in the feed/profile** — so "leave them" is not visually free. The honest trade-off:
- **Leave them**: simplest; the orphan card lingers until the user re-rates that wine (a still-empty
  save then trips the cascade and reaps it correctly incl. feed_item + S3; a scored/noted save revives
  it as a valid row). But it is **not guaranteed** to clean up — it persists indefinitely if the user
  never returns.
- **Eager reap**: removes the orphan cards immediately, but needs the full cascade-replication runbook
  (§4.1 — `rating_images` + S3 + the `(user_id, session_id)` feed_item delete) and an extended backup.

If the §8a count of fully-empty orphans is **low**, leave them (the few stray cards aren't worth the
runbook). If it's **material**, do the eager reap. Decide on the number, not in the abstract.

The eager-reap runbook (if chosen) — note `rating_images` **cascades from `ratings`** (FK
`onDelete: Cascade`), so the DB rows go automatically; the load-bearing step is **capturing the image
URLs *before* the delete** so S3 can be reclaimed after. Manually `DELETE rating_images` first is
optional and only complicates rollback — don't. Order:
1. **Capture** `rating_images.image_url` for the orphan set into memory (that's the only image source —
   `ratings` has no image column, just the `rating_images` child rows).
2. **`DELETE` the orphan `ratings`** (matching the cascade predicate) — `rating_images` cascade away.
3. **Clean session `feed_items`** by `(user_id, session_id)` with the `NOT EXISTS (other ratings)` guard
   (these do NOT cascade — `ratingId` is NULL for session posts, §4.1).
4. **Reclaim S3** out-of-band over the captured URLs (after commit, so a rollback never strands bytes).

Plus extend the §4.2 dump to `feed_items` + `rating_images`. That's a real runbook, not a `WHERE`
clause; spec it separately if chosen.

### 4.2 Backup — sufficient for BOTH goals only with the wine join

Two goals for the backup:

- **(a) carry `sweet → sweet` etc. forward** — trivially satisfied; the migration keeps those keys
  in place, value unchanged. No backup is even strictly required for this part.
- **(b) preserve "what flavours were rated" to seed the aroma tree later** — **a plain `pg_dump` of
  `ratings` alone is NOT sufficient.** The aroma tree needs to know *what each aroma word was about*
  ("dark fruit on this Nebbiolo"), i.e. the **wine identity**, not just `rating #4821`. So the
  archive must **join in the wine row**.

Note: wine *type* is stored in `wines.style` (one of `red`/`white`/`rose`/`spark`/`nonalc`), not a
`type` column (`lib/session.ts:558/573` maps `wine.type → style`; the wine-add allow-list is at
`lib/session.ts:416`). The archive grabs `style` plus grape/region/country for a rich seed.

**Runbook — runs inside the archive+migrate window (after the Expand PR is deployed, §8). Order
within that window: (0) run + review the §8a dry-run report, (1) this backup, (2) the §4.3 migration.
So this backup is the first *destructive-prep* step but is itself gated behind the §8a dry-run review —
do not run it before §8a. Monitored window throughout:**

```bash
# 1. Full safety dump of the ratings table (re-insertable, column-order-robust).
pg_dump "$DATABASE_URL" --table=ratings --data-only --column-inserts \
  --file=ratings_predump_$(date +%Y%m%d).sql

# 2. Aroma-tree seed archive — descriptor words + intensities JOINED to the wine they describe.
psql "$DATABASE_URL" -c "\copy (
  SELECT r.id AS rating_id, r.wine_id,
         w.name, w.producer, w.vintage, w.grape,
         w.category, w.style, w.region, w.country,
         r.flavors, r.rated_at
  FROM ratings r
  JOIN wines w ON w.id = r.wine_id
  WHERE r.flavors <> '{}'::jsonb
) TO 'aroma_seed_archive_$(date +%Y%m%d).csv' WITH CSV HEADER"
```

`(1)` is the rollback safety net; `(2)` is the convenient, mineable input for the future aroma tree.

### 4.3 The migration itself (in-place, destructive → hand-written)

Per `prisma/CLAUDE.md`, a destructive data migration is hand-written in `prisma/migrations/`, gated on
the dump above. **As-built (`20260629120000_structure_wheel_strip_descriptors`) it is a DENYLIST
subtraction** — it removes EXACTLY the 16 descriptor keys and leaves every other key untouched:

```sql
UPDATE ratings
SET flavors = flavors - array[
      'dark_fruit','red_fruit','dried_fruit','tree_fruit','tropical','stone','citrus',
      'floral','floral_herb','herbal','mineral','oak','earth','spice','creamy','nutty'
    ]
WHERE jsonb_typeof(flavors) = 'object'
  AND flavors <> '{}'::jsonb
  AND (flavors ?| array[
        'dark_fruit','red_fruit','dried_fruit','tree_fruit','tropical','stone','citrus',
        'floral','floral_herb','herbal','mineral','oak','earth','spice','creamy','nutty'
      ]);
```

> **Why denylist, not the earlier allowlist `keep body/acid/tannin/sweet` rebuild (review fix).** An
> allowlist `jsonb_object_agg … WHERE key IN ('body','acid','tannin','sweet')` rebuild would silently
> DROP the new structure keys (`finish`/`aroma`/`flavour`/`bubbles`) from any row that ALSO carried a
> descriptor key (a "mixed-vocabulary" row). The dry-run shows zero such rows in prod today, but the
> denylist is self-protecting and unconditionally safe to re-run. The `?|` WHERE scopes the touched
> rows (idempotency); `jsonb_typeof = 'object'` makes a malformed non-object row a clean no-op instead
> of aborting the deploy.

> **⚠️ AUTO-DEPLOY GATE (review fix — the load-bearing operational rule).** This ships as a normal
> tracked Prisma migration, and **Deplo.io's `deployJob` runs `prisma migrate deploy` AUTOMATICALLY
> before each release goes live** (`.deploio.yaml`). So **merging the PR == applying the UPDATE** — there
> is NO separate "Simon triggers it later" step once it's merged. The "monitored window, not auto-run"
> requirement is therefore re-expressed as a **merge gate**: the §4.2 backups (the `pg_dump` AND the
> aroma-seed archive — the only capture of the 16 descriptor keys before they're stripped forever) MUST
> be completed and verified BEFORE the PR is merged. The deploy IS the migrate step; the monitored
> window is "between archive-complete and merge." Do not merge until the archive exists. (Earlier drafts
> said "triggered by Simon, not auto-run" — that's true of the *decision to merge*, NOT of a separate
> post-merge trigger; the apply is automatic on deploy.)

**The migration must also reckon with the rollout order (see §8) — a bulk `UPDATE` that runs while
old code is still live, or vice-versa, produces mixed/mis-rendered data. The sequencing is not
optional.**

Redis carries live session ratings too. The key is **`s:<code>:r:<identityId>:<wineId>`** where
`identityId` is `u:<userId>` or `a:<uuid>` (`lib/redis.ts:29` — **not** an opaque `{ID}`; it contains
colons, so a SCAN glob like `s:*:r:*` over-matches and any parallel pass must parse, not pattern-split,
the identity segment). Live sessions at migration time hold descriptor data in Redis the SQL won't
touch. Options: run during a quiet window (48h TTL ages them out), or add a parallel Redis pass
(**which must rewrite with `KEEPTTL`** so it doesn't reset the rating's inherited session lifespan).
**Open — decide at build time based on whether any long-lived pro sessions are active.**

---

## 5. The zero rule (drop-all-or-keep-all)

Spec: *an absent add-on sits at None (valid data)* — but `validateFlavors` currently strips every
zero, and the empty-rating cascade keys on `flavors = '{}'`. Reconciliation (Simon's rule):

- **All axes None → not rated.** Saves nothing; row stays/returns to `{}`; cascade unaffected.
- **≥1 axis rated → the rest persist as explicit 0** ("perceived none", real data).

Implementation: change the strip from "drop all zeros" to "drop zeros **only when every value is
zero**". So `{acid:4, body:0, sweet:0}` keeps its zeros (one non-zero ⇒ all survive); `{acid:0,
body:0}` collapses to `{}`. This preserves the `'{}'` empty-signal exactly, and the existing
`hasEngagement` predicate in the rate route (`app/api/session/[code]/rate/route.ts`, ~line 166:
`Object.keys(validFlavors).length > 0`) then behaves correctly. **Not a 3-line tweak** — the current
strip is a single-pass `if (v===0) continue` (`checkinValidation.ts:38`); this needs a two-pass
restructure, and it changes the stored shape for **all three callers** (session rate + checkins POST +
checkins PATCH), so standalone check-in storage changes too, not just session ratings.

The input surface sends the **full resolved axis set** (including zeros) once the user has rated any
axis, so the keep-all branch has the complete set to store.

> **Mobile contract reversal (review fix).** `apps/mobile/src/lib/api/sessions.ts:180` documents
> `RateBody.flavors` as *"whole steps 1..5, **zero levels omitted**"*, and the native dirty/empty
> checks (`impression/[wineId].tsx`) compare against that omitted-zero shape. The keep-zero rule
> **reverses** this after first interaction. The native `RateBody` JSDoc, the dirty-check
> (`JSON.stringify(flavors) !== …`), and the empty-check (`Object.keys(flavors).length === 0`) must
> all be updated, or native will mis-detect "dirty" / "empty" once it sends explicit zeros.

---

## 6. Derived consumers — the real blast radius (review-driven)

The first draft was strong on *storage* and *input* and weak on *downstream product behaviour*. This
section is the missing inventory: every place that *derives* something from `flavors` and therefore
needs a defined new meaning, not just a key swap.

### 6a. User flavour profile (`lib/profileFlavor.ts`) — and the mixed-history problem

`getProfileFlavor` computes a **score-weighted mean per key over a user's *entire* rating history**,
hard-coded against `FL_KEYS`. Two changes required:

- **Rewrite `FL_KEYS`** → structure axes (drops the 6 descriptor keys).
- **The mixed-history product decision (genuinely new, not mechanical):** a user with 40 pre-migration
  ratings (only `body/acid/tannin/sweet` survive) and 5 new structure ratings will have `finish`/
  `aroma`/`flavour` averaged over **5 rows** while `body` averages over **45** — an apples-to-oranges
  wheel with no per-axis sample-count signal. **Decide:** (a) accept the blend, (b) re-aggregate only
  post-migration rows, or (c) surface a per-axis n. This is a product call the "no-op" framing hid.

### 6b. Badges (`lib/badgeService.ts` + `lib/badges.ts`)

The live badge aggregate reads `oak/floral/earth/avg_fruit` — **all dropped**. Four badges
(`oak_addict`, `floral_fanatic`, `earth_mover`, `fruit_bomb`) become unearnable; `tannic_titan`/
`acid_freak` survive. **DECIDED (Simon, 2026-06-28): DEFER — do nothing now** (the badge system is
being revamped wholesale later; §10 #11). The four go temporarily unearnable; already-awarded
`user_badges` rows are not revoked. **Still required in PR 1 regardless:** the aggregate rewrite
(§10 #10 + §8) must not *crash* on the dropped keys — i.e. the rewritten `getUserStats` simply stops
computing `avgFlavorOak/Floral/Earth/Fruit`, and the §6b "three surfaces" note below ensures the
`badges.ts` eval predicates that read those `stats` fields are removed/guarded so nothing dangles. So
"defer" = don't *re-key* the badges; it does **not** mean leave dead `stats` references.

> **Three surfaces, not two (review fix).** The breakage spans (1) the **SQL aggregate** in
> `badgeService.ts:75-80`, (2) the **catalog** text in `lib/badges.ts`, AND (3) the **eval predicates**
> in `lib/badges.ts:207-213` (`check('oak_addict', stats.avgFlavorOak >= 3.0 …)` etc.) which read
> `stats.avgFlavorOak`/`Floral`/`Earth`/`Fruit` fields the new `stats` shape won't have. Rewriting only
> (1)+(2) and missing (3) leaves dangling field reads (runtime/type break). Also note: the
> `nonalc`-keyed badges (`type_nonalc_5`, `type_all`, reading `stats.nonalcCount` from a `style='nonalc'`
> FILTER) are a **separate** concern owned by the alcohol-attribute proposal (§1), not this build —
> they break when `nonalc`-as-style is retired, not when descriptors are dropped.

### 6c. Other derived surfaces (verify during build)

- **Feed / profile cards** (`CheckinCard`, `SessionFeedCard`, `/u/[id]`) render other users' wheels —
  must tolerate a partial migrated row (see §6d render note) without assuming a full set.
- **Compare overlay** — already in §3. The **single-taster** path uses `detectFL` → must become
  **`detectLegacyDescriptorFL(row) ?? perRatingAxes(row, resolveAxes(...))`** (NOT a direct `resolveAxes`
  swap — that drops legacy descriptor rows in the Expand window, §8). The **multi-taster** path
  hard-codes legacy `FL` (`overlayFL = FL`) and gets the §10 #1 DECIDED change — option C, per-series
  open-path in `RadarChart`, union frame in registry order (legacy fallback per the §10 #1 spec).
- **Web `WineModal` dirty-check (review fix — was uninventoried)** — `components/wine/WineModal.tsx:276-310`
  is the **web twin** of the native dirty/empty-check the §5 box flags. Its own comment says
  "RatingPane always seeds the dense FL keyset" and it "walks the UNION of keys treating missing as 0."
  Under the keep-all-zeros rule, `RatingPane` seeds the *resolved* axis set with explicit zeros, so this
  comparison's behaviour shifts — re-verify it against migrated sparse rows (it was tuned for legacy
  sparse objects). Add to §3's audit list.
- **Test fixtures (review fix — named, the hit is real)** — the project has **no jest/vitest**; the only
  regression harness is `.local/test-env/scripts/section-*.sh`. `section-07-checkins.sh:20` posts
  `"flavors":{"red_fruit":3}` — a **dropped** descriptor key. That fixture (and any sibling posting
  descriptor keys) must be migrated to structure keys, else the smoke test asserts on a stale shape.
  Grep `.local/test-env/scripts/` for descriptor key names before the Contract PR.

### 6d. Missing-vs-zero (single wheels) — DECIDED (Simon, 2026-06-28): key-presence drives it, compute-only, no single-wheel renderer change (compare-overlay exception → §10 #1)

The distinction is **carried by the JSON shape**, and the rule keys on *whether the axis key is present
in the rating*, not on any marker:

- **Axis key ABSENT** (migrated legacy row that never had `finish`/`aroma`/`flavour`) → **don't draw
  that axis at all** (no spoke/wedge/label for it on that rating's wheel).
- **Axis key PRESENT with value 0** (post-migration; taster rated it None) → **draw the axis with a
  point at the 0 mark** (centre). On the radar/spider the polygon **connects down to 0** there.
- **Axis key PRESENT with value ≥1** → filled to the value, as today.

**This is a COMPUTE change, not a graphics change** (Simon's correction). The renderers already take a
flexible axis array and draw whatever they're handed, and already plot `val=0` at the hub
(`RadarChart.tsx:48-53` maps `fl`, `r=(R/5)*val` → centre point + polygon connects to 0;
`PolarChart.tsx:81-91` same, 0 → no fill but axis/label present). So for **single wheels** —
`PolarChart`, the native `FlavourWheel` type, and single-taster `RadarChart` use — **the renderers DO
NOT change.** The only change is **at the call site**: build the axis array a rating is rendered with
from **the keys present in that rating's `flavors`** (ordered/filtered by the registry), instead of from
the full `resolveAxes(category, style)` set. Absent key → not in the array → not drawn; present-and-0 →
in the array → centre point. **"Optics stay" is literally true for single wheels.** (The compare
**overlay** is the one exception — `RadarChart`'s overlay polygon-builder gets the per-series open-path
change, option C, §10 #1.)

Consequence: a migrated 4-axis rating draws a 4-spoke wheel; a new 7-axis rating draws 7 (zeros as
centre points). The wheel skeleton = whatever the rating's data contains. (Where a *category-complete*
frame is wanted — e.g. an input surface showing all axes to rate — that surface hands the renderer the
full `resolveAxes` set on purpose; that's the input array, distinct from the per-rating render array.)

> **⚠️ Compare-overlay exception — DECIDED option C (§10 #1).** `RadarChart` draws **N tasters'
> polygons over ONE shared `fl` axis frame** (`RadarChart.tsx:25-27` — a single `fl` prop; `n =
> fl.length`). So when one taster has a *partial* row (4 axes) and another a *full* structure row (7),
> the per-rating "absent → no spoke" rule can't ride the shared frame. **Resolution: change `RadarChart`
> so each series' polygon spans only that taster's present axes — missing axes are SKIPPED (open path),
> never plotted as 0-at-centre.** Frame = union of present axes in registry order; per-series points
> omit absent axes; the polygon is an open path across gaps (degenerate: 2 axes → line, 1 → dot). This
> is the **one scoped renderer change** — so "renderers untouched" holds for `PolarChart` + native
> `FlavourWheel` + single-taster `RadarChart` use, with `RadarChart`'s overlay polygon-builder as the
> single documented exception. Full spec + the rejected options (union+0-at-centre, exemption): §10 #1.

### 6e. Partial-row inference / version marker — NOT NEEDED (resolved by 6d)

The earlier worry: future code can't tell `{acid:4}` (migrated, only acidity survived) from a new
client that sent only acidity. **The §5 keep-all-zeros rule + the §6d key-presence rule dissolve this
without a marker:** under keep-all-zeros, any *rated* axis is **present** in the JSON (even at 0), and
any *never-rated* axis is **absent**. So "is the key present?" already encodes "was this axis rated?" —
the data shape IS the version signal. **No `flavors_version` column, no schema addition, no migration
backfill for this.** (Edge residual: a malformed client could still omit a key it should have sent —
bounded by §6g's write-side key allow-listing, which is **mandatory in the Expand PR** (not a version
column).)

### 6f. Aroma / Flavour axis subtitles — DECIDED (Simon, 2026-06-28): INPUT CHIPS ONLY

The *old whole feature* was the "flavour wheel"; the *new* wheel has an axis named **Flavour**. Rather
than rename, **keep the labels Aroma + Flavour (and keys `aroma`/`flavour`) and add plain-language
SUBTITLES**: **"smell"** under Aroma, **"taste"** under Flavour.

> **Scope: the rating INPUT only (`FlavorChips`), NOT the read-only wheels (review fix).** The wheel
> renderers DO render axis labels (`PolarChart.renderLabel(f.l,…)`, `RadarChart` `${f.l}`, native
> `FlavourWheel` `axes[].label`), so putting subtitles *there* would be a renderer change and contradict
> "renderers untouched" (§6d). Decision: subtitles appear **only on the input chip**, which already has
> a two-line label (axis name + intensity word, `FlavorChips.tsx:163/168`) — a subtitle line slots in
> cleanly. The read-only wheels stay **label-only**. So **"renderers untouched" stays literally true**;
> the subtitle is a `FlavorChips`-only change. The hint sits where it helps (while rating).

**Zero data/migration impact** (presentational). Registry implication: the axis definition gains an
optional `sub?` field (`{ k, l, sub? }` — no `c`, colour is per-platform, §3a); only the **input chip**
label renderer reads it (the wheel label renderers ignore it). Bake the field into the registry from the
start. (Subtitles could extend to other axes / surfaces later; only Aroma/Flavour on the input chip are
specified now.)

### 6g. Write-side key allow-listing — PART OF THE ROLLOUT, not an optional follow-up (review fix)

`validateFlavors` accepts any ≤32-char key. While descriptors were free-form that was fine, but it
creates a **rollout-correctness problem**: after the migration, a stale browser tab or un-updated
mobile client can still POST descriptor keys, `validateFlavors` accepts them, and they land in fresh
rows — so "prod is verified clean (no descriptor keys remain)", the **precondition for the Contract PR
deleting the legacy sets (§8)**, can silently become false again. Tolerant *reads* are fine during
Expand; **writes must be registry-keyed before legacy is deleted.**

This is feasible at the route layer, but the `(category, style)` source **differs by route** — make it
explicit so the implementer doesn't assume one shared path:
- **Session rate** (`/api/session/[code]/rate`): the wine is in scope via `getWines` (Redis); `style`
  comes from `wine.type`, `category` is `wine`.
- **Standalone checkins** (`/api/checkins` POST + `/api/checkins/[id]` PATCH): there is **no session
  wine object** — `type`/`style` comes from the **request body** (POST, validated against
  `category_styles`) or the **existing `wines.style`** (PATCH fallback), and `category` is `wine`
  (defaulting until other categories exist). Resolve `resolveAxes('wine', bodyTypeOrExistingStyle)`
  there, not via `getWines`.

With the right `(category, style)` per route, each can **reject keys not in that set**. **DECIDED:
registry-keyed writes ship in the Expand PR** — a write carrying a key ∉ `resolveAxes(category, style)`
→ **400**. (No "keep generic for now" option: new writes should only ever send structure keys, and
rejecting early is what keeps the Contract PR's "verified clean" precondition true.)

> **Edit-path requirement this creates (review fix — the load-bearing client rule).** Registry-keyed
> writes mean an **edit/input surface must never resubmit descriptor keys.** The trap: a user opens a
> legacy descriptor row during the Expand window and hits Save *without touching the chips* — if the
> client naively round-trips the row's existing `flavors` (descriptor keys and all), the new registry
> gate **rejects the save (400)**. So every edit/input surface must, before POST/PATCH, **either** seed
> + save **structure keys only**, **or transform** a loaded legacy `flavors` to the kept structure
> subset (`body`/`acid`/`tannin`/`sweet`) and drop the rest. (This is the same keep-set the migration
> applies, §4 — the client transform mirrors it so an edit-save produces the same shape the migration
> would.) Surfaces affected: `RatingPane`/`WineModal` (session rate), `CheckinModal` (standalone), and
> the native impression edit. Without this rule, registry-keyed writes turn "edit an old rating" into a
> silent 400.

(Without registry-keyed writes, the §3 "descriptor-resurrection residual" is not just a stray-data
nuisance — it invalidates the Contract PR's delete-legacy precondition.)

---

## 7. Multi-taster range view — SPEC PINNED 2026-07-02 (= design 02d, native compare screen)

For a single taster, each axis is one value (Build 1). For multiple tasters of the same item, the
intended display is the **range across tasters + the average**: per axis, a min–max band plus a mean
line (the decided **C1b** comparison wheel, `.local/design/vero-scoring.js` `comparisonC1b`). The
spread between tasters is signal, not noise. This section is the data-half spec; the full screen is
design section 02d. Rulings below are Simon's, 2026-07-02.

**Size-adaptive display** (recomputed live when the people selection changes) keys on the
STRUCTURE-ENGAGED taster count (ruled 2026-07-02 — one profile among score-only raters draws that
person's wheel, never a one-series radar or a degenerate C1b): 1 profile → plain flavour wheel (with
a "Structure detail from NAME only." hint when automatic) · 2–4 → overlaid per-taster radar · 5+ →
C1b range wheel. With 1–4 profiles the structure-givers sort to the TOP of the score list (dot
colours pair with polygons; a structure-only score-0 rater gets a row with an em-dash score so their
polygon has a legend). Rater iteration is roster-ordered (the wire map follows Redis SCAN order —
unsorted it would flicker between polls), and raters with neither a score nor structure (notes-only
/ stale rows) are excluded from Compare entirely. Plus the impression list + per-impression
accordion — **in LINE-UP order (Simon's ruling 2026-07-03, supersedes the score-ranked list): the
two tabs read as one list.** Within a card, scored rater rows stay score-ranked.

**People-selector = 02d·4 variant B, the AVATAR RAIL (DECIDED, Simon 2026-07-02)**, adapted to
hide/unhide semantics: one screen-level hidden set drives every compare view — the rail chips, the
person rows, and the lead-chip picker sheet ("Compare who?" with Everyone / Just me / Me + friends
presets + search + the mock's Friend row tag; friends = mutual follows via `GET /api/me/friends`,
fetched lazily when the sheet opens). Rail chip states: selected chips wear the accent active state,
deselected dim; the **All chip is a toggle** — everything visible → deselect everyone, anything
hidden → select everyone; deselecting one person drops All while the others stay selected. The rail
is STICKY under the title bar exactly like the reveal strip (plain layout: `stickyHeaderIndices`;
cover-hero: the strip's Dynamic Overlay slot — the two share it, since the strip is line-up-only and
the rail compare-only). Variant A (pill + sheet) and direction C rejected.

**Screen behaviours ruled 2026-07-02 (Simon, on first build review):** Compare is an **in-screen tab
swap**, not a route — everything above the tab strip (plain bar or cover hero, incl. the hero photo)
stays identical; only the Add pill + reveal strip are line-up-only, and there is no back-to-line-up.
Accordion cards are **multi-open** and **all collapsed by default** — opening one never closes or
moves another; closing is a deliberate tap; the card top stays put and content unfolds downward.
**The avatar rail is the ONLY select/deselect surface** (second ruling round): deselected people
disappear from every card entirely — rows, charts, Show-all sheet — and the card header (group ★ +
consensus) and the RANKING recompute over the selection (the mock's selAccItem semantics). **Person
rows: in RADAR mode (2–4 profiles) a structure-giver's row toggles their LINE on the overlay
(row dims, chart-layer only — the rail stays the selection surface); in the other modes a row tap
opens that person's detail** — the card's chart swaps to their flavour wheel, NO score/word under
the wheel (Simon: the score already shows on their row; a person without structure detail draws the
empty wheel so the card height stays put), tap again returns to the group view; axis drill and
person detail are mutually exclusive. The **axis split opens from a C1b wedge OR an axis
label — on the radar too** (label tap); the radar wheelhead is just "Group flavour" (no taster
count, no legend dots — the row dots carry the colour mapping). The rail's left clip edge (chips
sliding under the picker chip) wears a soft bg→transparent fade, not a hard line.

**Aggregate home — `@verre/core` pure function, computed client-side (supersedes this section's
original "on the session read path" wording).** The people-selector must recompute min/max/avg live
per selected subset, and the client already receives every taster's ratings via `GET /:code/state`
(`buildRatingsView`) — a server-side aggregate would only ever serve the "Everyone" default and has
no other consumer (web compare is design-frozen). So the canonical semantics live once in core
(`aggregateFlavourAxes`), shared web↔native later; **no new server surface**.

**Zero rule — per RATING, not per axis.** "Absent vs explicit 0" is not a per-key distinction in the
data model (writes are filled-or-empty by construction, `gateAndFillFlavors`); the aggregate applies
the same model to legacy sparse rows by normalizing each rating through `fillFlavourZeros` first:

- flavors non-empty (rated ≥1 structure axis) → the taster counts on **every** axis of the wine's
  resolved set; keys missing from an old sparse row normalize to **explicit 0** ("perceived None").
- flavors empty / rating reset → **no data**: the taster contributes to no axis, no band, no mean.

`n` is therefore uniform across axes for a given impression+selection (= engaged tasters). A lone
engaged taster (n = 1) draws a degenerate band — min = max — which C1b's minimum-band-thickness rule
already renders sensibly.

**Score-side corollary:** overall score `0` = "not rated" (score-system invariant) — excluded from
the group score avg, the spread, and the ranked rows. Flavour detail still aggregates for such a
taster (engagement is per-signal). The impression appears on Compare when ≥1 selected taster has any
rating engagement.

**Consensus teaser** (replaces the type line on the accordion row) — the BLENDED disagreement score
(`consensusFromRatings` in core, ruled 2026-07-02, superseding the score-range-only rule):
`D = 0.6·(scoreGap/5) + 0.4·(meanAxisGap/5)`, where each gap = 2 × mean absolute deviation (equals
the plain range for two tasters; dampens a lone outlier in a big group), the axis term averages the
per-axis intensity gaps over structure-engaged tasters (score-0 flavour-only tasters count here) and
drops out when fewer than two carry structure detail. Words: D ≤ 0.10 "In harmony" (positive) ·
≤ 0.25 "Mostly agreed" (ink-soft) · ≤ 0.45 "Mixed feelings" (caution) · else "Polarizing"
(critical) — in two-rater score-only terms: 0.5 / 1.25 / 2.25 gaps. A consensus is a GROUP signal:
fewer than two rated scores → no consensus line at all (no score-word substitute for a single
rater). The compare row's maker line is producer-only (no type/variety — same ruling round).

**Colours:** axis colours from the theme flavour palette (`useFlavourColors()`), never the mock's
baked hexes. Per-person series colours (≤4 radar polygons/dots) derive from the theme's palette base
ramp (structure and aroma are assignments off one shared hex ramp per theme). As built (refined on
device 2026-07-02): the 13 structure hexes in the palette's OWN canonical order — the same colour
family the 5+ wheel draws with; an earlier hue-spread permutation was rejected
(`theme/flavourColors.ts` `PERSON_SERIES`; aroma adds only `Chemical` beyond those, deliberately
skipped) — assigned in stable roster order.

**C1b band tones:** the mock's `color-mix(in srgb, colour 42%|92%, var(--surface))` maps to
`theme/color.ts` `mix()` against `theme.surface`.

---

## 8. Rollout sequencing — compatibility is mandatory, not incidental (review-driven)

The first draft's "delete legacy once call sites migrate" + a destructive migration is **not a safe
order** on its own. Two failure modes:

- **New code ships before migration** → old descriptor rows still in prod; the new `resolveAxes`
  renderer draws them as mostly-empty wheels (descriptor values ignored).
- **Migration runs before old code is gone** → any surviving `detectFL`/legacy path mis-detects the
  now-sparse rows.

**Mandatory order — expand → migrate → contract:**

1. **Expand (PR 1):** ship structure axes + `resolveAxes` + a **tolerant/dual-read** posture for the
   **charts**. Concretely (the boundary, made explicit): **writes** use the registry (new ratings store
   structure keys); **render call sites pick the axis array via a NEW explicit legacy predicate**, not
   the existing `detectFL`. ⚠️ **`detectFL` is NOT a usable legacy detector (review fix):** it
   **always returns an array** — its final branch is `return FL` (the generic legacy set,
   `flavours.ts:87`), so a new structure row `{body, acid, …}` (none of the descriptor sentinels
   `dark_fruit`/`floral_herb`/`tree_fruit`/`mineral`+`stone`) falls through to `FL` and is
   **misclassified as legacy**. A `detectFL(row) ? legacy : structure` ternary is therefore broken —
   the legacy branch always wins. PR 1 must add a **`detectLegacyDescriptorFL(flavors): FlItem[] | null`**.
   ⚠️ **Detection must key on ANY dropped descriptor key, NOT just `detectFL`'s 4 sentinels (review fix
   — a correctness bug in the earlier spec):** `detectFL`'s sentinels are only `dark_fruit` /
   `floral_herb` / `tree_fruit` / `mineral`+`stone`, but the DUMP set is **16 keys** (also `oak`,
   `floral`, `earth`, `spice`, `citrus`, `tropical`, `herbal`, `nutty`, `creamy`, `red_fruit`,
   `dried_fruit`). A legacy row like `{oak:3}` or `{floral:2, earth:4}` has **no sentinel** — under the
   sentinel-only predicate it returns `null`, gets treated as a structure row, and since those keys
   aren't in the structure registry, `perRatingAxes` **drops them and the descriptor data vanishes from
   the render before migration even runs.** So the **primary rule**: `detectLegacyDescriptorFL` returns
   non-null when the row contains **≥1 key in the known 16-key DUMP set** — those are real historical
   descriptor data that must keep rendering. It then *uses* the sentinel logic only to pick the
   best-fitting legacy set (RED/WHITE/SPARK/ROSE) for label fidelity, falling back to generic `FL`. Else
   (only structure keys present) → `null`. **Separate policy for unknown keys** (neither structure-registry
   nor DUMP-set — i.e. malformed/future junk): treat as invalid, not as legacy display data — drop or
   400 them, don't render them as if they were a descriptor wheel. (Keep the two distinct: "known
   descriptor → legacy render" vs "unknown → invalid"; a blanket "any non-structure key → legacy" would
   mis-render future garbage as a wheel.) Call site:
   `detectLegacyDescriptorFL(row) ?? perRatingAxes(row, resolveAxes(category, style))`. So a descriptor
   row draws its legacy wheel; a pure-structure row draws the new per-present-key array (§6d).
   The legacy detector + the legacy sets are deleted in PR 2. The profile/badge aggregates are
   **rewritten to structure axes in THIS PR** (§10 #10, switch-early decided). **Write-side key
   allow-listing (§6g)** is wired here too: writes become registry-keyed so no NEW descriptor key can
   land after deploy (this protects PR 2's "verified clean" precondition). **Do NOT delete the legacy
   sets in this PR** — they stay for the dual-read fallback.
2. **Archive + migrate (operational step):** §4.2 backup, then §4.3 migration, in a monitored window,
   after a **dry-run report** (§8a) is reviewed.
3. **Contract (PR 2):** once prod is verified clean (no descriptor keys remain) — a state that **holds
   only because writes were registry-keyed in step 1 (§6g)**, otherwise stale clients keep
   re-introducing descriptor keys — delete `FL_RED/…`, `getFL`, `detectFL`, the `detectLegacyDescriptorFL`
   adapter, and the legacy sets.

Deleting legacy constants in the same PR as the first structure rollout is only safe if the migration
has already run everywhere — which it can't have, since the migration follows the deploy. So the
three-step split is required. **Note:** the §3 change-table "Delete legacy" row is **Contract-PR (PR 2)
work, NOT Expand** — it's listed in §3 for completeness but sequenced here under step 3; do not delete
`FL_*`/`detectFL` in PR 1.

> **Charts dual-read; profile/badge aggregates do NOT (review fix).** "Dual-read" is a *chart*
> concept — the renderer can adapt per row. The **profile and badge aggregates** are single SQL
> statements over the whole table; they can't be "dual" without computing both key sets at once
> (waste) and they have no per-row branch. **DECIDED (§10 #10): switch early — rewrite the profile/
> badge aggregates to structure axes in the Expand PR (step 1); their derived behaviour switches at
> deploy, NOT at migration.** Concretely, between deploy and migration: the profile wheel's descriptor
> axes (still in un-migrated rows but no longer summed) read 0, and the four descriptor badges (§6b)
> stop being evaluable — *before* the data is migrated. Accepted: the window is short and those
> descriptor profile/badges are being retired anyway. (The rejected alternative — keep the old
> aggregates until migration, swap in the Contract PR — buys no cleaner window, since the old aggregate
> breaks equally the moment data migrates.)

### 8a. Pre-migration dry-run report (run + review before step 2)

Beyond the §4.1 counts, produce a one-shot report so the migration is auditable:
- total rows with non-empty `flavors`;
- rows retaining ≥1 structure key (survive with data) vs rows collapsing to `{}`;
- count per old descriptor key (sizes the aroma-tree seed);
- of the collapsing rows, how many keep a `score`/`notes` (stay engaged) vs become fully-empty orphans
  (the §4.1(b) population).

### 8b. Verifying the CODE (not just the migration) — process gap

The §8a report audits the *data migration*. The *code* needs its own check, and the project has **no
jest/vitest** — the regression harness is `.local/test-env/scripts/section-*.sh` (manual bash + curl).
A new `section-structure-wheel.sh` should assert at minimum:
- `resolveAxes(category, style)` returns the right set for each of `{red, white, rose, spark}` + the
  defensive `nonalc` fallback (§1a) — a pure-`tsx` unit check (the §-test-env pattern for pure logic).
- the two-pass zero rule across all three `validateFlavors` callers: all-zero → `{}`; one-non-zero →
  zeros retained.
- the rewritten profile + badge aggregates return sane numbers on a seeded structure row (and that the
  `badges.ts` eval predicates in §6b surface (3) don't reference dropped `stats` fields).
- a migrated partial row renders without error on the feed/profile/compare surfaces.
- **compare-overlay mixed-row cases (§10 #1):** (i) a full-structure taster + a partial taster overlay
  with the partial polygon's missing axes **omitted, not 0-at-centre** (open-path); (ii) **a
  descriptor-only taster contributes nothing to the overlay frame** during the Expand window — assert
  this decided tradeoff explicitly so it can't regress silently into a 0-collapsed shape or an error;
  (iii) the union frame is in registry order (stable across renders).
Pre-existing descriptor fixtures (`section-07-checkins.sh:20`, §6c) must be migrated first or they'll
fail against the new shape. Flagged because the migration is auditable but the code currently is not.

---

## 9. Semantic carry-forward (not just key carry-forward) — review note

"No namespacing" reuses `sweet/acid/body/tannin` on the **assumption that the old value *means* the
new structure axis**. That's solid for `acid`/`body`/`tannin` (they were always intensity-like). It's
**weaker for `sweet`** — depending how users treated the old flavour wheel, old `sweet` may have meant
"sweet *flavour* present" rather than "Sweetness *intensity*." This is a **semantic** carry-forward,
not just a key carry-forward; flag it as an accepted approximation (the values are close enough and
the alternative is discarding them). Documented here so it's a decision, not an accident.

---

## 10. Decisions — all Build-1 gates resolved; remaining items are migration-step + deferrable

Each item tags what it **blocks**, so the build-readiness question is answerable at a glance. **All
Build-1 gates are resolved** (the compare-overlay gate was the last; decided below). What remains is
🟡 migration-step (decide at the §8a dry-run) and 🟢 deferrable.

**🔴 Build-1 gates: ALL RESOLVED.** Single-wheel: renderers untouched per #7, aggregates switch early
per #10, no `flavors_version` column per #8. Compare-overlay: decided per #1 below (the one scoped
`RadarChart` change).

**✅ Compare-overlay — DECIDED (Simon, 2026-06-28): option C, open-path per-series.**

1. **Compare-overlay mixed partial/full rows** (§3 row, §6d exception) — `RadarChart` shares ONE axis
   frame across all tasters, so the per-rating "absent → no spoke" rule can't be applied via the frame.
   **Decision — each taster's polygon spans ONLY the axes that taster rated; missing axes are SKIPPED
   (open path), never pulled to centre.** This is **option C** (a per-series missing-value treatment —
   a real `RadarChart` change, the one component otherwise untouched). Rejected: (a) union-frame with
   absent→0-at-centre (reads as a false "rated zero"), (b) the same as an explicit exemption. The
   open-path is the only truthful one — a gap reads as "not rated," not "rated none."
   - **Frame** = **union of axes present across shown tasters, in registry order** (iterate
     `resolveAxes(category, style)` canonically, keep axes present in ≥1 taster; never order by insertion
     or a single taster's key order, which would drift between renders). Structure axes always first.
   - **Per series** = build the point list from **only that taster's present keys**; **omit** vertices
     for absent axes (no `flavors[k] || 0` 0-vertex). The polygon is an **open path** — no closing edge
     across a gap — so a partial taster visibly reads as incomplete rather than mimicking a full closed
     shape. **Degenerate cases**: a taster with 2 present axes draws a line; 1 draws a dot.
   - **Legacy rows in the Expand window** (detect via §8's `detectLegacyDescriptorFL` — DUMP-set primary
     rule, NOT the 4-sentinel test — else a `{oak:3}` taster is misread as structure): a legacy taster
     carries DUMP-set keys. **Show structure-registry axes only** (a descriptor-only taster then
     contributes nothing to the frame for the short Expand window — intentional, acceptable). The
     alternative (append legacy keys after structure axes) is available if mixed compare proves common,
     but default to structure-only.
   - **Scope note:** this means **`RadarChart` DOES change** (overlay only). `PolarChart` and the native
     `FlavourWheel` stay untouched. The doc's "renderers untouched" claim now carries this one scoped
     exception (§6d, §3 compare row).

**🟡 Migration-step decisions — RESOLVED by the 2026-06-29 prod dry-run (§8a):**

2. **Fully-empty orphan rows** (§4.1(b)) — ~~add a reap `DELETE` … or leave them?~~ **DECIDED:
   LEAVE, no reap.** The prod dry-run (2026-06-29) returned **0** fully-empty orphans (Q2) and **0**
   lingering orphan session cards (Q3): of 44 non-empty rows, 43 keep ≥1 structure key and the single
   collapsing row is engaged (carries a score/note), so it survives as a partial structure rating.
   There is nothing to reap → the §4.1 eager-reap runbook (`rating_images` + S3 + feed_item
   replication + extended backup) is **moot**; the migration is a pure `UPDATE`, no `DELETE` step.
   Dry-run also confirmed **0 unexpected keys** (Q5) and the descriptor-key frequencies that size the
   §4.2 aroma seed: `oak 38 · citrus 35 · herbal 32 · floral 31 · tropical 24 · stone 23 · red_fruit 21
   · mineral 19 · earth 17 · nutty 10 · creamy 10 · floral_herb 10 · dried_fruit 10 · tree_fruit 10 ·
   spice 8 · dark_fruit 8`. (The full report — queries + this table — is also kept at the gitignored
   `.local/structure-wheel-migration/dry-run-2026-06-29.md`, but the load-bearing numbers are inlined
   here so the evidence travels with the branch.) **blocks: nothing.**
3. **Redis live-session ratings during migration** (§4.3) — ~~quiet-window TTL ageout vs parallel
   pass.~~ **DECIDED for this window: no parallel pass.** Simon confirmed **no live session active**
   (2026-06-29) → no Redis descriptor data to migrate. (Re-verify with `SCAN s:*:r:*` at the actual
   migration moment if time has elapsed.) **blocks: nothing now.**

**🟢 Deferrable (do not block PR 1; resolve before the surface they touch ships):**

4. **Profile mixed-history** (§6a) — blend / post-migration-only / per-axis n. (The *new meaning*, vs
   #10's *timing*.) **blocks: profile surface correctness, not PR 1 structure.**
5. **Palette VALUES** (§3) — Simon decides; this doc pings when the build reaches it. **blocks: web colours +
   native input, NOT the registry/axis logic.** (Colour *home* is already decided — §3a/§10 #14: colour is
   per-platform presentation, web `WEB_PALETTE` + native theme-resolved, NOT in the core registry. Only the
   hex values remain deferred.)
6. **Axis order** (§1) — appended for now; locks once data ships. **blocks: nothing yet.**

**✅ Decided:**

7. **Missing-vs-zero render** (§6d) — **key-presence drives it, COMPUTE-ONLY, no SINGLE-WHEEL renderer
   change** (the compare overlay has the one scoped `RadarChart` change, #1). Absent key → no spoke;
   present-and-0 → centre point + radar connects to 0; present-and-N → filled. The render call site
   builds the axis array from the rating's present keys, not from the full category set. "Optics stay"
   holds for single wheels. *(Resolved 2026-06-28.)*
8. **Partial-row marker** (§6e) — **NOT NEEDED.** The JSON key-presence (under keep-all-zeros, §5) IS
   the version signal; no `flavors_version` column, no migration backfill. *(Resolved 2026-06-28.)*
9. **`nonalc` / alcohol** (§1, §1a) — **DIRECTION: alcohol becomes a drink attribute (ABV % + low-alc/
   no-alc ticks); `nonalc` is retired as a `style`** in a **separate proposal** (scheduled "towards
   the end"; prod has only ~1 `nonalc` impression → manually migratable). For THIS build: `resolveAxes`
   keys on `{red, white, rose, spark}` (Bubbles on `spark`), and **tolerates the legacy `nonalc` style
   defensively** (→ base wine set). *(Resolved 2026-06-28; superseded the earlier "one nonalc style +
   Bubbles" ruling.)*
10. **Profile/badge aggregate timing** (§8) — **SWITCH EARLY: PR 1 (Expand) ships the rewritten
    structure-axis aggregates.** Derived profile/badge behaviour changes at deploy, not at migration;
    the brief early-degraded window (descriptor axes read 0 before the data is migrated) is accepted
    because those descriptor profile/badges are being retired anyway, and "switch late" buys no cleaner
    window (the old aggregate breaks equally the moment data migrates). One code path. *(Resolved
    2026-06-28.)*
11. **Orphaned badges (§6b)** — **DEFER, do nothing now.** The badge system is being revamped wholesale
    later; the four descriptor badges (`oak_addict`/`floral_fanatic`/`earth_mover`/`fruit_bomb`) just go
    temporarily unearnable in the interim (already-awarded rows persist). Do **not** invest in re-keying
    them for this build. *(Resolved 2026-06-28.)*
12. **Aroma / Flavour axis labels (§6f)** — **KEEP the labels "Aroma" and "Flavour" and the keys
    `aroma`/`flavour`; add disambiguating SUBTITLES** — plain-language: **"smell"** under Aroma,
    **"taste"** under Flavour — **on the rating INPUT CHIP only** (`FlavorChips`), NOT the read-only
    wheels (so "renderers untouched" holds, §6f). Label-only, no rename, **zero data/migration impact.**
    Registry implication: the axis-definition shape gains an optional `sub?` field (`{ k, l, sub? }` —
    no `c`, colour is per-platform per §3a/§10 #14) that only the **input chip** renderer reads (wheel
    label renderers ignore it) — design the registry with this from the start. *(Resolved 2026-06-28.)*
13. **`bold → Strong` (§1)** — **CHANGE to "Strong"** across all 5 surfaces (IntensityHelp `INTENSITY` +
    its `DESCRIPTIONS` key, FlavorChips via import, RatingPane's 2nd hard-coded copy, native
    `scoreWords.ts`). Simon **signs off the design-copy override** of the frozen handoff's "4 Bold."
    *(Resolved 2026-06-28.)*
14. **Axis COLOUR home (§3a)** — **colour is per-platform presentation, NOT in the core registry.** The
    core axis def is `{ k, l, sub? }` (no `c`). **Web** owns a `WEB_PALETTE` (`k → hex`) + a `withColours`
    join in `lib/flavours.ts`; **native resolves axis colour from the user's active THEME at render time**
    (so an axis has no single fixed colour — it's a function of `(axis, theme)`). Reason: baking a static
    hex into the platform-neutral core table is wrong for native (theme-reactive) and violates core's
    platform-purity rule (colour is presentation). Only the colour *values* remain deferred (§10 #5), not
    where they live. *(Resolved 2026-06-28; as-built in the Expand PR registry.)*
