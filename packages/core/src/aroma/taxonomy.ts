// Aroma descriptor taxonomy — Layer 2 of the tasting model ("what it smells/
// tastes like"), beside the structure-wheel's intensity axes (structureAxes.ts,
// "how strong"). Lives in @verre/core so web + native share one tree; pure data
// + pure functions only (core's platform-purity rule).
//
// The tree (taxonomy.json, canonical since PR A — the docs/dev/proposals/aroma
// copy is a historical snapshot): family (tier1) → subfamily (tier2) → leaf
// (tier3), 12/60/365 in v1.1. A stored selection is `{ a: nodeId, m:
// modifierId | null }` — NEVER fused into one token. The node may sit at ANY
// tier (Simon's any-tier ruling, 2026-07-08): a lazy/unsure "berries" or
// "fruity" is honest coarse data, better than forced false precision. The id
// namespace keeps the three tiers unambiguous: leaf ids are bare label-derived
// slugs (unique tree-wide via one-leaf-one-home, never containing a dot),
// subfamily ids are dot-qualified (`fruity.berry`), and family slugs are
// CI-enforced disjoint from leaf slugs. Tier membership is derived from tree
// position HERE, never by parsing an id (re-parenting a leaf re-homes history
// automatically). Invariants are CI-enforced by
// scripts/check-aroma-taxonomy.mjs.
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
  // Present on PROMOTED leaves (raisin, prune): the (base, modifier) composite
  // this leaf is the canonical encoding of. The gate rewrites the composite to
  // this leaf so one percept has one stored form (decision #8).
  promoted_from?: { a: string; m: string }
  // Alternative search WORDS for this leaf (cassis, sultana, pyrazine) —
  // input-time vocabulary only, consumed by PR B's searchIndex; never stored,
  // never gated. CI enforces no-label-shadowing + tree-wide uniqueness.
  search_aliases?: string[]
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

// One stored aroma selection. `a` is a taxonomy node id at any tier (leaf
// "strawberry", subfamily "fruity.berry", family "fruity" — the stored grain
// encodes the taster's confidence). `m: null` is the implicit fresh/default
// state — the "fresh" modifier is never materialised as an id. `d` marks the
// selection DOMINANT (the note that led the impression, Simon's ruling
// 2026-07-08): canonical/stored form carries it only when true (absent =
// not dominant), it never affects the (a, m) dedupe identity or the cap
// unit, and the display word is UI copy (field name stays `d`). Typed as the
// literal `true` so the only-when-true rule is compile-enforced on anything
// CONSTRUCTING selections; wire input still tolerates `d: false` (the gate
// normalizes it away).
export type AromaSelection = { a: string; m: string | null; d?: true }

// Any selectable taxonomy node, tier-tagged. `subfamily`/`leaf` are present
// per tier; `path` is the dotted debug/display form — a DERIVED string,
// never a key.
export type AromaNode = {
  tier: 'family' | 'subfamily' | 'leaf'
  family: AromaFamily
  subfamily?: AromaSubfamily
  leaf?: AromaLeaf
  label: string
  path: string
}

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
// Every selectable node (all three tiers) + its effective allowed-modifier
// set. The gate and the read helpers below are lookups into these.
const NODE_BY_ID = new Map<string, AromaNode>()
const NODE_ALLOWED_MODIFIERS = new Map<string, ReadonlySet<string>>()
// (base, modifier) composite → the promoted leaf that IS that percept
// (grape+dried → raisin). Keyed like the gate's dedupe key.
const PROMOTED_BY_PAIR = new Map<string, string>()

for (const family of TAXONOMY.families) {
  // Coarse-node selectability follows the brief's "modifiers inherit
  // UPWARD" rule: a subfamily/family accepts the UNION of its descendants'
  // effective sets — a stored `fruity + ripe` is exactly what a valid
  // `strawberry + ripe` collapses to, so any valid leaf state must stay
  // valid at coarse grain, and genuine nonsense ("pickled Mineral") stays
  // rejected automatically wherever NO descendant allows the modifier.
  // Nothing to hand-author at coarse tiers; content passes edit leaves/
  // subfamilies and the unions follow.
  const familyUnion = new Set<string>()
  NODE_BY_ID.set(family.id, { tier: 'family', family, label: family.label, path: family.id })
  for (const subfamily of family.subfamilies) {
    // Declared lists still inherit DOWNWARD to leaves (leaf ← subfamily ←
    // family; a declared list at a lower tier overrides, per the JSON's
    // conventions block) — the leaf's effective set stays the write truth.
    const subAllowed = subfamily.allowed_modifiers ?? family.allowed_modifiers
    const subUnion = new Set<string>()
    NODE_BY_ID.set(subfamily.id, { tier: 'subfamily', family, subfamily, label: subfamily.label, path: subfamily.id })
    for (const leaf of subfamily.leaves) {
      const path = `${subfamily.id}.${leaf.id}`
      const effective = new Set(leaf.allowed_modifiers ?? subAllowed ?? [])
      LEAF_TIER_PATH.set(leaf.id, { family, subfamily, leaf, path })
      NODE_BY_ID.set(leaf.id, { tier: 'leaf', family, subfamily, leaf, label: leaf.label, path })
      NODE_ALLOWED_MODIFIERS.set(leaf.id, effective)
      if (leaf.promoted_from) {
        PROMOTED_BY_PAIR.set(JSON.stringify([leaf.promoted_from.a, leaf.promoted_from.m]), leaf.id)
      }
      for (const modId of effective) {
        subUnion.add(modId)
        familyUnion.add(modId)
      }
    }
    NODE_ALLOWED_MODIFIERS.set(subfamily.id, subUnion)
  }
  NODE_ALLOWED_MODIFIERS.set(family.id, familyUnion)
}

