import type { LookIn, LookInAroma, LookInBottle } from './lookInWire';

// A look-in, shaped for the moment's own Compare (Moment Visibility step-2
// plan § 4.4, T13): CompareBody / CompareToolbar / ComparePickerSheet read the
// moment's wire shapes, so the look-in's first read (+ the open cards' aromas
// from the details read) becomes them here. Pure, unit-tested from the repo
// root (scripts/tests/look-in-compare-units.ts).
//
//   - bottles → WireWine-shaped rows: `id` = the stable bottle KEY (never a
//     wine id), `_blind` on blind rows (no label, no photo: CompareBody shows
//     "Impression N");
//   - named people → the roster: a registered person `u:<publicId>` (what the
//     Friends preset and the person preview expect), a guest `g:<key>` (every
//     guest check goes through lib/blockLook.ts, where anything not `u:` is a
//     guest);
//   - light ratings → RatingsView: aromas EMPTY until the details read lands
//     (a synthesised aroma would feed the aroma model a bogus input), the
//     `hasAromas` flag only enters the comparable predicate (lib/compareItems);
//   - `groupStats` from the line-up (the server's average + count over everyone
//     counted, R4);
//   - `eligible`: the cards that can have aromas (a named person flagged them),
//     the only ones the details scheduler asks for.

export type LookInWine = {
  id: string; name: string; producer: string; vintage: string; grape: string; image: string; imageUrl: string
  description?: string; region?: string; country?: string; vinification?: string; purchaseUrl?: string
  colour: string | null; sparkling: boolean; abv: number | null; entry: null; isMine: false
  addedByDisplayName: string | null; addedByUserId: string | null; _blind?: boolean
};
export type LookInRatingMeta = {
  score: number; flavors: Record<string, number>; aromas: LookInAroma[]; hasAromas?: true; notes: ''; at: 0
};
export type LookInCompare = {
  wines: LookInWine[];
  roster: { participants: { id: string; displayName: string; imageUrl: string | null }[] };
  ratings: Record<string, { displayName: string; ratings: Record<string, LookInRatingMeta> }>;
  groupStats: Map<string, { avg: number | null; count: number }>;
  eligible: Set<string>;
  // Registered people's ids (the person preview's roster).
  previewIds: string[];
};

// A named person's id in the adapted shapes.
export const lookInPersonId = (p: { key: string; id?: string; guest?: true }): string => (p.guest || !p.id ? `g:${p.key}` : `u:${p.id}`);

export function lookInWine(b: LookInBottle): LookInWine {
  const base = { id: b.key, colour: b.colour, sparkling: b.sparkling, entry: null, isMine: false as const }
  if (b.blind) {
    return { ...base, name: '', producer: '', vintage: '', grape: '', image: '', imageUrl: '', abv: null, addedByDisplayName: null, addedByUserId: null, _blind: true };
  }
  return {
    ...base,
    name: b.name, producer: b.producer ?? '', vintage: b.vintage ?? '', grape: b.grape ?? '',
    image: b.imageUrl ?? '', imageUrl: b.imageUrl ?? '', abv: b.abv,
    ...(b.description ? { description: b.description } : {}),
    ...(b.region ? { region: b.region } : {}),
    ...(b.country ? { country: b.country } : {}),
    ...(b.vinification ? { vinification: b.vinification } : {}),
    ...(b.purchaseUrl ? { purchaseUrl: b.purchaseUrl } : {}),
    addedByDisplayName: b.broughtBy?.name ?? null,
    addedByUserId: b.broughtBy?.id ?? null,
  };
}

// `aromas`: bottle key → person key → that person's aromas (the details reads).
export function adaptLookIn(look: Pick<LookIn, 'lineup' | 'people' | 'ratings'>, aromas: ReadonlyMap<string, ReadonlyMap<string, LookInAroma[]>>): LookInCompare {
  const idOf = new Map(look.people.named.map((p) => [p.key, lookInPersonId(p)]));
  const ratings: LookInCompare['ratings'] = {};
  for (const p of look.people.named) ratings[idOf.get(p.key)!] = { displayName: p.name, ratings: {} };
  const eligible = new Set<string>();
  for (const r of look.ratings) {
    const id = idOf.get(r.person);
    if (!id) continue;
    if (r.hasAromas) eligible.add(r.bottle);
    ratings[id].ratings[r.bottle] = {
      score: r.score ?? 0,
      flavors: r.flavors,
      // Only while the first read still flags them: aromas cleared since the
      // details read arrived must not linger (Codex r1).
      aromas: r.hasAromas ? aromas.get(r.bottle)?.get(r.person) ?? [] : [],
      ...(r.hasAromas ? { hasAromas: true as const } : {}),
      notes: '',
      at: 0,
    };
  }
  // A person with no rating here adds nothing to Compare (it would only
  // inflate the picker); the roster keeps everyone named, in the room's order.
  for (const id of Object.keys(ratings)) if (Object.keys(ratings[id].ratings).length === 0) delete ratings[id];
  return {
    wines: look.lineup.map(lookInWine),
    roster: { participants: look.people.named.map((p) => ({ id: idOf.get(p.key)!, displayName: p.name, imageUrl: p.imageUrl })) },
    ratings,
    groupStats: new Map(look.lineup.map((b) => [b.key, { avg: b.avg, count: b.count }])),
    eligible,
    previewIds: look.people.named.filter((p) => !p.guest && p.id).map((p) => `u:${p.id}`),
  };
}

// The details reads, merged: bottle key → person key → aromas. The latest
// answer for a bottle replaces that bottle's entry whole (a person whose
// aromas were removed leaves it).
export function mergeAromas(
  into: ReadonlyMap<string, ReadonlyMap<string, LookInAroma[]>>,
  answer: { bottles: { key: string; ratings: { person: string; aromas: LookInAroma[] }[] }[] },
): Map<string, Map<string, LookInAroma[]>> {
  const out = new Map<string, Map<string, LookInAroma[]>>([...into].map(([k, v]) => [k, new Map(v)]));
  for (const b of answer.bottles) out.set(b.key, new Map(b.ratings.map((r) => [r.person, r.aromas])));
  return out;
}
