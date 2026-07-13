import { perRatingAxes, resolveAxes } from '@verre/core';
import type { WheelAxis } from '@/components/scoring/StructureWheel';

// Build the StructureWheel's WheelAxis[] from a rating's `flavors` record +
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

// Whether any wheel axis is rated (value > 0) — the flavour-vs-bare hero fork
// on the feed's photoless cards. (Replaces `topFlavours`, whose "Tastes like"
// chips were removed 2026-07-13 — aromas carry that job now; only the gate
// survived.)
export function hasRatedAxes(
  flavors: Record<string, number> | null | undefined,
  wineType: string | null | undefined,
): boolean {
  const levels = flavors ?? {};
  return perRatingAxes(levels, resolveAxes('wine', wineType ?? null)).some((a) => (levels[a.k] ?? 0) > 0);
}
