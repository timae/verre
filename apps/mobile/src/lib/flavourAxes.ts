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

// The top-N flavours by intensity — the "Tastes like" chip legend (design
// `topNotes`, the un-scientific wheel description: highest-scored axes as
// words+swatches instead of axis labels). Reads the SAME axes the wheel does
// (buildWheelAxes) so the chips and the wheel never disagree; filters to rated
// axes (value > 0), sorts desc, keeps N. Empty when nothing is rated — the
// caller uses that to decide the flavour-vs-text hero fork.
export function topFlavours(
  flavors: Record<string, number> | null | undefined,
  wineType: string | null | undefined,
  axisColor: (key: string) => string,
  n = 3,
): WheelAxis[] {
  return buildWheelAxes(flavors, wineType, axisColor)
    .filter((a) => a.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}
