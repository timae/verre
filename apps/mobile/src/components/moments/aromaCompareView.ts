// Aroma compare PRESENTATION derivations (aroma-layer.md §8 / §9). Pure, so the
// harness pins the BEHAVIOUR (what the strip contains, what the popover says,
// how selection/routing transitions) while the device owns only pixels,
// anchoring, and interaction feel (Codex, 2026-07-14). The JSX in the gallery /
// real card is a thin renderer over these functions. Gallery-owned alongside the
// selector + contributor helper until the compare surface ships.

import { AROMA_FAMILIES } from '@verre/core'
import type { AromaConsensusResult, ConsensusDisplayNode } from '@verre/core'
import type { AromaContributorIndex } from './aromaContributors'

const TIER_RANK = { family: 1, subfamily: 2, leaf: 3 } as const

// Global taxonomy-order index: every node id → its position in the canonical
// family → subfamily → leaf traversal (same order the aggregate's byFamily
// uses). The FINAL strip tie-breaker: the flattened collection order is NOT
// taxonomy order across different context branches (Codex #3 — a real panel
// returned Kernel before Fruity at equal count), so ranking must consult this
// absolute index, never rely on collection order. Built once at module load.
const TAXONOMY_ORDER: ReadonlyMap<string, number> = (() => {
  const order = new Map<string, number>()
  let i = 0
  for (const fam of AROMA_FAMILIES) {
    order.set(fam.id, i++)
    for (const sub of fam.subfamilies) {
      order.set(sub.id, i++)
      for (const leaf of sub.leaves) order.set(leaf.id, i++)
    }
  }
  return order
})()
const taxRank = (id: string) => TAXONOMY_ORDER.get(id) ?? Number.MAX_SAFE_INTEGER

// ── Tier 2 strip ────────────────────────────────────────────────────────────
// The "Aroma agreement" strip: ONLY the consensus primaries + secondaries,
// flattened out of the tree (NO context / heading / peak — those are Tier-3
// detail). Ranked primaries-FIRST, then secondaries, each group by the
// deterministic chip ranking (count desc → deeper tier first → the tree's
// existing sibling order, already taxonomy). The renderer packs this to ~2 lines
// and always shows "Detailed aromas"; overflow beyond the fit is Tier-3-only.

export type StripChip = {
  id: string
  tier: 'family' | 'subfamily' | 'leaf'
  label: string
  familyId: string
  count: number
  role: 'primary' | 'secondary'
  // Group-pronounced visual flag (panel-level bar; see pronouncedForNode).
  // Never affects ranking/selection — presentation only.
  pronounced: boolean
}

// `contributors` optional: when supplied, each chip carries its panel-level
// pronounced flag (a presentation-only visual — never ranking/selection). The
// caller passes the same index it feeds the popover + the same pronounced bar.
export function tier2Strip(result: AromaConsensusResult, contributors?: AromaContributorIndex, pronBar: PronouncedBar = 'majority'): StripChip[] {
  const chips: StripChip[] = []
  const walk = (dn: ConsensusDisplayNode) => {
    if (dn.role === 'primary' || dn.role === 'secondary') {
      const pronounced = contributors ? pronouncedForNode(contributors, dn.node.id, result.n, pronBar).isPanelPronounced : false
      chips.push({ id: dn.node.id, tier: dn.node.tier, label: dn.node.label, familyId: dn.node.familyId, count: dn.node.count, role: dn.role, pronounced })
    }
    for (const c of dn.children) walk(c)
  }
  for (const r of result.roots) walk(r)
  // Primaries before secondaries; within a role: count desc → deeper tier first
  // → GLOBAL taxonomy order (an explicit absolute index, NOT collection order —
  // Codex #3: collection order isn't taxonomy order across context branches).
  const roleRank = (r: 'primary' | 'secondary') => (r === 'primary' ? 0 : 1)
  return chips.sort(
    (a, b) =>
      roleRank(a.role) - roleRank(b.role) ||
      b.count - a.count ||
      TIER_RANK[b.tier] - TIER_RANK[a.tier] ||
      taxRank(a.id) - taxRank(b.id),
  )
}

// ── Two-line pack (pure; the renderer feeds it MEASURED widths) ───────────────
// Greedily fill up to STRIP_LINES lines. On overflow, reserve room for the "+N"
// pill (its ACTUAL measured width, passed in — NOT a hard-coded guess, since the
// pill width varies with the digit count + font scale + platform; a fixed
// reserve can wrongly fit one extra chip and push the pill to a 3rd line, the
// very thing this mock must validate — Codex). Returns how many chips fit + the
// overflow count. gap = the row's inter-chip gap. Behaviour is deterministic and
// harness-tested at the line boundaries.
export const STRIP_LINES = 2

