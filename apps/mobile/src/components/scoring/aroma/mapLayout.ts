import { AROMA_FAMILIES } from '@verre/core';
import { axialToPixel, combCoords, combXY } from './hexMath';

// The Map picker's territory layout — pure (no react-native imports) so the
// regression script can drive it against the real taxonomy (see
// .local/test-env/scripts/aroma-pickers-units.ts).

export type MapLevel = 1 | 2 | 3;
export const LEVEL_R: Record<MapLevel, number> = { 1: 37, 2: 46, 3: 44 };
// Per-group shade offsets at the note level (the mock's AMTS) — fraction
// toward ink, so neighbouring groups read as districts of one family.
const SHADES = [0, 0.13, 0.26, 0.07, 0.2, 0.32, 0.16, 0.09];

export type Placed = { id: string; label: string; familyId: string; groupId: string | null; x: number; y: number; shade: number };

// Territory layout — RECURSIVE BALANCED CUTS (device round 6: everything
// from one family/group must stay CONNECTED; the earlier centroid-growth
// variants kept fragmenting). The lattice is split by straight cuts along
// the axis of maximum spread into two contiguous chunks sized to the two
// halves of the quota list, recursively — every region is an intersection
// of half-plane cuts of the (convex) hex disc, so it stays one patch, and
// the max-spread axis keeps regions compact. If a cut's tie-row would
// fragment a side, the other axes are tried (connectivity-checked).
// Fully deterministic: same taxonomy → same map, no randomness anywhere.
// Verified against the real taxonomy: 60/60 + 365/365 placed, every family
// and every group one component, avg compactness 0.86 (L2) / 1.24 (L3).
const CUT_AXES: [number, number][] = [[1, 0], [0.5, Math.sqrt(3) / 2], [-0.5, Math.sqrt(3) / 2], [0, 1]];

export function placeLevel(level: MapLevel): Placed[] {
  const R = LEVEL_R[level];
  if (level === 1) {
    const fp = combXY(AROMA_FAMILIES.length, Math.sqrt(3) * R);
    return AROMA_FAMILIES.map((f, i) => ({ id: f.id, label: f.label, familyId: f.id, groupId: null, x: fp[i][0], y: fp[i][1], shade: 0 }));
  }
  const counts = AROMA_FAMILIES.map((f) =>
    level === 2 ? f.subfamilies.length : f.subfamilies.reduce((b, g) => b + g.leaves.length, 0),
  );
  const N = counts.reduce((a, b) => a + b, 0);
  const axial = combCoords(N);
  const cells = axial.map(([q, r]) => axialToPixel(q, r, R));
  const cellAt = new Map(axial.map(([q, r], i) => [`${q},${r}`, i]));
  const DIRS: [number, number][] = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  const neighbours = axial.map(([q, r]) =>
    DIRS.map(([dq, dr]) => cellAt.get(`${q + dq},${r + dr}`)).filter((x): x is number => x !== undefined),
  );

  const connected = (set: number[]): boolean => {
    if (!set.length) return true;
    const s = new Set(set);
    const stack = [set[0]];
    s.delete(set[0]);
    let seen = 1;
    while (stack.length) {
      const x = stack.pop()!;
      for (const nb of neighbours[x]) {
        if (s.has(nb)) {
          s.delete(nb);
          stack.push(nb);
          seen += 1;
        }
      }
    }
    return seen === set.length;
  };

  // Split idxs into one contiguous region per quota entry (list order).
  const partition = (idxs: number[], quotas: number[]): number[][] => {
    if (quotas.length === 1) return [idxs];
    const total = quotas.reduce((a, b) => a + b, 0);
    let acc = 0;
    let bestK = 1;
    let bestDiff = Infinity;
    let sumA = 0;
    for (let k = 1; k < quotas.length; k++) {
      acc += quotas[k - 1];
      const d = Math.abs(acc - total / 2);
      if (d < bestDiff) {
        bestDiff = d;
        bestK = k;
        sumA = acc;
      }
    }
    const spreads = CUT_AXES.map((dir) => {
      let mn = Infinity;
      let mx = -Infinity;
      for (const ci of idxs) {
        const p = cells[ci][0] * dir[0] + cells[ci][1] * dir[1];
        if (p < mn) mn = p;
        if (p > mx) mx = p;
      }
      return { dir, s: mx - mn };
    }).sort((a, b) => b.s - a.s);
    let A: number[] | null = null;
    let B: number[] | null = null;
    for (const { dir } of spreads) {
      const perp = [-dir[1], dir[0]];
      const sorted = [...idxs].sort((a, b) => {
        const pa = cells[a][0] * dir[0] + cells[a][1] * dir[1];
        const pb = cells[b][0] * dir[0] + cells[b][1] * dir[1];
        if (pa !== pb) return pa - pb;
        return cells[a][0] * perp[0] + cells[a][1] * perp[1] - (cells[b][0] * perp[0] + cells[b][1] * perp[1]);
      });
      const a = sorted.slice(0, sumA);
      const b = sorted.slice(sumA);
      if (connected(a) && connected(b)) {
        A = a;
        B = b;
        break;
      }
      if (!A) {
        A = a;
        B = b;
      }
    }
    return [...partition(A!, quotas.slice(0, bestK)), ...partition(B!, quotas.slice(bestK))];
  };

  // Families keep their design-layout neighbourhoods: ordered by angle of
  // their level-1 comb position, so cuts assign adjacent slices to
  // neighbouring families.
  const funit = combXY(AROMA_FAMILIES.length, 1);
  const order = AROMA_FAMILIES.map((_, i) => i).sort(
    (a, b) => Math.atan2(funit[a][1], funit[a][0]) - Math.atan2(funit[b][1], funit[b][0]),
  );
  const famClaims = partition(cells.map((_, i) => i), order.map((i) => counts[i]));

  const placed: Placed[] = [];
  order.forEach((i, k) => {
    const f = AROMA_FAMILIES[i];
    const idxs = famClaims[k];
    if (level === 2) {
      f.subfamilies.forEach((g, gi) => {
        const c = cells[idxs[gi]];
        placed.push({ id: g.id, label: g.label, familyId: f.id, groupId: g.id, x: c[0], y: c[1], shade: 0 });
      });
      return;
    }
    // Level 3: the same cuts partition the family region among its groups.
    const grpClaims = partition(idxs, f.subfamilies.map((g) => g.leaves.length));
    f.subfamilies.forEach((g, j) => {
      const shade = SHADES[j % SHADES.length];
      grpClaims[j].forEach((ci, li) => {
        const c = cells[ci];
        placed.push({ id: g.leaves[li].id, label: g.leaves[li].label, familyId: f.id, groupId: g.id, x: c[0], y: c[1], shade });
      });
    });
  });
  return placed;
}
