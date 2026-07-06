import { perRatingAxes, resolveAxes } from '@verre/core';
import type { WheelAxis } from '@/components/scoring/FlavourWheel';

// Build the FlavourWheel's WheelAxis[] from a rating's `flavors` record +
// the wine type — the read counterpart of the dev-gallery / 02e recipe
// (perRatingAxes over resolveAxes, coloured by the active theme). Shared
// by the feed card mini-wheel and the impression detail big wheel so they
// resolve axes identically.
export function buildWheelAxes(
  flavors: Record<string, number> | null | undefined,
  wineType: string | null | undefined,
  axisColor: (key: string) => string,
): WheelAxis[] {
  const levels = flavors ?? {};
  return perRatingAxes(levels, resolveAxes('wine', wineType ?? null)).map((a) => ({
    label: a.l,
    color: axisColor(a.k),
    value: levels[a.k] ?? 0,
  }));
}
