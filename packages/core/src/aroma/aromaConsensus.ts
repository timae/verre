// Aroma role-based CONSENSUS TREE — the compare selector (aroma-layer.md §8).
// Framework-neutral core: platform-pure (no node:*/next/@prisma/React/DOM), same
// posture as aggregateAromaRollup beside it. Moved into core from the mobile
// gallery once the two knobs were RULED (Simon, 2026-07-14): primary `> n/2`
// (majority), peak `>= 1/3`. Those are baked as the defaults here — call
// `aromaConsensus(rollup)` with no opts for the shipped behaviour; the opts stay
// a parameter so a future re-ruling (or the dev knob lab) can override.
//
// A role-tagged DISPLAY TREE over the compressed roll-up: integer counts + a tree
// walk, depth handled structurally (no confidence weights). (Superseded en route:
// the ancestor-free frontier with per-edge parent-retention, which COMPOUNDED to
// false-precision headlines.)
//
// Five roles (see the spec §3a table):
//   heading   — an uncounted grouping node (its count ≡ a child's ⇒ collapsed),
//               RETAINED only if it groups ≥2 displayed child branches (§rule H).
//   context   — a counted ancestor sitting ABOVE a primary (P2 Fruity, P8 Fruity).
//   primary   — counted, clears the primary bar, AND is the DEEPEST qualifier on
//               its branch (no eligible counted descendant). Each deepest
//               qualifying child branch gets its own primary (multi-label).
//   secondary — counted branch head, ≥2, with NO primary on its path (P3 roots,
//               P7 Vegetal, P8/P9 Citrus).
//   peak      — counted descendant below a displayed counted head (primary OR
//               secondary) or below another peak, concentrating its branch
//               (clears the peak bar vs the last emitted counted ancestor).
// Singletons (count 1) never appear.
//
// TWO DENOMINATORS, NEVER MERGED (Codex ruling 1):
//   - panel prevalence  count / n            → the PRIMARY bar ONLY (secondary
//                                              uses the fixed count>=2 floor).
//   - branch concentration count / ancestor  → the PEAK bar. The ancestor is the
//                                              nearest surviving COUNTED displayed
//                                              ancestor; an uncounted heading is
//                                              NEVER a denominator (§rule 6).
//
// Two knobs, INTEGER cross-multiplication (a single numeric bar + `>` can express
// neither the strict-majority nor the inclusive-⅔ rule, and it avoids float
// boundaries — Codex 5):
//   - primary bar — count>=2 AND (majority: count*2 > n ; twoThirds: count*3 >= n*2)
//   - peak bar     — count>=2 AND count*peakDen >= ancestorCount*peakNum

import type { AromaRollup, AromaRollupNode } from './aromaAggregate'

export type AromaConsensusOpts = Readonly<{
  /** Primary-bar mode. 'majority' = strict > n/2; 'twoThirds' = inclusive >= 2n/3. */
  primary: 'majority' | 'twoThirds'
  /** Peak-bar fraction numerator/denominator (branch concentration), e.g. 1/3 or 2/3. */
  peakNum: number
  peakDen: number
}>

// The RULED shipped defaults (Simon, 2026-07-14): primary strict majority, peak
// >= 1/3. `aromaConsensus(rollup)` with no opts uses exactly these. FROZEN so a
// caller can't mutate the shared object and silently re-rule every future
// no-options call (Codex).
export const DEFAULT_CONSENSUS_OPTS = Object.freeze({
  primary: 'majority',
  peakNum: 1,
  peakDen: 3,
}) satisfies AromaConsensusOpts

export type ConsensusRole = 'heading' | 'context' | 'primary' | 'secondary' | 'peak'

// The display-node payload — the diagnostic fields off the rollup node, plus
// the resolved role. Rendering reads role + counted, never re-derives structure.
export type ConsensusDisplayNode = {
  node: {
    id: string
    tier: 'family' | 'subfamily' | 'leaf'
    label: string
    familyId: string
    count: number
    atGrain: number
  }
  role: ConsensusRole
  /** false ONLY for role 'heading'. */
  counted: boolean
  /** Recursive — P5 Fruity›Berry›Strawberry nests here; ranked siblings. */
  children: ConsensusDisplayNode[]
}

export type AromaConsensusResult = {
  roots: ConsensusDisplayNode[]
  /** true iff ≥1 primary anywhere in the tree. */
  hasStrongAgreement: boolean
  n: number
}

const TIER_RANK = { family: 1, subfamily: 2, leaf: 3 } as const

function clearsPrimary(count: number, n: number, opts: AromaConsensusOpts): boolean {
  if (count < 2) return false
  return opts.primary === 'majority' ? count * 2 > n : count * 3 >= n * 2
}

