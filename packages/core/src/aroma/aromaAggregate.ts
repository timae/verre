// Multi-taster aroma roll-up — aroma-layer.md §8 / compare milestone. The raw
// aggregate ONLY: it counts tasters per taxonomy node with the settled rules
// and stops there. Presentation (which grain to surface, the primary/peak
// agreement bars, the role-based consensus tree) is a SEPARATE, still-deferred
// ruling and lives in the dev-gallery consensus selector (aromaConsensus) until
// Simon rules its two knobs from real output — so it deliberately does NOT live
// here (a Codex review caught the first draft smuggling those product decisions
// into core).
//
// Pure + platform-neutral (core's purity rule). Computed CLIENT-side, same
// posture as aggregateFlavourAxes (compareAggregate.ts): every taster's ratings
// already arrive via GET /:code/state, the selector recomputes live over the
// chosen subset, there is NO server aggregate.
//
// Upward-only subsumption (Simon, 2026-07-13, from the iNaturalist community-
// taxon / True Path Rule precedent): a taster's pick votes for that node AND
// every ancestor, NEVER a descendant. A leaf `strawberry` votes for
// Strawberry + Berry + Fruity; a coarse `fruity` pick votes for Fruity only.
// So a stored coarse pick is honest low-confidence data that arrives already
// collapsed a tier, never inflated back down into a specificity the taster
// never claimed.
//
// Per-taster set-union BEFORE counting is load-bearing: one taster picking
// strawberry AND raspberry (both Fruity›Berry) counts ONCE for Berry and ONCE
// for Fruity — a single taster is one vote per node no matter how many of their
// leaves roll into it (the coarse-sibling double-count trap).
//
// Modifiers are STRIPPED for the grain: strawberry+cooked and strawberry both
// agree on Strawberry. Modifier agreement is out of scope for v1.
//
// Resolution safety: every stored id is resolved FRESH via getAromaNode, and an
// unknown / deleted id is skipped, never thrown (read paths render nothing
// rather than crash — the write boundary already rejected genuine garbage).
// Re-parent behaviour depends on the tier, because ids are only path-independent
// at the LEAF (bare label slug, one-leaf-one-home):
//   - LEAF re-parenting re-aggregates history automatically — the same leaf id
//     resolves to its new home, so a re-homed strawberry re-rolls under its new
//     subfamily/family with no migration.
//   - SUBFAMILY re-parenting does NOT: a subfamily id encodes its family path
//     (`fruity.berry`), so moving or renaming it CHANGES the id. Old stored
//     `fruity.berry` selections become unknown until the planned
//     superseded_by alias / migration mechanism re-ids them (none exist yet);
//     until then they are safely SKIPPED, not crashed.

import { AROMA_FAMILIES, aromaAncestorChain, getAromaNode, type AromaSelection } from './taxonomy'

export type AromaRollupNode = {
  readonly id: string
  readonly tier: 'family' | 'subfamily' | 'leaf'
  readonly label: string
  readonly familyId: string
  // Resolved ancestor id (subfamily→family, leaf→subfamily, family→null). Lets
  // a selector compute child/parent branch concentration and walk children
  // (nodes whose parentId === this id) straight off the rollup — no tree pass.
  readonly parentId: string | null
  // Tasters who picked THIS node or any descendant (the subsumption count).
  readonly count: number
  // Of those, how many picked at THIS exact grain (this id was in their raw
  // picks). count - atGrain = rolled-up-from-below. DIAGNOSTIC ONLY — never a
  // ranking signal (leaf-derived support is full support at ancestors, so
  // rewarding a coarse pick would contradict subsumption).
  readonly atGrain: number
}

export type AromaRollup = {
  readonly n: number
  readonly nodes: ReadonlyMap<string, AromaRollupNode>
  // Active families only (≥1 reached node), in AROMA_FAMILIES order; each
  // family's members in taxonomy-traversal order (family, then its subfamilies
  // in declaration order, each followed by its leaves in declaration order).
  readonly byFamily: ReadonlyArray<{
    readonly familyId: string
    readonly nodes: ReadonlyArray<AromaRollupNode>
  }>
}

function parentIdOf(node: NonNullable<ReturnType<typeof getAromaNode>>): string | null {
  if (node.tier === 'leaf') return node.subfamily!.id
  if (node.tier === 'subfamily') return node.family.id
  return null
}

export function aggregateAromaRollup(
  selectionSets: ReadonlyArray<ReadonlyArray<AromaSelection> | null | undefined>,
): AromaRollup {
  // Accumulate voters per node id as Sets of taster indices — the per-taster
  // Set is what makes sibling dedupe automatic (adding the same taster twice is
  // a no-op). `grain` is the subset who picked at that exact tier.
  const voters = new Map<string, Set<number>>()
  const grainVoters = new Map<string, Set<number>>()
  let n = 0
  selectionSets.forEach((selections, taster) => {
    if (!selections || selections.length === 0) return
    const voted = new Set<string>()
    const grain = new Set<string>()
    for (const sel of selections) {
      const node = getAromaNode(sel.a)
      if (!node) continue
      const chain = aromaAncestorChain(node)
      for (const id of chain) voted.add(id)
      grain.add(chain[chain.length - 1])
    }
    if (voted.size === 0) return
    n += 1
    for (const id of voted) {
      let set = voters.get(id)
      if (!set) voters.set(id, (set = new Set()))
      set.add(taster)
    }
    for (const id of grain) {
      let set = grainVoters.get(id)
      if (!set) grainVoters.set(id, (set = new Set()))
      set.add(taster)
    }
  })

  const nodes = new Map<string, AromaRollupNode>()
  for (const [id, set] of voters) {
    const node = getAromaNode(id)
    if (!node) continue
    nodes.set(id, {
      id,
      tier: node.tier,
      label: node.label,
      familyId: node.family.id,
      parentId: parentIdOf(node),
      count: set.size,
      atGrain: grainVoters.get(id)?.size ?? 0,
    })
  }

  // byFamily in taxonomy-traversal order over the ACTIVE nodes only.
  const byFamily: { familyId: string; nodes: AromaRollupNode[] }[] = []
  for (const family of AROMA_FAMILIES) {
    const ordered: AromaRollupNode[] = []
    const famNode = nodes.get(family.id)
    if (famNode) ordered.push(famNode)
    for (const sub of family.subfamilies) {
      const subNode = nodes.get(sub.id)
      if (subNode) ordered.push(subNode)
      for (const leaf of sub.leaves) {
        const leafNode = nodes.get(leaf.id)
        if (leafNode) ordered.push(leafNode)
      }
    }
    if (ordered.length > 0) byFamily.push({ familyId: family.id, nodes: ordered })
  }

  return { n, nodes, byFamily }
}
