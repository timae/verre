// Instagram-style feed photo aspect handling (researched 2026-07, Simon's rules).
//
// Aspect is expressed as height/width (h/w) so "taller = bigger number".
//
// The frame band — the tallest and widest a photo FRAME may be:
//   - Tallest frame = 3:4 portrait  → h/w = 4/3 ≈ 1.333  (MAX_ASPECT)
//   - Widest frame  = 4:3 landscape → h/w = 3/4 = 0.75   (MIN_ASPECT)
// 3:4 / 4:3 are the phone-camera default aspect (4:3 sensor, held either way),
// so a STANDARD phone photo fills the frame edge-to-edge with NO crop in either
// orientation. Only unusual shapes crop: a portrait taller than 3:4 (e.g. a
// 9:16 screenshot) crops to 3:4; a landscape wider than 4:3 (e.g. 16:9) crops
// to 4:3. (Simon: the 4:5 cap cropped common 3:4 phone portraits ~6% — reverted
// to 3:4 so the default camera shape is shown whole.)
//
// Carousel frame rule (session posts): TALLEST photo wins, clamped to the band.
// The frame is therefore always ≥ every photo's height → a shorter (landscape)
// slide letterboxes with tint bars TOP/BOTTOM; it never pillarboxes.
//
// Per-slide fit rule: a photo TALLER than the frame (only possible when the
// frame hit the 3:4 cap and the photo is taller, e.g. 9:16) is CROPPED (cover)
// to the frame — we NEVER draw side bars (Simon: "rather crop, like Insta").
// Everything at-or-shorter than the frame is CONTAINed with top/bottom bars.

// Widest frame allowed (landscape 4:3): h/w = 3/4.
export const MIN_ASPECT = 3 / 4;
// Tallest frame allowed (portrait 3:4): h/w = 4/3.
export const MAX_ASPECT = 4 / 3;
// Frame reserved before the images' real aspects are known (4:5 — a sensible
// middle; a typical portrait settles from here with little jump).
export const DEFAULT_ASPECT = 5 / 4;

// Clamp a raw h/w ratio into the frame band.
export function clampAspect(hOverW: number): number {
  if (!Number.isFinite(hOverW) || hOverW <= 0) return DEFAULT_ASPECT;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, hOverW));
}

// Raw intrinsic h/w for one image (unclamped — the carousel reducer needs the
// true value to pick the tallest, and the fit decision compares true vs frame).
export function rawAspect(width: number, height: number): number {
  if (!width || !height) return DEFAULT_ASPECT;
  return height / width;
}

// Frame aspect for a set of images: the TALLEST wins, clamped to the band.
// `aspects` are raw h/w values (from rawAspect); empties/unknowns are ignored.
// Returns DEFAULT_ASPECT when nothing is measured yet.
export function frameAspectFor(aspects: number[]): number {
  const valid = aspects.filter((a) => Number.isFinite(a) && a > 0);
  if (!valid.length) return DEFAULT_ASPECT;
  return clampAspect(Math.max(...valid));
}

// How a single photo sits in the frame. `contain` (+ tint bars) when it's the
// same height or shorter than the frame; `cover` (crop) when it's TALLER than
// the frame (avoids side bars). Small epsilon so an exact match contains.
export function fitInFrame(photoAspect: number, frameAspect: number): 'cover' | 'contain' {
  if (!Number.isFinite(photoAspect) || photoAspect <= 0) return 'cover';
  return photoAspect > frameAspect + 0.001 ? 'cover' : 'contain';
}
