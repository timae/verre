import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';
import { flavourWheelGeometry, wheelRadius, LABEL_OFFSET, type WheelGeometry } from '@verre/core';
import { mix } from '@/theme/color';
import { typeScale, useTheme } from '@/theme';

export type WheelAxis = {
  label: string;
  color: string;
  /** Whole-number intensity 0–5; 0 renders no wedge. */
  value: number;
};

// EXPLORATION (dev gallery, `straightSides`): the coxcomb wedge but with a
// STRAIGHT constant-width SEPARATOR between neighbours instead of the radial
// gap (which reads as an angled/triangular sliver widening toward the rim).
// Each wedge still fills its angular SLOT (2π/n) and keeps its eased length +
// curved inner/outer arcs — but its two side edges are the SLOT-BOUNDARY
// radials shifted perpendicular-inward by half the gap, so the channel
// between two wedges is a straight parallel-sided strip of constant width.
// (Sizing the gap in px and offsetting the boundary lines — NOT resizing the
// wedge — was the fix; the first cut made each wedge a rim-wide slab that
// overlapped everything.) Pure angle/radius math from core; render-only.
function straightSideWedgePaths(geo: WheelGeometry, values: number[], toRim: boolean): Array<{ index: number; d: string }> {
  const { cx, cy, R, r0 } = geo;
  const n = values.length;
  // Constant separator half-width in px (matches the coxcomb's ~3° gap at a
  // mid radius, so it reads similar without the taper). Small + fixed.
  const gapHalf = Math.max(2, R * 0.02);
  const slotHalf = Math.PI / n; // full half-slot; the gap comes from gapHalf now
  const round = (v: number) => Math.round(v * 10) / 10;
  const out: Array<{ index: number; d: string }> = [];
  values.forEach((v, i) => {
    if (v <= 0) return;
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const rTip = toRim ? R : wheelRadius(v, R, r0);
    // Each side edge = the slot-boundary radial, shifted toward the wedge
    // interior by gapHalf along that radial's perpendicular. A corner at
    // radius `rad` on side s (−1 = the a−slotHalf boundary, +1 = a+slotHalf):
    // point = center·(0) + boundaryDir·rad + interiorPerp·gapHalf.
    const corner = (rad: number, s: number): [number, number] => {
      const b = a + s * slotHalf; // boundary radial angle
      const bx = Math.cos(b);
      const by = Math.sin(b);
      // interior perpendicular points from the boundary toward the wedge
      // centre, i.e. rotate the boundary dir by −s·90°.
      const px = Math.cos(b - s * Math.PI / 2);
      const py = Math.sin(b - s * Math.PI / 2);
      return [cx + bx * rad + px * gapHalf, cy + by * rad + py * gapHalf];
    };
    const [ilx, ily] = corner(r0, -1);
    const [olx, oly] = corner(rTip, -1);
    const [orx, ory] = corner(rTip, 1);
    const [irx, iry] = corner(r0, 1);
    out.push({
      index: i,
      d:
        `M ${round(ilx)} ${round(ily)} ` +
        `L ${round(olx)} ${round(oly)} ` +
        `A ${round(rTip)} ${round(rTip)} 0 0 1 ${round(orx)} ${round(ory)} ` + // outer arc
        `L ${round(irx)} ${round(iry)} ` +
        `A ${round(r0)} ${round(r0)} 0 0 0 ${round(ilx)} ${round(ily)} Z`, // inner arc back
    });
  });
  return out;
}

