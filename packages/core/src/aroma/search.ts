// Aroma search — the input-time query resolver (aroma-layer.md §2's
// searchIndex, built in PR B). Pure + platform-free like the rest of core.
// Matches nodes at ALL tiers (any-tier ruling) by label + per-leaf
// search_aliases, and resolves modifier VOCABULARY inside the same query —
// "dried fig" → fig + dried, "jammy strawberry" → strawberry + cooked.
// Modifier words only count against nodes whose effective allowed set
// contains that modifier, so "pickled lemon" surfaces nothing. Results are
// canonicalized like the write gate (grape + dried → raisin), so search can
// never hand the UI a pair the gate would rewrite. The index is built lazily
// once (~440 nodes); every query is a linear scan over it — fine at this size.

import {
  AROMA_FAMILIES,
  AROMA_MODIFIERS,
  aromaAllowedModifiers,
  aromaModifierDisplay,
  gateAromaSelections,
  getAromaNode,
  type AromaNode,
} from './taxonomy'

export type AromaSearchResult = {
  node: AromaNode
  // Modifier resolved FROM the query text — never invented. Null = plain node.
  m: string | null
  // The badge word for `m` on this node (per-leaf display override or the
  // modifier label — "jammy", "dried"). Null exactly when `m` is null. The UI
  // composes `${modifierWord} ${node.label}` with its own styling.
  modifierWord: string | null
  // Ancestor labels above the node (family, then subfamily for a leaf) — the
  // disambiguator for the four leaf labels that equal a subfamily label
  // (honey / vanilla / cocoa / char) and general "where is this?" context.
  context: string[]
}

type NodeEntry = { id: string; words: string[]; context: string[] }
type ModifierWord = { word: string; modId: string }

// Match quality per token, lower = better: exact node word (0), node-word
// prefix (1), node-word substring (2), fuzzy node word (3), then the same
// ladder over modifier vocabulary (+4, below the worst node tier). A
// result's score is the sum over tokens; ties keep index order (families →
// subfamilies → leaves, taxonomy order), which reads as tree order in the
// result list.
const NO_MATCH = Infinity

// ── forgiving matching — the app-wide search ruling (Simon, 2026-07-03):
// diacritic-insensitive, small typos excused. Semantics mirror the native
// fuzzyIncludes (apps/mobile/src/lib/search.ts): typo budget by token length
// (<4 exact, 4–6 one edit, ≥7 two), OSA distance (transposition = 1 edit),
// prefix-fuzzy for mid-typing. Kept here so BOTH platforms search aromas the
// same way; consolidating the mobile twin onto these primitives is a noted
// future dedupe.
const FOLD: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th', ð: 'd' }
export function normalizeSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ßæœøđłþð]/g, (ch) => FOLD[ch]!)
}

function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false
  let prevPrev: number[] | null = null
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevPrev[j - 2] + 1)
      }
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return false
    prevPrev = prev
    prev = cur
  }
  return prev[b.length] <= max
}

// Fuzzy hit for one token against one (multi-)word: any haystack word within
// the token's typo budget, or a typo'd INFIX of a longer word — a sliding
// window sized token±tol ("verry" lands on the "berry" inside "strawberry";
// the window generalizes the prefix-fuzzy case). The DP grids are tiny
// (token × window), so the scan stays cheap even per keystroke.
function fuzzyHits(token: string, word: string): boolean {
  const tol = token.length >= 7 ? 2 : token.length >= 4 ? 1 : 0
  if (tol === 0) return false
  return word.split(' ').some((w) => {
    if (withinDistance(w, token, tol)) return true
    for (let L = token.length - tol; L <= token.length + tol; L++) {
      if (L <= 0 || L > w.length) continue
      for (let start = 0; start + L <= w.length; start++) {
        if (withinDistance(w.slice(start, start + L), token, tol)) return true
      }
    }
    return false
  })
}

function wordVariants(raw: string): string[] {
  const w = normalizeSearch(raw)
  const stripped = w.replace(/[^a-z0-9 ]/g, '') // "(over)ripe" → "overripe"
  return stripped && stripped !== w ? [w, stripped] : [w]
}

let INDEX: { entries: NodeEntry[]; modifierWords: ModifierWord[]; leafModifierWords: Map<string, ModifierWord[]> } | null = null

