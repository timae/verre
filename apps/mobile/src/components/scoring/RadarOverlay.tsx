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
// (when the contour is closed) and strokes with a mask so the void stays
// visible; guide rings sit at the eased whole intensities 1..5.
export function RadarOverlay({
  axes,
  series,
  size = 232,
  maxWidth,
  selected = -1,
  absentAxes,
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
  /** Parallel to `axes`: true where no taster in the selection was ASKED that
   *  axis (aggregate n=0). A never-asked axis reads as absent, not a hub-pinned
   *  0: its spoke + label go quiet/dashed, its vertex dot is dropped, and the
   *  series contour is OPENED so no edge runs across it (see the path builder). */
  absentAxes?: boolean[];
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
      // Root deliberately NOT accessible (ComparisonWheel parity): an
      // accessible root groups children on iOS and would swallow the per-label
      // hit-rect stops below.
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
        <Line
          key={s.index}
          x1={s.x1}
          y1={s.y1}
          x2={s.x2}
          y2={s.y2}
          stroke={theme.rule}
          strokeWidth={1}
          strokeDasharray={absentAxes?.[s.index] ? '2 3' : undefined}
        />
      ))}
      <G mask={`url(#${maskId})`}>
        {series.map((s) => {
          const pts = radarSeriesPoints(s.values, size);
          // Build the contour over the ASKED axes only. A never-asked axis
          // (absentAxes[i]) is not a data point — the stroke must NOT run across
          // it (that would draw a false edge dipping to the hub, Simon
          // 2026-07-06). Walk the axes as a CIRCLE and cut the run wherever an
          // absent axis interrupts; an edge between two adjacent present axes
          // (incl. the last→first wrap) is real and kept.
          const present = pts.map((p, i) => ({ p, i })).filter((x) => !absentAxes?.[x.i]);
          if (present.length === 0) return null;
          // Rotate the circular order so it STARTS right after a gap — then a
          // simple gap-cut walk emits each maximal run of adjacent present axes
          // as its own open sub-path (no wrap-around bookkeeping).
          const n = pts.length;
          const anyAbsent = present.length < n;
          let start = 0;
          if (anyAbsent) {
            // first present index whose PREDECESSOR (circular) is absent = a run start
            start = present.findIndex((x) => absentAxes?.[(x.i - 1 + n) % n]);
            if (start < 0) start = 0;
          }
          const ordered = present.slice(start).concat(present.slice(0, start));
          const segs: string[] = [];
          let cur: typeof ordered = [];
          const flush = () => {
            if (cur.length) segs.push(cur.map((x, k) => `${k === 0 ? 'M' : 'L'} ${x.p.x} ${x.p.y}`).join(' '));
            cur = [];
          };
          for (let k = 0; k < ordered.length; k++) {
            const x = ordered[k];
            if (k > 0) {
              const prevAxis = ordered[k - 1].i;
              const gap = (x.i - prevAxis + n) % n; // >1 means an absent axis sits between
              if (gap !== 1) flush();
            }
            cur.push(x);
          }
          flush();
          // No gaps at all → close the loop as before (a fully-rated wine).
          const closed = !anyAbsent;
          const d = closed
            ? ordered.map((x, k) => `${k === 0 ? 'M' : 'L'} ${x.p.x} ${x.p.y}`).join(' ') + ' Z'
            : segs.join(' ');
          return (
            <Path
              key={s.id}
              d={d}
              // Fill only when the contour is a genuine closed loop; an open
              // (partial-data) contour would implicit-close across the gap and
              // re-introduce the false region — so it renders as a stroke only.
              fill={closed ? s.color : 'none'}
              fillOpacity={closed ? 0.13 : 0}
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}
      </G>
      {series.map((s) =>
        radarSeriesPoints(s.values, size).map((p, i) =>
          // No vertex DOT on a never-asked axis — a dot at the hub reads as
          // "rated 0" (the contour above is already opened across it).
          absentAxes?.[i] ? null : <Circle key={`${s.id}-${i}`} cx={p.x} cy={p.y} r={2.4} fill={s.color} />,
        ),
      )}
      {geo.labels.map((l) => (
        <SvgText
          key={l.index}
          x={l.x}
          y={l.y + LABEL_OFFSET / 7} // optical centre nudge (FlavourWheel parity)
          fontSize={typeScale.caption.size}
          fontFamily="InstrumentSans_500Medium"
          // Selected axis label darkens to ink (same affordance as C1b); an
          // absent axis (never asked) reads faint.
          fill={absentAxes?.[l.index] ? theme.inkFaint : selected === l.index ? theme.ink : theme.inkSoft}
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
              accessibilityLabel={`${axes[l.index]}${absentAxes?.[l.index] ? ', not rated by this group' : ''}${selected === l.index ? ', selected' : ''}. Double tap for the split.`}
            />
          ))
        : null}
    </Svg>
  );
}
