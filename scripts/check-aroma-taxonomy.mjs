// Aroma-taxonomy invariants gate — fails the build if the canonical tree
// (packages/core/src/aroma/taxonomy.json) violates the structural rules the
// runtime and the stored data depend on. The taxonomy is content-edited by
// hand (content passes add leaves/modifiers over time); this makes the
// invariants safe-by-construction instead of safe-by-review.
//
// Invariants (docs/dev/proposals/aroma/aroma-layer.md §2/§3):
//   1. Leaf ids are bare label-derived slugs (no dots), unique tree-wide —
//      they are the ONLY ids persisted in user data.
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

const checkRefs = (list, where) => {
  for (const id of list ?? []) {
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
      for (const modId of Object.keys(leaf.modifier_display ?? {})) {
        if (!modifierIds.has(modId)) {
          errors.push(`${leaf.id}: modifier_display for unknown modifier "${modId}"`)
        } else if (effective && !effective.includes(modId)) {
          errors.push(`${leaf.id}: modifier_display for disallowed modifier "${modId}"`)
        }
      }
    }
  }
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