function buildIndex() {
  if (INDEX) return INDEX
  const entries: NodeEntry[] = []
  const modifierWords: ModifierWord[] = []
  const leafModifierWords = new Map<string, ModifierWord[]>()
  for (const mod of AROMA_MODIFIERS) {
    for (const raw of [mod.label, ...(mod.search_aliases ?? [])])
      for (const word of wordVariants(raw)) modifierWords.push({ word, modId: mod.id })
  }
  for (const family of AROMA_FAMILIES) {
    entries.push({ id: family.id, words: wordVariants(family.label), context: [] })
    for (const subfamily of family.subfamilies) {
      entries.push({ id: subfamily.id, words: wordVariants(subfamily.label), context: [family.label] })
      for (const leaf of subfamily.leaves) {
        const words = wordVariants(leaf.label)
        for (const alias of leaf.search_aliases ?? []) words.push(...wordVariants(alias))
        entries.push({ id: leaf.id, words, context: [family.label, subfamily.label] })
        if (leaf.modifier_display) {
          const own: ModifierWord[] = []
          for (const [modId, word] of Object.entries(leaf.modifier_display))
            for (const variant of wordVariants(word)) own.push({ word: variant, modId })
          leafModifierWords.set(leaf.id, own)
        }
      }
    }
  }
  INDEX = { entries, modifierWords, leafModifierWords }
  return INDEX
}

function hit(token: string, word: string): number {
  if (word === token) return 0
  if (word.startsWith(token)) return 1
  if (word.includes(token)) return 2
  if (fuzzyHits(token, word)) return 3
  return NO_MATCH
}

export function searchAromas(query: string, limit = 60): AromaSearchResult[] {
  const tokens = normalizeSearch(query.trim()).split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  const { entries, modifierWords, leafModifierWords } = buildIndex()
  const scored: { entry: NodeEntry; score: number; m: string | null }[] = []
  for (const entry of entries) {
    const allowed = aromaAllowedModifiers(entry.id)
    const ownWords = leafModifierWords.get(entry.id)
    let score = 0
    let m: string | null = null
    let ok = true
    for (const token of tokens) {
      let best = NO_MATCH
      for (const word of entry.words) best = Math.min(best, hit(token, word))
      if (best === NO_MATCH) {
        // Node words missed — try modifier vocabulary gated to this node
        // (+4 keeps every modifier tier below the worst node tier, fuzzy=3).
        let bestMod: string | null = null
        for (const mw of modifierWords) {
          if (!allowed.has(mw.modId)) continue
          const q = hit(token, mw.word)
          if (q + 4 < best) { best = q + 4; bestMod = mw.modId }
        }
        if (ownWords) for (const mw of ownWords) {
          const q = hit(token, mw.word)
          if (q + 4 < best) { best = q + 4; bestMod = mw.modId }
        }
        // Two tokens resolving to two DIFFERENT modifiers is compound
        // nonsense ("dried pickled fig") — no single selection encodes it.
        if (bestMod === null || (m !== null && m !== bestMod)) { ok = false; break }
        m = bestMod
      }
      score += best
    }
    if (ok) scored.push({ entry, score, m })
  }
  scored.sort((a, b) => a.score - b.score)
  const out: AromaSearchResult[] = []
  const seen = new Set<string>()
  for (const { entry, m } of scored) {
    if (out.length >= limit) break
    // Canonicalize exactly like the gate — a promoted composite (grape +
    // dried) surfaces as its promoted leaf (raisin), deduped against a
    // direct label/alias hit on that same leaf.
    const gated = gateAromaSelections([{ a: entry.id, m }]).value
    if (!gated?.length) continue
    const { a: canonA, m: canonM } = gated[0]
    const key = `${canonA} ${canonM ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const node = getAromaNode(canonA)
    if (!node) continue
    const context = canonA === entry.id ? entry.context
      : node.tier === 'leaf' ? [node.family.label, node.subfamily!.label]
      : node.tier === 'subfamily' ? [node.family.label] : []
    out.push({ node, m: canonM, modifierWord: canonM ? aromaModifierDisplay(canonA, canonM) : null, context })
  }
  return out
}
