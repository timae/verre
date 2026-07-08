// Aroma descriptor taxonomy — Layer 2 of the tasting model ("what it smells/
// tastes like"), beside the structure-wheel's intensity axes (structureAxes.ts,
// "how strong"). Lives in @verre/core so web + native share one tree; pure data
// + pure functions only (core's platform-purity rule).
//
// The tree (taxonomy.json, canonical since PR A — the docs/dev/proposals/aroma
// copy is a historical snapshot): family (tier1) → subfamily (tier2) → leaf
// (tier3), 12/60/365 in v1.1. A stored selection is `{ a: leafId, m:
// modifierId | null }` — NEVER fused into one token, never a tier-1/2 id.
// Leaf ids are bare label-derived slugs, unique tree-wide via the
// one-leaf-one-home rule; tier membership is derived from tree position HERE,
// never by parsing an id (re-parenting a leaf re-homes history automatically).
// Invariants are CI-enforced by scripts/check-aroma-taxonomy.mjs.
//
// See docs/dev/proposals/aroma/aroma-layer.md (§2 module, §3 id scheme,
// §5 validation).

import taxonomyJson from './taxonomy.json'

export type AromaModifier = {
  id: string
  label: string
  search_aliases?: string[]
}

export type AromaLeaf = {
  id: string
  label: string
  allowed_modifiers?: string[]
  modifier_display?: Record<string, string>
}

export type AromaSubfamily = {
  id: string
  label: string
  allowed_modifiers?: string[]
  leaves: AromaLeaf[]
}

export type AromaFamily = {
  id: string
  label: string
  allowed_modifiers?: string[]
  subfamilies: AromaSubfamily[]
}

// One stored aroma selection. `m: null` is the implicit fresh/default state —
// the "fresh" modifier is never materialised as an id.
export type AromaSelection = { a: string; m: string | null }

// The position of a leaf in the tree, derived at read time. `path` is the
// dotted debug/display form (e.g. "fruity.berry.strawberry") — a DERIVED
// string, never a key.
export type AromaTierPath = {
  family: AromaFamily
  subfamily: AromaSubfamily
  leaf: AromaLeaf
  path: string
}

// The JSON's shape is guaranteed by the CI invariants check; the cast keeps
// tsc from inferring a 365-literal union type for every field.
type TaxonomyFile = {
  schema_version: string
  modifiers: AromaModifier[]
  families: AromaFamily[]
}
const TAXONOMY = taxonomyJson as unknown as TaxonomyFile

export const AROMA_MODIFIERS: readonly AromaModifier[] = TAXONOMY.modifiers
export const AROMA_FAMILIES: readonly AromaFamily[] = TAXONOMY.families

// Max selections per rating (decision registry #3). One unit = one (a, m)
// pair — modifiers and future per-selection flags never count extra. An
// abuse bound, not a UX target; the input UI shows no counter.
export const AROMA_SELECTION_CAP = 30

// ---------------------------------------------------------------------------
// Lookup maps, built once at module load. All helpers below are O(1) hits
// into these — no tree walks, no id parsing, on any hot path.

const MODIFIER_BY_ID = new Map(TAXONOMY.modifiers.map((m) => [m.id, m]))
const LEAF_TIER_PATH = new Map<string, AromaTierPath>()
const LEAF_ALLOWED_MODIFIERS = new Map<string, ReadonlySet<string>>()

for (const family of TAXONOMY.families) {
  for (const subfamily of family.subfamilies) {
    const subAllowed = subfamily.allowed_modifiers ?? family.allowed_modifiers
    for (const leaf of subfamily.leaves) {
      LEAF_TIER_PATH.set(leaf.id, {
        family,
        subfamily,
        leaf,
        path: `${subfamily.id}.${leaf.id}`,
      })
      // allowed_modifiers inherits leaf ← subfamily ← family; a leaf-level
      // list overrides (per the JSON's conventions block).
      LEAF_ALLOWED_MODIFIERS.set(leaf.id, new Set(leaf.allowed_modifiers ?? subAllowed ?? []))
    }
  }
}

