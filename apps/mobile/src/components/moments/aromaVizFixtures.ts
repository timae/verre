// Fixed sample data for comparing the three aroma visualisations (Simon's
// fixture, promoted from .local/aroma-viz-fixtures.ts so the dev gallery can
// import it — gallery/lab data only, no production surface).
//
// Counting rule for these visualisations:
// every stored aroma pick is one mention for its family and one mention at the
// exact grain selected. Strawberry + Raspberry therefore gives Fruity 2, while
// a coarse Fruity pick gives Fruity 1 without inventing a child aroma.

import {
  AROMA_FAMILIES,
  getAromaNode,
  isValidAromaSelection,
  type AromaSelection,
} from '@verre/core'

export type AromaVizRater = {
  readonly id: string
  readonly displayName: string
  readonly aromas: ReadonlyArray<AromaSelection>
}

export type AromaVizFamily = {
  readonly id: string
  readonly label: string
  readonly count: number
  readonly tasters: number
  readonly notes: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly count: number
    readonly tier: 'family' | 'subfamily' | 'leaf'
  }>
}

// Compact chart copy for labels whose taxonomy wording is intentionally
// explanatory in pickers but too long for a proportional spiral segment.
// Canonical labels remain in `label` and should be used by inspection UI.
const SHORT_VIZ_LABELS: Readonly<Record<string, string>> = {
  'fresh-cut grass': 'cut grass',
  'black pepper': 'pepper',
  'Pungent spice': 'pungent',
  'Warm / baking spice': 'baking spice',
  'Caramel & sugar': 'toffee/sugar',
  'White flowers': 'white floral',
  'Red / pink flowers': 'red floral',
  'Green / leafy': 'leafy',
  'Sulphury / eggy': 'sulphur',
  'petrol / kerosene': 'petrol',
  'Yeasty / leesy': 'lees',
  'Animal / barnyard': 'animal',
  'Toasted / baked': 'toasted',
  'Stone / rock': 'stone',
  'Brothy / meaty': 'meaty',
  'Tree nuts': 'nuts',
}

export function aromaVizShortLabel(label: string): string {
  const compact = SHORT_VIZ_LABELS[label] ?? label
  return compact.length > 0 ? compact[0].toUpperCase() + compact.slice(1) : compact
}

const p = (a: string, m: string | null = null, pronounced = false): AromaSelection =>
  pronounced ? { a, m, p: true } : { a, m }

const NAMES = [
  'Ana', 'Ben', 'Camille', 'Dario', 'Elise',
  'Farah', 'Gabriel', 'Hana', 'Ivo', 'Jia',
  'Karim', 'Lina', 'Mateo', 'Noor', 'Olivia',
  'Pavel', 'Quinn', 'Rosa', 'Sacha', 'Theo',
] as const

const PROFILES: ReadonlyArray<ReadonlyArray<AromaSelection>> = [
  [p('strawberry', null, true), p('raspberry'), p('fruity.berry'), p('fruity')],
  [p('lemon', null, true), p('lime'), p('fruity.citrus'), p('wet_stone')],
  [p('oak', 'smoked', true), p('cedar'), p('woody'), p('vanilla')],
  [p('cut_grass', null, true), p('vegetal.green'), p('vegetal'), p('cucumber')],
  [p('skunky', null, true), p('chemical.sulphur'), p('petrol'), p('chemical')],
  [p('rose', null, true), p('violet'), p('floral.red'), p('elderflower')],
  [p('black_pepper', null, true), p('clove'), p('spice.pungent'), p('spice')],
  [p('barnyard', null, true), p('funky.animal'), p('funky'), p('woodsmoke')],
  [p('honey', null, true), p('vanilla'), p('caramel'), p('sweet')],
  [p('strawberry', 'cooked', true), p('lingonberry'), p('blackcurrant'), p('fruity.berry')],
]

const ALL_NODE_IDS = AROMA_FAMILIES.flatMap((family) => [
  family.id,
  ...family.subfamilies.flatMap((subfamily) => [
    subfamily.id,
    ...subfamily.leaves.map((leaf) => leaf.id),
  ]),
])

// A bounded, taxonomy-wide tail for the 20-person panel. It keeps meaningful
// overlap instead of turning nearly every one of the 200 picks into a singleton.
const SMALL_TAIL_NODE_IDS = AROMA_FAMILIES.flatMap((family) => {
  const subfamily = family.subfamilies[0]
  return [family.id, subfamily.id, ...subfamily.leaves.slice(0, 2).map((leaf) => leaf.id)]
})

function fillWithTail(
  core: ReadonlyArray<AromaSelection>,
  wanted: number,
  seed: number,
  pool: ReadonlyArray<string> = ALL_NODE_IDS,
): AromaSelection[] {
  const out = [...core]
  const used = new Set(out.map((selection) => JSON.stringify([selection.a, selection.m])))
  let cursor = seed % pool.length
  while (out.length < wanted) {
    const selection = p(pool[cursor])
    cursor = (cursor + 17) % pool.length
    const key = JSON.stringify([selection.a, selection.m])
    if (used.has(key)) continue
    used.add(key)
    out.push(selection)
  }
  return out
}

// Exactly 20 people and 200 aroma picks. It includes multiple picks by the
// same person, all three taxonomy tiers, modifiers, and pronounced picks.
export const MIXED_GRAIN_20_PEOPLE_200_MENTIONS: ReadonlyArray<AromaVizRater> =
  Array.from({ length: 20 }, (_, i) => ({
    id: `mixed-${String(i + 1).padStart(2, '0')}`,
    displayName: NAMES[i],
    aromas: fillWithTail(PROFILES[i % PROFILES.length], 10, i * 23 + 7, SMALL_TAIL_NODE_IDS),
  }))

