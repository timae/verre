import { perRatingAxes, resolveAxes } from '@verre/core';
import type { WheelAxis } from '@/components/scoring/StructureWheel';

// The bottle's kind as the axes read it: `sparkling` decides the set (Bubbles),
// catalogue model change step 4. Colour plays no part.
export type AxisBottle = { sparkling?: boolean | null } | null | undefined;

// Build the StructureWheel's WheelAxis[] from a rating's `flavors` record +
// the bottle's kind — the read counterpart of the dev-gallery / 02e recipe
// (perRatingAxes over resolveAxes, coloured by the active theme). Shared
// by the feed card mini-wheel and the impression detail big wheel so they
// resolve axes identically.
export function buildWheelAxes(
  flavors: Record<string, number> | null | undefined,
  bottle: AxisBottle,
  axisColor: (key: string) => string,
): WheelAxis[] {
  const levels = flavors ?? {};
  return perRatingAxes(levels, resolveAxes('wine', { sparkling: !!bottle?.sparkling })).map((a) => ({
    label: a.l,
    color: axisColor(a.k),
    value: levels[a.k] ?? 0,
  }));
}

// Whether any wheel axis is rated (value > 0) — the flavour-vs-bare hero fork
// on the feed's photoless cards. (Replaces `topFlavours`, whose "Tastes like"
// chips were removed 2026-07-13 — aromas carry that job now; only the gate
// survived.)
export function hasRatedAxes(
  flavors: Record<string, number> | null | undefined,
  bottle: AxisBottle,
): boolean {
  const levels = flavors ?? {};
  return perRatingAxes(levels, resolveAxes('wine', { sparkling: !!bottle?.sparkling })).some((a) => (levels[a.k] ?? 0) > 0);
}
