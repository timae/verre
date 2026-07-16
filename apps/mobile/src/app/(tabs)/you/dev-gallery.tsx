import { Fragment, useMemo, useState } from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText, TextPath } from 'react-native-svg';
import { AromaBunGraphic } from '@/components/moments/AromaBunGraphic';
import { buildCompareAromaModel } from '@/components/moments/aromaCompareView';
import { aromaMosaic, concentricRings, spiralRibbon, weightedPolar, type MosaicMode, type PolarMode, type VizFamily } from '@/components/moments/aromaVizGeometry';
import { aromaIris, bubbleColumns, radialTreemap, ringChain, voronoiContinents, type ContinentsShape, type IrisDepth } from '@/components/moments/aromaVizGeometry2';
import { additiveMentionFamilies, aromaVizShortLabel, irisMentionFamilies, LONG_TAIL_120_PEOPLE_1440_MENTIONS, MIXED_GRAIN_20_PEOPLE_200_MENTIONS } from '@/components/moments/aromaVizFixtures';
import { Segmented } from '@/components/ui/Segmented';
import { alpha, inkOn, mix } from '@/theme/color';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AROMA_FAMILIES, resolveAxes, perRatingAxes } from '@verre/core';
import { StructureWheel, type WheelAxis } from '@/components/scoring/StructureWheel';
import { StructureInput } from '@/components/scoring/StructureInput';
import { AromaChip, useTapOrDouble } from '@/components/scoring/aroma/parts';
import { StarScore } from '@/components/scoring/StarScore';
import { QrCode } from '@/components/ui/QrCode';
import { VText } from '@/components/ui/VText';
import { contrastRatio } from '@/lib/contrast';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { useAromaColors, useFlavourColors } from '@/theme/flavourColors';
import { radius, space, themes, typeScale, useTheme, type ThemeChoice } from '@/theme';
// Dev-only widget gallery + theme switcher: the Simulator verification surface
// for the scoring widgets and the NativeTabs/theming spike. Not a user surface.
//
// Structure-wheel data: the axes are the real registry set (resolveAxes) with
// colour resolved from the ACTIVE THEME (useFlavourColors) — switch themes above
// to see the wheel + input retint. A sparkling style is used here so Bubbles
// shows; the values are a demo profile.
const SAMPLE_STYLE = 'spark';
const SAMPLE_LEVELS: Record<string, number> = {
  sweet: 2,
  acid: 4,
  body: 3,
  finish: 4,
  aroma: 3,
  flavour: 5,
  funk: 1,
  tannin: 2,
  bubbles: 4,
};

// Dev-only value slider (the app has no slider dep) — pan/tap the track,
// step-snapped. Powers the badge-height exploration in the aroma section.
function DevSlider({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number }) {
  const { theme } = useTheme();
  const [trackW, setTrackW] = useState(0);
  const setFromX = (x: number) => {
    if (trackW <= 0) return;
    const frac = Math.min(1, Math.max(0, x / trackW));
    const next = Math.round((min + frac * (max - min)) / step) * step;
    if (next !== value) onChange(next);
  };
  const pan = Gesture.Pan().runOnJS(true).activeOffsetX([-6, 6]).failOffsetY([-8, 8]).onUpdate((e) => setFromX(e.x));
  const tap = Gesture.Tap().runOnJS(true).onEnd((e, ok) => { if (ok) setFromX(e.x); });
  const frac = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return (
    <GestureDetector gesture={Gesture.Race(pan, tap)}>
      <View onLayout={(e) => setTrackW(e.nativeEvent.layout.width)} style={{ height: 28, justifyContent: 'center' }}>
        <View style={{ height: 6, borderRadius: 999, backgroundColor: theme.surfaceSunk, overflow: 'hidden' }}>
          <View style={{ width: `${frac * 100}%`, height: '100%', backgroundColor: theme.accent }} />
        </View>
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: Math.max(0, Math.min(trackW - 18, frac * trackW - 9)), width: 18, height: 18, borderRadius: 999, backgroundColor: theme.accent }}
        />
      </View>
    </GestureDetector>
  );
}

// ── Aroma summary visualisations (static look studies) ──────────────────────
// These deliberately show a LEADING SUBSET, never the complete 12-family / full
// taxonomy. The exhaustive view already belongs to All Aromas; this lab asks
// which summary shape gives the fastest human read of the same sample panel.
type AromaVizFamily = VizFamily;

// ADDITIVE samples (reference-mock semantics: a family's count = the sum of
// its named notes + its unnamed remainder, so segmented rings and Others
// tails are honest). `tasters` feeds the B "by tasters" sector variant. TWO
// sets (Simon round 5): the earthy matchy-palette one, and a WILD set whose
// family colours clash on purpose (floral/sweet/chemical/mineral/fire/funky).
// "Tasting" set = Simon's REAL fixture panel (20 people, 200 taxonomy-valid
// picks, mixed grain + modifiers) converted to additive mention families —
// replaces the hand-made earthy sample (round 7).
const AROMA_SET_TASTING: AromaVizFamily[] = additiveMentionFamilies(MIXED_GRAIN_20_PEOPLE_200_MENTIONS).map((family) => ({
  id: family.id,
  label: family.label,
  count: family.count,
  tasters: family.tasters,
  notes: family.notes.map((note) => ({ label: note.label, count: note.count })),
}));
const AROMA_SET_STRESS: AromaVizFamily[] = additiveMentionFamilies(LONG_TAIL_120_PEOPLE_1440_MENTIONS).map((family) => ({
  id: family.id,
  label: family.label,
  count: family.count,
  tasters: family.tasters,
  notes: family.notes.map((note) => ({ label: note.label, count: note.count })),
}));
const AROMA_SET_WILD: AromaVizFamily[] = [
  { id: 'sweet', label: 'Sweet', count: 88, tasters: 47, notes: [{ label: 'Honey', count: 31 }, { label: 'Vanilla', count: 22 }, { label: 'Caramel', count: 15 }] },
  { id: 'floral', label: 'Floral', count: 66, tasters: 33, notes: [{ label: 'Rose', count: 26 }, { label: 'Violet', count: 18 }, { label: 'Honeysuckle', count: 11 }] },
  { id: 'chemical', label: 'Chemical', count: 45, tasters: 26, notes: [{ label: 'Petrol', count: 24 }, { label: 'Skunky', count: 13 }] },
  { id: 'mineral', label: 'Mineral', count: 39, tasters: 24, notes: [{ label: 'Flint', count: 21 }, { label: 'Chalk', count: 12 }] },
  { id: 'fire', label: 'Fire', count: 30, tasters: 18, notes: [{ label: 'Smoke', count: 17 }, { label: 'Tar', count: 8 }] },
  { id: 'funky', label: 'Funky', count: 28, tasters: 16, notes: [{ label: 'Blue cheese', count: 14 }, { label: 'Barnyard', count: 9 }] },
  { id: 'other', label: 'Other families', count: 22, tasters: 13, notes: [{ label: 'Fruity', count: 12 }, { label: 'Savory', count: 10 }] },
];
// Round-6 stress set: ~20 tasters, 200 mentions, random-ish spread across ALL
// 12 real families (numbers fixed, generated once — no pseudo "other" entry:
// the omission machinery produces Others naturally at scale).
const AROMA_SET_RANDOM200: AromaVizFamily[] = [
  { id: 'fruity', label: 'Fruity', count: 34, tasters: 18, notes: [{ label: 'Strawberry', count: 9 }, { label: 'Lemon', count: 8 }, { label: 'Apricot', count: 6 }, { label: 'Blackcurrant', count: 4 }] },
  { id: 'sweet', label: 'Sweet', count: 25, tasters: 14, notes: [{ label: 'Honey', count: 9 }, { label: 'Vanilla', count: 7 }, { label: 'Caramel', count: 5 }] },
  { id: 'woody', label: 'Woody', count: 23, tasters: 13, notes: [{ label: 'Oak', count: 10 }, { label: 'Cedar', count: 6 }, { label: 'Sandalwood', count: 4 }] },
  { id: 'vegetal', label: 'Vegetal', count: 21, tasters: 12, notes: [{ label: 'Cut grass', count: 8 }, { label: 'Bell pepper', count: 6 }, { label: 'Fennel', count: 3 }] },
  { id: 'spice', label: 'Spice', count: 17, tasters: 10, notes: [{ label: 'Pepper', count: 7 }, { label: 'Clove', count: 5 }, { label: 'Cinnamon', count: 3 }] },
  { id: 'mineral', label: 'Mineral', count: 16, tasters: 9, notes: [{ label: 'Flint', count: 7 }, { label: 'Wet stone', count: 6 }] },
  { id: 'fire', label: 'Fire', count: 14, tasters: 9, notes: [{ label: 'Smoke', count: 8 }, { label: 'Tar', count: 4 }] },
  { id: 'floral', label: 'Floral', count: 12, tasters: 8, notes: [{ label: 'Rose', count: 7 }, { label: 'Violet', count: 3 }] },
  { id: 'funky', label: 'Funky', count: 11, tasters: 7, notes: [{ label: 'Blue cheese', count: 5 }, { label: 'Barnyard', count: 4 }] },
  { id: 'chemical', label: 'Chemical', count: 10, tasters: 6, notes: [{ label: 'Petrol', count: 6 }, { label: 'Skunky', count: 3 }] },
  { id: 'kernel', label: 'Kernel', count: 9, tasters: 6, notes: [{ label: 'Almond', count: 5 }, { label: 'Marzipan', count: 3 }] },
  { id: 'savory', label: 'Savory', count: 8, tasters: 5, notes: [{ label: 'Broth', count: 4 }, { label: 'Soy', count: 2 }] },
];

