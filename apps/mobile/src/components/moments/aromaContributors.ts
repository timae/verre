// Aroma contributor index — the compare surface's "who is behind THIS aroma"
// map (aroma-layer.md §8 / §9). SHARED compare-feature helper, NOT the core
// aggregate: contributor identity is a compare-INTERACTION concern (tap a chip →
// see the people + their exact picks), whereas aggregateAromaRollup deliberately
// keeps only counts. Both are derived from the SAME per-taster picks, so a
// tested invariant pins that they agree (every agreement node's UNIQUE
// contributor count === its aggregate count). SHIPS IN PRODUCTION via
// buildCompareAromaModel (aromaCompareView) → the strip/sheet popovers.
//
// Three granularities, because the compare surface reads contributors three
// ways (Simon + Codex, 2026-07-14; participants added for slice 3d):
//   - AGREEMENT (subsumed): a node's contributors include finer picks that
//     rolled UP into it (tap Berry → Ana's strawberry + Ben's raspberry + Dan's
//     coarse "Berry" all appear). Upward-only subsumption, same as the aggregate.
//   - ALL AROMAS (exact): indexed by BASE aroma id and exact modifier. The
//     detail sheet flattens these buckets into canonical modifier-bearing
//     AromaChips; the base-level bucket remains useful for fallback popovers
//     and routes. Base count = distinct tasters; each exact modifier count =
//     distinct tasters using that modifier, so those counts MAY sum above the
//     base when one person made several modifier-bearing picks.
//   - PARTICIPANTS (per taster): every aroma respondent with ALL their exact
//     picks, roster order — the detail sheet's People tab.
//
// One contributor appears ONCE per node/base even if several of their picks
// support it (per-taster dedupe, like the aggregate's vote-set). Unknown /
// re-homed ids are skipped, never thrown (read-path safety).

import { aromaAncestorChain, getAromaNode, type AromaSelection } from '@verre/core'

// The minimal taster shape the helper needs — id + name + their raw stored
// picks. Mirrors CompareBody's `Rater` (id/displayName/rating.aromas); the wire
// `p?: boolean` is accepted (contributor identity ignores the pronounced flag).
export type AromaContributorInput = {
  id: string
  displayName: string
  aromas: ReadonlyArray<{ a: string; m: string | null; p?: boolean }> | null | undefined
}

// One person behind an aroma node/base, with the EXACT picks of theirs that
// support it (so the UI can show "Ben · jammy raspberry" AND their Pronounced
// state). picks preserves BOTH the modifier and the `p: true` pronounced flag
// (Codex #1 — participant badges render Pronounced); for an agreement node these
// are the finer picks that rolled up. Deeply readonly (the result is pure — a
// consumer must not mutate it; the builder below uses a private mutable type).
export type AromaContributor = {
  readonly id: string
  readonly displayName: string
  readonly picks: ReadonlyArray<Readonly<AromaSelection>>
}

// The All-aromas grouping for one BASE aroma id (leaf/subfamily/family exactly
// as picked — NO subsumption): distinct-taster base count + per-modifier
// distinct-taster tallies (each carrying ITS OWN contributors, so tapping an
// exact (aroma, modifier) pair reads directly — Codex #2) + the base-level
// contributors (deduped per taster).
export type AromaModifierGroup = {
  readonly m: string | null // null = fresh/default
  readonly count: number // distinct tasters who used this exact (base, modifier)
  readonly contributors: ReadonlyArray<AromaContributor>
}
export type AromaBaseGroup = {
  readonly baseId: string
  readonly label: string
  readonly familyId: string
  readonly tier: 'family' | 'subfamily' | 'leaf'
  readonly count: number // distinct tasters who picked this base at ANY modifier
  // Each modifier is an INDEPENDENT signal — the counts may sum ABOVE `count`
  // when a taster used several modifiers on the same base, never additive parts.
  readonly byModifier: ReadonlyArray<AromaModifierGroup>
  readonly contributors: ReadonlyArray<AromaContributor>
}

export type AromaContributorIndex = {
  // AGREEMENT (subsumed) node id → its contributors. Keyed like the aggregate's
  // nodes; agreementContributors.get(id)!.length === aggregate node.count.
  readonly agreement: ReadonlyMap<string, ReadonlyArray<AromaContributor>>
  // ALL AROMAS: base aroma id → its exact grouping, in taxonomy-adjacent input
  // order (first-seen); the surface applies its own sort (occurrence / family).
  readonly byBase: ReadonlyArray<AromaBaseGroup>
  // PARTICIPANTS (slice 3d): every aroma RESPONDENT (>= 1 resolvable pick) with
  // ALL their exact picks, in roster (input) order — the People tab's
  // unfiltered read. participants.length === the consensus n. The FILTERED
  // read (View contributors → one aroma) uses `agreement` instead, so the
  // filter inherits the same upward subsumption the counts use.
  readonly participants: ReadonlyArray<AromaContributor>
}

