// WCAG relative-luminance contrast ratio between two opaque colours (6-digit
// hex OR mix()'s `rgb(r,g,b)` output). Originally the themed-QR scan-safety
// check; now also underpins `inkOn`/`readableSolid`/`readableBorder` and the
// aroma hex-stage label picking (theme/color.ts).

function relLuminance(hex: string): number {
  // Accept theme/color.ts mix() output (`rgb(r,g,b)`) beside plain hex —
  // the aroma stages contrast-pick label ink against mixed fills.
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(hex.trim());
  const [r, g, b] = m
    ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]
    : (() => {
        const h = hex.replace('#', '');
        return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
      })();
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Ratio in [1, 21]. Both inputs must be 6-digit hex (#rrggbb); theme bg/surface
// are solid hex, theme.ink too (rgba tokens like rule/scrim are never passed here).
export function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
