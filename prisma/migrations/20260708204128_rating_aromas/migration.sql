-- Aroma descriptor layer (Layer 2) — per-rating aroma selections.
-- Array of {a: leafId, m: modifierId|null} pairs against the @verre/core
-- taxonomy; gated at the write boundary (lib/aromas.ts gateAromas, cap 30).
-- '[]' (the default, backfilled onto every existing row here) is the empty
-- signal the engagement-deletion cascade matches beside flavors = '{}'.
-- Additive, non-destructive. See docs/dev/proposals/aroma/aroma-layer.md §4.

-- AlterTable
ALTER TABLE "ratings" ADD COLUMN     "aromas" JSONB NOT NULL DEFAULT '[]';
