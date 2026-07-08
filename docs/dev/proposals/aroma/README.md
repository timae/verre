# Aroma descriptor layer — proposal

**Status: decisions settled; PR A (backend, moments-first) built on `feature/aroma-core`.** Layer 2 of the tasting model (aroma *descriptors* — "what it smells/tastes like"), on top of the shipped structure-wheel (Layer 1, the intensity axes).

Files here:

- [`aroma-layer.md`](aroma-layer.md) — the Verre integration proposal: taxonomy home, data model, validation chokepoint, API shape, input UI phasing, decision registry (all DECIDED 2026-07-08).
- [`tasting-model-brief.md`](tasting-model-brief.md) — Simon's model brief (both layers, all future categories). Input spec, verbatim. The Layer 1 parts describe the *target* cross-category model; the shipped wine structure-wheel is the current subset.
- [`aroma-taxonomy.json`](aroma-taxonomy.json) — the descriptor tree **v1.0 snapshot** (12 families / 60 subfamilies / 365 leaves / 8 modifiers, per-node allowed-modifier gating), with the ORIGINAL path-encoded leaf ids. **Historical since PR A** — the canonical tree is `packages/core/src/aroma/taxonomy.json` (v1.1: bare-slug leaf ids per aroma-layer.md §3, `pumpkin_seed` fix), CI-guarded by `scripts/check-aroma-taxonomy.mjs`. Content passes edit the core copy, never this one.
