# Tasting Model — Implementation Brief

A tasting-impression app spanning wine, coffee, beer, tea, cheese, chocolate, spirits, food. Each impression has two layers: a **structure** rating (intensity axes) and an **aroma** description (hierarchical descriptors + modifiers). The purpose is **comparison and conversation**, not objective measurement — the *spread* between tasters is the signal, not noise.

Companion file: `aroma-taxonomy.json` (machine-readable tier-2/tier-3 leaf tree with per-node allowed-modifiers).

---

## Core philosophy (applies to both layers)

- **Style-relative.** Ratings are read within the category. A coffee at "5 Sweetness" is not as sweet as cola — the category label plus the human reading it supply the context. No absolute cross-category scale.
- **Spread is the content.** For multi-person tastings, disagreement is the interesting output, not error to be corrected.
- **Perception over origin.** Descriptors are placed/named by what they *smell or taste like*, not by the process or chemistry that produced them (e.g. vanillin from oak smells like vanilla, so vanilla-notes sit in Sweet — placement follows perception, not source).
- **Naming: broad category word for groups, specific/evocative words for leaves.** Plain and second-language-safe (e.g. "smell/taste" not "nose/palate", "Bubbles" not "effervescence").

---

## LAYER 1 — STRUCTURE

Intensity axes rated per impression on one fixed 0–5 ladder.

### Scale ladder (identical for every axis, every category)
`0 None · 1 Faint · 2 Light · 3 Medium · 4 Strong · 5 Intense`

### No universal core
There is **no fixed set of axes across all categories** (e.g. Sweetness is meaningless for cheese). Instead, **each category defines its own baseline set** drawn from the master axis list, plus **type additions inside the category**.

### Master structure-axis list (13)
`Flavour · Body · Tannin · Finish · Sweetness · Acidity · Bitterness · Umami · Saltiness · Spiciness · Bubbles · Funk · Aroma`

- **Warmth (alcohol heat) is deliberately excluded.** Strength is already captured as ABV metadata, warmth-perception tracks ABV closely enough to be largely redundant, and it is hard to rate reliably even for experienced tasters — so it fails the "produces meaningful spread" test.
- **Spiciness = chili / trigeminal heat** (capsaicin), a genuinely distinct sensation, available to categories where it applies (food, hot sauces, spiced drinks, chai, spiced chocolate). It is **not** aliased to anything.

- **Aroma** = intensity of the smell; **Flavour** = intensity of the in-mouth perception. Both are *intensity* axes ("how strong"). The aroma **descriptor** layer (Layer 2) is a separate feature ("what it is").
- **Funk** as a structure axis = overall funk intensity; **Funky** as an aroma family (Layer 2) = which funky notes. Intended double-duty across layers, not a duplication to collapse (same as Aroma/Flavour).

### Aliases (same axis, category-appropriate label)
One axis slot, shown under a different name depending on the category/impression:
- **Body ↔ Texture**
- **Tannin ↔ Astringency**

*(These are genuine same-percept aliases. Warmth and Spiciness are not aliased — Warmth is removed entirely, and Spiciness stands as its own axis.)*

### Category hierarchy + per-category baselines
Categories are grouped under two top-level parents, **Drink** and **Food** (a grouping/navigation layer; it does not change the axes). Each category shows a fixed subset of the 13 master axes. The **Tannin↔Astringency** alias displays the category-appropriate word (Tannin for wine; Astringency for tea/coffee/chocolate); the two catch-alls, which span both, show "Tannin / Astringency". More categories (kombucha, cider, mead, soft drinks, etc.) will be promoted later; for now they use the relevant catch-all.

**DRINK**
- **Wine:** Aroma · Flavour · Body · Sweetness · Acidity · Tannin · Funk · Finish  *(sparkling adds Bubbles)*
- **Beer:** Aroma · Flavour · Body · Sweetness · Acidity · Bitterness · Bubbles · Funk · Finish
- **Coffee:** Aroma · Flavour · Body · Sweetness · Acidity · Bitterness · Astringency · Finish
- **Tea:** Aroma · Flavour · Body · Sweetness · Bitterness · Astringency · Finish
- **Spirits:** Aroma · Flavour · Body · Sweetness · Bitterness · Saltiness · Funk · Finish
- **Cocktails:** Aroma · Flavour · Body · Sweetness · Acidity · Bitterness · Tannin · Umami · Saltiness · Spiciness · Bubbles · Funk · Finish  *(all 13 — a cocktail can draw on anything, incl. tannic wine/tea/amaro bases)*
- **Drink (catch-all):** all 13 axes

