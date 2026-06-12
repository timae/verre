import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';
import { flavourWheelGeometry, LABEL_OFFSET } from '@verre/core';
import { typeScale, useTheme } from '@/theme';

export type WheelAxis = {
  label: string;
  color: string;
  /** Whole-number intensity 0–5; 0 renders no wedge. */
  value: number;
};

// Coxcomb flavour wheel (handoff §4): each wedge a flavour colour, length =
// eased intensity, open hub, 3° gaps. Geometry from @verre/core; this is the
// react-native-svg render layer (the web design's SVG-string assembly does
// not port — proposal 05 §2). Colours arrive as data: the Vero palette for
// the real backend flavour sets is a pending design decision.
export function FlavourWheel({ axes, size = 260, labels = true }: { axes: WheelAxis[]; size?: number; labels?: boolean }) {
  const { theme } = useTheme();
  const pad = labels ? 58 : 4;
  const vpad = labels ? 12 : 4;
  const geo = flavourWheelGeometry(axes.map((a) => a.value), size);

  return (
    <Svg
      width={size + pad * 2}
      height={size + vpad * 2}
      viewBox={`${-pad} ${-vpad} ${size + pad * 2} ${size + vpad * 2}`}
    >
      <Circle cx={geo.cx} cy={geo.cy} r={geo.R} fill="none" stroke={theme.rule} strokeWidth={1} />
      <Circle cx={geo.cx} cy={geo.cy} r={geo.r0} fill="none" stroke={theme.ruleSoft} strokeWidth={1} />
      {geo.wedges.map((w) => (
        <Path key={w.index} d={w.d} fill={axes[w.index].color} fillOpacity={0.72} />
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
