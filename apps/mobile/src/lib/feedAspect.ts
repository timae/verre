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
//
// Per-slide fit rule: every slide CROP-FILLS the frame (contentFit "cover",
// hardcoded — Simon: "rather crop, like Insta"). The earlier contain/letterbox
// alternative and its dev toggle were deleted; the minority orientation in a
// mixed carousel crops to the frame.

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
