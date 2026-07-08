// Server-side aroma write boundary — the chokepoint every route that accepts
// aroma selections goes through (mirrors lib/flavours.ts for structure axes).
// The gate itself is platform-neutral and lives in @verre/core
// (gateAromaSelections: shape + cap + taxonomy + per-leaf modifier gating +
// (a,m)-pair dedupe, rejecting loudly — see aroma/taxonomy.ts for the
// no-silent-stripping rationale). This module re-exports it under the
// server-facing name so route code reads like the flavours pipeline:
//
//   const ar = gateAromas(body.aromas)
//   if (ar.error) return 400
//   // body.aromas === undefined → ar.value = [] — but routes should treat
//   // an OMITTED field as "preserve existing" and only store ar.value when
//   // the field was present (aroma-layer.md §4: present-replaces /
//   // omitted-preserves, so a client that predates aromas can't wipe them).
//   // An explicit `aromas: null` is a 400 ('aromas must be an array'), NOT a
//   // clear — a client serialising undefined→null must never silently wipe.
//
// See docs/dev/proposals/aroma/aroma-layer.md §5.

export { gateAromaSelections as gateAromas, AROMA_SELECTION_CAP, type AromaSelection } from '@verre/core'
