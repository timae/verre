// Aroma-taxonomy invariants gate — fails the build if the canonical tree
// (packages/core/src/aroma/taxonomy.json) violates the structural rules the
// runtime and the stored data depend on. The taxonomy is content-edited by
// hand (content passes add leaves/modifiers over time); this makes the
// invariants safe-by-construction instead of safe-by-review.
//
// Invariants (docs/dev/proposals/aroma/aroma-layer.md §2/§3):
//   1. Leaf ids are bare label-derived slugs (no dots), unique tree-wide.
//      Selections may reference a node at ANY tier (any-tier ruling,
//      2026-07-08), so the persisted-id namespace spans all three — kept
//      unambiguous by construction: leaf slugs never contain a dot,
//      subfamily ids always do, and leaf slugs must stay DISJOINT from
//      family slugs (checked below).
//   2. Leaf labels are unique tree-wide (one leaf, one home).
//   3. Family ids are bare slugs; subfamily ids are `family.subfamily`
//      qualified (bare subfamily slugs collide: stone/cured/dairy).
//   4. Every allowed_modifiers / modifier_display reference resolves to a
//      declared modifier id; modifier ids are unique.
//   5. Every leaf resolves a non-empty... no — an EFFECTIVE allowed set may
//      be empty, but it must be DECLARED somewhere on the leaf→subfamily→
//      family chain (an undeclared chain means someone forgot the gating).
//   6. A modifier_display override must be for a modifier actually allowed
//      on that leaf (a display word for an unattachable modifier is dead
//      data — usually a sign the allowed list lost an entry).
//
// Dependency-free Node (same pattern as check-mobile-design-tokens.mjs);
// runtime counterpart: the maps in packages/core/src/aroma/taxonomy.ts.

import { readFileSync } from 'node:fs'

const FILE = 'packages/core/src/aroma/taxonomy.json'
const tax = JSON.parse(readFileSync(FILE, 'utf8'))
const errors = []

const SLUG = /^[a-z0-9_]+$/

const modifierIds = new Set()
for (const m of tax.modifiers ?? []) {
  if (!SLUG.test(m.id)) errors.push(`modifier id not a slug: ${m.id}`)
  if (modifierIds.has(m.id)) errors.push(`duplicate modifier id: ${m.id}`)
  modifierIds.add(m.id)
}

// Strings are iterable, so a malformed `"allowed_modifiers": "dried"` (or
// `"search_aliases": "abc"`) would iterate per-CHARACTER instead of failing —
// every optional-array field must be shape-checked before iteration. `asArray`
// is that guard: undefined stays undefined, a real array passes through,
// anything else records an error and yields [] so downstream checks don't
// cascade on garbage.
const asArray = (value, where, field) => {
  if (value === undefined || Array.isArray(value)) return value
  errors.push(`${where}: ${field} must be an array`)
  return []
}

const checkRefs = (list, where) => {
  for (const id of asArray(list, where, 'allowed_modifiers') ?? []) {
    if (!modifierIds.has(id)) errors.push(`${where}: unknown modifier "${id}"`)
  }
}

const leafIds = new Set()
const leafLabels = new Set()
const familyIds = new Set()
const subfamilyIds = new Set()

for (const family of tax.families ?? []) {
  if (!SLUG.test(family.id)) errors.push(`family id not a slug: ${family.id}`)
  if (familyIds.has(family.id)) errors.push(`duplicate family id: ${family.id}`)
  familyIds.add(family.id)
  checkRefs(family.allowed_modifiers, family.id)

  for (const sub of family.subfamilies ?? []) {
    const parts = sub.id.split('.')
    if (parts.length !== 2 || parts[0] !== family.id || !SLUG.test(parts[1])) {
      errors.push(`subfamily id must be "${family.id}.<slug>": ${sub.id}`)
    }
    if (subfamilyIds.has(sub.id)) errors.push(`duplicate subfamily id: ${sub.id}`)
    subfamilyIds.add(sub.id)
    checkRefs(sub.allowed_modifiers, sub.id)

    for (const leaf of sub.leaves ?? []) {
      if (!SLUG.test(leaf.id)) errors.push(`leaf id not a bare slug: ${leaf.id}`)
      if (leafIds.has(leaf.id)) errors.push(`duplicate leaf id: ${leaf.id}`)
      leafIds.add(leaf.id)
      const label = (leaf.label ?? '').toLowerCase()
      if (!label) errors.push(`leaf without label: ${leaf.id}`)
      if (leafLabels.has(label)) errors.push(`duplicate leaf label (one leaf, one home): "${leaf.label}"`)
      leafLabels.add(label)
      checkRefs(leaf.allowed_modifiers, leaf.id)

      const effective = leaf.allowed_modifiers ?? sub.allowed_modifiers ?? family.allowed_modifiers
      if (effective === undefined) {
        errors.push(`no allowed_modifiers anywhere on chain for leaf: ${leaf.id}`)
      }
      const display = leaf.modifier_display
      if (display !== undefined && (typeof display !== 'object' || display === null || Array.isArray(display))) {
        errors.push(`${leaf.id}: modifier_display must be an object`)
      }
      for (const modId of Object.keys((typeof display === 'object' && display) || {})) {
        if (!modifierIds.has(modId)) {
          errors.push(`${leaf.id}: modifier_display for unknown modifier "${modId}"`)
        } else if (Array.isArray(effective) && !effective.includes(modId)) {
          errors.push(`${leaf.id}: modifier_display for disallowed modifier "${modId}"`)
        }
      }
    }
  }
}