// Larger stress case: 120 people and 1,440 aroma picks across the complete
// taxonomy. The profiles provide a shared core; the deterministic tail creates
// many niche aromas and mixed-grain selections.
export const LONG_TAIL_120_PEOPLE_1440_MENTIONS: ReadonlyArray<AromaVizRater> =
  Array.from({ length: 120 }, (_, i) => ({
    id: `long-${String(i + 1).padStart(3, '0')}`,
    displayName: `Panelist ${String(i + 1).padStart(3, '0')}`,
    aromas: fillWithTail(PROFILES[i % PROFILES.length], 12, i * 41 + 13),
  }))

// Converts raw picks into additive family/note data suitable for partitioned
// rings, radial bars, and the spiral. Modifiers are preserved in the raw panel
// but collapsed here because these overview charts show the aroma itself.
export function additiveMentionFamilies(raters: ReadonlyArray<AromaVizRater>): ReadonlyArray<AromaVizFamily> {
  type MutableFamily = {
    id: string
    label: string
    count: number
    tasters: Set<string>
    notes: Map<string, { id: string; label: string; count: number; tier: 'family' | 'subfamily' | 'leaf' }>
  }
  const families = new Map<string, MutableFamily>()

  for (const rater of raters) {
    for (const selection of rater.aromas) {
      const node = getAromaNode(selection.a)
      if (!node) continue
      let family = families.get(node.family.id)
      if (!family) {
        family = { id: node.family.id, label: node.family.label, count: 0, tasters: new Set(), notes: new Map() }
        families.set(node.family.id, family)
      }
      family.count += 1
      family.tasters.add(rater.id)
      // Family-grain picks read as the plain family name (Simon round 10 —
      // no "(general)" suffix on charts).
      const label = node.label
      const note = family.notes.get(node.path)
      if (note) note.count += 1
      else family.notes.set(node.path, { id: node.path, label, count: 1, tier: node.tier })
    }
  }

  const familyOrder = new Map(AROMA_FAMILIES.map((family, i) => [family.id, i]))
  return [...families.values()]
    .map((family) => ({
      id: family.id,
      label: family.label,
      count: family.count,
      tasters: family.tasters.size,
      notes: [...family.notes.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => b.count - a.count || (familyOrder.get(a.id) ?? 999) - (familyOrder.get(b.id) ?? 999))
}

// Converts raw picks into the SUBFAMILY-grain skeleton the two-tier iris
// (aromaVizGeometry2 · variant G) reads: ALL 12 families × ALL 60 subfamilies
// in fixed taxonomy order (the fixed-fingerprint ruling — empty spokes render
// as stubs), family-grain picks counted separately (they tint the family arc,
// not a spoke), subfamily- and leaf-grain picks bucketed under their
// subfamily with per-grain aroma tallies for the tile modes.
export type AromaIrisSub = {
  readonly id: string
  readonly label: string
  readonly count: number
  readonly aromas: ReadonlyArray<{ readonly label: string; readonly count: number }>
}
export type AromaIrisFamily = {
  readonly id: string
  readonly label: string
  readonly familyCount: number
  readonly subs: ReadonlyArray<AromaIrisSub>
}

export function irisMentionFamilies(raters: ReadonlyArray<AromaVizRater>): ReadonlyArray<AromaIrisFamily> {
  const familyDirect = new Map<string, number>()
  const bySub = new Map<string, Map<string, { label: string; count: number }>>()
  for (const rater of raters) {
    for (const selection of rater.aromas) {
      const node = getAromaNode(selection.a)
      if (!node) continue
      if (node.tier === 'family') {
        familyDirect.set(node.family.id, (familyDirect.get(node.family.id) ?? 0) + 1)
        continue
      }
      const subId = node.subfamily!.id
      let grains = bySub.get(subId)
      if (!grains) {
        grains = new Map()
        bySub.set(subId, grains)
      }
      const grain = grains.get(node.path)
      if (grain) grain.count += 1
      else grains.set(node.path, { label: node.label, count: 1 })
    }
  }
  return AROMA_FAMILIES.map((family) => ({
    id: family.id,
    label: family.label,
    familyCount: familyDirect.get(family.id) ?? 0,
    subs: family.subfamilies.map((subfamily) => {
      const grains = bySub.get(subfamily.id)
      const aromas = grains ? [...grains.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)) : []
      return {
        id: subfamily.id,
        label: subfamily.label,
        count: aromas.reduce((sum, aroma) => sum + aroma.count, 0),
        aromas,
      }
    }),
  }))
}

export function assertAromaVizFixtures(): void {
  const panels = [MIXED_GRAIN_20_PEOPLE_200_MENTIONS, LONG_TAIL_120_PEOPLE_1440_MENTIONS]
  const expected = [200, 1440]
  panels.forEach((panel, index) => {
    const selections = panel.flatMap((rater) => rater.aromas)
    if (selections.length !== expected[index]) throw new Error(`panel ${index}: expected ${expected[index]} picks`)
    for (const selection of selections) {
      if (!isValidAromaSelection(selection.a, selection.m)) {
        throw new Error(`invalid pick: ${selection.a} + ${selection.m ?? 'none'}`)
      }
    }
    for (const family of additiveMentionFamilies(panel)) {
      const noteTotal = family.notes.reduce((sum, note) => sum + note.count, 0)
      if (noteTotal !== family.count) throw new Error(`${family.id}: family and note totals differ`)
    }
  })
}