const vizNotes = (families: AromaVizFamily[]) =>
  families
    .flatMap((family) => family.notes.map((note) => ({ ...note, shortLabel: aromaVizShortLabel(note.label), familyId: family.id })))
    .sort((a, b) => b.count - a.count);

// Geometry lives in the PURE, harness-pinned module (aromaVizGeometry —
// d3-shape math, rnsvg rendering per Simon's stack ruling 2026-07-15); these
// components only paint its `d` strings and placements.

function AromaVizLegend({ families }: { families: AromaVizFamily[] }) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10 }}>
      {families.map((family) => (
        <View key={family.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: family.id === 'other' ? theme.inkFaint : aromaColor(family.id) }} />
          <VText surface="badge" variant="caption" color="inkSoft">{family.label}</VText>
        </View>
      ))}
    </View>
  );
}

function ConcentricRingsStudy({ size, families, dataKey }: { size: number; families: AromaVizFamily[]; dataKey: string }) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  const fontSize = typeScale.caption.size - 1;
  const [origin, setOrigin] = useState<'top' | 'bottom'>('top');
  const [scaleMode, setScaleMode] = useState<'length' | 'angle' | 'hierarchy'>('length');
  // Round-6 sliders: row thickness + inter-ring gap (0 = the "no space
  // between arcs" version). The ring count auto-fits — fatter rows can cost
  // a ring, and the layout answers "would we lose a line" live.
  const [rowThick, setRowThick] = useState(16);
  const [rowGap, setRowGap] = useState(3);
  // All three studies reserve at least a 13% notch. Length compares physical distance,
  // Angle compares family share without letting inner circumference reject a
  // ring, and Full Rings uses radius for rank while maximizing label space.
  const layout = concentricRings(families, {
    size,
    maxRings: 6,
    fontSize,
    originDeg: origin === 'bottom' ? 210 : 0,
    maxSweepDeg: 313.2,
    thicknessPx: rowThick,
    gapPx: rowGap,
    mode: scaleMode,
    hierarchyStepDeg: 4,
  });
  return (
    <View style={{ gap: 10, alignItems: 'center', alignSelf: 'stretch' }}>
      <Segmented
        compact
        segments={[{ key: 'top' as const, label: 'From Top' }, { key: 'bottom' as const, label: 'From Bottom' }]}
        active={origin}
        onSelect={setOrigin}
      />
      <Segmented
        compact
        segments={[
          { key: 'length' as const, label: 'Length' },
          { key: 'angle' as const, label: 'Angle' },
          { key: 'hierarchy' as const, label: 'Full Rings' },
        ]}
        active={scaleMode}
        onSelect={setScaleMode}
      />
      <View style={{ alignSelf: 'stretch', gap: 2 }}>
        <VText variant="caption" color="inkFaint">{`${scaleMode === 'length' ? 'Shared physical length' : scaleMode === 'angle' ? 'Shared proportional angle' : 'Ranked near-full rings'} · row ${rowThick} · rings ${layout.rings.length}`}</VText>
        <DevSlider value={rowThick} onChange={setRowThick} min={10} max={22} step={1} />
        <VText variant="caption" color="inkFaint">{`Ring gap ${rowGap} (default 3)${rowGap === 0 ? ' · touching' : ''}`}</VText>
        <DevSlider value={rowGap} onChange={setRowGap} min={0} max={8} step={1} />
      </View>
      <Svg
        // ⚠️ Remount on toggle: rnsvg TextPath keeps MOUNT-time path geometry —
        // without the key, flipping the origin moved the rings but left every
        // label stranded at its old position (the round-4 device mess).
        key={`${origin}-${scaleMode}-${dataKey}-${rowThick}-${rowGap}`}
        pointerEvents="none"
        accessible
        accessibilityLabel={scaleMode === 'length'
          ? "Ranked physical-length family rings. The strongest family is outermost and physical arc length compares family mentions."
          : scaleMode === 'angle'
            ? "Ranked proportional-angle family rings. The six strongest families use one common angular scale, with the strongest reaching eighty-seven percent."
            : "Ranked full family rings. The six strongest families run outermost to innermost on near-full arcs, and each ring shows that family's aroma mix."}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <G x={layout.cx} y={layout.cy}>
          {layout.rings.map((ring) => {
            const color = aromaColor(ring.familyId);
            // OPAQUE pale (mix, not alpha): translucent tails stacked with the
            // cap nubs and read as darker overlap blobs at the row ends.
            const pale = mix(color, theme.bg, 0.34);
            const segColor = (others: boolean) => (others ? pale : color);
            const first = ring.segments[0];
            const last = ring.segments[ring.segments.length - 1];
            return (
              <Fragment key={ring.familyId}>
                {/* Pill ends: tiny nub arcs with round caps at the row's start + end. */}
                <Path d={ring.capStartD} fill="none" stroke={segColor(first.others)} strokeWidth={layout.thickness} strokeLinecap="round" />
                <Path d={ring.capEndD} fill="none" stroke={segColor(last.others)} strokeWidth={layout.thickness} strokeLinecap="round" />
                {ring.segments.map((seg, i) => {
                  const id = `viz1-${origin}-${scaleMode}-${dataKey}-${ring.familyId}-${i}`;
                  return (
                    <Fragment key={id}>
                      <Path d={seg.arcD} fill="none" stroke={segColor(seg.others)} strokeWidth={layout.thickness} strokeLinecap="butt" />
                      {seg.labelText ? (
                        <>
                          <Path id={id} d={seg.labelPathD} fill="none" stroke="none" />
                          <SvgText fill={inkOn(segColor(seg.others), theme.ink, theme.bg)} fontFamily="InstrumentSans_600SemiBold" fontSize={fontSize} textAnchor="middle" dy={3.5}>
                            <TextPath href={`#${id}`} startOffset="50%">{seg.labelText}</TextPath>
                          </SvgText>
                        </>
                      ) : null}
                    </Fragment>
                  );
                })}
                {/* STRAIGHT radial cuts between segments (angular gaps read as
                    diverging slivers — round 5). */}
                {ring.separators.map((s, i) => (
                  <Line key={`rsep-${ring.familyId}-${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={theme.bg} strokeWidth={2} strokeLinecap="butt" />
                ))}
                {/* Straight family name beside the shared origin. The inner
                    rings reserve a larger angle for the same physical width. */}
                <SvgText x={ring.originX} y={ring.originY} textAnchor={ring.originAnchor} fontFamily="InstrumentSans_600SemiBold" fontSize={fontSize} fill={color}>
                  {ring.familyLabel}
                </SvgText>
              </Fragment>
            );
          })}
          {layout.othersDisc ? (
            <>
              <Circle cx={0} cy={0} r={layout.othersDisc.r} fill={alpha(theme.inkFaint, 0.22)} />
              <SvgText x={0} y={-2} fill={theme.inkSoft} fontFamily="InstrumentSans_600SemiBold" fontSize={fontSize} textAnchor="middle">{`${layout.othersDisc.familyCount} other`}</SvgText>
              <SvgText x={0} y={fontSize + 1} fill={theme.inkSoft} fontFamily="InstrumentSans_600SemiBold" fontSize={fontSize} textAnchor="middle">{layout.othersDisc.familyCount === 1 ? 'family' : 'families'}</SvgText>
            </>
          ) : null}
        </G>
      </Svg>
    </View>
  );
}

function WeightedPolarStudy({ size, families, dataKey }: { size: number; families: AromaVizFamily[]; dataKey: string }) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  const fontSize = typeScale.caption.size - 1;
  // Three sector weightings (Simon round 5): V1 mentions, V2 equal wedge
  // width (family grows with its aroma count), V3 by tasters touched.
  const [pMode, setPMode] = useState<PolarMode>('equal');
  // Each family's unnamed remainder feeds the centre Others together with
  // folded aromas and omitted families; only readable named bars stay radial.
  const withTail = (f: AromaVizFamily): AromaVizFamily => {
    const tail = f.count - f.notes.reduce((n, x) => n + x.count, 0);
    return tail > 0 ? { ...f, notes: [...f.notes, { label: 'Others', count: tail, others: true }] } : f;
  };
  const source: AromaVizFamily[] = families.filter((f) => f.id !== 'other').map(withTail);
  const layout = weightedPolar(source, { size, fontSize, mode: pMode });
  const colorOf = (id: string) => (id === 'other' ? theme.inkFaint : aromaColor(id));
  return (
    <View style={{ gap: 10, alignItems: 'center' }}>
      <Segmented
        compact
        segments={[
          { key: 'mentions' as const, label: 'Mentions' },
          { key: 'equal' as const, label: 'Equal Wedges' },
          { key: 'tasters' as const, label: 'Tasters' },
        ]}
        active={pMode}
        onSelect={setPMode}
      />
    <Svg
      // Remount on toggle — rnsvg TextPath keeps mount-time path geometry.
      key={`${pMode}-${dataKey}`}
      pointerEvents="none"
      accessible
      accessibilityLabel="Grouped circular aroma bars. Equal wedges are the default; bar length represents aroma mentions, family names sit at the hub, and every visible aroma label stays inside its bar. The centre bundles omitted families and aromas as Others."
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
    >
      {layout.sectors.map((s) => (
        <Fragment key={`sector-${s.familyId}`}>
          <Path d={s.guideD} fill="none" stroke={colorOf(s.familyId)} strokeWidth={3} strokeLinecap="round" />
          {/* Family name INSIDE the prominence arc (round-3 ruling). */}
          {s.labelText ? (
            <>
              <Path id={`viz2-fam-${s.familyId}`} d={s.labelPathD} fill="none" stroke="none" />
              <SvgText fill={colorOf(s.familyId)} fontFamily="InstrumentSans_600SemiBold" fontSize={fontSize} textAnchor="middle" dy={3.5}>
                <TextPath href={`#viz2-fam-${s.familyId}`} startOffset="50%">{s.labelText}</TextPath>
              </SvgText>
            </>
          ) : null}
        </Fragment>
      ))}
      <G x={layout.cx} y={layout.cy}>
        {layout.wedges.map((w) => (
          <Path
            key={`wedge-${w.familyId}-${w.label}-${w.angleDeg.toFixed(1)}`}
            d={w.wedgeD}
            fill={w.others ? mix(colorOf(w.familyId), theme.bg, 0.34) : colorOf(w.familyId)}
          />
        ))}
      </G>
      {layout.wedges.map((w) => w.labelText ? (
        <SvgText
          key={`wlabel-${w.familyId}-${w.label}-${w.angleDeg.toFixed(1)}`}
          x={w.labelX}
          y={w.labelY + fontSize * 0.32}
          fill={inkOn(w.others ? mix(colorOf(w.familyId), theme.bg, 0.34) : colorOf(w.familyId), theme.ink, theme.bg)}
          fontFamily="InstrumentSans_500Medium"
          fontSize={fontSize}
          textAnchor={w.labelAnchor}
          transform={`rotate(${w.labelRotate.toFixed(1)}, ${w.labelX.toFixed(1)}, ${w.labelY.toFixed(1)})`}
        >
          {w.labelText}
        </SvgText>
      ) : null)}
      {/* The centre circle IS Others: omitted families + folded aromas. */}
      <Circle cx={layout.cx} cy={layout.cy} r={layout.innerR - 30} fill={alpha(theme.inkFaint, 0.22)} />
      <SvgText x={layout.cx} y={layout.cy + fontSize * 0.35} fill={theme.inkSoft} fontFamily="InstrumentSans_600SemiBold" fontSize={fontSize} textAnchor="middle">Others</SvgText>
    </Svg>
    </View>
  );
}

function SpiralRibbonStudy({ size, families, dataKey }: { size: number; families: AromaVizFamily[]; dataKey: string }) {
  const { theme } = useTheme();
  const fontSize = typeScale.caption.size; // +1 (round 7)
  // Top notes ride the coil core → niche; EVERYTHING omitted (the long tail of
  // named notes + the pseudo "other" family + family remainders) aggregates
  // into the grey OUTER-TAIL segment — the coil's own start closes the centre.
  const notes = vizNotes(families);
  const [mono, setMono] = useState(false);
  const [input, setInput] = useState<'mentions' | 'agreement'>('mentions');
  // The geometry chooses the largest count-ranked prefix whose names all fit;
  // the remaining exact count lives in a visually capped Others tail. The
  // fade width remains adjustable for comparing the colour treatment.
  const [fadePx, setFadePx] = useState(9);
  const [labelPaddingPx, setLabelPaddingPx] = useState(6);
  // Agreement-summary mode uses the SAME compare derivation as production.
  // Mixed + Stress have real respondent fixtures; the two hand-authored colour
  // studies use Mixed as their explicit compare fixture.
  const agreementPanel = dataKey === 'stress'
    ? LONG_TAIL_120_PEOPLE_1440_MENTIONS
    : MIXED_GRAIN_20_PEOPLE_200_MENTIONS;
  const agreementModel = useMemo(() => buildCompareAromaModel(agreementPanel), [agreementPanel]);
  const mentionNotes = notes.filter((note) => note.familyId !== 'other');
  const top = input === 'agreement' ? agreementModel.bun : mentionNotes;
  // Others = the COMPLETE sample minus what rides the coil — family counts
  // include unnamed remainders that plain note sums silently lost (round-7
  // finding, confirmed: the coil's proportions must represent everything).
  const othersCount = input === 'agreement'
    ? 0
    : families.reduce((sum, f) => sum + f.count, 0) - mentionNotes.reduce((sum, note) => sum + note.count, 0);
  const layout = spiralRibbon(top, othersCount, { size, fontSize, callouts: false, fadePx, labelPaddingPx });
  const legendFamilies = input === 'agreement'
    ? AROMA_FAMILIES
        .filter((family) => layout.representedFamilyIds.includes(family.id))
        .map((family) => ({ id: family.id, label: family.label, count: 0, notes: [] }))
    : families.filter((family) => layout.representedFamilyIds.includes(family.id));
  return (
    <View style={{ gap: 10, alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }}>
        <Segmented
          compact
          segments={[{ key: 'mentions' as const, label: 'Mentions' }, { key: 'agreement' as const, label: 'Compare summary' }]}
          active={input}
          onSelect={setInput}
        />
        <Segmented
          compact
          segments={[{ key: 'family' as const, label: 'Family Colours' }, { key: 'mono' as const, label: 'Accent' }]}
          active={mono ? 'mono' : 'family'}
          onSelect={(k) => setMono(k === 'mono')}
        />
      </View>
      {input === 'agreement' && dataKey !== 'tasting' && dataKey !== 'stress' ? (
        <VText variant="caption" color="inkFaint">Compare summary uses the Mixed respondent fixture.</VText>
      ) : null}
      <View style={{ alignSelf: 'stretch', gap: 2 }}>
        <VText variant="caption" color="inkFaint">{`Colour fade width ${fadePx} (default 9)`}</VText>
        <DevSlider value={fadePx} onChange={setFadePx} min={2} max={30} step={1} />
        <VText variant="caption" color="inkFaint">{`Extra label padding ${labelPaddingPx}px (default 6)`}</VText>
        <DevSlider value={labelPaddingPx} onChange={setLabelPaddingPx} min={0} max={16} step={1} />
      </View>
      <AromaBunGraphic
        key={`${input}-${mono ? 'mono' : 'family'}-${fadePx}-${labelPaddingPx}-${dataKey}`}
        layout={layout}
        width={size}
        fontSize={fontSize}
        monochrome={mono}
        backgroundColor={theme.bg}
        accessibilityLabel="Shared-to-niche aroma coil. One continuous ribbon coils outward; segment length shows relative mentions, from widely shared at the centre to niche outside. Straight cuts mark where one aroma ends and the next begins, with the colours blending into each other on both sides of every cut; the grey tail bundles the remaining aromas as Others."
      />
      {mono ? null : <AromaVizLegend families={legendFamilies} />}
    </View>
  );
}

function AromaMosaicStudy({ size, families, dataKey }: { size: number; families: AromaVizFamily[]; dataKey: string }) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  const fontSize = typeScale.caption.size - 1;
  const [mode, setMode] = useState<MosaicMode>('aromas');
  const height = size * 0.72;
  const layout = aromaMosaic(families, { width: size, height, fontSize, mode });
  const colorOf = (familyId: string, others: boolean) => others
    ? mix(theme.inkFaint, theme.bg, 0.38)
    : aromaColor(familyId);
  return (
    <View style={{ gap: 10, alignItems: 'center' }}>
      <Segmented
        compact
        segments={[
          { key: 'aromas' as const, label: 'Aromas' },
          { key: 'family' as const, label: 'Family' },
        ]}
        active={mode}
        onSelect={setMode}
      />
      <Svg
        key={`${mode}-${dataKey}`}
        pointerEvents="none"
        accessible
        accessibilityLabel={mode === 'aromas'
          ? 'Aroma mosaic. Every column width represents its family share. Aroma height represents mentions inside that family; unreadable aromas fold into Others.'
          : 'Aroma family mosaic. Tile area represents family mentions. All represented families remain visible.'}
        width={size}
        height={height}
        viewBox={`0 0 ${size} ${height}`}
      >
        {layout.tiles.map((tile) => {
          const fill = colorOf(tile.familyId, tile.others);
          return (
            <Fragment key={tile.key}>
              <Rect x={tile.x} y={tile.y} width={tile.w} height={tile.h} rx={5} fill={fill} />
              {tile.labelText ? (
                <SvgText
                  x={tile.x + tile.w / 2}
                  y={tile.y + tile.h / 2 + tile.labelFontSize * 0.35}
                  fill={inkOn(fill, theme.ink, theme.bg)}
                  fontFamily="InstrumentSans_600SemiBold"
                  fontSize={tile.labelFontSize}
                  textAnchor="middle"
                  transform={tile.labelOrientation === 'vertical'
                    ? `rotate(-90, ${(tile.x + tile.w / 2).toFixed(1)}, ${(tile.y + tile.h / 2).toFixed(1)})`
                    : undefined}
                >
                  {tile.labelText}
                </SvgText>
              ) : null}
            </Fragment>
          );
        })}
      </Svg>
    </View>
  );
}

// ── Batch-2 studies (E–I, Simon's reference images a–e, 2026-07-16) ──────────
// Geometry in aromaVizGeometry2 (pure, pinned); these paint its outputs with
// the BATCH-1 colour vocabulary (Simon's round-2 correction): named content =
// the SOLID family colour; aggregates are the family colour paled toward bg.
// ⚠️ theme `mix(base, press, ratio)` — ratio is the BASE share (0.34 = pale),
// NOT a blend-toward amount; an inverted first cut painted solid content at
// ratio 0 = pure background (the invisible-ring-chain screenshot).
// The aggregate ratio is GEOMETRY-DEPENDENT (round 3, Simon's "empty spots"):
// thin ribbons keep batch-1's 0.34, but big AREA fills (Voronoi cells,
// bubbles, treemap tiles) at 0.34 read as unfilled holes over a coloured
// ground — verified headless on mauve; area aggregates use 0.55.
const AREA_REMAINDER = 0.55;

function VoronoiContinentsStudy({ size, families, dataKey }: { size: number; families: AromaVizFamily[]; dataKey: string }) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  const fontSize = typeScale.caption.size - 1;
  const [shape, setShape] = useState<ContinentsShape>('round');
  const colorOf = (id: string) => (id === 'other' ? theme.inkFaint : aromaColor(id));
  // The weighted-Voronoi solver iterates — memoise per data set + size.
  const layout = useMemo(() => voronoiContinents(families, { size, fontSize, shape }), [families, size, fontSize, shape]);
  return (
    <View style={{ gap: 10, alignItems: 'center' }}>
      <Segmented
        compact
        segments={[
          { key: 'round' as const, label: 'Round' },
          { key: 'rectangle' as const, label: 'Rectangle' },
        ]}
        active={shape}
        onSelect={setShape}
      />
      <Svg
        key={`${dataKey}-${shape}`}
        pointerEvents="none"
        accessible
        accessibilityLabel={`Aroma continents. A ${shape === 'round' ? 'round' : 'rectangular'} map where each family is a connected continent and its aromas are countries. Country area represents mentions and deeper colour marks the stronger aromas; pale cells bundle each family's remaining mentions.`}
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
      >
        {layout.cells.map((cell, i) => (
          <Path
            key={`cont-cell-${i}`}
            d={cell.pathD}
            fill={cell.others
              ? mix(colorOf(cell.familyId), theme.bg, AREA_REMAINDER)
              : mix(colorOf(cell.familyId), theme.bg, cell.share)}
            stroke={theme.bg}
            strokeWidth={1.2}
          />
        ))}
        {layout.outlines.map((outline) => (
          <Path key={`cont-line-${outline.familyId}`} d={outline.pathD} fill="none" stroke={theme.bg} strokeWidth={3} strokeLinejoin="round" />
        ))}
        {layout.outlines.map((outline) => {
          if (!outline.labelText) return null;
          const ground = outline.labelCellOthers
            ? mix(colorOf(outline.familyId), theme.bg, AREA_REMAINDER)
            : mix(colorOf(outline.familyId), theme.bg, outline.labelCellShare);
          return (
            <SvgText
              key={`cont-label-${outline.familyId}`}
              x={outline.labelX}
              y={outline.labelY + (fontSize + 1) * 0.35}
              fill={inkOn(ground, theme.ink, theme.bg)}
              fontFamily="InstrumentSans_600SemiBold"
              fontSize={fontSize + 1}
              textAnchor="middle"
            >
              {outline.labelText}
            </SvgText>
          );
        })}
      </Svg>
    </View>
  );
}