// Leaf search_aliases (input-time vocabulary — cassis→blackcurrant): each
// alias must be a non-empty lowercase-ish string, must NOT equal any node
// label at any tier (an alias may never shadow a real node), and must be
// unique across all leaves (one alias, one destination).
{
  // Shadow set spans node labels AND modifier vocabulary (labels + the
  // modifiers' own search_aliases) — a leaf alias equal to "dried" or
  // "jammy" would collide in PR B's flat search index.
  const allLabels = new Set()
  for (const m of tax.modifiers ?? []) {
    allLabels.add((m.label ?? '').toLowerCase())
    for (const a of asArray(m.search_aliases, m.id, 'search_aliases') ?? []) allLabels.add(String(a).toLowerCase())
  }
  for (const family of tax.families ?? []) {
    allLabels.add((family.label ?? '').toLowerCase())
    for (const sub of family.subfamilies ?? []) {
      allLabels.add((sub.label ?? '').toLowerCase())
      for (const leaf of sub.leaves ?? []) allLabels.add((leaf.label ?? '').toLowerCase())
    }
  }
  const seenAliases = new Map()
  for (const family of tax.families ?? []) {
    for (const sub of family.subfamilies ?? []) {
      for (const leaf of sub.leaves ?? []) {
        for (const alias of asArray(leaf.search_aliases, leaf.id, 'search_aliases') ?? []) {
          if (typeof alias !== 'string' || !alias.trim() || alias !== alias.trim() || alias.length > 40 || alias !== alias.toLowerCase()) {
            errors.push(`${leaf.id}: bad search alias ${JSON.stringify(alias)} (non-empty trimmed lowercase string ≤40 chars)`)
            continue
          }
          if (allLabels.has(alias)) errors.push(`${leaf.id}: search alias "${alias}" shadows a node label or modifier word`)
          if (seenAliases.has(alias)) errors.push(`duplicate search alias "${alias}" on ${seenAliases.get(alias)} and ${leaf.id}`)
          seenAliases.set(alias, leaf.id)
        }
      }
    }
  }
}

// promoted_from mappings (gate canonicalization, decision #8): the composite
// must resolve — base is a real leaf, modifier is real and legal on the base —
// and the promoted leaf itself must NOT allow that modifier (else the
// redundant pair the promotion exists to eliminate comes back).
for (const family of tax.families ?? []) {
  for (const sub of family.subfamilies ?? []) {
    const subAllowed = sub.allowed_modifiers ?? family.allowed_modifiers
    for (const leaf of sub.leaves ?? []) {
      const pf = leaf.promoted_from
      if (pf === undefined) continue
      if (typeof pf?.a !== 'string' || typeof pf?.m !== 'string') {
        errors.push(`${leaf.id}: promoted_from must be {a: string, m: string}`)
        continue
      }
      if (!leafIds.has(pf.a)) errors.push(`${leaf.id}: promoted_from base is not a leaf: ${pf.a}`)
      if (!modifierIds.has(pf.m)) errors.push(`${leaf.id}: promoted_from unknown modifier: ${pf.m}`)
      const own = asArray(leaf.allowed_modifiers ?? subAllowed, leaf.id, 'allowed_modifiers') ?? []
      if (own.includes(pf.m)) errors.push(`${leaf.id}: promoted leaf must not allow its own promoted_from modifier "${pf.m}"`)
    }
  }
}
// Second pass for base-legality (needs the full tree walked to resolve the
// base leaf's effective set — recompute it here, dependency-free).
{
  const effectiveByLeaf = new Map()
  for (const family of tax.families ?? []) {
    for (const sub of family.subfamilies ?? []) {
      const subAllowed = sub.allowed_modifiers ?? family.allowed_modifiers
      for (const leaf of sub.leaves ?? []) {
        effectiveByLeaf.set(leaf.id, asArray(leaf.allowed_modifiers ?? subAllowed, leaf.id, 'allowed_modifiers') ?? [])
      }
    }
  }
  for (const family of tax.families ?? []) {
    for (const sub of family.subfamilies ?? []) {
      for (const leaf of sub.leaves ?? []) {
        const pf = leaf.promoted_from
        if (!pf || typeof pf.a !== 'string' || typeof pf.m !== 'string') continue
        const baseSet = effectiveByLeaf.get(pf.a)
        if (baseSet && !baseSet.includes(pf.m)) {
          errors.push(`${leaf.id}: promoted_from composite ${pf.a}+${pf.m} is not legal on the base (dead canonicalization)`)
        }
      }
    }
  }
}

// Any-tier namespace disjointness: a stored id resolves by exact match across
// all three tiers, which is only unambiguous while no leaf slug equals a
// family slug (dots already separate subfamilies). True today; a content pass
// adding e.g. a leaf literally named "spice" would silently shadow the family.
for (const id of leafIds) {
  if (familyIds.has(id)) errors.push(`leaf slug collides with family slug: ${id}`)
}

// Non-degeneracy floors. taxonomy.ts casts the JSON to its types on the
// strength of THIS script ("shape is guaranteed by the CI invariants check"),
// so a renamed top-level key or a truncated file must fail HERE, not at
// module load on both platforms. Content passes only ever grow the tree;
// lower a floor consciously (it means a breaking removal), never delete it.
if ((tax.modifiers ?? []).length < 8) errors.push(`modifiers collapsed: ${(tax.modifiers ?? []).length} < 8 — top-level key renamed/truncated?`)
if (familyIds.size < 12) errors.push(`families collapsed: ${familyIds.size} < 12 — top-level key renamed/truncated?`)
if (leafIds.size < 365) errors.push(`leaves collapsed: ${leafIds.size} < 365 — truncation? (content passes only grow)`)

if (errors.length) {
  console.error(`✖ ${FILE} violates ${errors.length} taxonomy invariant(s):\n`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`✓ aroma taxonomy OK — ${leafIds.size} leaves, ${familyIds.size} families, ${modifierIds.size} modifiers`)