**FOOD**
- **Cheese:** Aroma · Flavour · Body · Saltiness · Umami · Funk · Finish
- **Chocolate:** Aroma · Flavour · Body · Sweetness · Bitterness · Acidity · Astringency · Finish
- **Food (catch-all):** all 13 axes

Body displays as **Texture** for solids (Body↔Texture alias). Each category's axes are its baseline; within-category sub-types may add axes (e.g. sparkling wine adds Bubbles).

### Alcohol
Not a rated axis. The user sets **ABV as a value**, or picks **"low alcohol"** / **"no alcohol"** as input variants.

### Structural notes
- A baseline axis that is perceptually absent for a given impression just sits at **None** — a valid data point. Axes are resolved from the category/type, not hidden dynamically on metadata.
- Multi-person aggregation shows the spread across tasters plus a central value. (Display handled separately.)

---

## LAYER 2 — AROMA

One **universal descriptor tree**, three tiers (family → subfamily → leaf). Faults are included as **neutral descriptors** — named by what they smell like, never flagged good/bad; context + spread decide.

### Tier-1 families (12)
`Fruity · Floral · Vegetal · Spice · Sweet · Kernel · Fire · Woody · Mineral · Savory · Funky · Chemical`

- **Kernel** = nuts, seeds, cocoa, and grain/cereal (a kernel is a nut, seed, grain and bean — it unifies the dry, mild, biscuity-nutty cluster). Grain/cereal is a subfamily here (malt, barley, wheat, rye, oat, bran, flour, husk, etc.), not its own family; raw grain isn't "green" so it does not belong in Vegetal.
- **Fire** = notes whose identity *is* heat transformation: roast, toast, smoke, char (coffee, toast, biscuit, woodsmoke, peat, tar). Named "Fire" rather than "Roasted" so it reads across all categories and does not clash with the roasted/smoked/burnt *modifiers*.

Full tier-2/tier-3 leaves (~365, machine-readable, each with per-node allowed-modifiers and optional per-leaf `modifier_display` overrides): see `aroma-taxonomy.json`. **The leaf list is a strong v1 but not exhaustive** — deeper coverage (hop varietals, peat gradations, cheese rinds, regional notes) can still be added.

### Rules
- **One leaf, one home.** Each descriptor lives in exactly one place (search and matching depend on it). Where a percept genuinely splits, use *different leaf words* for the two faces (flint → Mineral, struck-match → Chemical).
- **Vegetal = fresh/raw green plant matter only**, plus a small **Cured/brined veg** subfamily (olive, caper, pickle) for preserved-but-still-vegetal notes. Cooked/dried plant notes route via modifier on the fresh base.
- **Sweet = aromatic sweetness** (caramel, vanilla, honey). Caramel is its **own base** (a distinct percept), not "burnt sugar"; burnt sugar = sugar + burnt modifier.
- **Fire = notes whose identity *is* the roast/smoke/char** (coffee, toast, woodsmoke, tar) — distinct from the roasted/smoked/burnt *modifiers*.
- **Tobacco** is a tier-2 under Woody (cigar, cigarette, pipe tobacco); unlit is the base state, lit/smoked reached via the smoked modifier.

### Dairy placement (resolved)
Dairy is a fermentation continuum that crosses families; placed by perception:
- **Sweet:** brown butter, buttercream, custard, condensed milk, dulce de leche, caramelized dairy
- **Savory:** all cheese, cream cheese, plain / cultured / salted butter, ghee, yogurt, kefir, sour milk
- **Funky:** blue cheese only (the mould percept is Funky, not Savory)
- No "sour" modifier — cultured/soured dairy sits in Savory as plain leaves (not enough other use cases to justify a modifier).

---

## MODIFIERS

Orthogonal **state-transformations** applied to a base descriptor. The tree stores base descriptors in **fresh/default** state; transformed versions are `base + modifier`, not separate leaves.

