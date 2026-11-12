// The profile cover hero's geometry (04·R5i·b), pure so it can be reasoned
// about without a device.
//
// The photo sits with its centre ON the sheet edge: the rounded sheet rises
// over the cover, and on the left its corner flows into the photo's ring (a 4pt
// bg halo, RING) through a small fillet. Ported from vero-you.js `notchSvg`
// (variant 'b'), parametrized by the screen width AND the photo size: the
// photo breathes with the device by the SAME ratio as the title type of the
// name beside it (30 → 34pt at full comfort), so the two stay in proportion
// (ProfileHeader `useProfilePhotoSize`).

export const PHOTO_BASE = 104;
export const RING = 4;
// The sheet edge sits SHEET_RISE above the cover's bottom (the mock's notch box:
// edge at 60 in an 87-tall box whose bottom is 1pt below the cover).
export const SHEET_RISE = 26;
// The notch SVG's box for a photo: the sheet edge at `e` (room above for the
// ring arc), the box running SHEET_RISE + 1 below it.
export function notchBox(photo: number): { e: number; h: number } {
  const e = Math.max(60, Math.ceil(photo / 2 + RING + 4));
  return { e, h: e + SHEET_RISE + 1 };
}
// The name's bottom sits this far above the sheet edge (`.yo-hero-title`
// bottom 10 + its −26 lift, against the −26 sheet edge).
export const NAME_LIFT = 10;
// Gap between the photo and the name beside it, and the name block's right
// inset (`.yo-hero-title.yo-cn` left = photo right + 12, right 18).
export const NAME_GAP = 12;
export const NAME_RIGHT = 18;

// The SVG path of the sheet's top edge (fill = theme.bg), in a W × notchBox(photo).h
// box. cx = the photo's centre x.
export function notchPath(W: number, cx: number, photo: number): string {
  const { e: E, h: H } = notchBox(photo);
  const Rr = photo / 2 + RING, rc = 26, g = 8;
  const C1x = rc, C1y = E + rc, A = rc + g, B = Rr + g;
  const ex = cx - C1x, ey = E - C1y, dd = Math.hypot(ex, ey), ux = ex / dd, uy = ey / dd;
  const l = (A * A - B * B + dd * dd) / (2 * dd), hh = Math.sqrt(A * A - l * l);
  const Px = C1x + l * ux + hh * uy, Py = C1y + l * uy - hh * ux;
  const t1x = C1x + ((Px - C1x) * rc) / A, t1y = C1y + ((Py - C1y) * rc) / A;
  const t2x = cx + ((Px - cx) * Rr) / B, t2y = E + ((Py - E) * Rr) / B;
  const f = (n: number) => n.toFixed(1);
  return (
    `M0,${H} L0,${C1y} A${rc},${rc} 0 0 1 ${f(t1x)},${f(t1y)} A${g},${g} 0 0 0 ${f(t2x)},${f(t2y)}` +
    ` A${Rr},${Rr} 0 0 1 ${f(cx + Rr)},${E} L${f(W - rc)},${E} A${rc},${rc} 0 0 1 ${f(W)},${E + rc} L${f(W)},${H} Z`
  );
}

// `fitName` (vero-you.js), with a better break: a profile name keeps its
// size while it fits; else it shrinks by up to 4pt; else (two or more words)
// it goes onto two lines. On the cover, line 1 hugs the photo's ring
// (indented left into the space above the circle); without a cover the name's
// column beside the photo is straight, so no indent (ruled 2026-11-12: the
// mock cut a coverless name on one line). At each size, from the base down to
// `min`, the break points are tried IN ORDER (after the first word, then
// after the second, …) and the first where both lines fit wins: a short name
// keeps the mock's first-word-on-top, a long one moves words up to line 1
// before anything shrinks or truncates (Simon, 2026-11-11: the mock only ever
// broke after the first word, so a long rest truncated with room to spare
// above). A one-word name shrinks to `min` and then wraps.
//
// Inputs are MEASURED at the base size (Dynamic Type included): `w` = the whole
// name on one line, `splits[i]` = the widths of line 1 / line 2 when breaking
// after word i + 1, `lineH` = one line's height, `scale` = rendered size ÷
// style size. Widths scale linearly with the font size.
export type NameFit =
  | { lines: 1; fontSize: number; wrap: boolean }
  | { lines: 2; fontSize: number; indent: number; split: number };

export function fitProfileName(m: {
  fs: number; w: number; splits: { w1: number; w2: number }[]; lineH: number; scale: number;
  avail: number; min: number; ring?: { nameLeft: number; photoCx: number; photo: number };
}): NameFit {
  const { fs, w, splits, lineH, scale, avail, min: MIN, ring } = m;
  if (w <= avail + 1) return { lines: 1, fontSize: fs, wrap: false };
  for (let f = fs - 1; f >= fs - 4; f--) if ((w * f) / fs <= avail + 1) return { lines: 1, fontSize: f, wrap: false };
  if (splits.length === 0) {
    for (let f = fs - 5; f >= MIN; f--) if ((w * f) / fs <= avail + 1) return { lines: 1, fontSize: f, wrap: false };
    return { lines: 1, fontSize: MIN, wrap: true };
  }
  // Line 1's indent at size f: the ring circle (photo radius + 15) at line 1's
  // baseline height, measured from the photo centre (the sheet edge, NAME_LIFT
  // below the name block).
  const indentAt = (f: number) => {
    if (!ring) return 0;
    const { nameLeft, photoCx, photo } = ring;
    const R = photo / 2 + 15;
    const k = f / fs;
    const dy = NAME_LIFT + lineH * k + 0.24 * f * scale;
    const x = dy < R ? photoCx + Math.sqrt(R * R - dy * dy) : photoCx - photo / 2;
    return Math.min(0, x - nameLeft);
  };
  for (let f = fs; f >= MIN; f--) {
    const k = f / fs, indent = indentAt(f);
    for (let i = 0; i < splits.length; i++) {
      if (splits[i].w1 * k <= avail - indent + 1 && splits[i].w2 * k <= avail + 1) return { lines: 2, fontSize: f, indent, split: i };
    }
  }
  // Nothing fits even at `min`: the break with the smallest overflow (the
  // longer line truncates).
  const k = MIN / fs, indent = indentAt(MIN);
  let best = 0, bestOver = Infinity;
  splits.forEach((sp, i) => {
    const over = Math.max(sp.w1 * k - (avail - indent), sp.w2 * k - avail);
    if (over < bestOver) { bestOver = over; best = i; }
  });
  return { lines: 2, fontSize: MIN, indent, split: best };
}