// Coxcomb flavour wheel (handoff §4): each wedge a flavour colour, length =
// eased intensity, open hub, 3° gaps. Geometry from @verre/core; this is the
// react-native-svg render layer (the web design's SVG-string assembly does
// not port — proposal 05 §2). Colours arrive as data: the Vero palette for
// the real backend flavour sets is a pending design decision.
export function StructureWheel({ axes, size = 260, labels = true, maxWidth, badgeTint, ghostRemainder, straightSides }: {
  axes: WheelAxis[];
  size?: number;
  labels?: boolean;
  maxWidth?: number;
  /** EXPLORATION (dev gallery until Simon rules): extend each rated wedge to
      the RIM in a paled-down same-colour tint — the filled part reads to the
      rating, then a lighter ghost continues to 5 as a scale reference (memory:
      wheel ghost-remainder idea). Rendered as a full-value (=5) base wedge
      layer UNDER the real wedges, at a low opacity so only the remainder band
      past `wheelRadius(v)` shows. */
  ghostRemainder?: boolean;
  /** DEVICE-COMPARISON (dev gallery until Simon rules): the StructureInput's
      badge-tint WEDGES — the OPAQUE mix(colour, theme.surface, 0.72), the
      input's exact fill. ⚠️ Deliberately NOT composited over the actual
      backdrop: a 0.72-translucent wedge over ground G IS mix(colour, G,
      0.72), so "badge tint over the backdrop" is indistinguishable from the
      wash (first gallery round proved it). The visible difference between
      the modes = the bg↔surface gap per theme. Labels stay inkSoft (Simon:
      the switch adapts the wedge colour only). */
  badgeTint?: boolean;
  /** EXPLORATION (dev gallery until Simon rules): STRAIGHT parallel separators
      between wedges instead of the coxcomb's radial-sided gaps (which read as
      angled/triangular slivers widening toward the rim). The wedge keeps its
      eased length + curved arcs; only its two side edges become parallel. */
  straightSides?: boolean;
}) {
  const { theme } = useTheme();
  const pad = labels ? 58 : 4;
  const vpad = labels ? 12 : 4;
  const values = axes.map((a) => a.value);
  const geo = flavourWheelGeometry(values, size);
  // The REAL wedges: coxcomb (radial-sided, from core) or the straight-bar
  // exploration (parallel sides, render-layer helper).
  const wedges = straightSides ? straightSideWedgePaths(geo, values, false) : geo.wedges;
  // Ghost-remainder base layer: each rated axis extended to the RIM (=5) so
  // only the band past the real wedge's tip shows through at low opacity.
  // Unrated axes (value 0) stay empty (no ghost from nothing). Matches the
  // real-wedge shape (straight vs coxcomb) so the remainder aligns.
  const ghostWedges = !ghostRemainder
    ? null
    : straightSides
      ? straightSideWedgePaths(geo, values, true)
      : flavourWheelGeometry(values.map((v) => (v > 0 ? 5 : 0)), size).wedges;
  // The design's `.radar { max-width: 100% }` responsive scale-down: the
  // natural canvas (labels included) is wider than a small phone's content
  // column, so a measured maxWidth shrinks the whole SVG uniformly.
  const naturalW = size + pad * 2;
  const scale = maxWidth && maxWidth < naturalW ? maxWidth / naturalW : 1;

  return (
    <Svg
      width={naturalW * scale}
      height={(size + vpad * 2) * scale}
      viewBox={`${-pad} ${-vpad} ${size + pad * 2} ${size + vpad * 2}`}
    >
      <Circle cx={geo.cx} cy={geo.cy} r={geo.R} fill="none" stroke={theme.rule} strokeWidth={1} />
      <Circle cx={geo.cx} cy={geo.cy} r={geo.r0} fill="none" stroke={theme.ruleSoft} strokeWidth={1} />
      {/* Ghost-remainder base layer (dev exploration): full-rim wedges at a
          low opacity; the real wedge on top covers the filled part, leaving
          the paled remainder showing out to the rim. */}
      {ghostWedges?.map((w) => (
        <Path
          key={`ghost-${w.index}`}
          d={w.d}
          fill={badgeTint ? mix(axes[w.index].color, theme.surface, 0.92) : axes[w.index].color}
          fillOpacity={badgeTint ? 1 : 0.13}
        />
      ))}
      {wedges.map((w) => (
        // Default (wash): 0.72 IS the mock's value (vero-scoring.js coxcomb
        // wedge fill-opacity="0.72"), translucent so wedges shift with the
        // host ground. `badgeTint` (dev gallery until Simon rules) renders the
        // OPAQUE mix(colour, surface, 0.72) instead — since StructureInput's
        // ruled fill (2026-07-11) is now that same badge tint, badgeTint makes
        // wheel and input read as ONE colour on a surface host. (Web's
        // PolarChart uses 0.85 + a 0.13 ghost — a third rendering; web is
        // frozen pre-redesign.) Changing the DEFAULT is a design decision —
        // ask Simon, don't "fix" it.
        <Path
          key={w.index}
          d={w.d}
          fill={badgeTint ? mix(axes[w.index].color, theme.surface, 0.72) : axes[w.index].color}
          fillOpacity={badgeTint ? 1 : 0.72}
        />
      ))}
      {labels
        ? geo.labels.map((l) => (
            <SvgText
              key={l.index}
              x={l.x}
              y={l.y + LABEL_OFFSET / 7} // optical centre: RN svg baseline ≈ middle nudge
              fontSize={typeScale.caption.size}
              fontFamily="InstrumentSans_500Medium"
              fill={theme.inkSoft}
              textAnchor={l.anchor}
            >
              {axes[l.index].label}
            </SvgText>
          ))
        : null}
    </Svg>
  );
}