export function packStrip(widths: ReadonlyArray<number>, rowW: number, gap: number, pillW: number): { fit: number; overflow: number } {
  if (rowW <= 0 || widths.length === 0) return { fit: widths.length, overflow: 0 }
  // Does the first `limit` chips fit within STRIP_LINES, optionally also
  // reserving the pill after them on the same run?
  const fitsAll = (limit: number, reservePill: boolean): boolean => {
    let line = 1
    let cursor = 0
    for (let i = 0; i < limit; i++) {
      const w = widths[i]
      if (cursor > 0 && cursor + gap + w > rowW) { line++; cursor = w } else { cursor += (cursor > 0 ? gap : 0) + w }
      if (line > STRIP_LINES) return false
    }
    if (reservePill && cursor > 0 && cursor + gap + pillW > rowW) line++
    return line <= STRIP_LINES
  }
  if (fitsAll(widths.length, false)) return { fit: widths.length, overflow: 0 }
  // Overflow: the largest prefix that fits WITH the pill reserved after it.
  let fit = widths.length - 1
  while (fit > 0 && !fitsAll(fit, true)) fit--
  return { fit, overflow: widths.length - fit }
}

// ── Popover content (for a selected node) ─────────────────────────────────────
// Header = the selected node (count). Descendant detail = the selected node's qualifying
// peak BRANCHES (its peak children rendered as full nested chains), starting at
// its CHILDREN — the selected node is NEVER repeated as its own descendant.
// Cap: at most LED_BY_CAP branches; the rest fold into `moreBranches`. Contributor
// preview: the first PREVIEW_CAP names + `moreContributors`.

export const LED_BY_CAP = 2
export const PREVIEW_CAP = 3

// ── Pronounced (group-level) ──────────────────────────────────────────────────
// Derived from the contributor index (NO core change — the aggregate ignores the
// flag; the contributor helper preserves `p: true` on each person's picks). A
// node's pronounced supporters = distinct tasters where ANY of their supporting
// picks for that node carries p:true. Because the agreement index already
// subsumes upward, this is upward-only for free (pronounced strawberry supports
// pronounced Berry/Fruity, never siblings/descendants). Pronounced NEVER affects
// ranking or selection — it's a visual flag only.
//
// The PANEL-level bar is a DEFERRED knob (like primary/peak) — a live gallery
// toggle rules it, so it is a PARAMETER, not hardcoded (Codex):
//   'majority'  (default, Codex's recommendation) — pronouncedCount*2 > n
//   'twoThirds' (stricter)                        — pronouncedCount*3 >= n*2
// Both floor at >= 2. So under 'majority' 3-of-5 shows pronounced, 3-of-8 does
// NOT — the popover still reports "3 of 5 supporters marked pronounced" for the
// nuance, without overstating panel agreement.
//
// `n` = the AROMA RESPONDENTS (the consensus result's n = tasters with >= 1
// resolvable aroma), NOT every selected compare participant. No aroma entry is
// MISSING EVIDENCE, not a negative pronounced vote — so the respondents
// denominator is the intentional one (confirmed Codex + Simon 2026-07-14): 3-of-8
// selected participants can pass if only 5 gave aromas and 3 of those 5 marked
// pronounced (n=5 here, not 8). Explanatory copy says "aroma respondents", never
// "panel", to avoid implying all selected participants were counted.
export type PronouncedBar = 'majority' | 'twoThirds'
export function pronouncedForNode(
  contributors: AromaContributorIndex,
  id: string,
  n: number,
  bar: PronouncedBar = 'majority',
): { pronouncedCount: number; supporterCount: number; isPanelPronounced: boolean } {
  const supporters = contributors.agreement.get(id) ?? []
  let pronouncedCount = 0
  for (const c of supporters) if (c.picks.some((p) => p.p === true)) pronouncedCount++
  const clears = pronouncedCount >= 2 && (bar === 'majority' ? pronouncedCount * 2 > n : pronouncedCount * 3 >= n * 2)
  return { pronouncedCount, supporterCount: supporters.length, isPanelPronounced: clears }
}