function BubbleColumnsStudy({ size, families, dataKey }: { size: number; families: AromaVizFamily[]; dataKey: string }) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  const fontSize = typeScale.caption.size - 1;
  const colorOf = (id: string) => (id === 'other' ? theme.inkFaint : aromaColor(id));
  const layout = useMemo(() => bubbleColumns(families, { size, fontSize }), [families, size, fontSize]);
  return (
    <Svg
      key={dataKey}
      pointerEvents="none"
      accessible
      accessibilityLabel="Aroma bubble columns. One column per leading family; every bubble is an aroma sized by mentions on one shared scale, settling from the top. Pale bubbles bundle each family's remainder, and a grey trailing column carries the omitted families."
      width={size}
      height={layout.height}
      viewBox={`0 0 ${size} ${layout.height}`}
    >
      {layout.columns.map((column) => (
        <Fragment key={`bcol-head-${column.familyId}`}>
          <Line
            x1={column.x0 + 5}
            x2={column.x0 + column.w - 5}
            y1={layout.headerH - 7}
            y2={layout.headerH - 7}
            stroke={mix(colorOf(column.familyId), theme.bg, column.familyId === 'other' ? 0.28 : 0.5)}
            strokeWidth={2}
            strokeLinecap="round"
          />
          {column.labelText ? (
            <SvgText
              x={column.x0 + column.w / 2}
              y={fontSize + 2}
              fill={colorOf(column.familyId)}
              fontFamily="InstrumentSans_600SemiBold"
              fontSize={fontSize}
              textAnchor="middle"
            >
              {column.labelText}
            </SvgText>
          ) : null}
        </Fragment>
      ))}
      {layout.bubbles.map((bubble, i) => {
        const fill = bubble.others ? mix(colorOf(bubble.familyId), theme.bg, AREA_REMAINDER) : colorOf(bubble.familyId);
        return (
          <Fragment key={`bub-${i}`}>
            <Circle cx={bubble.cx} cy={bubble.cy} r={bubble.r} fill={fill} />
            {bubble.labelText ? (
              <SvgText x={bubble.cx} y={bubble.cy + fontSize * 0.35} fill={inkOn(fill, theme.ink, theme.bg)} fontFamily="InstrumentSans_500Medium" fontSize={fontSize} textAnchor="middle">
                {bubble.labelText}
              </SvgText>
            ) : null}
          </Fragment>
        );
      })}
    </Svg>
  );
}

