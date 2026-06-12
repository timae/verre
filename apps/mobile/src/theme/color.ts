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

function parse(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
