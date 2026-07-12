import Svg, { Circle, Path, Rect, Text as SvgText } from 'react-native-svg';
import { comparisonWheelGeometry, LABEL_OFFSET } from '@verre/core';
import { intensityWord } from '@/lib/scoreWords';
import { mix } from '@/theme/color';
import { typeScale, useTheme } from '@/theme';

export type ComparisonAxis = {
  label: string;
  color: string;
  min: number;
  max: number;
  avg: number;
  /** No taster in the selection was ever ASKED this axis (aggregate n=0 — e.g.
   *  bubbles on a wine since flipped to spark). The slot is KEPT (fixed
   *  geometry across wines) but drawn as an absent placeholder: base wedge only,
   *  no band/avg arc, quiet dashed rule + faint label. NOT a real perceived 0. */
  absent?: boolean;
};

// Comparison wheel · C1b (design vero-scoring.js ~326, DECIDED for 5+ tasters):
// per axis a min→max range band in a light tone with a quiet arc at the group
// average in a dark tone — tones invert on the selected wedge. A full-height
// faint base wedge doubles as the tap target. Geometry from @verre/core; the
// mock's CSS color-mix(42%|92% against --surface) maps to theme mix().
export function ComparisonWheel({
  axes,
  size = 232,
  selected = -1,
  maxWidth,
  onSelect,
}: {
  axes: ComparisonAxis[];
  size?: number;
  /** Drilled-in wedge index, -1 for none. */
  selected?: number;
  /** Measured host width — scales the whole canvas down uniformly (the design's max-width:100%). */
  maxWidth?: number;
  onSelect?: (index: number) => void;
}) {
  const { theme } = useTheme();
  // pad 58 (mock: 50) — deliberately StructureWheel's padding so all three
  // size-adaptive charts share one canvas width and the wheel centre stays
  // fixed when the taster count flips the chart type.
  const pad = 58;
  const vpad = 12;
  const geo = comparisonWheelGeometry(axes, size);
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
      {geo.wedges.map((w) => (
        <Path
          key={`base-${w.index}`}
          d={w.baseD}
          fill={axes[w.index].color}
          fillOpacity={0.05}
          onPress={onSelect ? () => onSelect(w.index) : undefined}
        />
      ))}
      {geo.wedges.map((w) => {
        const a = axes[w.index];
        const sel = selected === w.index;
        // An ABSENT axis (no taster asked) keeps its slot but shows no band —
        // just a quiet dashed rule at the rim so the empty wedge reads as
        // "not rated," not a real 0 pinned at the hub. The base wedge (drawn
        // above) stays the tap target so the split is still reachable.
        if (a.absent) {
          return (
            <Path
              key={`band-${w.index}`}
              d={w.baseD}
              fill="none"
              stroke={theme.ruleSoft}
              strokeWidth={1}
              strokeDasharray="2 3"
              onPress={onSelect ? () => onSelect(w.index) : undefined}
              accessible={!!onSelect}
              accessibilityLabel={
                onSelect
                  ? `${a.label}, not rated by this group${sel ? ', selected' : ''}. Double tap for the split.`
                  : undefined
              }
            />
          );
        }
        // Two solid tones off the axis colour (mock: color-mix 42% / 92% into
        // --surface); the band wears the light tone, the avg arc the dark —
        // inverted on the selected wedge.
        const lightTone = mix(a.color, theme.surface, 0.42);
        const darkTone = mix(a.color, theme.surface, 0.92);
        return (
          <Path
            key={`band-${w.index}`}
            d={w.bandD}
            fill={sel ? darkTone : lightTone}
            onPress={onSelect ? () => onSelect(w.index) : undefined}
            // The band is the wedge's assistive-tech surface (the base wedge +
            // label stay non-accessible so each axis is one focus stop).
            // react-native-svg elements only support accessible/label — no
            // role/state props — so selection is folded into the label.
            accessible={!!onSelect}
            accessibilityLabel={
              onSelect
                ? `${a.label}: ${intensityWord(a.min)} to ${intensityWord(a.max)}, average ${a.avg.toFixed(1)}${sel ? ', selected' : ''}. Double tap for the split.`
                : undefined
            }
          />
        );
      })}
      {geo.wedges.map((w) => {
        const a = axes[w.index];
        if (a.absent) return null; // no average arc for a never-asked axis
        const sel = selected === w.index;
        return (
          <Path
            key={`avg-${w.index}`}
            d={w.avgD}
            fill="none"
            stroke={sel ? mix(a.color, theme.surface, 0.42) : mix(a.color, theme.surface, 0.92)}
            strokeWidth={2.6}
            strokeLinecap="round"
            pointerEvents="none"
          />
        );
      })}
      {geo.labels.map((l) => (
        <SvgText
          key={l.index}
          x={l.x}
          y={l.y + LABEL_OFFSET / 7} // optical centre: RN svg baseline ≈ middle nudge (StructureWheel parity)
          fontSize={typeScale.caption.size}
          fontFamily="InstrumentSans_500Medium"
          // Deliberate addition over the mock (which keeps labels ink-soft):
          // the selected wedge's label darkens to ink as a selection affordance.
          // An absent axis (never asked) reads faint — quieter than a rated one.
          fill={axes[l.index].absent ? theme.inkFaint : selected === l.index ? theme.ink : theme.inkSoft}
          textAnchor={l.anchor}
        >
          {axes[l.index].label}
        </SvgText>
      ))}
      {/* Generous invisible hit targets over the caption-sized labels (the
          wedge is the main target + the a11y stop; these make the label a
          reliable secondary tap). */}
      {onSelect
        ? geo.labels.map((l) => (
            <Rect
              key={`hit-${l.index}`}
              x={l.anchor === 'end' ? l.x - 62 : l.anchor === 'middle' ? l.x - 36 : l.x - 10}
              y={l.y - 16}
              width={72}
              height={32}
              fill="transparent"
              onPress={() => onSelect(l.index)}
            />
          ))
        : null}
    </Svg>
  );
}
