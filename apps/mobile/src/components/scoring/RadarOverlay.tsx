import { useId } from 'react';
import Svg, { Circle, Defs, G, Line, Mask, Path, Rect, Text as SvgText } from 'react-native-svg';
import { LABEL_OFFSET, radarOverlayGeometry, radarSeriesPoints } from '@verre/core';
import { typeScale, useTheme } from '@/theme';

export type RadarSeries = {
  /** Stable identity for the React key (identity id, never display name). */
  id: string;
  color: string;
  /** Normalized full axis set (fillFlavourZeros) — one value per axis, 0 sits on the hub. */
  values: number[];
};

// Overlaid multi-taster radar (02d, 2–4 tasters). Same radius/hub/ease as the
// wheels so a value sits at the SAME radius on radar and C1b (design intent,
// vero-scoring.js radarMulti). The open hub is punched out of the series fills
// and strokes with a mask so the void stays visible; guide rings sit at the
// eased whole intensities 1..5.
export function RadarOverlay({
  axes,
  series,
  size = 232,
  maxWidth,
  selected = -1,
  onSelectLabel,
}: {
  /** Axis labels in registry order. */
  axes: string[];
  series: RadarSeries[];
  size?: number;
  /** Measured host width — scales the whole canvas down uniformly (the design's max-width:100%). */
  maxWidth?: number;
  /** Drilled-in axis index, -1 for none (highlights that label). */
  selected?: number;
  /** Axis-label tap → the per-axis split (02d ruling: radar drills like C1b). */
  onSelectLabel?: (index: number) => void;
}) {
  const { theme } = useTheme();
  // pad 58 (mock: 56) — FlavourWheel's padding, so the size-adaptive chart
  // swap keeps one canvas width and a fixed wheel centre (see ComparisonWheel).
  const pad = 58;
  const vpad = 14;
  // Per-instance mask id (the mock's uid counter): react-native-svg scopes ids
  // per Svg root, but two mounted radars would still collide if a future
  // surface renders them side by side.
  const maskId = `hub-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const geo = radarOverlayGeometry(axes.length, size);
  const naturalW = size + pad * 2;
  const scale = maxWidth && maxWidth < naturalW ? maxWidth / naturalW : 1;

  return (
    <Svg
      width={naturalW * scale}
      height={(size + vpad * 2) * scale}
      viewBox={`${-pad} ${-vpad} ${size + pad * 2} ${size + vpad * 2}`}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Overlaid flavour radar, ${series.length} taster${series.length === 1 ? '' : 's'}`}
    >
      <Defs>
        <Mask id={maskId}>
          <Rect x={-pad} y={-vpad} width={size + pad * 2} height={size + vpad * 2} fill="white" />
          <Circle cx={geo.cx} cy={geo.cy} r={geo.r0} fill="black" />
        </Mask>
      </Defs>
      <Circle cx={geo.cx} cy={geo.cy} r={geo.r0} fill="none" stroke={theme.ruleSoft} strokeWidth={1} />
      {geo.rings.map((r, i) => (
        <Circle key={i} cx={geo.cx} cy={geo.cy} r={r} fill="none" stroke={theme.rule} strokeWidth={1} />
      ))}
      {geo.spokes.map((s) => (
        <Line key={s.index} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={theme.rule} strokeWidth={1} />
      ))}
      <G mask={`url(#${maskId})`}>
        {series.map((s) => {
          const pts = radarSeriesPoints(s.values, size);
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z';
          return (
            <Path
              key={s.id}
              d={d}
              fill={s.color}
              fillOpacity={0.13}
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          );
        })}
      </G>
      {series.map((s) =>
        radarSeriesPoints(s.values, size).map((p, i) => (
          <Circle key={`${s.id}-${i}`} cx={p.x} cy={p.y} r={2.4} fill={s.color} />
        )),
      )}
      {geo.labels.map((l) => (
        <SvgText
          key={l.index}
          x={l.x}
          y={l.y + LABEL_OFFSET / 7} // optical centre nudge (FlavourWheel parity)
          fontSize={typeScale.caption.size}
          fontFamily="InstrumentSans_500Medium"
          // Selected axis label darkens to ink (same affordance as C1b).
          fill={selected === l.index ? theme.ink : theme.inkSoft}
          textAnchor={l.anchor}
        >
          {axes[l.index]}
        </SvgText>
      ))}
      {/* Generous invisible hit targets over the caption-sized labels — the
          text itself is far too small to tap reliably. Anchored to match the
          label's growth direction; also the labels' single assistive-tech
          stop. */}
      {onSelectLabel
        ? geo.labels.map((l) => (
            <Rect
              key={`hit-${l.index}`}
              x={l.anchor === 'end' ? l.x - 62 : l.anchor === 'middle' ? l.x - 36 : l.x - 10}
              y={l.y - 16}
              width={72}
              height={32}
              fill="transparent"
              onPress={() => onSelectLabel(l.index)}
              accessible
              accessibilityLabel={`${axes[l.index]}${selected === l.index ? ', selected' : ''}. Double tap for the split.`}
            />
          ))
        : null}
    </Svg>
  );
}