export function getAromaModifier(id: string): AromaModifier | undefined {
  return MODIFIER_BY_ID.get(id)
}

export function getAromaLeaf(id: string): AromaLeaf | undefined {
  return LEAF_TIER_PATH.get(id)?.leaf
}

// Tree position for a stored leaf id — the roll-up primitive ("strawberry →
// Fruity"). Undefined for an unknown id (callers on read paths should render
// nothing rather than throw; the write boundary already rejected unknowns).
export function aromaTierPath(id: string): AromaTierPath | undefined {
  return LEAF_TIER_PATH.get(id)
}

// The effective allowed-modifier set for a leaf (inheritance resolved).
export function aromaAllowedModifiers(id: string): ReadonlySet<string> {
  return LEAF_ALLOWED_MODIFIERS.get(id) ?? EMPTY_SET
}
const EMPTY_SET: ReadonlySet<string> = new Set()

// The badge word for a (leaf, modifier) pair — the per-leaf display override
// (strawberry+cooked → "jammy") or the modifier's default label. Data still
// stores the modifier id; this only changes the shown word.
export function aromaModifierDisplay(leafId: string, modifierId: string): string {
  const leaf = getAromaLeaf(leafId)
  return leaf?.modifier_display?.[modifierId] ?? MODIFIER_BY_ID.get(modifierId)?.label ?? modifierId
}

export function isValidAromaSelection(a: string, m: string | null): boolean {
  if (!LEAF_TIER_PATH.has(a)) return false
  if (m === null) return true
  return LEAF_ALLOWED_MODIFIERS.get(a)?.has(m) ?? false
}

// ---------------------------------------------------------------------------
// Write-boundary gate — shape AND taxonomy in one pass (aroma-layer.md §5).
// Server routes apply it via lib/aromas.ts (the chokepoint re-export, flavours
// pattern); native uses it directly for optimistic state. Policy differs from
// gateAndFillFlavors deliberately: there is NO innocent way to send an unknown
// leaf or a disallowed modifier (no style-race equivalent), so everything
// rejects loudly — no silent stripping. Dedupe is on the (a, m) pair: `fig`
// and `fig + dried` are two distinct selections.

type GatedAromas =
  | { value: AromaSelection[]; error?: undefined }
  | { value?: undefined; error: string }

export function gateAromaSelections(input: unknown): GatedAromas {
  // Only a genuinely ABSENT field is the empty no-op — an explicit null is a
  // malformed payload (a client serialising undefined→null would otherwise
  // silently CLEAR stored aromas under the route's present-replaces rule).
  if (input === undefined) return { value: [] }
  if (!Array.isArray(input)) return { error: 'aromas must be an array' }
  if (input.length > AROMA_SELECTION_CAP) return { error: `too many aromas (max ${AROMA_SELECTION_CAP})` }
  const out: AromaSelection[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'each aroma must be an object' }
    const { a, m } = raw as { a?: unknown; m?: unknown }
    if (typeof a !== 'string') return { error: 'aroma id required' }
    const mod = m === undefined || m === null ? null : m
    if (mod !== null && typeof mod !== 'string') return { error: 'aroma modifier must be a string or null' }
    // Truncate echoed ids — real slugs are short; don't reflect an
    // attacker's multi-MB string back in the 400 body.
    if (!LEAF_TIER_PATH.has(a)) return { error: `unknown aroma id: ${a.slice(0, 64)}` }
    if (mod !== null && !(LEAF_ALLOWED_MODIFIERS.get(a)?.has(mod) ?? false)) {
      return { error: `modifier not allowed for this aroma: ${a.slice(0, 64)}+${mod.slice(0, 64)}` }
    }
    const key = JSON.stringify([a, mod])
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ a, m: mod })
  }
  return { value: out }
}