// Private mutable builder mirror of AromaContributor — the ONLY place picks is
// pushed to. The public type is deeply readonly; this stays inside the module.
type MutableContributor = { id: string; displayName: string; picks: AromaSelection[] }

export function buildAromaContributors(
  raters: ReadonlyArray<AromaContributorInput>,
): AromaContributorIndex {
  // Add (or extend) one taster's contributor entry in a (tasterId → contributor)
  // bucket, appending the supporting pick. The per-taster Map makes the dedupe
  // automatic (one contributor per bucket) while collecting every pick.
  const addTo = (bucket: Map<string, MutableContributor>, rater: AromaContributorInput, sel: AromaSelection) => {
    const existing = bucket.get(rater.id)
    if (existing) existing.picks.push(sel)
    else bucket.set(rater.id, { id: rater.id, displayName: rater.displayName, picks: [sel] })
  }

  // agreement: node id → (tasterId → contributor). byBase: base id → same, plus
  // per-(base, modifier) contributor buckets so an exact-pair tap reads directly.
  const agree = new Map<string, Map<string, MutableContributor>>()
  const baseContrib = new Map<string, Map<string, MutableContributor>>()
  const baseMods = new Map<string, Map<string | null, Map<string, MutableContributor>>>()
  const baseOrder: string[] = []
  // Respondents in roster order, each with ALL their resolvable picks (the
  // People tab). A rater whose picks ALL fail to resolve never lands here —
  // matching the consensus n (they're not an aroma respondent).
  const participantByTaster = new Map<string, MutableContributor>()

  for (const rater of raters) {
    if (!rater.aromas || rater.aromas.length === 0) continue
    for (const raw of rater.aromas) {
      const node = getAromaNode(raw.a)
      if (!node) continue // re-homed / unknown id — skip, never throw
      // Reconstruct the EXACT selection, preserving the Pronounced flag (only
      // when true — the type is `p?: true`, matching the canonical stored form).
      const sel: AromaSelection = raw.p === true ? { a: raw.a, m: raw.m, p: true } : { a: raw.a, m: raw.m }
      addTo(participantByTaster, rater, sel)

      // AGREEMENT: attribute this pick to the node AND every ancestor.
      for (const id of aromaAncestorChain(node)) {
        let byTaster = agree.get(id)
        if (!byTaster) agree.set(id, (byTaster = new Map()))
        addTo(byTaster, rater, sel)
      }

      // ALL AROMAS: the base is the pick's OWN grain (no subsumption); also
      // bucket by exact modifier so a (base, modifier) tap has its own list.
      const baseId = raw.a
      if (!baseContrib.has(baseId)) {
        baseContrib.set(baseId, new Map())
        baseMods.set(baseId, new Map())
        baseOrder.push(baseId)
      }
      addTo(baseContrib.get(baseId)!, rater, sel)
      const mods = baseMods.get(baseId)!
      let modBucket = mods.get(raw.m)
      if (!modBucket) mods.set(raw.m, (modBucket = new Map()))
      addTo(modBucket, rater, sel)
    }
  }

  // Convert a private mutable builder bucket into the public (readonly-typed)
  // contributor array. Not a runtime freeze — the readonly-ness is compile-time.
  const finish = (bucket: Map<string, MutableContributor>): AromaContributor[] => [...bucket.values()]

  const agreement = new Map<string, ReadonlyArray<AromaContributor>>()
  for (const [id, byTaster] of agree) agreement.set(id, finish(byTaster))

  const byBase: AromaBaseGroup[] = []
  for (const baseId of baseOrder) {
    const node = getAromaNode(baseId)!
    const contributors = finish(baseContrib.get(baseId)!)
    // Modifier groups: null (fresh) first, then the rest by count desc for a
    // stable, glanceable order; each carries its own contributors.
    const byModifier: AromaModifierGroup[] = [...baseMods.get(baseId)!.entries()]
      .map(([m, bucket]) => ({ m, count: bucket.size, contributors: finish(bucket) }))
      .sort((a, b) => (a.m === null ? -1 : b.m === null ? 1 : b.count - a.count))
    byBase.push({
      baseId,
      label: node.label,
      familyId: node.family.id,
      tier: node.tier,
      count: contributors.length,
      byModifier,
      contributors,
    })
  }

  return { agreement, byBase, participants: finish(participantByTaster) }
}