// One step in a descendant-detail chain (Berry 4 → Strawberry 2 is two steps).
export type LedByStep = { id: string; label: string; count: number }
export type PopoverContent = {
  id: string
  label: string
  familyId: string // retained for the canonical aroma badge's family styling
  count: number // distinct tasters at this node (the header "N tasters")
  // Each branch is the full nested peak chain under the selected node, capped to
  // LED_BY_CAP branches. Empty ⇒ omit the whole descendant-detail line.
  ledBy: LedByStep[][]
  moreBranches: number // qualifying peak branches beyond the cap (→ Tier 3)
  contributorNames: string[] // up to PREVIEW_CAP
  moreContributors: number // beyond the preview cap
  // Group-pronounced (see pronouncedForNode): the panel-level flag for the chip
  // visual + the raw counts for the popover's "X of Y supporters" nuance.
  pronouncedCount: number
  isPanelPronounced: boolean
}

// Enumerate EVERY root-to-leaf peak PATH under a peak child — a fork yields
// multiple paths (Berry → {Strawberry, Raspberry} ⇒ [Berry,Strawberry] AND
// [Berry,Raspberry]), so none is silently dropped (Codex #2). Paths inherit the
// tree's sibling ranking (count desc → taxonomy) because children[] is
// pre-ranked and we recurse in order. A leaf peak (no peak children) is a single
// one-step path.
function peakPaths(node: ConsensusDisplayNode): LedByStep[][] {
  const self: LedByStep = { id: node.node.id, label: node.node.label, count: node.node.count }
  const childPeaks = node.children.filter((c) => c.role === 'peak')
  if (childPeaks.length === 0) return [[self]]
  const paths: LedByStep[][] = []
  for (const child of childPeaks) {
    for (const sub of peakPaths(child)) paths.push([self, ...sub])
  }
  return paths
}

// Locate a node in the consensus tree by id (the strip chip carries only an id).
export function findConsensusNode(result: AromaConsensusResult, id: string): ConsensusDisplayNode | null {
  const stack = [...result.roots]
  while (stack.length) {
    const dn = stack.pop()!
    if (dn.node.id === id) return dn
    stack.push(...dn.children)
  }
  return null
}

export function popoverContent(
  result: AromaConsensusResult,
  contributors: AromaContributorIndex,
  id: string,
  pronBar: PronouncedBar = 'majority',
): PopoverContent | null {
  const dn = findConsensusNode(result, id)
  if (!dn) return null
  // Every root-to-leaf peak path under the selected node (a fork counts as
  // multiple branches), then the 2-branch cap — never a silent drop.
  const branches = dn.children.filter((c) => c.role === 'peak').flatMap(peakPaths)
  const supporters = contributors.agreement.get(id) ?? []
  const pron = pronouncedForNode(contributors, id, result.n, pronBar)
  return {
    id,
    label: dn.node.label,
    familyId: dn.node.familyId,
    count: dn.node.count,
    ledBy: branches.slice(0, LED_BY_CAP),
    moreBranches: Math.max(0, branches.length - LED_BY_CAP),
    contributorNames: supporters.slice(0, PREVIEW_CAP).map((c) => c.displayName),
    moreContributors: Math.max(0, supporters.length - PREVIEW_CAP),
    pronouncedCount: pron.pronouncedCount,
    isPanelPronounced: pron.isPanelPronounced,
  }
}

// ── Selection + Tier 3 routing state (single-select, mutually exclusive) ───────
// One aroma OR one participant selected at a time; a new selection REPLACES the
// prior (Codex). Tapping the SAME target again clears it. `View contributors`
// produces a Tier 3 routing descriptor: Participants mode filtered to the aroma.

export type CompareSelection =
  | { kind: 'none' }
  | { kind: 'aroma'; id: string }
  | { kind: 'participant'; id: string }

export type CompareSelectionAction =
  | { type: 'tapAroma'; id: string }
  | { type: 'tapParticipant'; id: string }
  | { type: 'clear' }

export function compareSelectionReducer(state: CompareSelection, action: CompareSelectionAction): CompareSelection {
  if (action.type === 'clear') return { kind: 'none' }
  if (action.type === 'tapAroma') {
    return state.kind === 'aroma' && state.id === action.id ? { kind: 'none' } : { kind: 'aroma', id: action.id }
  }
  // tapParticipant — replaces any aroma selection too (mutually exclusive).
  return state.kind === 'participant' && state.id === action.id ? { kind: 'none' } : { kind: 'participant', id: action.id }
}

export type Tier3Mode = 'agreement' | 'participants' | 'all'
export type Tier3Route = { mode: Tier3Mode; aromaFilter: string | null }

// `View contributors` on an aroma → open/mutate Tier 3 in Participants mode
// filtered to that aroma. Same descriptor whether opening the sheet (Tier 2) or
// mutating it in place (already inside Tier 3) — the CALLER decides which; this
// only names the target state, never opens a nested sheet.
export function viewContributorsRoute(aromaId: string): Tier3Route {
  return { mode: 'participants', aromaFilter: aromaId }
}