function AromaIrisStudy({ size, dataKey }: { size: number; dataKey: string }) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  const fontSize = typeScale.caption.size - 1;
  const [spokeMode, setSpokeMode] = useState<'all' | 'active'>('all');
  const [tileMode, setTileMode] = useState<'mentions' | 'aromas'>('mentions');
  // Per-aroma mention-depth encodings (Simon's round-4 asks) — only bite in
  // Tile-per-Aroma mode; per-mention tiles are unit counters.
  const [depthMode, setDepthMode] = useState<IrisDepth>('uniform');
  // The iris needs SUBFAMILY grain, so it reads the respondent fixtures
  // directly (the two hand-authored colour sets fall back to Mixed — the same
  // convention as the Bun's compare-summary mode).
  const panel = dataKey === 'stress' ? LONG_TAIL_120_PEOPLE_1440_MENTIONS : MIXED_GRAIN_20_PEOPLE_200_MENTIONS;
  const iris = useMemo(() => irisMentionFamilies(panel), [panel]);
  const layout = useMemo(
    () => aromaIris(iris, { size, fontSize, spokes: spokeMode, tiles: tileMode, depth: depthMode }),
    [iris, size, fontSize, spokeMode, tileMode, depthMode],
  );
  return (
    <View style={{ gap: 10, alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }}>
        <Segmented
          compact
          segments={[{ key: 'all' as const, label: 'All 60 Spokes' }, { key: 'active' as const, label: 'Active Only' }]}
          active={spokeMode}
          onSelect={setSpokeMode}
        />
        <Segmented
          compact
          segments={[{ key: 'mentions' as const, label: 'Tile per Mention' }, { key: 'aromas' as const, label: 'Tile per Aroma' }]}
          active={tileMode}
          onSelect={setTileMode}
        />
      </View>
      {tileMode === 'aromas' ? (
        <Segmented
          compact
          segments={[
            { key: 'uniform' as const, label: 'Uniform' },
            { key: 'length' as const, label: 'Length' },
            { key: 'shade' as const, label: 'Shade' },
            { key: 'position' as const, label: 'Position' },
          ]}
          active={depthMode}
          onSelect={setDepthMode}
        />
      ) : null}
      {dataKey !== 'tasting' && dataKey !== 'stress' ? (
        <VText variant="caption" color="inkFaint">The iris uses the Mixed respondent fixture.</VText>
      ) : null}
      <Svg
        // Remount on toggle — rnsvg TextPath keeps mount-time path geometry.
        key={`${spokeMode}-${tileMode}-${depthMode}-${dataKey}`}
        pointerEvents="none"
        accessible
        accessibilityLabel="Aroma iris. Twelve family arcs form an inner ring around an open centre; every subfamily is a spoke inside its family's span, and tiles stack outward on a spoke for its mentions. Family-level picks deepen the family arc itself, empty spokes stay as faint stubs, and a small chevron marks a spoke with more than fits."
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <G x={layout.cx} y={layout.cy}>
          {layout.families.map((familyArc) => {
            // Solid band when the family itself was picked (family-grain data);
            // a readable pale band otherwise.
            const bandFill = familyArc.familyCount > 0
              ? aromaColor(familyArc.familyId)
              : mix(aromaColor(familyArc.familyId), theme.bg, 0.42);
            const id = `iris-fam-${familyArc.familyId}-${spokeMode}-${tileMode}-${depthMode}-${dataKey}`;
            return (
              <Fragment key={familyArc.familyId}>
                <Path d={familyArc.arcD} fill="none" stroke={bandFill} strokeWidth={layout.bandThickness} strokeLinecap="butt" />
                {familyArc.labelText ? (
                  <>
                    <Path id={id} d={familyArc.labelPathD} fill="none" stroke="none" />
                    <SvgText fill={inkOn(bandFill, theme.ink, theme.bg)} fontFamily="InstrumentSans_600SemiBold" fontSize={familyArc.labelFontSize} textAnchor="middle" dy={3.2}>
                      <TextPath href={`#${id}`} startOffset="50%">{familyArc.labelText}</TextPath>
                    </SvgText>
                  </>
                ) : null}
              </Fragment>
            );
          })}
          {layout.spokes.map((spoke) => {
            const color = aromaColor(spoke.familyId);
            return (
              <Fragment key={spoke.subId}>
                {spoke.trackD ? <Path d={spoke.trackD} fill={mix(color, theme.bg, 0.14)} /> : null}
                {spoke.stubD ? <Path d={spoke.stubD} fill={mix(color, theme.bg, 0.3)} /> : null}
                {spoke.tiles.map((tile, j) => (
                  <Path key={`${spoke.subId}-${j}`} d={tile.pathD} fill={tile.share >= 1 ? color : mix(color, theme.bg, tile.share)} />
                ))}
                {spoke.overflowD ? <Path d={spoke.overflowD} fill={color} /> : null}
              </Fragment>
            );
          })}
        </G>
      </Svg>
    </View>
  );
}

