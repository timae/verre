// Aroma compare PRESENTATION derivations (aroma-layer.md §8 / §9). Pure, so the
// harness pins the BEHAVIOUR (what the strip contains, what the popover says,
// how selection/routing transitions) while the device owns only pixels,
// anchoring, and interaction feel (Codex, 2026-07-14). SHIPS IN PRODUCTION via
// CompareBody → AromaCompareStrip/AromaDetailSheet; the dev gallery renders the same
// functions as its lab. `buildCompareAromaModel` below is the ONE derivation
// the production surfaces consume — strip and sheet must never fork on their
// own recomputation of any of this.

import { aggregateAromaRollup, aromaAncestorChain, aromaConsensus, aromaModifierDisplay, getAromaNode, AROMA_FAMILIES } from '@verre/core'
import type { AromaConsensusResult, ConsensusDisplayNode } from '@verre/core'
import { buildAromaContributors, type AromaBaseGroup, type AromaContributor, type AromaContributorIndex, type AromaContributorInput } from './aromaContributors'
// Relative (not '@/') so the node test harness can import this module directly.
import { contrastRatio } from '../../lib/contrast'

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
// and always shows "Aroma Details"; overflow beyond the fit is Tier-3-only.

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

// Measurement cache identity = everything that changes the rendered badge
// width. The node id alone is insufficient because the live count is part of
// the label (`9x` → `10x`).
export const stripChipMeasureKey = (chip: StripChip): string =>
  `${chip.id}|${chip.count}|${chip.pronounced ? 1 : 0}`