### The set
`fresh (default, implicit — never shown/selected) · (over)ripe · dried · cooked · candied · roasted · smoked · burnt · pickled`

Search aliases (resolve to the modifier, and supply the natural display word per leaf): cooked → stewed, jammy · roasted → toasted, grilled · burnt → charred · pickled → brined.

### Rules
1. **Promotion rule.** If `base + modifier` becomes a *widely-used, distinct product/percept*, it earns its own named leaf. Accepted: raisin, prune. Composites stay composite: candied orange, stewed plum.
2. **Gating is per-node, not just per-family.** Some modifiers attach only to specific leaves (candied → citrus peel, cherry, ginger, chestnut, crystallised violet — scattered across families). Allowed-modifier lists live on the taxonomy node.
3. **Two words, two mechanisms.** `smoked`/`burnt` (modifiers) transform a base in another family (smoked chili → Spice; burnt sugar → Sweet). `Smoke`/`Char` (Fire leaves) are standalone identity percepts. They coexist.
4. **Modifiers inherit upward.** `candied + walnut` is also aggregatable as `candied + Nut` and `candied + [tier-1]`. The modifier is an independent aggregation axis anchored to a base — you can slice by modifier across bases.

*(No family-crossing rule. An overripe banana is simply banana + overripe — navigate Fruit → banana → overripe. Modifiers never re-file a note into another family.)*

---

## DATA MODEL

- **Taxonomy is a static, known hierarchy.** It owns tier relationships (leaf → subfamily → family), leaf metadata, and the **allowed-modifiers list per node**.
- **An aroma selection stores only `(aroma_id, modifier_id)`** — two separate fields. **Never fuse** into a single token (`"dried-fig"`); fusing would destroy modifier-axis aggregation.
- **All tier paths are derived from the taxonomy on demand**, not persisted on the impression. If the taxonomy is manually re-parented later, historical impressions inherit the new structure automatically. (Re-parenting is a manual taxonomy edit only — nothing automatic.)
- **Structure:** per-impression, per-axis integer 0–5; axis set resolved from category + type. Alcohol as ABV value or low/no-alcohol flag.

### Comparison / roll-up (dynamic, at query time — not a fixed level)
The tier+modifier structure allows choosing grain *per comparison* to find the agreement point:
- Strip modifiers (overripe-mango + mango → "mango").
- Climb tiers (mango + lychee → "Tropical" → "Fruity").
- Or hold a modifier and slice across bases.
High granularity is therefore safe: precision is stored, and comparison collapses to whatever level shows meaningful overlap.

---

## INPUT MODEL

- **Manual entry (current):** a **modifier bar** (location up to design) plus tier-by-tier browse of the aroma tree; select a modifier and an aroma, add the pair. Structure axes rated on the 0–5 ladder.
- **Search:** typing e.g. "dried fig" resolves directly to `fig + dried`. Search makes a deep long tail an asset (rare deep leaves cost nothing to browse and pay off on exact search).
- **Voice (future, not current):** speak an impression; maps free speech to overall score (if stated), structure axes, and aroma+modifier pairs, with a visible confirmation step so the user can correct or pick a similar option, and the correction stream feeding taxonomy QA.

---

## USER PROFILE — "Palate Fingerprint" (proposed)

Aggregate a user's tendencies across their tastings — which aroma families and structure leanings they gravitate to, and how far they typically diverge from consensus. Cross-category aggregation works via **preference tendencies** (e.g. "leans high-acid, bitter-tolerant"), on dimensions that are genuinely the same percept everywhere (acidity, bitterness, sweetness).

- **Heat = chili only.** With Warmth removed, the only heat dimension is **Spiciness** (chili/trigeminal), aggregated wherever it applies (mostly food and spiced items). There is no alcohol-warmth heat trait, so no food/drink heat split is needed.

---

## OPEN / REMAINING WORK

1. **Content pass (main work):** extend the aroma tree to fuller leaf depth (still missing many notes), and author the **allowed-modifiers list per node** (per-leaf gating, e.g. candied).
2. **Within-category sub-type additions** — the base categories are finalized; specific sub-types (e.g. sparkling wine → +Bubbles) can add axes as they come up.
3. **Blue cheese** kept as the single Funky cheese exception — confirm it stays split from Savory or gets folded for simplicity.