function RingChainStudy({ size, families, dataKey }: { size: number; families: AromaVizFamily[]; dataKey: string }) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  const fontSize = typeScale.caption.size - 1;
  const colorOf = (id: string) => (id === 'other' ? theme.inkFaint : aromaColor(id));
  const notes = useMemo(() => vizNotes(families).filter((note) => note.familyId !== 'other'), [families]);
  const layout = useMemo(() => ringChain(notes, { size, fontSize }), [notes, size, fontSize]);
  return (
    <Svg
      key={dataKey}
      pointerEvents="none"
      accessible
      accessibilityLabel="Aroma snail. One continuous ribbon meanders top to bottom carrying every aroma in strict mention order, most mentioned first. Segments are the aromas in family colours, the ribbon flows from each loop straight into the next, and the pale tail at the very end bundles what did not fit."
      width={size}
      height={layout.height}
      viewBox={`0 0 ${size} ${layout.height}`}
    >
      <Defs>
        {layout.connectors.map((conn, i) => {
          const from = conn.fromOthers ? mix(colorOf(conn.fromFamilyId), theme.bg, 0.34) : colorOf(conn.fromFamilyId);
          const to = conn.toOthers ? mix(colorOf(conn.toFamilyId), theme.bg, 0.34) : colorOf(conn.toFamilyId);
          return (
            <LinearGradient
              key={`chain-gradient-${i}`}
              id={`chain-gradient-${dataKey}-${i}`}
              x1={conn.x1}
              y1={conn.y1}
              x2={conn.x2}
              y2={conn.y2}
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor={from} />
              <Stop offset="0.42" stopColor={from} />
              <Stop offset="0.58" stopColor={to} />
              <Stop offset="1" stopColor={to} />
            </LinearGradient>
          );
        })}
      </Defs>
      {layout.connectors.map((conn, i) => {
        return (
          <Path
            key={`chain-conn-${i}`}
            d={conn.pathD}
            fill="none"
            stroke={`url(#chain-gradient-${dataKey}-${i})`}
            strokeWidth={layout.ribbon}
            strokeLinecap="butt"
          />
        );
      })}
      {layout.rings.map((ring, ri) => {
        const first = ring.segments[0];
        const last = ring.segments[ring.segments.length - 1];
        const segColor = (seg: { familyId: string; others: boolean }) =>
          seg.others ? mix(colorOf(seg.familyId), theme.bg, 0.34) : colorOf(seg.familyId);
        return (
          <Fragment key={`chain-ring-${ri}`}>
            {ring.capStartD ? <Path d={ring.capStartD} fill="none" stroke={segColor(first)} strokeWidth={layout.ribbon} strokeLinecap="round" /> : null}
            {ring.capEndD ? <Path d={ring.capEndD} fill="none" stroke={segColor(last)} strokeWidth={layout.ribbon} strokeLinecap="round" /> : null}
            {ring.segments.map((seg, i) => {
              const segFill = segColor(seg);
              const id = `chain-${ri}-${i}-${dataKey}`;
              return (
                <Fragment key={id}>
                  <Path d={seg.arcD} fill="none" stroke={segFill} strokeWidth={layout.ribbon} strokeLinecap="butt" />
                  {seg.labelText ? (
                    <>
                      <Path id={id} d={seg.labelPathD} fill="none" stroke="none" />
                      <SvgText fill={inkOn(segFill, theme.ink, theme.bg)} fontFamily="InstrumentSans_600SemiBold" fontSize={fontSize} textAnchor="middle" dy={3.5}>
                        <TextPath href={`#${id}`} startOffset="50%">{seg.labelText}</TextPath>
                      </SvgText>
                    </>
                  ) : null}
                </Fragment>
              );
            })}
            {ring.separators.map((s, i) => (
              <Line key={`chain-sep-${ri}-${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={theme.bg} strokeWidth={2} strokeLinecap="butt" />
            ))}
          </Fragment>
        );
      })}
    </Svg>
  );
}

function RadialTreemapStudy({ size, families, dataKey }: { size: number; families: AromaVizFamily[]; dataKey: string }) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  const fontSize = typeScale.caption.size - 1;
  const colorOf = (id: string) => (id === 'other' ? theme.inkFaint : aromaColor(id));
  const layout = useMemo(() => radialTreemap(families, { size, fontSize }), [families, size, fontSize]);
  return (
    <Svg
      key={dataKey}
      pointerEvents="none"
      accessible
      accessibilityLabel="Radial aroma treemap. Families claim wedges of the ring in proportion to their mentions, and inside a wedge every aroma's tile area is exactly its share. Deeper colour marks a family's stronger aromas; the pale tile bundles its remainder. Family names ride the outer rim."
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
    >
      <G x={layout.cx} y={layout.cy}>
        {layout.tiles.map((tile, i) => (
          <Path
            key={`rtm-${i}`}
            d={tile.pathD}
            fill={tile.others
              ? mix(colorOf(tile.familyId), theme.bg, AREA_REMAINDER)
              : mix(colorOf(tile.familyId), theme.bg, tile.share)}
            stroke={theme.bg}
            strokeWidth={0.8}
          />
        ))}
        {layout.famLabels.map((fam) => (
          <Path
            key={`rtm-outline-${fam.familyId}`}
            d={fam.outlineD}
            fill="none"
            stroke={theme.bg}
            strokeWidth={3}
            strokeLinejoin="round"
          />
        ))}
        {layout.tiles.map((tile, i) => tile.labelText ? (
          <SvgText
            key={`rtml-${i}`}
            x={tile.labelX}
            y={tile.labelY + tile.labelFontSize * 0.32}
            fill={inkOn(
              tile.others
                ? mix(colorOf(tile.familyId), theme.bg, AREA_REMAINDER)
                : mix(colorOf(tile.familyId), theme.bg, tile.share),
              theme.ink,
              theme.bg,
            )}
            fontFamily="InstrumentSans_500Medium"
            fontSize={tile.labelFontSize}
            textAnchor={tile.labelAnchor}
            transform={`rotate(${tile.labelRotate.toFixed(1)}, ${tile.labelX.toFixed(1)}, ${tile.labelY.toFixed(1)})`}
          >
            {tile.labelText}
          </SvgText>
        ) : null)}
        {layout.famLabels.map((fam) => fam.labelText ? (
          <Fragment key={`rtmf-${fam.familyId}`}>
            <Path id={`rtm-fam-${fam.familyId}-${dataKey}`} d={fam.labelPathD} fill="none" stroke="none" />
            <SvgText fill={colorOf(fam.familyId)} fontFamily="InstrumentSans_600SemiBold" fontSize={fontSize} textAnchor="middle" dy={3.5}>
              <TextPath href={`#rtm-fam-${fam.familyId}-${dataKey}`} startOffset="50%">{fam.labelText}</TextPath>
            </SvgText>
          </Fragment>
        ) : null)}
      </G>
    </Svg>
  );
}

// FLAT sections (round 7 — no panels: the production detail view won't have
// them either, and the charts get the breathing room).
function AromaVizCard({ index, title, note, children }: { index: string; title: string; note: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={{ gap: 12, paddingVertical: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.surface }}>
          <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.inkSoft }}>{index}</VText>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <VText surface="compactList" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{title}</VText>
          <VText variant="caption" color="inkSoft">{note}</VText>
        </View>
      </View>
      <View style={{ alignItems: 'center' }}>{children}</View>
    </View>
  );
}

// Sample distributions (Simon round 5 + 6): the real fixture panels vs the
// hand-authored colour studies — vet every form against all four.
type AromaSetKey = 'tasting' | 'wild' | 'random' | 'stress';
const AROMA_SET_FOR: Record<AromaSetKey, AromaVizFamily[]> = {
  tasting: AROMA_SET_TASTING,
  wild: AROMA_SET_WILD,
  random: AROMA_SET_RANDOM200,
  stress: AROMA_SET_STRESS,
};

// The card stack only — the section intro + data-set Segmented live in
// DevGallery as DIRECT ScrollView children so the Segmented can ride
// stickyHeaderIndices (the line-up toolbar pattern).
function AromaVizCards({ set }: { set: AromaSetKey }) {
  const { width } = useWindowDimensions();
  // Charts may use more width than the gallery's prose column; keep only the
  // small screen-edge safety margin.
  const chartSize = Math.min(450, width - space.sm * 2);
  const families = AROMA_SET_FOR[set].map((family) => ({
    ...family,
    notes: family.notes.map((note) => ({ ...note, shortLabel: aromaVizShortLabel(note.label) })),
  }));
  return (
    <View style={{ gap: space.sm }}>
      <AromaVizCard index="A" title="Family Rings" note="Compare physical length, proportional angle, and near-full hierarchy · strongest family outermost · bounded Others tails · centre = other families">
        <ConcentricRingsStudy size={chartSize} families={families} dataKey={set} />
      </AromaVizCard>
      <AromaVizCard index="B" title="Weighted Aroma Circle" note="Equal aroma wedges by default · bar length = mentions · labels stay inside bars · six leading families · centre = omitted aromas and families">
        <WeightedPolarStudy size={chartSize} families={families} dataKey={set} />
      </AromaVizCard>
      <AromaVizCard index="C" title="Aroma Bun" note="Largest readable set of individual aromas · ordered by mentions · segment lengths stay proportional within the visible set · bounded Others tail">
        <SpiralRibbonStudy size={chartSize} families={families} dataKey={set} />
      </AromaVizCard>
      <AromaVizCard index="D" title="Aroma Mosaic" note="Aromas: family share = column width · Family: all 12 fit · horizontal or vertical labels · bounded Others per column">
        <AromaMosaicStudy size={chartSize} families={families} dataKey={set} />
      </AromaVizCard>
      <AromaVizCard index="E" title="Aroma Continents" note="Voronoi treemap · families are continents, aromas their countries · cell area = mentions · pale cell = family remainder · family labels only (countries reveal on the future zoom)">
        <VoronoiContinentsStudy size={chartSize} families={families} dataKey={set} />
      </AromaVizCard>
      <AromaVizCard index="F" title="Bubble Columns" note="One packed column per leading family · bubble area = mentions on one shared scale · pale bubble = family remainder · grey column = omitted families">
        <BubbleColumnsStudy size={chartSize} families={families} dataKey={set} />
      </AromaVizCard>
      <AromaVizCard index="G" title="Aroma Iris" note="Two tiers: 12 family arcs on the inner ring (family-grain picks deepen them) · subfamily spokes with tiles stacked outward · fixed 60-spoke fingerprint vs active-only · per-aroma depth: uniform, length, shade, or position (hub = most mentioned) · chevron = more than fits">
        <AromaIrisStudy size={chartSize} dataKey={set} />
      </AromaVizCard>
      <AromaVizCard index="H" title="Ring Chain" note="The Bun's winding sibling · one continuous snail, every aroma in strict mention order (most mentioned on top) · every segment carries its name, family colours · single +N tail at the end">
        <RingChainStudy size={chartSize} families={families} dataKey={set} />
      </AromaVizCard>
      <AromaVizCard index="I" title="Radial Treemap" note="Family wedges by share · aromas subdivide the wedge area-true · pale +N remainder per family · family names on the rim">
        <RadialTreemapStudy size={chartSize} families={families} dataKey={set} />
      </AromaVizCard>
    </View>
  );
}

export default function DevGallery() {
  const insets = useSafeAreaInsets();
  const { theme, choice, setChoice } = useTheme();
  const axisColor = useFlavourColors();
  const [levels, setLevels] = useState<Record<string, number>>(SAMPLE_LEVELS);
  const [monoWords, setMonoWords] = useState<'mono' | 'resting' | 'solid'>('mono');
  const [monoPronounced, setMonoPronounced] = useState<Set<string>>(new Set());
  const [monoSolidFill, setMonoSolidFill] = useState(false);
  const [badgeArmed, setBadgeArmed] = useState<Set<string>>(new Set());
  const [badgePron, setBadgePron] = useState<Set<string>>(new Set());
  const [armedStyle, setArmedStyle] = useState<'ruled' | 'solid' | 'map'>('ruled');
  const [dotArmed, setDotArmed] = useState(true);
  const [paleAll, setPaleAll] = useState(false);
  const [badgeVPad, setBadgeVPad] = useState(4.5);
  const galleryTap = useTapOrDouble();
  const [wheelBadge, setWheelBadge] = useState(false);
  const [wheelGhost, setWheelGhost] = useState(false);
  const [wheelStraight, setWheelStraight] = useState(false);
  const [aromaSet, setAromaSet] = useState<AromaSetKey>('tasting');
  // Testing phase (Simon, 2026-07-16): the gallery ships in RELEASE builds too
  // so TestFlight can compare the aroma studies — re-gate on __DEV__ before a
  // public launch.

  // Wheel reads the SAME resolved axes + theme colours the input writes.
  const sample: WheelAxis[] = perRatingAxes(levels, resolveAxes('wine', SAMPLE_STYLE)).map((a) => ({
    label: a.l,
    color: axisColor(a.k),
    value: levels[a.k] ?? 0,
  }));

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      {/* PINNED theme switcher (Simon, 2026-07-16): always under the title bar
          — the gallery's whole point is flipping themes while comparing. A
          single-line swipeable RAIL of compact pills (Simon round 2); the six
          real themes lead, System parks at the end. */}
      <View style={{ paddingTop: space.xs, paddingBottom: space.xs, backgroundColor: theme.bg }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.lg, gap: 6, alignItems: 'center' }}>
          {([...Object.keys(themes), 'system'] as ThemeChoice[]).map((c) => {
            const on = choice === c;
            return (
              <Pressable
                key={c}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setChoice(c)}
                style={{ paddingVertical: 5, paddingHorizontal: 11, borderRadius: 999, backgroundColor: on ? theme.accent : theme.surface }}
              >
                <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: on ? theme.accentInk : theme.inkSoft }}>
                  {c[0].toUpperCase() + c.slice(1)}
                </VText>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, paddingTop: space.xs, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE, gap: space.lg }}
        // The aroma data-set selector docks right under the pinned theme bar
        // (the line-up toolbar pattern). ⚠️ Index = the sticky View's position
        // among the DIRECT children below — keep in sync when adding sections.
        stickyHeaderIndices={[6]}
      >
        <View style={{ gap: space.xs }}>
          <VText variant="heading">Star + value</VText>
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <StarScore value={4.25} />
            <StarScore value={5} />
            <StarScore value={0.75} size={18} />
          </View>
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">Structure input</VText>
          <VText variant="small" color="inkSoft">Fill-track — tap/drag; wheel below updates live. Badge-tint fill + ink font (ruled 2026-07-11).</VText>
          <StructureInput style={SAMPLE_STYLE} value={levels} onChange={setLevels} />
        </View>

        <View style={{ gap: space.xs }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <VText variant="heading">Structure wheel</VText>
            {/* wash = the mock's 0.72 wedge opacity (shipped); badge tint =
                the Structure input's badge look — opaque 0.72 mix over the
                ground + readable axis-coloured labels. */}
            <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.surface }}>
              {([false, true] as const).map((sol) => {
                const on = wheelBadge === sol;
                return (
                  <Pressable
                    key={String(sol)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    onPress={() => setWheelBadge(sol)}
                    style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: on ? theme.bg : 'transparent' }}
                  >
                    <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                      {sol ? 'Badge Tint' : 'Wash (0.72)'}
                    </VText>
                  </Pressable>
                );
              })}
            </View>
          </View>
          {/* exploration toggles, each on its own row */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {/* Ghost remainder: fill to the rating, then a paled same-colour
                tint continues to the rim (=5) as a scale reference. */}
            <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.surface }}>
              {([false, true] as const).map((g) => {
                const on = wheelGhost === g;
                return (
                  <Pressable
                    key={String(g)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    onPress={() => setWheelGhost(g)}
                    style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: on ? theme.bg : 'transparent' }}
                  >
                    <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                      {g ? 'Ghost Remainder' : 'No Remainder'}
                    </VText>
                  </Pressable>
                );
              })}
            </View>
            {/* Straight separators: parallel side edges (straight gaps between
                wedges) vs the coxcomb's radial-sided (angled/triangular gap)
                wedges. Wedge length + arcs are unchanged. */}
            <View style={{ flexDirection: 'row', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.surface }}>
              {([false, true] as const).map((s) => {
                const on = wheelStraight === s;
                return (
                  <Pressable
                    key={String(s)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    onPress={() => setWheelStraight(s)}
                    style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: on ? theme.bg : 'transparent' }}
                  >
                    <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                      {s ? 'Straight Separators' : 'Angled Separators'}
                    </VText>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <View style={{ alignItems: 'center' }}>
            <StructureWheel axes={sample} badgeTint={wheelBadge} ghostRemainder={wheelGhost} straightSides={wheelStraight} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <StructureWheel axes={sample} size={72} labels={false} badgeTint={wheelBadge} ghostRemainder={wheelGhost} straightSides={wheelStraight} />
            <VText variant="small" color="inkSoft">mini (feed-card scale)</VText>
          </View>
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">Aroma badges</VText>
          <VText variant="small" color="inkSoft">
            One per family, on a surface card (where badges actually sit). Switch themes above.
          </VText>
          <View style={{ gap: 12, padding: 12, borderRadius: radius.md, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule }}>
            {/* badge-height exploration (Simon, 2026-07-13): the slider drives
                every chip's vPad. Shipped values: 4.5 = write surfaces,
                0 = READ surfaces (AromaReadChips). Negative range =
                padding 0 + tightened label line (see the vPad prop doc) so
                the shrink continues past the padding floor. */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <VText variant="caption" color="inkFaint">height</VText>
              <View style={{ flex: 1 }}>
                <DevSlider value={badgeVPad} onChange={setBadgeVPad} min={-4} max={12} step={0.5} />
              </View>
              <VText variant="caption" color="inkSoft" style={{ width: 88, textAlign: 'right' }}>
                vPad {badgeVPad}{badgeVPad === 4.5 ? ' (write)' : badgeVPad === 0 ? ' (read)' : ''}
              </VText>
            </View>
            {/* ONE interactive row (Simon, 2026-07-12): every chip starts
                resting; tap toggles ARMED, double-tap toggles PRONOUNCED
                (useTapOrDouble runs single on tap 1, so the double handler
                reverts that arm — a double-tap nets pronounced only). The
                pill picks which armed treatment renders. */}
            <View style={{ gap: 6 }}>
              <VText variant="caption" color="inkFaint">
                resting — tap = armed, double-tap = pronounced; armed treatment:
              </VText>
              {/* switches wrap onto their own lines (Simon) — no overflow on
                  narrow screens. */}
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
                  {(['ruled', 'solid', 'map'] as const).map((k) => {
                    const on = armedStyle === k;
                    return (
                      <Pressable
                        key={k}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: on }}
                        onPress={() => setArmedStyle(k)}
                        style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: on ? theme.surface : 'transparent' }}
                      >
                        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                          {k === 'ruled' ? 'Ruled: Mute Rest' : k === 'solid' ? 'Solid (old armed)' : 'Map (All Solid, Arm Pales Rest)'}
                        </VText>
                      </Pressable>
                    );
                  })}
                </View>
                {/* all-or-nothing arm toggle — whole-row compare per theme. */}
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    setBadgeArmed((prev) =>
                      prev.size === AROMA_FAMILIES.length ? new Set() : new Set(AROMA_FAMILIES.map((f) => f.id)),
                    )
                  }
                  style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: theme.bg }}
                >
                  <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: theme.inkSoft }}>
                    {badgeArmed.size === AROMA_FAMILIES.length ? 'Disarm All' : 'Arm All'}
                  </VText>
                </Pressable>
                {/* Contextual modes (deep/map) change NO colour on the armed
                    chip — with everything armed there is no rest to pale, so
                    Arm All is colour-inert there by design. Pale All previews
                    the pale state on every un-armed chip instead. */}
                {armedStyle !== 'solid' ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: paleAll }}
                    onPress={() => setPaleAll((b) => !b)}
                    style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: paleAll ? theme.surface : theme.bg }}
                  >
                    <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: paleAll ? theme.ink : theme.inkSoft }}>
                      Pale All
                    </VText>
                  </Pressable>
                ) : null}
                {/* the ListPicker's round-mark armed vocabulary, on a chip. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: dotArmed }}
                  onPress={() => setDotArmed((b) => !b)}
                  style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: dotArmed ? theme.surface : theme.bg }}
                >
                  <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: dotArmed ? theme.ink : theme.inkSoft }}>
                    ● Dot Armed
                  </VText>
                </Pressable>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {AROMA_FAMILIES.map((f) => {
                  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>) =>
                    set((prev) => {
                      const next = new Set(prev);
                      if (next.has(f.id)) next.delete(f.id);
                      else next.add(f.id);
                      return next;
                    });
                  const armed = badgeArmed.has(f.id);
                  return (
                    <AromaChip
                      key={f.id}
                      a={f.id}
                      m={null}
                      // 'ruled' = Simon's 2026-07-12 search ruling (now live in
                      // AromaInput): armed keeps its resting colours, the ONLY
                      // change is the rest muting. 'map' = the hexStage anatomy
                      // verbatim (all solid, arm pales rest). 'solid' = the old
                      // armed flip, kept for comparison.
                      focused={(armedStyle === 'solid' || armedStyle === 'map') && armed}
                      mapSolid={armedStyle === 'map'}
                      muted={armedStyle === 'ruled' && (badgeArmed.size > 0 || paleAll) && !armed}
                      pale={armedStyle === 'map' && (badgeArmed.size > 0 || paleAll) && !armed}
                      armedDot={dotArmed && armed}
                      pronounced={badgePron.has(f.id)}
                      vPad={badgeVPad}
                      onPress={() =>
                        galleryTap(
                          f.id,
                          () => toggle(setBadgeArmed),
                          () => { toggle(setBadgeArmed); toggle(setBadgePron); },
                        )
                      }
                    />
                  );
                })}
              </View>
            </View>
            <View style={{ gap: 6 }}>
              <VText variant="caption" color="inkFaint">theme-coloured rows — font (tap a chip = pronounced):</VText>
              <View style={{ flexDirection: 'row', alignSelf: 'flex-start', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
                {(['tint', 'solid'] as const).map((k) => {
                  const on = monoSolidFill === (k === 'solid');
                  return (
                    <Pressable
                      key={k}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: on }}
                      onPress={() => setMonoSolidFill(k === 'solid')}
                      style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: on ? theme.surface : 'transparent' }}
                    >
                      <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                        {k === 'tint' ? 'Tint Fill' : 'Solid Fill'}
                      </VText>
                    </Pressable>
                  );
                })}
              </View>
              <View style={{ flexDirection: 'row', alignSelf: 'flex-start', gap: 3, padding: 2, borderRadius: 999, backgroundColor: theme.bg }}>
                {(['mono', 'resting', 'solid'] as const).map((k) => {
                  const on = monoWords === k;
                  return (
                    <Pressable
                      key={k}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: on }}
                      onPress={() => setMonoWords(k)}
                      style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: on ? theme.surface : 'transparent' }}
                    >
                      <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: on ? theme.ink : theme.inkSoft }}>
                        {k === 'mono' ? 'Mono' : k === 'resting' ? 'Family' : 'Family 100%'}
                      </VText>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            {([['accent', theme.accent], ['neutral ink', theme.ink]] as const).map(([label, tintColor]) => (
              <View key={label} style={{ gap: 5 }}>
                <VText variant="caption" color="inkFaint">theme-coloured — {label} (exploration: all families one colour)</VText>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {AROMA_FAMILIES.map((f) => (
                    <AromaChip
                      key={f.id}
                      a={f.id}
                      m={null}
                      tint={tintColor}
                      tintSolid={monoSolidFill}
                      monoWords={monoWords === 'mono' ? undefined : monoWords}
                      pronounced={monoPronounced.has(f.id)}
                      vPad={badgeVPad}
                      onPress={() =>
                        setMonoPronounced((prev) => {
                          const next = new Set(prev);
                          if (next.has(f.id)) next.delete(f.id);
                          else next.add(f.id);
                          return next;
                        })
                      }
                    />
                  ))}
                </View>
              </View>
            ))}
          </View>
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">QR code</VText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
            <View style={{ gap: 4 }}>
              <View style={{ padding: 12, borderRadius: radius.md, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule }}>
                <QrCode value="https://verre.app/join/7F3K-9QX2" size={156} />
              </View>
              <VText variant="caption" color="inkSoft">
                {contrastRatio(theme.ink, theme.surface) >= 3 ? 'auto: themed' : 'auto: fallback (white)'}
              </VText>
            </View>
            <View style={{ gap: 4 }}>
              <View style={{ padding: 12, borderRadius: radius.md, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule }}>
                <QrCode value="https://verre.app/join/7F3K-9QX2" size={156} forceThemed />
              </View>
              <VText variant="caption" color="inkSoft">forced: theme colors</VText>
            </View>
          </View>
          <VText variant="small" color="inkSoft">
            {`ink/surface contrast ${contrastRatio(theme.ink, theme.surface).toFixed(2)} (clamp at 3.0)`}
          </VText>
          <VText variant="caption" color="inkFaint">
            Left = the real component (clamps to white below 3.0; all current themes pass). Right = forced theme colors, no clamp. Scan each with the Camera app.
          </VText>
        </View>

        <View style={{ gap: 3 }}>
          <VText variant="heading">Aroma overview · visual studies</VText>
          <VText variant="small" color="inkSoft">
            Same sample distribution in every study. Each is a selective overview; All Aromas remains the exhaustive view.
          </VText>
        </View>
        {/* STICKY child #6: full-bleed opaque bar so scrolling content never
            shows through while it is docked. */}
        <View style={{ backgroundColor: theme.bg, marginHorizontal: -space.lg, paddingHorizontal: space.lg, paddingVertical: 8 }}>
          <Segmented
            segments={[{ key: 'tasting' as const, label: 'Mixed' }, { key: 'wild' as const, label: 'Wild' }, { key: 'random' as const, label: 'Random' }, { key: 'stress' as const, label: 'Stress' }]}
            active={aromaSet}
            onSelect={setAromaSet}
          />
        </View>
        <AromaVizCards set={aromaSet} />
      </ScrollView>
    </View>
  );
}