export function getAromaModifier(id: string): AromaModifier | undefined {
  return MODIFIER_BY_ID.get(id)
}

export function getAromaLeaf(id: string): AromaLeaf | undefined {
  return LEAF_TIER_PATH.get(id)?.leaf
}

// Tree position for a stored LEAF id — the roll-up primitive ("strawberry →
// Fruity"). Undefined for an unknown or non-leaf id; for any-tier reads use
// getAromaNode. (Callers on read paths should render nothing rather than
// throw; the write boundary already rejected unknowns.)
export function aromaTierPath(id: string): AromaTierPath | undefined {
  return LEAF_TIER_PATH.get(id)
}

// Any-tier resolver for a stored node id — tier tag + family (for colour/
// roll-up) + label. The read primitive for selections at coarse grain
// ("berries" → {tier:'subfamily', family: Fruity, label:'Berry'}).
export function getAromaNode(id: string): AromaNode | undefined {
  return NODE_BY_ID.get(id)
}

// The effective allowed-modifier set for any node. Leaves: declared-list
// inheritance (leaf ← subfamily ← family). Subfamilies/families: the UNION
// of their descendants' effective sets (upward inheritance — see the map
// builder above).
export function aromaAllowedModifiers(id: string): ReadonlySet<string> {
  return NODE_ALLOWED_MODIFIERS.get(id) ?? EMPTY_SET
}
const EMPTY_SET: ReadonlySet<string> = new Set()

// The badge word for a (node, modifier) pair — the per-leaf display override
// (strawberry+cooked → "jammy") or the modifier's default label. Non-leaf
// nodes have no overrides, so they fall through to the default. Data still
// stores the modifier id; this only changes the shown word.
export function aromaModifierDisplay(leafId: string, modifierId: string): string {
  const leaf = getAromaLeaf(leafId)
  return leaf?.modifier_display?.[modifierId] ?? MODIFIER_BY_ID.get(modifierId)?.label ?? modifierId
}

export function isValidAromaSelection(a: string, m: string | null): boolean {
  if (!NODE_BY_ID.has(a)) return false
  if (m === null) return true
  return NODE_ALLOWED_MODIFIERS.get(a)?.has(m) ?? false
}

// ---------------------------------------------------------------------------
// Write-boundary gate — shape AND taxonomy in one pass (aroma-layer.md §5).
// Server routes apply it via lib/aromas.ts (the chokepoint re-export, flavours
// pattern); native uses it directly for optimistic state. `a` may be a node
// at ANY tier, gated by that node's own effective modifier set. Policy differs
// from gateAndFillFlavors deliberately: there is NO innocent way to send an
// unknown node or a disallowed modifier (no style-race equivalent), so
// everything rejects loudly — no silent stripping. Dedupe is on the (a, m)
// pair: `fig` and `fig + dried` are two distinct selections — and so are
// `fruity.berry` and `strawberry` (no auto-subsumption: "berries, and
// specifically strawberry" is a real perception).

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
  const byKey = new Map<string, AromaSelection>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'each aroma must be an object' }
    const { a, m, d } = raw as { a?: unknown; m?: unknown; d?: unknown }
    if (typeof a !== 'string') return { error: 'aroma id required' }
    const mod = m === undefined || m === null ? null : m
    if (mod !== null && typeof mod !== 'string') return { error: 'aroma modifier must be a string or null' }
    // `d: null` deliberately 400s (unlike `m`, where null IS the fresh state):
    // JSON.stringify drops undefined properties, so no honest client emits a
    // null here — same malformed-payload stance as `aromas: null` above.
    if (d !== undefined && typeof d !== 'boolean') return { error: 'aroma dominant flag must be a boolean' }
    // Truncate echoed ids — real slugs are short; don't reflect an
    // attacker's multi-MB string back in the 400 body.
    if (!NODE_BY_ID.has(a)) return { error: `unknown aroma id: ${a.slice(0, 64)}` }
    if (mod !== null && !(NODE_ALLOWED_MODIFIERS.get(a)?.has(mod) ?? false)) {
      return { error: `modifier not allowed for this aroma: ${a.slice(0, 64)}+${mod.slice(0, 64)}` }
    }
    // Promoted-percept canonicalization (decision #8): a composite that a
    // promoted leaf exists for is rewritten to that leaf (grape+dried →
    // raisin), so one percept has exactly one stored encoding. Runs AFTER
    // validity (the composite must be legal on the base) and BEFORE dedupe
    // (raisin and grape+dried in one payload merge to one entry).
    let canonA = a
    let canonM = mod
    const promoted = PROMOTED_BY_PAIR.get(JSON.stringify([a, mod]))
    if (promoted) {
      canonA = promoted
      canonM = null
    }
    // Dedupe stays keyed on (a, m) — `d` is not identity. If duplicates
    // disagree on dominance, dominant wins (an any-true upgrade loses no
    // signal either ordering). Canonical form carries `d` only when true.
    const key = JSON.stringify([canonA, canonM])
    const existing = byKey.get(key)
    if (existing) {
      if (d === true) existing.d = true
      continue
    }
    const sel: AromaSelection = d === true ? { a: canonA, m: canonM, d: true } : { a: canonA, m: canonM }
    byKey.set(key, sel)
    out.push(sel)
  }
  return { value: out }
}