// `pronouncedIds` is the model's single panel-level derivation; the flag is
// presentation-only and never affects ranking or selection.
const EMPTY_PRONOUNCED_IDS: ReadonlySet<string> = new Set()
export function tier2Strip(result: AromaConsensusResult, pronouncedIds: ReadonlySet<string> = EMPTY_PRONOUNCED_IDS): StripChip[] {
  const chips: StripChip[] = []
  const walk = (dn: ConsensusDisplayNode) => {
    if (dn.role === 'primary' || dn.role === 'secondary') {
      chips.push({
        id: dn.node.id,
        tier: dn.node.tier,
        label: dn.node.label,
        familyId: dn.node.familyId,
        count: dn.node.count,
        role: dn.role,
        pronounced: pronouncedIds.has(dn.node.id),
      })
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

// ── Union fallback strip (no group agreement) ─────────────────────────────────
// When the panel doesn't agree (n>=2 total scatter → no shared node) or only ONE
// taster gave aromas (n<2), there's no consensus to distil — but the aromas DO
// exist and are worth showing (Simon, 2026-07-14). This flattens EVERY picked
// base aroma into chips with its distinct-taster mention count, ordered by
// occurrence (desc) then GLOBAL taxonomy — an explicit fallback, NOT agreement
// (the caller retitles the section "Aromas mentioned" / "Aromas" accordingly).
// No pronounced ring: panel-pronounced is an agreement-level signal that doesn't
// apply here; the count badge ("1x") is the truthful per-aroma signal.
export function unionStrip(contributors: AromaContributorIndex): StripChip[] {
  return contributors.byBase
    .map((b): StripChip => ({
      id: b.baseId,
      tier: b.tier,
      label: b.label,
      familyId: b.familyId,
      count: b.count,
      role: 'secondary',
      pronounced: false,
    }))
    .sort((a, b) => b.count - a.count || taxRank(a.id) - taxRank(b.id))
}

// ── Two-line pack (pure; the renderer feeds it MEASURED widths) ───────────────
// Greedily fill up to STRIP_LINES lines. On overflow, reserve room for the "+N"
// pill (its ACTUAL measured width, passed in — NOT a hard-coded guess, since the
// pill width varies with the digit count + font scale + platform; a fixed
// reserve can wrongly fit one extra chip and push the pill to a 3rd line, the
// very thing this mock must validate — Codex). Returns how many chips fit + the
// overflow count. gap = the row's inter-chip gap. Behaviour is deterministic and
// harness-tested at the line boundaries. Deliberately SEPARATE from parts.tsx's
// packChips: that one is selection-shaped (AromaSelection keys, estimate
// fallbacks, an estimated pill) where this is a pure widths-array pack with a
// measured always-present tail — merging them would couple two different
// contracts for ~20 shared lines.
export const STRIP_LINES = 2
// One inter-chip gap for every compare aroma surface (strip lines + the sheet's
// chip grids) — matches feed detail's AromaReadChips CHIP_GAP so the aroma read
// has the same rhythm everywhere (Simon, 2026-07-14).
export const STRIP_GAP = 7
// The ruled pronounced bar (majority) — the ONE constant strip + sheet + popover
// all read; the knob lab in the dev gallery is the only place that varies it.
export const PRON_BAR: PronouncedBar = 'majority'

export function packStrip(
  widths: ReadonlyArray<number>,
  rowW: number,
  gap: number,
  pillW: number,
  // ALWAYS-PRESENT TAIL contract: when the caller renders the pill
  // unconditionally (compare's "Aroma detail" tail is always there), the pill
  // must be reserved even in the no-overflow branch — otherwise a full-but-
  // fitting chip set leaves no room and the pill spills to a 3rd line (Codex
  // finding #1). Default false preserves the dev-gallery caller, which only adds
  // the pill on overflow (feed uses the separate packChips in parts.tsx).
  // Harness-pinned at the boundary.
  alwaysReserveTail = false,
): { fit: number; overflow: number } {
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
  if (fitsAll(widths.length, alwaysReserveTail)) return { fit: widths.length, overflow: 0 }
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

// One panel-level pronounced derivation for the whole consensus tree. The
// compact strip and detail sheet consume this same set, so their pronounced
// rings cannot drift through duplicate per-node walks.
export function pronouncedNodeIds(
  result: AromaConsensusResult,
  contributors: AromaContributorIndex,
  bar: PronouncedBar = 'majority',
): ReadonlySet<string> {
  const ids = new Set<string>()
  const walk = (dn: ConsensusDisplayNode) => {
    if (dn.counted && pronouncedForNode(contributors, dn.node.id, result.n, bar).isPanelPronounced) ids.add(dn.node.id)
    dn.children.forEach(walk)
  }
  result.roots.forEach(walk)
  return ids
}

// A contributor reference for the popovers — the STABLE identity id + the
// display name. Popover render keys on `id` (Codex: display names aren't unique,
// so two "Alex"es must not collide as React keys / avatar reconciliation).
export type ContributorRef = { id: string; displayName: string }

export type ExactAromaPopoverContent = {
  ref: Extract<AromaRef, { kind: 'pair' }>
  count: number
  contributors: ContributorRef[]
  moreContributors: number
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
  contributors: ContributorRef[] // up to PREVIEW_CAP — keyed by stable id, NOT name
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
    contributors: supporters.slice(0, PREVIEW_CAP).map((c) => ({ id: c.id, displayName: c.displayName })),
    moreContributors: Math.max(0, supporters.length - PREVIEW_CAP),
    pronouncedCount: pron.pronouncedCount,
    isPanelPronounced: pron.isPanelPronounced,
  }
}

// ── Union chip popover (fallback — "who picked THIS aroma, and how") ──────────
// The agreement popover reads the consensus TREE; a fallback (union) chip has no
// tree node, so this reads the contributor index's byBase entry directly: the
// exact per-modifier breakdown (Strawberry · cooked 2 / fresh 1) + who picked it
// (Simon 2026-07-14 — union badges must be tappable to inspect contributors, and
// keep modifiers, which the base-only strip drops). No "Includes mentions of"
// (that's consensus-only) and no group-pronounced bar (agreement-level signal).
export type UnionModifier = { m: string | null; count: number }
export type UnionPopoverContent = {
  id: string
  label: string
  familyId: string
  count: number
  byModifier: UnionModifier[]
  contributors: ContributorRef[] // keyed by stable id, NOT name
  moreContributors: number
}
export function unionPopoverContent(contributors: AromaContributorIndex, id: string): UnionPopoverContent | null {
  const base = contributors.byBase.find((b) => b.baseId === id)
  if (!base) return null
  return {
    id: base.baseId,
    label: base.label,
    familyId: base.familyId,
    count: base.count,
    // Show a modifier line ONLY when there's a real distinction — a lone
    // "fresh/default" adds nothing (shared predicate: hasModifierDistinction).
    byModifier: hasModifierDistinction(base.byModifier)
      ? base.byModifier.map((g) => ({ m: g.m, count: g.count }))
      : [],
    contributors: base.contributors.slice(0, PREVIEW_CAP).map((c) => ({ id: c.id, displayName: c.displayName })),
    moreContributors: Math.max(0, base.contributors.length - PREVIEW_CAP),
  }
}

// One exact modifier-bearing badge in All Aromas or a People row. The focused
// badge keeps the TOTAL distinct-taster count, while `excludeId` lets a
// person's own row say "Also perceived by" without repeating that person.
export function exactAromaPopoverContent(
  contributors: AromaContributorIndex,
  ref: Extract<AromaRef, { kind: 'pair' }>,
  excludeId?: string,
): ExactAromaPopoverContent | null {
  const all = selectionContributors(contributors, ref)
  if (all.length === 0) return null
  const visible = excludeId ? all.filter((person) => person.id !== excludeId) : all
  return {
    ref,
    count: all.length,
    contributors: visible.slice(0, PREVIEW_CAP).map((person) => ({ id: person.id, displayName: person.displayName })),
    moreContributors: Math.max(0, visible.length - PREVIEW_CAP),
  }
}

// ── Selection + Tier 3 routing state (single-select, mutually exclusive) ───────
// One aroma OR one participant selected at a time; a new selection REPLACES the
// prior (Codex). Tapping the SAME target again clears it. `View contributors`
// produces a Tier 3 routing descriptor: Participants mode filtered to the aroma.
// SHIPS since slice 3d: the tabbed detail sheet runs one reducer instance PER
// TAB, so each view preserves its own focus without leaking muting/highlighting
// into another. Within a view the selection drives the ruled tap behaviours:
// an agreement chip
// highlights + shows its subsumed contributors, an All-aromas chip its exact
// pair's, a participant highlights their supported branches / expands their
// row. Never a nested popover or sheet.

// A discriminated aroma reference (Codex rounds 1+2, 2026-07-15): the SAME
// aroma id names THREE different supporter sets depending on where it was
// tapped —
//   node: an agreement/tree node — contributors resolve upward-SUBSUMED via
//         the agreement map (a strawberry pick supports Berry and Fruity).
//   base: a union (fallback) badge — the base aroma across ALL its modifiers,
//         LITERAL picks only, no subsumption (one taster's coarse Fruity pick
//         is not joined by their strawberry pick — the round-2 repro).
//   pair: one exact (base, modifier) row from the All-aromas read.
// A plain string couldn't tell node from pair (round 1); node vs base diverge
// on mixed-grain panels (round 2), so the kind is explicit at every tap site.
export type AromaRef =
  | { kind: 'node'; a: string }
  | { kind: 'base'; a: string }
  | { kind: 'pair'; a: string; m: string | null }
export const sameAromaRef = (x: AromaRef, y: AromaRef): boolean =>
  x.kind === y.kind && x.a === y.a && (x.kind !== 'pair' || y.kind !== 'pair' || x.m === y.m)

export type CompareSelection =
  | { kind: 'none' }
  | { kind: 'aroma'; ref: AromaRef }
  | { kind: 'participant'; id: string }

export type CompareSelectionAction =
  | { type: 'tapAroma'; ref: AromaRef }
  | { type: 'tapParticipant'; id: string }
  | { type: 'clear' }

export function compareSelectionReducer(state: CompareSelection, action: CompareSelectionAction): CompareSelection {
  if (action.type === 'clear') return { kind: 'none' }
  if (action.type === 'tapAroma') {
    return state.kind === 'aroma' && sameAromaRef(state.ref, action.ref) ? { kind: 'none' } : { kind: 'aroma', ref: action.ref }
  }
  // tapParticipant — replaces any aroma selection too (mutually exclusive).
  return state.kind === 'participant' && state.id === action.id ? { kind: 'none' } : { kind: 'participant', id: action.id }
}

// Resolve a selection's contributors at ITS OWN granularity (the discriminant's
// whole point): node → the agreement map (subsumed); base → the base group's
// contributor set (literal picks, all modifiers); pair → the (base, modifier)
// group's own set. Unknown ids → [] (read-path safety; the sheet treats an
// empty resolution as "selection no longer exists").
export function selectionContributors(contrib: AromaContributorIndex, ref: AromaRef): ReadonlyArray<AromaContributor> {
  if (ref.kind === 'node') return contrib.agreement.get(ref.a) ?? []
  const base = contrib.byBase.find((b) => b.baseId === ref.a)
  if (!base) return []
  if (ref.kind === 'base') return base.contributors
  const grp = base.byModifier.find((g) => g.m === ref.m)
  return grp ? grp.contributors : []
}

// The consensus branches a base/pair selection SUPPORTS — the pick's own
// upward chain (modifiers never change the chain). The Agreement tab dims to
// this set contextually instead of accenting a consensus node: the node's
// count describes a broader (subsumed) population than the selection's own
// contributors, and pairing that count with these names would lie (Codex
// round 2). Only a NODE selection accents a consensus node directly.
export function aromaAncestorIds(a: string): ReadonlySet<string> {
  const node = getAromaNode(a)
  if (!node) return new Set()
  return new Set(aromaAncestorChain(node))
}

// Read-path predicate shared by CompareBody's card admission and the aroma
// model's respondent semantics. A raw non-empty array is not sufficient:
// historical unknown/re-homed ids are safely ignored by the aggregate.
export function hasResolvableAroma(
  aromas: ReadonlyArray<{ a: string }> | null | undefined,
): boolean {
  return aromas?.some((selection) => getAromaNode(selection.a) !== undefined) ?? false
}

// One exact pick's identity key — matches all-aromas chips by (a, m), NOT by
// row.key (a collapsed no-distinction row keys as the bare id).
export const pickKey = (a: string, m: string | null): string => `${a}|${m ?? ''}`

// The exact picks FEEDING an agreement node (for muting the All-aromas grid to
// a tree selection): the union of the node's supporters' supporting picks.
export function supportingPickKeys(contrib: AromaContributorIndex, nodeId: string): Set<string> {
  const keys = new Set<string>()
  for (const c of contrib.agreement.get(nodeId) ?? []) for (const p of c.picks) keys.add(pickKey(p.a, p.m))
  return keys
}

// Every agreement node a participant supports (for highlighting their branches
// in the consensus tree). Upward-subsumed for free — the agreement map already is.
export function supportedNodeIds(contrib: AromaContributorIndex, participantId: string): Set<string> {
  const ids = new Set<string>()
  for (const [id, cs] of contrib.agreement) if (cs.some((c) => c.id === participantId)) ids.add(id)
  return ids
}

export type Tier3Mode = 'agreement' | 'participants' | 'all'
export type Tier3Route = { mode: Tier3Mode; aromaFilter: AromaRef | null }

// The detail sheet's available tabs (slice 3d, Simon 2026-07-15): Agreement
// exists only when the panel agrees; People sits before All Aromas because the
// human read is more useful than the exhaustive inventory. Fallback mode
// therefore opens on People. First entry = the default tab without a route.
export function tier3Tabs(hasAgreement: boolean): Tier3Mode[] {
  return hasAgreement ? ['agreement', 'participants', 'all'] : ['participants', 'all']
}

// `View contributors` on a popover aroma → open/mutate Tier 3 in Participants
// mode filtered to that aroma. Same descriptor whether opening the sheet
// (Tier 2) or mutating it in place — the CALLER decides which; this only names
// the target state, never opens a nested sheet. The caller also owns the ref's
// KIND (round-2 fix): an agreement popover passes a node ref (subsumed), a
// union/fallback popover a base ref (literal picks only) — the route never
// invents a granularity.
export function viewContributorsRoute(ref: AromaRef): Tier3Route {
  return { mode: 'participants', aromaFilter: ref }
}

// ── The ONE derived compare-aroma model (Codex architecture ruling, 2026-07-15) ─
// Everything the production strip + sheet render is derived HERE, once per card:
// consensus result, contributor index, the agreement/fallback mode fork, the
// Tier-2 strip (consensus chips or the flat union), the modifier-preserving
// all-aromas rows, and the group-pronounced id set. CompareBody computes this in
// one memo and passes it to both surfaces — the strip and its own detail sheet
// can never drift on a duplicated predicate/constant again.

// A real modifier distinction: >1 distinct modifier, or a single NON-default
// one — a lone fresh/default adds nothing over the base chip.
export function hasModifierDistinction(mods: AromaBaseGroup['byModifier']): boolean {
  return mods.length > 1 || (mods.length === 1 && mods[0].m !== null)
}

// All Aromas now shows the literal stored selections as canonical badges:
// `3x Strawberry`, `2x Strawberry, Jammy`, etc. The modifier stays inside the
// same badge anatomy used on impression detail; there is no analytical
// base-heading + modifier-tally hierarchy. Count = distinct tasters who made
// this exact (aroma, modifier) pick, and every row therefore carries a PAIR
// ref. Mentions is one flat occurrence-ranked field; Family only groups these
// same rows under family headers. Family groups are ranked by the SUM of their
// literal family/subfamily/leaf mention rows; rows inside each family remain
// occurrence-ranked. Taxonomy order is only the deterministic tie-break.
export type AromaMentionRow = {
  a: string
  m: string | null
  count: number
  familyId: string
  ref: Extract<AromaRef, { kind: 'pair' }>
}

export type AromaMentionSort = 'occurrence' | 'family'
export type AromaMentionFamily = { familyId: string; label: string; totalCount: number; rows: AromaMentionRow[] }

const modifierRank = (m: string | null) => (m === null ? '' : m)
const compareMentionRows = (a: AromaMentionRow, b: AromaMentionRow) =>
  b.count - a.count
  || taxRank(a.a) - taxRank(b.a)
  || modifierRank(a.m).localeCompare(modifierRank(b.m))

export function sortAromaMentions(rows: ReadonlyArray<AromaMentionRow>, sort: AromaMentionSort): AromaMentionRow[] {
  if (sort === 'family') return groupAromaMentions(rows).flatMap((family) => family.rows)
  return [...rows].sort(compareMentionRows)
}

export function groupAromaMentions(rows: ReadonlyArray<AromaMentionRow>): AromaMentionFamily[] {
  return AROMA_FAMILIES.map((family) => {
    const familyRows = rows.filter((row) => row.familyId === family.id).sort(compareMentionRows)
    return {
      familyId: family.id,
      label: family.label,
      totalCount: familyRows.reduce((sum, row) => sum + row.count, 0),
      rows: familyRows,
    }
  })
    .filter((family) => family.rows.length > 0)
    .sort((a, b) => b.totalCount - a.totalCount || taxRank(a.familyId) - taxRank(b.familyId))
}

const searchText = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim()
const matchesTerms = (haystack: string, query: string) => {
  const terms = searchText(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const normalized = searchText(haystack)
  return terms.every((term) => normalized.includes(term))
}
const aromaSearchWords = (a: string, m: string | null) => {
  const node = getAromaNode(a)
  if (!node) return `${a} ${m ?? ''}`
  return [
    a,
    node.label,
    node.family.label,
    node.subfamily?.label ?? '',
    m ?? '',
    m ? aromaModifierDisplay(a, m) : '',
  ].join(' ')
}

export function filterAromaMentions(rows: ReadonlyArray<AromaMentionRow>, query: string): AromaMentionRow[] {
  if (!query.trim()) return [...rows]
  return rows.filter((row) => matchesTerms(aromaSearchWords(row.a, row.m), query))
}

export function filterAromaParticipants(people: ReadonlyArray<AromaContributor>, query: string): AromaContributor[] {
  if (!query.trim()) return [...people]
  return people.filter((person) =>
    matchesTerms(
      `${person.displayName} ${person.picks.map((pick) => aromaSearchWords(pick.a, pick.m)).join(' ')}`,
      query,
    ))
}

// People-search focus inside one respondent row. A family query such as
// "Fruity" matches every descendant Fruity pick because aromaSearchWords
// includes the resolved family label. The renderer moves these exact pairs to
// the front and mutes the rest; a name-only query returns an empty set, so that
// person's full aroma row stays normally coloured.
export function matchingParticipantPickKeys(person: AromaContributor, query: string): ReadonlySet<string> {
  if (!query.trim()) return new Set()
  return new Set(
    person.picks
      .filter((pick) => matchesTerms(aromaSearchWords(pick.a, pick.m), query))
      .map((pick) => pickKey(pick.a, pick.m)),
  )
}

// ── People-tab taste similarity ───────────────────────────────────────────────
// A compact human summary, computed only while the detail sheet is mounted.
// Each pick becomes a weighted taxonomy signature:
//   family 1 · subfamily 2 · leaf 3 · explicit modifier 1
// and people are compared with weighted Sørensen-Dice. This rewards exact
// matches most, still recognises two different Berry leaves as related, and
// treats a coarse family pick as weaker evidence than a shared leaf. Pronounced
// is confidence, not aroma identity, so it never affects similarity.
export type AromaTastePerson = { id: string; displayName: string }
export type AromaTastePair = { people: readonly [AromaTastePerson, AromaTastePerson]; score: number }
export type AromaTasteGroupMember = { person: AromaTastePerson; score: number }
export type AromaTasteSummary = {
  respondents: number
  /** EVERY pair, best overlap first (stable i<j roster order on ties) — the
      stat cards' tap-through ranking source. */
  pairs: readonly AromaTastePair[]
  /** Every respondent by mean pair overlap, highest first (stable). */
  group: readonly AromaTasteGroupMember[]
  closestPair: AromaTastePair
  farthestPair: AromaTastePair
  closestToGroup: AromaTasteGroupMember
  mostIndividual: AromaTasteGroupMember
}

const putTasteSignal = (signals: Map<string, number>, key: string, weight: number) => {
  signals.set(key, Math.max(signals.get(key) ?? 0, weight))
}
function tasteSignals(person: AromaContributor): Map<string, number> {
  const signals = new Map<string, number>()
  for (const pick of person.picks) {
    const node = getAromaNode(pick.a)
    if (!node) continue
    putTasteSignal(signals, `node:${node.family.id}`, 1)
    if (node.subfamily) putTasteSignal(signals, `node:${node.subfamily.id}`, 2)
    if (node.leaf) putTasteSignal(signals, `node:${node.leaf.id}`, 3)
    if (pick.m) putTasteSignal(signals, `modifier:${pick.a}:${pick.m}`, 1)
  }
  return signals
}
function tasteScore(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let totalA = 0
  let totalB = 0
  let shared = 0
  for (const weight of a.values()) totalA += weight
  for (const weight of b.values()) totalB += weight
  for (const [key, weight] of a) shared += Math.min(weight, b.get(key) ?? 0)
  return totalA + totalB > 0 ? Math.round((200 * shared) / (totalA + totalB)) : 0
}

export function aromaTasteSummary(people: ReadonlyArray<AromaContributor>): AromaTasteSummary | null {
  // Minimum THREE respondents (Simon, 2026-07-17): with two, every stat names
  // the same pair — closest, farthest, and both group extrema carry nothing.
  if (people.length < 3) return null
  const refs = people.map((person): AromaTastePerson => ({ id: person.id, displayName: person.displayName }))
  const signals = people.map(tasteSignals)
  const totals = Array.from({ length: people.length }, () => 0)
  const pairCounts = Array.from({ length: people.length }, () => 0)
  let closestPair: AromaTastePair | null = null
  let farthestPair: AromaTastePair | null = null
  const allPairs: AromaTastePair[] = []

  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const score = tasteScore(signals[i], signals[j])
      const pair: AromaTastePair = { people: [refs[i], refs[j]], score }
      allPairs.push(pair)
      if (!closestPair || score > closestPair.score) closestPair = pair
      if (!farthestPair || score < farthestPair.score) farthestPair = pair
      totals[i] += score
      totals[j] += score
      pairCounts[i]++
      pairCounts[j]++
    }
  }

  const group = refs.map((person, i): AromaTasteGroupMember => ({
    person,
    score: pairCounts[i] > 0 ? Math.round(totals[i] / pairCounts[i]) : 0,
  }))
  const closestToGroup = group.reduce((best, current) => (current.score > best.score ? current : best))
  const mostIndividual = group.reduce((best, current) => (current.score < best.score ? current : best))
  // Stable sorts: ties keep i<j / roster encounter order, so the sorted heads
  // agree with the reduce-picked extremes above.
  allPairs.sort((x, y) => y.score - x.score)
  const sortedGroup = [...group].sort((x, y) => y.score - x.score)

  return {
    respondents: people.length,
    pairs: allPairs,
    group: sortedGroup,
    closestPair: closestPair!,
    farthestPair: farthestPair!,
    closestToGroup,
    mostIndividual,
  }
}

// ── Taste-detail evidence ─────────────────────────────────────────────────────
// WHY a pair scores what it scores: the shared signals resolved back to
// displayable nodes, strongest grain first. `exact` = the same canonical
// (aroma, modifier) pick on both sides (any tier — two plain Berry picks land
// here). `leaves` = the same leaf reached through different modifiers.
// `related` = shared subfamily/family territory NOT already represented by a
// finer shared node (a shared subfamily suppresses its family, a shared leaf
// suppresses both). Mirrors the tasteSignals weights (leaf 3 · subfamily 2 ·
// family 1), so the chips are the score's actual ingredients. Ordered by the
// first person's pick order — deterministic, poll-stable.
export type AromaTasteEvidence = {
  exact: ReadonlyArray<{ a: string; m: string | null }>
  leaves: ReadonlyArray<string>
  related: ReadonlyArray<{ id: string; label: string }>
}
export function tasteSharedEvidence(a: AromaContributor, b: AromaContributor): AromaTasteEvidence {
  const sig = (person: AromaContributor) => {
    const exact = new Map<string, { a: string; m: string | null }>()
    const leaves = new Set<string>()
    const subs = new Set<string>()
    const fams = new Set<string>()
    for (const pick of person.picks) {
      const node = getAromaNode(pick.a)
      if (!node) continue
      if (!exact.has(pickKey(pick.a, pick.m))) exact.set(pickKey(pick.a, pick.m), { a: pick.a, m: pick.m })
      if (node.leaf) leaves.add(node.leaf.id)
      if (node.subfamily) subs.add(node.subfamily.id)
      fams.add(node.family.id)
    }
    return { exact, leaves, subs, fams }
  }
  const A = sig(a)
  const B = sig(b)
  const exact = [...A.exact.entries()].filter(([k]) => B.exact.has(k)).map(([, pick]) => pick)
  const exactAs = new Set(exact.map((pick) => pick.a))
  const leaves = [...A.leaves].filter((id) => B.leaves.has(id) && !exactAs.has(id))
  const coveredSubs = new Set<string>()
  const coveredFams = new Set<string>()
  for (const id of [...exactAs, ...leaves]) {
    const node = getAromaNode(id)
    if (!node) continue
    if (node.subfamily) coveredSubs.add(node.subfamily.id)
    coveredFams.add(node.family.id)
  }
  const related: Array<{ id: string; label: string }> = []
  for (const id of A.subs) {
    if (!B.subs.has(id) || coveredSubs.has(id)) continue
    const node = getAromaNode(id)
    if (!node) continue
    coveredFams.add(node.family.id)
    related.push({ id, label: node.label })
  }
  for (const id of A.fams) {
    if (!B.fams.has(id) || coveredFams.has(id)) continue
    related.push({ id, label: getAromaNode(id)?.label ?? id })
  }
  return { exact, leaves, related }
}

// The Aroma Bun consumes the COMPLETE counted consensus summary, not the
// compact Tier-2 strip. Context + peak nodes therefore remain available even
// when the two-line strip only has room for its primary/secondary heads.
// Headings are structural only (counted=false), so they never become data
// segments. Counts are relative agreement strengths; ancestor and descendant
// supporter sets may overlap and must not be summed as a panel total.
export type CompareAromaBunNote = {
  id: string
  label: string
  count: number
  familyId: string
  role: 'context' | 'primary' | 'secondary' | 'peak'
}

export function consensusBunNotes(result: AromaConsensusResult): CompareAromaBunNote[] {
  const notes: CompareAromaBunNote[] = []
  const walk = (dn: ConsensusDisplayNode) => {
    if (dn.counted && dn.role !== 'heading') {
      notes.push({
        id: dn.node.id,
        label: dn.node.label.length > 0 ? dn.node.label[0].toUpperCase() + dn.node.label.slice(1) : dn.node.label,
        count: dn.node.count,
        familyId: dn.node.familyId,
        role: dn.role,
      })
    }
    dn.children.forEach(walk)
  }
  result.roots.forEach(walk)
  return notes.sort((a, b) => b.count - a.count || taxRank(a.id) - taxRank(b.id))
}

export type CompareAromaModel = {
  result: AromaConsensusResult
  contrib: AromaContributorIndex
  /** True iff the panel shares at least one node (n>=2 with displayable roots) —
      the strip shows consensus and the sheet the tree; false → union fallback. */
  hasAgreement: boolean
  /** Tier-2 chips: consensus primaries+secondaries, or the flat union fallback. */
  strip: StripChip[]
  /** Exact modifier-bearing aroma badges, occurrence-ranked by default. */
  allAromas: AromaMentionRow[]
  /** Consensus node ids clearing the group-pronounced bar (PRON_BAR). */
  pronouncedIds: ReadonlySet<string>
  /** Full counted consensus summary for the Aroma Bun; no Tier-2 line cap. */
  bun: CompareAromaBunNote[]
}

// Stable semantic key for the model input. Compare's poll rebuilds fresh item
// objects even when aromas are unchanged; keying the memo by this value avoids
// rebuilding every collapsed card's consensus/contributor tree every 5s.
export function compareAromaInputSignature(raters: ReadonlyArray<AromaContributorInput>): string {
  return JSON.stringify(raters.map((rater) => [
    rater.id,
    rater.displayName,
    (rater.aromas ?? []).map((selection) => [selection.a, selection.m, selection.p === true ? 1 : 0]),
  ]))
}

export function buildCompareAromaModel(raters: ReadonlyArray<AromaContributorInput>): CompareAromaModel {
  // No opts → aromaConsensus bakes the ruled defaults (majority / 1/3).
  const result = aromaConsensus(aggregateAromaRollup(raters.map((x) => (x.aromas ?? []).map((a) => ({ a: a.a, m: a.m })))))
  const contrib = buildAromaContributors(raters)
  const hasAgreement = result.n >= 2 && result.roots.length > 0
  const pronouncedIds = pronouncedNodeIds(result, contrib, PRON_BAR)
  const strip = hasAgreement ? tier2Strip(result, pronouncedIds) : unionStrip(contrib)
  const allAromas = sortAromaMentions(
    contrib.byBase.flatMap((base) =>
      base.byModifier.map((modifier): AromaMentionRow => ({
        a: base.baseId,
        m: modifier.m,
        count: modifier.count,
        familyId: base.familyId,
        ref: { kind: 'pair', a: base.baseId, m: modifier.m },
      }))),
    'occurrence',
  )
  const bun = hasAgreement ? consensusBunNotes(result) : []
  return { result, contrib, hasAgreement, strip, allAromas, pronouncedIds, bun }
}

// ── Detail-pill colours (pure; pinned per-theme in the harness) ────────────────
// The "Aroma Details" pill wants the moments-filter activated-chip look
// (accentTint fill + accentLine border + accent text), but accent-on-tint fails
// 4.5:1 on apricot/clay, and on clay even ink-on-tint fails (~2.85). Ladder
// (Codex contrast ruling, 2026-07-15): accent text on the tint where it reads;
// else ink text on the tint; else the SOLID accent fill with accentInk (clears
// >=5.8:1 on every current theme). Pure over the token values so the harness
// asserts >=4.5 for all six themes — never device-eyeball-only.
export type DetailPillColors = { bg: string; border: string; ink: string }
export function detailPillColors(t: {
  accent: string; accentTint: string; accentLine: string; accentInk: string; ink: string; surface: string
}): DetailPillColors {
  const flat = flattenRgbaOver(t.accentTint, t.surface)
  if (contrastRatio(t.accent, flat) >= 4.5) return { bg: t.accentTint, border: t.accentLine, ink: t.accent }
  if (contrastRatio(t.ink, flat) >= 4.5) return { bg: t.accentTint, border: t.accentLine, ink: t.ink }
  return { bg: t.accent, border: t.accent, ink: t.accentInk }
}
// Flatten an `rgba(r,g,b,a)` token over an opaque hex base → `rgb()` (what the
// tint actually composites to on the card), so contrast math sees real pixels.
export function flattenRgbaOver(rgba: string, baseHex: string): string {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i.exec(rgba.trim())
  if (!m) return rgba
  const a = Number(m[4])
  const h = baseHex.replace('#', '')
  const ch = (i: number) => parseInt(h.slice(i, i + 2), 16)
  const r = Math.round(Number(m[1]) * a + ch(0) * (1 - a))
  const g = Math.round(Number(m[2]) * a + ch(2) * (1 - a))
  const b = Math.round(Number(m[3]) * a + ch(4) * (1 - a))
  return `rgb(${r},${g},${b})`
}
