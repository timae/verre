import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';

// Shared screen-layout + over-photo constants. Centralised so the many screens
// that re-declared these (GUTTER, FOOT_CLEARANCE, the hero ratios, the glass
// fill, the hero scrim) can't drift — an audit found each copied 5–10×.

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function phoneComfortFor(width: number, height: number): number {
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  const widthT = clamp01((shortSide - 390) / 50);
  const heightT = clamp01((longSide - 844) / 112);
  return clamp01(widthT * 0.72 + heightT * 0.28);
}

export function usePhoneMetrics() {
  const { width, height } = useWindowDimensions();
  const comfort = phoneComfortFor(width, height);
  return useMemo(() => ({
    width,
    height,
    comfort,
    lerp: (from: number, to: number) => lerp(from, to, comfort),
  }), [width, height, comfort]);
}

// Extra bottom padding for scroll content above the native tab bar. The
// react-native-screens tab host auto-insets content for the bar itself
// (disableAutomaticContentInsets defaults off), so this is breathing room,
// not bar clearance — verify on device and tune here if content still runs
// under the translucent bar.
export const TAB_BAR_CLEARANCE = 16;

// Horizontal screen gutter. 22 nearly everywhere; the impression detail (02e)
// deliberately uses 20 (a per-screen override — pass it locally, don't change
// this).
export const GUTTER = 22;

// Bottom padding that clears a sticky `.vfoot`/action bar so the last scroll
// item isn't hidden under it. The impression's `.ir-foot` is taller → 130.
export const FOOT_CLEARANCE = 120;
export const FOOT_CLEARANCE_IR = 130;

// Hero photo height as a fraction of the window. ONE ratio for both the
// impression hero (.ir-hero) and the line-up cover hero (.hero-bleed-top) —
// Simon's ruling: they should be the same height, set to the impression's
// 280/744 (the cover hero was 248/800, ~56pt shorter, before).
export const HERO_RATIO = 280 / 744;

// Over-photo dark glass fill for floating controls (back/⋯/Crave/Reveal/Add
// pills + circles, the photo-remove ×). A sanctioned non-token literal (same on
// every theme — it darkens the PHOTO, not the surface). Converged to one value
// (was drifting 0.42/0.5/0.55).
export const GLASS_FILL = 'rgba(20,18,15,0.42)';

// Hero-photo scrim: a 3-stop vertical near-black gradient (top → middle →
// bottom) that keeps white status-bar glyphs + glass controls + the hero title
// readable over any photo. One gradient on both heroes (was drifting).
export const HERO_SCRIM = ['rgba(15,12,10,0.25)', 'rgba(15,12,10,0.05)', 'rgba(15,12,10,0.82)'] as const;
