import { Fragment } from 'react';
import Svg, { ClipPath, Defs, Line, LinearGradient, Path, Stop, Text as SvgText, TextPath } from 'react-native-svg';
import type { SpiralLayout } from './aromaVizGeometry';
import { alpha, inkOn, mix } from '@/theme/color';
import { useAromaColors } from '@/theme/flavourColors';
import { useTheme } from '@/theme';

// Shared painter for the Aroma Bun. Geometry stays pure in
// aromaVizGeometry.ts; this component only applies Verre family colours,
// transitions, separators and labels to an already-computed layout.
export function AromaBunGraphic({
  layout,
  width,
  fontSize,
  accessibilityLabel,
  monochrome = false,
  backgroundColor,
}: {
  layout: SpiralLayout;
  width: number;
  fontSize: number;
  accessibilityLabel: string;
  monochrome?: boolean;
  backgroundColor?: string;
}) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  if (layout.segments.length === 0) return null;

  const bg = backgroundColor ?? theme.surface;
  const colorOf = (familyId: string, others: boolean) => {
    if (monochrome) return others ? mix(theme.accent, bg, 0.45) : theme.accent;
    return others || familyId === 'other' ? theme.inkFaint : aromaColor(familyId);
  };
  const height = (width * layout.bbox.h) / layout.bbox.w;

  return (
    <Svg
      pointerEvents="none"
      accessible
      accessibilityLabel={accessibilityLabel}
      width={width}
      height={height}
      viewBox={`${layout.bbox.x.toFixed(1)} ${layout.bbox.y.toFixed(1)} ${layout.bbox.w.toFixed(1)} ${layout.bbox.h.toFixed(1)}`}
    >
      <Defs>
        {layout.separators.map((separator, index) => (
          <ClipPath key={`separator-clip-${index}`} id={`aroma-bun-separator-clip-${index}`}>
            <Path d={separator.clipD} />
          </ClipPath>
        ))}
        {layout.segments.map((segment, index) => {
          const own = colorOf(segment.familyId, segment.others);
          return (
            <Fragment key={`fades-${index}`}>
              {segment.fade ? (
                <LinearGradient
                  id={`aroma-bun-fade-${index}`}
                  x1={segment.fade.x1}
                  y1={segment.fade.y1}
                  x2={segment.fade.x2}
                  y2={segment.fade.y2}
                  gradientUnits="userSpaceOnUse"
                >
                  <Stop offset="0" stopColor={own} />
                  <Stop offset="1" stopColor={mix(own, colorOf(segment.fade.nextFamilyId, segment.fade.nextOthers), 0.5)} />
                </LinearGradient>
              ) : null}
              {segment.fadeIn ? (
                <LinearGradient
                  id={`aroma-bun-fadein-${index}`}
                  x1={segment.fadeIn.x1}
                  y1={segment.fadeIn.y1}
                  x2={segment.fadeIn.x2}
                  y2={segment.fadeIn.y2}
                  gradientUnits="userSpaceOnUse"
                >
                  <Stop offset="0" stopColor={mix(own, colorOf(segment.fadeIn.prevFamilyId, segment.fadeIn.prevOthers), 0.5)} />
                  <Stop offset="1" stopColor={own} />
                </LinearGradient>
              ) : null}
            </Fragment>
          );
        })}
      </Defs>
      <Path
        d={layout.capStartD}
        fill="none"
        stroke={colorOf(layout.segments[0].familyId, layout.segments[0].others)}
        strokeWidth={layout.ribbon}
        strokeLinecap="round"
      />
      <Path
        d={layout.capEndD}
        fill="none"
        stroke={colorOf(layout.segments[layout.segments.length - 1].familyId, layout.segments[layout.segments.length - 1].others)}
        strokeWidth={layout.ribbon}
        strokeLinecap="round"
      />
      {layout.segments.map((segment, index) => (
        <Path
          key={`segment-${index}`}
          d={segment.bandD}
          fill={colorOf(segment.familyId, segment.others)}
        />
      ))}
      {layout.segments.map((segment, index) => segment.fade ? (
        <Path
          key={`fade-${index}`}
          d={segment.fade.bandD}
          fill={`url(#aroma-bun-fade-${index})`}
        />
      ) : null)}
      {layout.segments.map((segment, index) => segment.fadeIn ? (
        <Path
          key={`fadein-${index}`}
          d={segment.fadeIn.bandD}
          fill={`url(#aroma-bun-fadein-${index})`}
        />
      ) : null)}
      {layout.separators.map((separator, index) => (
        <Path
          key={`separator-${index}`}
          d={separator.pathD}
          fill={bg}
          clipPath={`url(#aroma-bun-separator-clip-${index})`}
        />
      ))}
      {layout.segments.map((segment, index) => segment.labelText ? (
        <Fragment key={`label-${index}`}>
          <Path id={`aroma-bun-label-${index}`} d={segment.labelPathD} fill="none" stroke="none" />
          <SvgText
            fill={inkOn(colorOf(segment.familyId, segment.others), theme.ink, bg)}
            fontFamily="InstrumentSans_600SemiBold"
            fontSize={fontSize}
            textAnchor="middle"
            dy={4}
          >
            <TextPath href={`#aroma-bun-label-${index}`} startOffset="50%">{segment.labelText}</TextPath>
          </SvgText>
        </Fragment>
      ) : null)}
      {layout.callouts.map((callout, index) => (
        <Fragment key={`callout-${index}`}>
          <Line x1={callout.px} y1={callout.py} x2={callout.ex} y2={callout.ey} stroke={alpha(theme.inkSoft, 0.6)} strokeWidth={1} />
          <Line
            x1={callout.ex}
            y1={callout.ey}
            x2={callout.lx + (callout.anchor === 'start' ? -2 : 2)}
            y2={callout.ly - fontSize * 0.35}
            stroke={alpha(theme.inkSoft, 0.6)}
            strokeWidth={1}
          />
          <SvgText
            x={callout.lx}
            y={callout.ly}
            fill={theme.inkSoft}
            fontFamily="InstrumentSans_500Medium"
            fontSize={fontSize}
            textAnchor={callout.anchor}
          >
            {callout.label}
          </SvgText>
        </Fragment>
      ))}
    </Svg>
  );
}
