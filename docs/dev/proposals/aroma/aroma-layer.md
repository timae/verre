# Aroma layer — Verre integration proposal

**Status: decisions settled (§10 all DECIDED, 2026-07-08); PR A in progress.** Adds the aroma **descriptor** layer (Layer 2 of [`tasting-model-brief.md`](tasting-model-brief.md)) to Verre's impressions. The structure-wheel (Layer 1) shipped this as far as "Aroma = intensity of the smell"; this proposal is the "*what* it smells like" half — the universal descriptor tree in [`aroma-taxonomy.json`](aroma-taxonomy.json).

Scope guard: **wine only, as Verre exists today.** The tree is category-universal by design, so nothing here blocks coffee/cheese later — but no category work ships with this. The brief's Layer 1 material (category baselines, Warmth→Spiciness swap) is context, not scope; drift it creates is flagged in §9.

## 1. What ships

Per rating (session rate AND standalone check-in), a set of aroma selections. Each selection is the pair the brief mandates:

```
{ a: <leaf id>, m: <modifier id> | null }
```

- `a` — a tier-3 leaf from the taxonomy (365 in v1). Selections are leaf-only; tiers exist for browse + roll-up, not for storage.
- `m` — one of the 8 modifiers, or null for the fresh/default state. Never fused into the leaf token (`"dried-fig"` is banned by the brief's data model — fusing destroys the modifier aggregation axis).

Faults are neutral leaves like any other (Chemical family). No good/bad flag anywhere.

## 2. Taxonomy home: `packages/core`

The tree is static data + pure derivations — exactly what `@verre/core` exists for (platform-pure, shared web↔native). New module `packages/core/src/aroma/`:

- `taxonomy.ts` — the tree as typed data (generated from the JSON, or the JSON imported + typed; either way the JSON in this folder stops being canonical the day this lands).
- Derivations (all pure, all computed from tree position, **never by parsing ids** — see §3): `getLeaf(id)`, `tierPath(id)` → `[family, subfamily, leaf]`, `allowedModifiers(id)` (resolves the leaf → subfamily → family inheritance chain), `modifierDisplay(leafId, modId)` (per-leaf display-word override, e.g. strawberry+cooked → "jammy"), `isValidSelection(a, m)`.
- `searchIndex()` — flat index over leaf labels + modifier labels + modifier `search_aliases` + `modifier_display` words, so "dried fig" resolves to `fig + dried` and "jammy strawberry" to `strawberry + cooked`. Built once at module load; both platforms consume it.

Size: the JSON is 65KB pretty-printed, ~25–30KB minified inside a bundle. Acceptable for both web and native; native *needs* it locally for the browse tree anyway.

Validation status of the v1 file (checked 2026-07-08): ids unique, labels unique tree-wide (the "one leaf, one home" rule holds), every `allowed_modifiers` / `modifier_display` reference resolves, every leaf has an effective allowed-modifier set via inheritance, promoted leaves (raisin, prune) present, brief's contested placements all match (blue cheese → Funky, flint → Mineral vs struck-match → Chemical, dairy split, cured veg, peat → Fire). A CI check should re-run these invariants once the file lives in core (same shape as the palette gate precedent).

## 3. ID scheme — DECIDED shape (pending Simon's confirm): path-free leaf slugs

The JSON's `id_scheme` bakes the tree path into the id (`fruity.citrus.lemon`). The brief simultaneously promises: *"If the taxonomy is manually re-parented later, historical impressions inherit the new structure automatically."* **These two contradict.** Re-parenting a leaf either changes its id (breaking every stored `(aroma_id)` reference — the exact failure the promise rules out) or leaves the id lying about its path (breaking anything that derives tiers by splitting the id, which the dotted scheme invites).

Implementation reality check (why the dotted scheme buys nothing): in code the id is an **opaque Map key** — `getLeaf`, `allowedModifiers`, `tierPath`, the search index, chip render, the `gateAromas` 400-check are all lookups into structures built from the tree at module load. Nothing legitimate ever parses an id; the only code path-encoding enables is the id-splitting shortcut we'd have to forbid anyway. So the id's *only* real property is stability under taxonomy evolution — and path-encoding is the one choice that breaks it.

**The scheme:**

- **Leaf ids = label-derived slugs** (`lemon`, `blue_cheese`, `pumpkin_seed`), stored in impressions. Uniqueness is guaranteed by the one-leaf-one-home rule (labels are unique tree-wide; where a percept splits, the brief already mandates *different words*). One fix needed in the v1 JSON: `kernel.seeds.pumpkin` shortened its slug and collides with the vegetable — becomes `pumpkin_seed` (its label already says "pumpkin seed").
- **Family + subfamily ids stay qualified** (`fruity`, `mineral.stone`). Verified: bare subfamily slugs actually collide (`stone`, `cured`, `dairy` each exist twice), and 6 leaf slugs coincide with subfamily slugs (`char`, `honey`, `vanilla`, `cocoa`, `anise`, `petrol`). Harmless — tier-1/tier-2 ids are **never persisted in user data**; they live in the taxonomy structure, the palette mapping, and computed roll-ups. Re-parenting a *subfamily* changes its id, which breaks nothing stored.
- **Namespace rule**: a stored aroma reference is ALWAYS a leaf id. Roll-up grain (family/subfamily level for compare) is a query-time computation parameter, never a stored value — so leaf-vs-subfamily slug coincidences can't be confused in any persisted field.
- **Rename ≠ re-id**: a label rename keeps the slug (slug drift from label is acceptable; the label is the display truth). Deleting/merging a leaf later needs an explicit `superseded_by` alias map in the taxonomy — true under ANY id scheme, so it's a content-pass mechanism, not a reason to prefer either scheme.
- Modifier ids (`dried`, `cooked`, …) are already opaque and stay as-is.

The dotted form survives as a *derived* path string (`tierPath(id).join('.')`) for debugging/display, never as a key. The JSON gets regenerated with slug leaf-ids as part of PR A (a mechanical transform + the one pumpkin fix); the `conventions.id_scheme` note updates accordingly.

Rejected alternative: keep dotted ids and declare re-parenting a breaking change requiring stored-data migrations. Preserves the current JSON verbatim but makes the brief's re-parenting promise false — and the promise is load-bearing, because the brief explicitly plans content passes after data exists.

## 4. Data model

Rides the existing two-tier persistence — aromas are part of the rating, not a new entity:

- **Redis** (`s:{CODE}:r:{ID}:{WINEID}` JSON): add `aromas: [{a, m}]` beside `score`/`flavors`/`notes`. Absent/empty array = none.
- **Postgres**: `ratings.aromas Json @default("[]")` — additive column, non-destructive migration, mirrors the `flavors` precedent. Same column serves standalone check-ins.
- **Present-replaces / omitted-preserves** (as built in PR A): the rate POST treats an OMITTED `aromas` field as "keep what's stored" (Redis via a prior-value read; Postgres via a `CASE` on the conflict row, so a TTL'd Redis key can't wipe the archive) and a PRESENT field — including `[]` — as the full new truth. Rationale: the rate POST is otherwise full-replace, but web's rate pane and any stale binary won't send `aromas` for a while, and a save from them must not wipe selections made on native. Consequence for "clear my rating": an empty POST from an aromas-unaware client leaves an aromas-only row alive (correct — don't destroy data the client doesn't know about); the explicit Reset DELETE force-reaps everything.

**Why a JSON column, not a `rating_aromas` table**: consistency with `flavors` and the Redis→PG archival flow; the read paths that matter (rating render, feed card, compare) always want the whole set for a rating; and the brief's roll-ups are computed *from the taxonomy at query time*, so relational tier columns would be denormalised derivations we'd have to keep in sync — the thing the brief's "derive on demand" rule exists to prevent. Revisit trigger: the Palate Fingerprint profile aggregate — if per-user cross-rating slicing in SQL gets hot, a projection table can be added *then* without touching the write model (`lib/profileFlavor.ts` already does this style of aggregation over `flavors` JSON in app code).

**Cap**: 30 selections per rating (DECIDED, Simon 2026-07-08 — a validation limit, generous vs real tasting-note practice; prevents a hostile 10k-element array). **Unit = one selection = one `(a, m)` pair** — the modifier is a field on the selection, never a second unit, and any future per-selection flag (e.g. "dominant": `{a, m, dominant: true}`) is likewise a field, not a unit; the JSON shape absorbs such flags without migration. Dedupe on the `(a, m)` pair — `fig` and `fig + dried` are two distinct selections (legitimately: fresh and dried fig notes in one wine).

**Engagement rule extension (mandatory touchpoint)**: `hasEngagement` in the rate POST and the empty-payload predicate in `lib/engagementCascade.ts` both currently define engagement as score > 0 OR non-empty flavours OR non-empty note. A rating carrying only aromas MUST count as engaged, and an upsert that empties aromas along with everything else must still trigger the cascade. Both sides of the predicate change in the same PR that adds the column — shipping the column without this silently breaks the feed-item lifecycle.

**Cascade/tombstone**: nothing new. Aromas live inside the `ratings` row, so they follow the existing split rule (standalone hard-cascade, session tombstone) with zero extra handling. No S3, no counters, no new rate limits (writes ride the existing rate/checkin endpoints and their caps).

## 5. Validation chokepoint

Mirrors the flavours pattern exactly — one pure validator in core, one server gate in lib, applied by every write route AFTER it:

- **core `validateAromaSelections(input)`** — shape check: array, ≤ cap, each element `{a: string, m: string|null}`, dedupe. Shared with native for optimistic state.
- **lib/aromas.ts `gateAromas(selections)`** — the server boundary: `a` must be a known leaf id → else **400, loudly** (`unknown aroma id`); `m` must be null or in `allowedModifiers(a)` → else **400** (`modifier not allowed for this aroma`). No silent stripping: unlike the flavours gate (where a stray zero is a fill artifact from a style race), there is no innocent way to post an unknown leaf or a disallowed modifier — reject is always correct. Returns the deduped canonical array; the cap is checked on the RAW input length (before dedupe) — stricter than strictly necessary, fine for an abuse bound.

Call sites: `app/api/session/[code]/rate/route.ts`, `app/api/checkins/route.ts` POST, `app/api/checkins/[id]/route.ts` PATCH. Wire format is plain strings/null — no Decimal trap.

## 6. Input UI (native first)

Per the brief's input model: a **modifier bar** + tier-by-tier browse + search. Phasing:

1. **Native input** (the current milestone track) — browse Family → Subfamily → leaf grid; modifier bar gated per selected node via `allowedModifiers`; selected pairs render as chips (leaf label + modifier badge using `modifierDisplay`). Search-first entry: typing resolves leaf and leaf+modifier directly.
2. **Web read-only** — chips on wine detail / feed / profile render from the same core helpers. Web *input* deferred (web rate UI is slated for redesign anyway — don't build the browse tree twice).
3. **Compare/aggregate** — later phase (§8).

Design detail (chip layout, where the modifier bar sits, wheel-vs-list browse) is deliberately not specified here — that's a `docs/design/` conversation with mockups, and per the pixel-spec rule it needs Simon's visual ruling, not an approximation.

## 7. Display + palette mapping (decision needed)

Family colour comes from the palette's per-theme `aroma` block (12 colours, authored 2026-07-01, `apps/mobile/src/theme/flavour-palette/palette.js`). The palette's family names had drifted from the taxonomy — palette said `Nut/Cocoa` and `Roasted`; the brief/taxonomy renamed these to **Kernel** and **Fire**. **DECIDED (Simon, 2026-07-08): re-key the palette** — `Nut/Cocoa`→`Kernel`, `Roasted`→`Fire`, same colour values, in both the tracked `palette.js` and the gitignored design source `.local/design/flavour-palette.js` (keep the mirrors in sync). Lands with PR A.

Read surfaces render selections grouped by family, family-coloured chips, `modifierDisplay` word as the badge. Blind sessions: no new redaction — aroma selections are the *taster's own perception*, same trust class as structure ratings and notes, and never identify the wine's label.

## 8. Comparison / roll-up (later phase, design constraint now)

The brief's query-time roll-up (strip modifiers → climb tiers → find the agreement grain) is the compare feature's job, not v1's. v1 only has to not foreclose it — which the storage rules already guarantee: leaf-grain + separate modifier stored, tier paths derived. Because every read derives `tierPath(leafId)` fresh from the tree (one-leaf-one-home makes it deterministic), "1 picked strawberry, 1 peach, 1 cherry → 3 say Fruity" is a pure computation over stored leaf ids — and a later re-parenting automatically re-aggregates historical data under the leaf's new home. `compareAggregate.ts` grows an aroma section when the compare milestone picks this up.

## 9. Adjacent drift flagged (NOT this proposal's scope)

- **Structure master list — RULED (Simon, 2026-07-08): Spiciness is in, Warmth is dropped.** The shipped palette's 13 structure colours still carry `Warmth` and lack `Spiciness`; nothing in the wine-8 set is affected today, so the palette swap (re-key `Warmth`→`Spiciness`, colour value = Simon's call at that point) lands with the first category that needs it — but the ruling is settled now, don't re-litigate then.
- **Category baselines / Drink-Food hierarchy** (brief Layer 1): future-categories work. `resolveAxes` already reserves the `category` parameter for it.
- **Taxonomy content pass** (brief's open work #1): the v1 tree is shippable as-is (per-node modifier gating is already authored throughout, contra the brief's own open-work note, which predates this JSON). Deeper leaves (hop varietals, cheese rinds, per-leaf search aliases like cassis→blackcurrant) are additive content PRs against the core file — never blockers.

## 10. Decision registry

1. ~~**ID scheme** (§3)~~ — **DECIDED (Simon, 2026-07-08): path-free label-derived leaf slugs**, qualified tier-1/tier-2 ids, leaf-only persistence, `pumpkin_seed` collision fix. Performance was probed and answered (O(1) map lookups built at module load; the lost `LIKE 'fruity.%'` SQL shortcut is the flaw, not a feature — app-side aggregation or a taxonomy-derived VALUES join covers any future SQL need re-parent-safely).
2. ~~**Palette family re-key** (§7)~~ — **DECIDED (Simon, 2026-07-08): re-key to `Kernel`/`Fire`** in both palette copies. Bonus ruling same day: structure list takes `Spiciness`, drops `Warmth` (§9).
3. ~~**Selection cap** (§4)~~ — **DECIDED (Simon, 2026-07-08): 30** (abuse bound, not a UX target; §4 defines the unit — one `(a, m)` pair = 1).
4. ~~**v1 surface cut** (§6)~~ — **DECIDED (Simon, 2026-07-08): moments write route first** (`/api/session/[code]/rate`), then the standalone check-in routes as a follow-up carrying the lessons learned. Read surfaces follow the same order.
5. ~~**Blue cheese in Funky**~~ — **CONFIRMED (Simon, 2026-07-08): stays in Funky.** The brief's open #3 is closed; the single Funky cheese exception is canonical.

## 11. Rollout shape

1. Decision #1 (id scheme) confirmed in this doc — the last open gate before PR A.
2. PR A (backend, moments-first) — **BUILT (2026-07-08, `feature/aroma-core`)**: core taxonomy module (slug-id regeneration + pumpkin_seed fix) + validators, palette re-key (both copies), `ratings.aromas` column + migration, `gateAromas`, **session rate route only**, engagement predicate extension, session GET surfaces include `aromas`. CI taxonomy-invariants check (`scripts/check-aroma-taxonomy.mjs`). E2E pins in `.local/test-env/scripts/section-aromas.sh` (22 assertions: gate 400s, dedupe, omitted-preserves on both stores, aromas-as-engagement, extended cascade predicate).
3. PR B (native input, moments rating sheet): browse/search/modifier-bar input + chips, per the design conversation.
4. PR C (standalone check-ins): `/api/checkins` POST + `[id]` PATCH gain `aromas` (same `gateAromas` chokepoint), check-in create sheet input, feed/detail chips — applying whatever PR A/B taught. README API table updates here (checkins are the README-documented routes).
5. PR D (remaining read surfaces): profile, web read-only chips.
6. Later milestones: compare roll-up, Palate Fingerprint, content passes.

Each PR on its own `feature/aroma-*` branch, reviewer pass per root rules (schema + shared primitive → mandatory).
