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

// ── With a `@username` under the name (design spec, 2026-11-14) ─────────────
// Everything is placed by BASELINES (line boxes differ between iOS and
// Android, baselines don't), and every line's left edge keeps a fixed gap to
// the photo's ROUND edge at its own height, so the block follows the circle.
// Numbers are for the 104pt photo and scale with it (`photo / PHOTO_BASE`);
// baseline-to-baseline distances also grow with the text scale.

// Instrument Sans (hhea / OS/2, per em): what a baseline position needs.
export const FONT = { ascent: 0.97, descent: 0.25, cap: 0.72 } as const;

// ON THE COVER: the handle's baseline sits `handleAboveEdge` above the sheet
// edge (as far as the status pill's top sits below it), the name's baseline
// `nameToHandle` above the handle's; the name keeps `nameGap` and the handle
// `handleGap` to the photo's edge (the handle a little right of the name).
// Tuned on device (Simon, 2026-11-14): the name 13, the spec's 11.5 sat a
// tad close.
export const COVER_SPEC = { handleAboveEdge: 8.5, nameToHandle: 19.3, nameGap: 13, handleGap: 12.5 } as const;
// WITHOUT A COVER: the top of the name's capitals `capTop` below the photo's
// top, name → handle and handle → pill top from the baselines, the friends
// line `pillToFriends` under the pill; name, handle and friends line keep
// `gap` to the photo's edge, the status pill `pillGap` (tuned on device,
// Simon 2026-11-14: at the spec's 15 its filled box read a tad far). The name
// is 26pt there (`nameSize` of the 30pt title).
export const PLAIN_SPEC = { capTop: 8, nameToHandle: 21.3, handleToPill: 11.5, pillToFriends: 4, gap: 15, pillGap: 12.5, nameSize: 26 / 30 } as const;

// The x of a left edge that keeps `gap` to a circle (centre `cx`, radius `r`)
// for something whose ink runs from `inkTop` down to `inkBottom`, both given
// as heights ABOVE the circle's centre (negative = below it). The circle is
// nearest where the ink is closest to the centre line: the baseline for a
// line above it, the top for one below it, the full width for one across it.
export function curveLeft(cx: number, r: number, gap: number, inkTop: number, inkBottom: number): number {
  const d = inkBottom >= 0 ? inkBottom : inkTop <= 0 ? -inkTop : 0;
  return cx + (d < r ? Math.sqrt(r * r - d * d) : 0) + gap;
}

// The cover's lines for a photo and a text scale, as heights ABOVE the sheet
// edge (the photo's centre line): the handle's baseline, the name's LAST
// baseline, and how far the status pill's top sits BELOW the edge (the same
// as the handle above it). `textScale` = the phone's font scale.
export function coverLines(photo: number, textScale: number): { handleRise: number; nameRise: number; pillDrop: number } {
  const k = photo / PHOTO_BASE;
  const handleRise = COVER_SPEC.handleAboveEdge * k;
  return { handleRise, nameRise: handleRise + COVER_SPEC.nameToHandle * k * textScale, pillDrop: handleRise };
}

// The coverless block, as y's from the photo's TOP and x's from its LEFT:
// the two baselines, the tops of the pill and the friends line, the block's
// height, and each left edge (`base` = where a line beside the photo's widest
// point starts: the name's `ring.nameLeft`). `nameSize` / `handleSize` are the
// style font sizes; `pillH` / `countsH` are measured. Without `withStat`
// (blocked, private) the two lines are centred on the photo.
export function plainLines(m: { photo: number; textScale: number; nameSize: number; handleSize: number; pillH: number; countsH: number; withStat: boolean }) {
  const { photo, textScale, pillH, countsH } = m;
  const k = photo / PHOTO_BASE, r = photo / 2, gap = PLAIN_SPEC.gap * k;
  const capH = FONT.cap * m.nameSize * textScale;
  const lead = PLAIN_SPEC.nameToHandle * k * textScale;
  const nameB = (m.withStat ? PLAIN_SPEC.capTop * k : (photo - capH - lead) / 2) + capH;
  const handleB = nameB + lead;
  const pillTop = handleB + PLAIN_SPEC.handleToPill * k;
  const countsTop = pillTop + pillH + PLAIN_SPEC.pillToFriends * k;
  const leftAt = (top: number, bottom: number, g = gap) => curveLeft(r, r, g, r - top, r - bottom);
  return {
    nameB, handleB, pillTop, countsTop, gap,
    height: Math.max(photo, m.withStat ? countsTop + countsH : handleB + FONT.descent * m.handleSize * textScale),
    base: photo + gap,
    handleLeft: leftAt(handleB - FONT.cap * m.handleSize * textScale, handleB),
    pillLeft: leftAt(pillTop, pillTop + pillH, PLAIN_SPEC.pillGap * k),
    countsLeft: leftAt(countsTop, countsTop + countsH),
  };
}

