// What one aroma pick in a LIST FILTER matches (Filter Impressions, ruled
// 2026-11-14). A pick is a canonical AromaSelection, the same shape a rating
// stores, but it reads BROADER than its stored twin:
//
//   • the node matches itself AND everything under it (Fruity finds every
//     subfamily and leaf of Fruity; inheritance runs DOWNWARD only: a rating
//     that noted just "Fruity" does not match a "Strawberry" pick);
//   • no modifier = any modifier (Apricot finds dried apricot too); a
//     modifier = only that modifier (Dried apricot finds only dried);
//   • Pronounced = only selections marked Pronounced; unmarked = either;
//   • a refine passes down: (Fruity, dried) finds any Fruity node stored
//     with dried.
//
// A PROMOTED leaf is the stored form of a (base, modifier) composite (grape +
// dried is stored as raisin, the gate rewrites it). So a pick whose subtree
// holds the base also finds the promoted leaf, whatever modifier that leaf
// carries itself, when the pick's modifier is open or equals the composite's
// (Grape finds raisin; Fruity + dried finds raisin; Grape + cooked doesn't).
//
// Pure taxonomy walk over the tree (never id parsing, taxonomy.ts header).
// The server turns the result into SQL (lib/profileLists.ts); nothing here
// knows about storage.

import { AROMA_FAMILIES, type AromaSelection } from './taxonomy'

export type AromaFilterMatch = {
  /** Node ids that match with the pick's modifier rule (`m`). */
  ids: string[]
  /** null = any modifier; else a stored selection must carry exactly this one. */
  m: string | null
  /** Promoted leaves that match whatever modifier they carry. */
  promotedIds: string[]
  /** Only selections marked Pronounced. */
  pronounced: boolean
}

// node id → itself + every descendant id; built once.
const SUBTREE = new Map<string, readonly string[]>()
// Every promoted leaf with the composite it stands for.
const PROMOTED: { id: string; a: string; m: string }[] = []
for (const family of AROMA_FAMILIES) {
  const famIds: string[] = [family.id]
  for (const sub of family.subfamilies) {
    const subIds: string[] = [sub.id]
    for (const leaf of sub.leaves) {
      SUBTREE.set(leaf.id, [leaf.id])
      subIds.push(leaf.id)
      if (leaf.promoted_from) PROMOTED.push({ id: leaf.id, a: leaf.promoted_from.a, m: leaf.promoted_from.m })
    }
    SUBTREE.set(sub.id, subIds)
    famIds.push(...subIds)
  }
  SUBTREE.set(family.id, famIds)
}

export function aromaSubtree(id: string): readonly string[] {
  return SUBTREE.get(id) ?? []
}

/** The match sets for one canonical pick (run gateAromaSelections first). */
export function aromaFilterMatch(sel: AromaSelection): AromaFilterMatch {
  const ids = aromaSubtree(sel.a)
  const inTree = new Set(ids)
  const promotedIds = PROMOTED
    .filter((p) => inTree.has(p.a) && (sel.m === null || p.m === sel.m))
    .map((p) => p.id)
    // With an open modifier a promoted leaf inside the subtree is already in `ids`.
    .filter((id) => sel.m !== null || !inTree.has(id))
  return { ids: [...ids], m: sel.m, promotedIds, pronounced: sel.p === true }
}

/** Does one stored selection satisfy the pick? The SQL's twin, for unit pins. */
export function aromaPickMatches(match: AromaFilterMatch, stored: { a: string; m: string | null; p?: boolean }): boolean {
  if (match.pronounced && stored.p !== true) return false
  if (match.promotedIds.includes(stored.a)) return true
  return match.ids.includes(stored.a) && (match.m === null || stored.m === match.m)
}
