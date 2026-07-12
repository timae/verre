import { contrastRatio } from '../lib/contrast';

// Hex-only blend of the design CSS `color-mix(in srgb, base N%, press)` press
// states. Handles 3- and 6-digit hex (theme `press` tokens are '#000'/'#fff').
export function mix(base: string, press: string, baseRatio: number): string {
  const b = parse(base), p = parse(press);
  if (!b || !p) return base;
  const ch = (i: number) => Math.round(b[i] * baseRatio + p[i] * (1 - baseRatio));
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

// The CSS `color-mix(in srgb, var(--ink) N%, transparent)` pattern (e.g. the
// secondary button border at 28%/42% ink).
export function alpha(hex: string, a: number): string {
  const c = parse(hex);
  if (!c) return hex;
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

// Contrast-picked label ink for a coloured fill: whichever of the two
// candidates (usually theme.ink / theme.bg) reads better on it. Used by the
// aroma hex cells and the armed solid-fill badges. Relative imports (not
// '@/…') so the node-side units script can load this.
export function inkOn(fill: string, a: string, b: string): string {
  return contrastRatio(fill, a) >= contrastRatio(fill, b) ? a : b;
}

// Solid-first readable words: the 100% palette colour where it already reads
// on the fill, pulled toward ink in small steps ONLY where it doesn't (the
// aroma badge "readable words" variant — device comparison, 2026-07-10).
// Distinct from the deleted readableTint, which always started ink-tinged;
// this one is byte-identical to the solid ruling wherever that ruling works.
// Bar = 3:1 (the large-text/UI threshold — the chips are 13.5pt semibold):
// at 4.5 only 5/72 theme×family combos stayed solid, ink-pulling even the
// ones Simon judged fine on apricot/aubergine; 3:1 corrects only the truly
// unreadable tail.
export function readableSolid(color: string, ink: string, fill: string): string {
  for (let r = 1; r > 0; r -= 0.05) {
    const out = mix(color, ink, r);
    if (contrastRatio(out, fill) >= 3) return out;
  }
  return ink;
}

// The BORDER variant of readableSolid: never pulled past 45% colour share.
// A hairline trades contrast for hue — on clay the full pull collapsed to
// ink and every pronounced border read as WHITE (Simon); measured across all
// themes, every non-clay border keeps ≥0.45 share naturally, so the floor
// bites only where the pull had bottomed out.
export function readableBorder(color: string, ink: string, fill: string): string {
  for (let r = 1; r >= 0.45; r -= 0.05) {
    const out = mix(color, ink, r);
    if (contrastRatio(out, fill) >= 3) return out;
  }
  return mix(color, ink, 0.45);
}

function parse(hex: string): [number, number, number] | null {
  const t = hex.trim();
  // mix() emits rgb(r,g,b) — accept it back so mixes COMPOSE (a second mix
  // over a mixed colour silently no-op'd before: the aroma map's shaded
  // cells never muted, device finding).
  const r = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(t);
  if (r) return [Number(r[1]), Number(r[2]), Number(r[3])];
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