// `fitName` (vero-you.js), with a better break: a profile name keeps its
// size while it fits; else it shrinks by up to 4pt; else (two or more words)
// it goes onto two lines. At each size, from the base down to
// `min`, the break points are tried IN ORDER (after the first word, then
// after the second, …) and the first where both lines fit wins: a short name
// keeps the mock's first-word-on-top, a long one moves words up to line 1
// before anything shrinks or truncates (Simon, 2026-11-11: the mock only ever
// broke after the first word, so a long rest truncated with room to spare
// above). A one-word name shrinks to `min` and then wraps. `maxLines: 1`
// (the coverless name): shrink to `min`, then cut with "…".
//
// THE RING, two ways:
//   - no `anchor` (a profile WITHOUT a username, as before usernames): on the
//     cover line 1 of two hugs the photo's ring (radius + `pad`), the bottom
//     line never indents; without `ring` nothing does.
//   - `anchor` (with a username): the name's LAST baseline sits `dy` above the
//     photo's centre whatever its size, and every line keeps `ring.gap` to the
//     photo's edge at its own baseline (`curveLeft`), at most `maxShift` left
//     of `nameLeft` (a line above the photo's top would run over it).
//
// Inputs are MEASURED at the base size (Dynamic Type included): `w` = the whole
// name on one line, `splits[i]` = the widths of line 1 / line 2 when breaking
// after word i + 1, `lineH` = one line's height, `scale` = rendered size ÷
// style size. Widths scale linearly with the font size.
export type NameFit =
  | { lines: 1; fontSize: number; wrap: boolean; indent: number }
  | { lines: 2; fontSize: number; indent: number; indent2: number; split: number };
export type NameRing = { nameLeft: number; photoCx: number; photo: number; pad?: number; gap?: number; maxShift?: number };
export type NameAnchor = { dy: number };

export function fitProfileName(m: {
  fs: number; w: number; splits: { w1: number; w2: number }[]; lineH: number; scale: number;
  avail: number; min: number; ring?: NameRing; anchor?: NameAnchor; maxLines?: 1 | 2;
}): NameFit {
  const { fs, w, lineH, scale, avail, min: MIN, ring, anchor } = m;
  const splits = m.maxLines === 1 ? [] : m.splits;
  // The indent of the line with `under` name lines beneath it, at size f.
  const indentAt = (f: number, under: 0 | 1) => {
    if (!ring) return 0;
    const { nameLeft, photoCx, photo } = ring;
    const k = f / fs;
    if (anchor) {
      const base = anchor.dy + under * lineH * k;
      const x = curveLeft(photoCx, photo / 2, ring.gap ?? 0, base + FONT.cap * f * scale, base);
      return Math.max(-(ring.maxShift ?? Infinity), x - nameLeft);
    }
    if (under === 0) return 0;
    // Before usernames: the ring circle (photo radius + 15) at line 1's
    // baseline height, measured from the photo centre (the sheet edge,
    // NAME_LIFT below the name block).
    const R = photo / 2 + (ring.pad ?? 15);
    const dy = NAME_LIFT + lineH * k + 0.24 * f * scale;
    const x = dy < R ? photoCx + Math.sqrt(R * R - dy * dy) : photoCx - photo / 2;
    return Math.min(0, x - nameLeft);
  };
  const one = (f: number): NameFit | null => {
    const indent = indentAt(f, 0);
    return (w * f) / fs <= avail - indent + 1 ? { lines: 1, fontSize: f, wrap: false, indent } : null;
  };
  for (let f = fs; f >= fs - 4; f--) {
    const fit = one(f);
    if (fit) return fit;
  }
  if (splits.length === 0) {
    for (let f = fs - 5; f >= MIN; f--) {
      const fit = one(f);
      if (fit) return fit;
    }
    return { lines: 1, fontSize: MIN, wrap: m.maxLines !== 1, indent: indentAt(MIN, 0) };
  }
  for (let f = fs; f >= MIN; f--) {
    const k = f / fs, indent = indentAt(f, 1), indent2 = indentAt(f, 0);
    for (let i = 0; i < splits.length; i++) {
      if (splits[i].w1 * k <= avail - indent + 1 && splits[i].w2 * k <= avail - indent2 + 1) return { lines: 2, fontSize: f, indent, indent2, split: i };
    }
  }
  // Nothing fits even at `min`: the break with the smallest overflow (the
  // longer line truncates).
  const k = MIN / fs, indent = indentAt(MIN, 1), indent2 = indentAt(MIN, 0);
  let best = 0, bestOver = Infinity;
  splits.forEach((sp, i) => {
    const over = Math.max(sp.w1 * k - (avail - indent), sp.w2 * k - (avail - indent2));
    if (over < bestOver) { bestOver = over; best = i; }
  });
  return { lines: 2, fontSize: MIN, indent, indent2, split: best };
}
