// Pure lattice math for the honeycomb browse pickers (Map H3 / Canvas H2) —
// split out of hexStage.tsx so it stays free of react-native imports and a
// plain node/tsx script can regression-drive it (placement counts, wrap
// behaviour, clamp parity — see .local/test-env/scripts/aroma-pickers-units.ts).

/** Axial hex → pixel for flat-top hexes of circumradius R (cells touch). */
export function axialToPixel(q: number, r: number, R: number): [number, number] {
  return [1.5 * R * q, Math.sqrt(3) * R * (r + q / 2)];
}

/** n lattice cells filled centre-out, each ring vertically symmetric. */
export function combCoords(n: number): [number, number][] {
  const cells: { q: number; r: number; d: number; a: number }[] = [];
  // Lattice radius sized to demand: a radius-R hex holds 1+3R(R+1) cells.
  // (The mock's fixed 8 capped at 217 — the note level needs 365; a fixed
  // cap silently starved six families of cells, review finding #1.)
  let RNG = 1;
  while (1 + 3 * RNG * (RNG + 1) < n) RNG++;
  for (let q = -RNG; q <= RNG; q++) {
    for (let r = -RNG; r <= RNG; r++) {
      const s = -q - r;
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) <= RNG) {
        const x = 1.5 * q;
        const y = Math.sqrt(3) * (r + q / 2);
        cells.push({ q, r, d: Math.hypot(x, y), a: Math.atan2(x, -y) });
      }
    }
  }
  cells.sort((A, B) => A.d - B.d || Math.abs(A.a) - Math.abs(B.a) || A.a - B.a);
  return cells.slice(0, n).map((c) => [c.q, c.r]);
}

/** combCoords → pixel positions centred on their bounding box. */
export function combXY(n: number, step: number): [number, number][] {
  const pts = combCoords(n).map(([q, r]) => [0.866 * step * q, step * (r + q / 2)] as [number, number]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const ox = (Math.min(...xs) + Math.max(...xs)) / 2;
  const oy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return pts.map((p) => [p[0] - ox, p[1] - oy]);
}

// Hand-tuned compact clusters for the common counts, generative past them
// (the mock's honeyCoords — the Canvas picker's cluster shapes).
const FIXED_CLUSTERS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [[0, 0], [0, 1]],
  3: [[0, 0], [1, 0], [0, 1]],
  4: [[0, 0], [1, 0], [0, 1], [1, 1]],
  6: [[0, -1], [1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0]],
  7: [[0, 0], [0, -1], [1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0]],
};
export function honeyCoords(n: number): [number, number][] {
  return FIXED_CLUSTERS[n] ?? combCoords(n);
}

/** honeyCoords → centred pixel positions (the Canvas cluster layout). */
export function honeyXY(n: number, step: number): [number, number][] {
  const pts = honeyCoords(n).map(([q, r]) => [0.866 * step * q, step * (r + q / 2)] as [number, number]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const ox = (Math.min(...xs) + Math.max(...xs)) / 2;
  const oy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return pts.map((p) => [p[0] - ox, p[1] - oy]);
}

/** Pan clamp shared by the stage's render, drag and pinch-conversion paths —
    ONE function so stage→content coordinate math can never diverge from what
    is drawn (a min/max reimplementation in the pinch path returned an edge
    where this returns the centring midpoint on wider-than-content stages,
    focusing the wrong cluster; review finding). */
export function clampAxis(t: number, lo: number, hi: number): number {
  'worklet';
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, t));
}

// Flat-top hexagon points around (x, y), slightly shrunk for the lattice gap.
export function hexPoints(x: number, y: number, R: number, f: number): string {
  const hw = R * f;
  const hh = ((Math.sqrt(3) / 2) * R) * f;
  return [
    [x - hw / 2, y - hh],
    [x + hw / 2, y - hh],
    [x + hw, y],
    [x + hw / 2, y + hh],
    [x - hw / 2, y + hh],
    [x - hw, y],
  ]
    .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
    .join(' ');
}

// Syllable-ish hyphenation for a single token longer than the line. True
// hyphenation needs a dictionary; this heuristic covers the taxonomy's
// vocabulary: break BEFORE a consonant whose following letters form a
// plausible syllable onset ("chemi-cal", "goose-ber-ry"), never before a
// vowel and never splitting an onset cluster ("fl", "ch", …). A blind
// fixed-width cut produced "chemic-al" (device finding).
const VOWELS = new Set('aeiouy');
const ONSETS = new Set(['bl','br','ch','cl','cr','dr','fl','fr','gl','gr','kr','ph','pl','pr','qu','sc','sh','sk','sl','sm','sn','sp','st','sw','th','tr','tw','wh','wr']);
export function breakWord(w: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = w;
  while (rest.length > maxChars) {
    // Chunk budget leaves room for the hyphen; the tail keeps ≥3 letters
    // (2-letter tails produced "chlori-ne" — a silent-e stub).
    const limit = Math.min(rest.length - 3, Math.max(2, maxChars - 1));
    // A compound that already carries a hyphen splits there, no extra dash
    // ("band-aid" → "band-" + "aid", not "band--aid").
    const hy = rest.lastIndexOf('-', limit);
    if (hy > 0) {
      parts.push(rest.slice(0, hy + 1));
      rest = rest.slice(hy + 1);
      continue;
    }
    let cut = -1;
    for (let i = limit; i >= 3; i--) {
      const prev = rest[i - 1].toLowerCase();
      const cur = rest[i].toLowerCase();
      if (VOWELS.has(cur)) continue; // a chunk never starts on a vowel
      if (ONSETS.has(prev + cur)) continue; // never split an onset cluster ("elder-flower", not "elderf-lower")
      const next = rest[i + 1]?.toLowerCase();
      if (next && !VOWELS.has(next) && !ONSETS.has(cur + next)) continue; // next chunk must start speakably
      cut = i;
      break;
    }
    if (cut < 0) cut = Math.max(2, maxChars - 1);
    parts.push(`${rest.slice(0, cut)}-`);
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

// Greedy word wrap for the cell label (SVG text can't wrap itself). A single
// token longer than the line is hyphen-broken on a syllable-ish boundary —
// space-only splitting let words like "elderflower" run past the cell
// (review finding).
export function wrapLabel(label: string, maxChars: number): string[] {
  const words = label.split(' ').flatMap((w) => (w.length <= maxChars ? [w] : breakWord(w, maxChars)));
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur = `${cur} ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > 3) {
    const kept = lines.slice(0, 3);
    kept[2] = `${kept[2].slice(0, Math.max(1, maxChars - 1))}…`;
    return kept;
  }
  return lines;
}