function clearsPeak(count: number, ancestorCount: number, opts: AromaConsensusOpts): boolean {
  if (count < 2) return false
  return count * opts.peakDen >= ancestorCount * opts.peakNum
}

// A working node in the compressed tree the passes build over.
type WorkNode = {
  ro: AromaRollupNode
  children: WorkNode[]
  // Pass 2: this node's count ≡ its (compressed) parent's count ⇒ the parent is
  // redundant (identical voter sets). Marked on the PARENT.
  collapsed: boolean
  // Pass 4: the resolved role, filled across 4a (primary/context) then 4b.
  role: ConsensusRole | null
}

export function aromaConsensus(rollup: AromaRollup, opts: AromaConsensusOpts = DEFAULT_CONSENSUS_OPTS): AromaConsensusResult {
  // Pass 0 — empty guard. No engaged taster ⇒ no division ever runs on empty
  // data (Codex 2). Return the exact empty contract.
  if (rollup.n === 0) return { roots: [], hasStrongAgreement: false, n: 0 }

  // Pass 1 (raw counts) → Pass 3 (drop singletons): build the reached tree over
  // count>=2 nodes only, in taxonomy-traversal order (byFamily already orders
  // members that way). A singleton parent is dropped, so a surviving child
  // re-parents onto the nearest surviving ancestor — walk parentId up the
  // rollup skipping dropped ids.
  const kept = new Map<string, WorkNode>()
  for (const fam of rollup.byFamily) {
    for (const ro of fam.nodes) {
      if (ro.count < 2) continue
      kept.set(ro.id, { ro, children: [], collapsed: false, role: null })
    }
  }
  const roots: WorkNode[] = []
  for (const fam of rollup.byFamily) {
    for (const ro of fam.nodes) {
      const wn = kept.get(ro.id)
      if (!wn) continue
      // Nearest surviving ancestor (skip singleton-dropped ids).
      let pid = ro.parentId
      let parent: WorkNode | undefined
      while (pid !== null) {
        parent = kept.get(pid)
        if (parent) break
        pid = rollup.nodes.get(pid)?.parentId ?? null
      }
      if (parent) parent.children.push(wn)
      else roots.push(wn)
    }
  }

  // Pass 2 — equal-count collapse. A node whose count equals its (surviving)
  // PARENT's count ⇒ identical voter sets ⇒ the parent's count is redundant:
  // mark the PARENT collapsed. Chains automatically (Fruity≡Berry≡Raspberry →
  // both Fruity and Berry marked). A strict count DROP keeps the ancestor
  // counted (Chemical 3 > Skunky 2 — the petrol taster keeps Chemical alive).
  const markCollapse = (wn: WorkNode) => {
    for (const c of wn.children) {
      if (c.ro.count === wn.ro.count) wn.collapsed = true
      markCollapse(c)
    }
  }
  for (const r of roots) markCollapse(r)

  // Pass 4a — POST-ORDER discovery of primaries. A counted node is PRIMARY iff
  // it clears the primary bar AND has NO eligible counted descendant (deepest
  // majority on that path; each deepest qualifying child branch gets its own).
  // "Eligible counted descendant" = a descendant that itself clears the primary
  // bar (so a coarse node with a qualifying finer child defers to the child).
  const hasQualifyingDescendant = (wn: WorkNode): boolean => {
    for (const c of wn.children) {
      if (clearsPrimary(c.ro.count, rollup.n, opts)) return true
      if (hasQualifyingDescendant(c)) return true
    }
    return false
  }
  const assignPrimaries = (wn: WorkNode) => {
    for (const c of wn.children) assignPrimaries(c)
    if (wn.role) return
    if (clearsPrimary(wn.ro.count, rollup.n, opts) && !hasQualifyingDescendant(wn)) {
      wn.role = 'primary'
    }
  }
  for (const r of roots) assignPrimaries(r)
  // Mark every counted ancestor of a primary as context (a collapsed node stays
  // collapse-marked; the §rule-H prune later decides heading-vs-context off the
  // collapse mark, so DON'T overwrite a collapsed node's role with context).
  const markContext = (wn: WorkNode): boolean => {
    let below = wn.role === 'primary'
    for (const c of wn.children) if (markContext(c)) below = true
    if (below && wn.role === null && !wn.collapsed) wn.role = 'context'
    return below
  }
  for (const r of roots) markContext(r)

  // Pass 4b — TOP-DOWN emission of secondary + peak. Walk each branch root→leaf,
  // tracking the last emitted COUNTED displayed ancestor (its count is the peak
  // denominator; a collapsed heading is NOT a counted ancestor — §rule 6). The
  // FIRST still-unclassified counted node on a branch with NO primary anywhere
  // on its path → secondary. A still-unclassified counted node BELOW an emitted
  // counted head (primary OR secondary) or below an emitted peak → peak iff it
  // clears the peak bar vs the last emitted counted ancestor.
  const branchHasPrimary = (wn: WorkNode): boolean => {
    if (wn.role === 'primary') return true
    return wn.children.some(branchHasPrimary)
  }
  // Does the path from root DOWN TO (and excluding) this node contain a primary?
  // Passed down as `primaryAbove`.
  const emit = (wn: WorkNode, primaryAbove: boolean, lastCountedAncestor: WorkNode | null, headEmitted: boolean) => {
    let counted = true
    if (wn.collapsed) {
      // Provisionally a heading (uncounted); §rule H prunes decorative ones.
      wn.role = 'heading'
      counted = false
    } else if (wn.role === 'primary' || wn.role === 'context') {
      // Already assigned in 4a — a counted displayed head/ancestor.
    } else if (!primaryAbove && !headEmitted) {
      // First still-unclassified counted node on a primary-free branch → the
      // branch head. It's a SECONDARY iff this subtree has no primary at all
      // (if it did, 4a would have marked this node context, not left it null).
      wn.role = branchHasPrimary(wn) ? 'context' : 'secondary'
    } else if (clearsPeak(wn.ro.count, lastCountedAncestor?.ro.count ?? wn.ro.count, opts)) {
      wn.role = 'peak'
    } else {
      // Counted, below a head, but fails the peak bar → not displayed. Drop the
      // whole subtree (a child can't out-concentrate a parent that already
      // failed against the same-or-shallower ancestor).
      wn.role = null
    }
    const nextPrimaryAbove = primaryAbove || wn.role === 'primary'
    const nextHead = headEmitted || wn.role === 'primary' || wn.role === 'secondary' || wn.role === 'peak'
    const nextAncestor = counted && wn.role !== null ? wn : lastCountedAncestor
    for (const c of wn.children) emit(c, nextPrimaryAbove, nextAncestor, nextHead)
  }
  for (const r of roots) emit(r, false, null, false)

  // Build the display tree from surviving (role !== null) nodes, then apply
  // §rule H and ranking. A dropped node (role null, not collapsed) prunes its
  // whole subtree; a collapsed heading with <2 displayed children is removed and
  // its sole child promoted into its slot.
  const build = (wn: WorkNode): ConsensusDisplayNode | ConsensusDisplayNode[] | null => {
    if (wn.role === null) return null
    const kids: ConsensusDisplayNode[] = []
    for (const c of wn.children) {
      const r = build(c)
      if (r === null) continue
      if (Array.isArray(r)) kids.push(...r)
      else kids.push(r)
    }
    if (wn.role === 'heading') {
      // §rule H — a heading is retained only if it groups ≥2 displayed child
      // branches; otherwise remove it and promote its children into its slot.
      if (kids.length < 2) return kids
    }
    rankSiblings(kids)
    return {
      node: {
        id: wn.ro.id,
        tier: wn.ro.tier,
        label: wn.ro.label,
        familyId: wn.ro.familyId,
        count: wn.ro.count,
        atGrain: wn.ro.atGrain,
      },
      role: wn.role,
      counted: wn.role !== 'heading',
      children: kids,
    }
  }
  const displayRoots: ConsensusDisplayNode[] = []
  for (const r of roots) {
    const built = build(r)
    if (built === null) continue
    if (Array.isArray(built)) displayRoots.push(...built)
    else displayRoots.push(built)
  }
  rankSiblings(displayRoots)

  const hasStrongAgreement = anyPrimary(displayRoots)
  return { roots: displayRoots, hasStrongAgreement, n: rollup.n }
}

// Rank siblings: count desc → deeper tier first on ties → taxonomy order.
// NEVER atGrain (a unanimous leaf outranks a coarse family at equal count by
// DEPTH). The input is already in taxonomy-traversal order (byFamily), so a
// STABLE sort by (−count, −tierRank) preserves taxonomy order within ties.
function rankSiblings(nodes: ConsensusDisplayNode[]): void {
  nodes.sort((a, b) => b.node.count - a.node.count || TIER_RANK[b.node.tier] - TIER_RANK[a.node.tier])
}

function anyPrimary(nodes: ConsensusDisplayNode[]): boolean {
  for (const d of nodes) {
    if (d.role === 'primary') return true
    if (anyPrimary(d.children)) return true
  }
  return false
}
