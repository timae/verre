import { useMemo, useReducer, useRef, useState, useEffect } from 'react';
import { Pressable, View, type LayoutRectangle } from 'react-native';
import { BottomSheetScrollView, type BottomSheetScrollViewMethods } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { AromaChip } from '@/components/scoring/aroma/parts';
import { AromaReadChips } from '@/components/scoring/aroma/AromaReadChips';
import { Icon } from '@/components/ui/Icon';
import Svg, { G, Polygon, Text as SvgText } from 'react-native-svg';
import { aromaModifierDisplay, getAromaNode } from '@verre/core';
import {
  buildAgreementOverview, capFirstLabel, compareSelectionReducer, exactAromaPopoverContent, familyFingerprint, filterAromaMentions, filterAromaParticipants, groupAromaMentions, hasModifierDistinction, matchingParticipantPickKeys, overviewCountLabel, pickKey, selectionContributors, sortAromaMentions, supportingPickKeys, pyramidLayout, tasteSharedEvidence, tier3Tabs, topAromaPyramid, wrapPyramidLabel, OVERVIEW_DOT_MAX, PREVIEW_CAP, STRIP_GAP,
  type AromaMentionRow, type AromaMentionSort, type AromaRef, type AromaTasteGroupMember, type AromaTastePair, type AromaTasteSummary, type CompareAromaModel, type CompareSelection, type FamilyShare, type OverviewHeadRow, type Tier3Mode, type Tier3Route,
} from './aromaCompareView';
import type { AromaContributor } from './aromaContributors';
import { inkOn, mix } from '@/theme/color';
import { AromaBadgePopover, AromaPopoverPeople } from './AromaBadgePopover';
import { Avatar } from '@/components/ui/Avatar';
import { Segmented } from '@/components/ui/Segmented';
import { Sheet } from '@/components/ui/Sheet';
import { SheetSearchField } from '@/components/ui/SheetSearchField';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';
import { radius, typeScale, useTheme } from '@/theme';
import { useAromaColors } from '@/theme/flavourColors';

// Tier 3 — the full aroma detail in a bottom sheet (compare §9, slices 3c+3d).
// Renders from the SAME CompareAromaModel the strip consumes (one derivation in
// CompareBody — strip and sheet can't fork). TABBED since slice 3d (Simon
// 2026-07-15, the BrowseSheet pill segmented control):
// - Agreement (only when model.hasAgreement): the OVERVIEW (scientific-review
//   redesign + Simon's rounds 2–3, 2026-07-19 — replaces the indented
//   consensus-tree render, which exposed the selector's five-role internals
//   with sub-threshold encodings and no magnitude channel): the family
//   FINGERPRINT strip (mention-mix, segments fade + tap) over one CHART BLOCK
//   per agreed head — label line + a proportion bar whose filled region is
//   DIVIDED by contributing aromas (labelled when they fit; discrete cells at
//   n<=OVERVIEW_DOT_MAX keep the icon-array granularity, whole-% labels at
//   larger n). Every segment taps to an anchored contributors popover (badge +
//   modifier split + Perceived-by → full People list). No expansion, no
//   second strip scale, no sentence, no legend. An Also-mentioned tail covers
//   uncovered bases; the multi-select disclosure caption closes the page.
//   The Aroma Bun + its view toggle are REMOVED (Simon 2026-07-19).
// - All Aromas: the Top-10 true-triangle PYRAMID (solid family-colour facets,
//   slope-aware wrapped labels, tap lifts the facet into the popover) over
//   searchable canonical modifier-bearing badges. Mentions is one flat
//   occurrence-ranked field; Family groups the same badges under family
//   headings. No analytical base-heading/modifier-tally rows. A strip-popover
//   "+N more branches" focusId opens HERE with the node's picks highlighted.
// - People: searchable established person rows (40pt Avatar + name + exact
//   AromaReadChips), collapsed to two lines; "+N more" pushes the established
//   full-badge read sheet above this one.
//
// Two INDEPENDENT pieces of state (Simon's round-2 ruling, 2026-07-15):
// - `peopleFilter` — the People tab's navigation context: which aroma's
//   supporters the list shows. Set by the popover's viewContributorsRoute,
//   cleared ONLY by Show All ✕. Expanding a person never touches it.
// - one `selection` for All Aromas and one for People — each view keeps its
//   own ruled focus (single-select, aroma XOR participant, retap clears,
//   never a nested popover/sheet). Switching tabs preserves that view's state
//   without leaking its muting/highlight into another view. Aroma identity is
//   the three-way AromaRef — node (subsumed) / base (literal, all modifiers) /
//   pair (exact) — because the same id names three different supporter sets.
//   The Overview is NOT a selection surface: fingerprint + bar segments
//   anchor a contributors popover on tap (`openBar` — Simon round 3).
// Per-tab effects: on All Aromas the matching rows stay lit and the rest mute
// (the ruled contextual-focus treatment — a selection never recolours
// itself); a participant expands their row in place.
// Validity of the filter, each tab's selection, and the active tab is DERIVED
// each render, so poll churn falls back gracefully; tab changes reset only the
// shared scroll viewport.

const TAB_LABELS: Record<Tier3Mode, string> = {
  agreement: 'Overview',
  all: 'All Aromas',
  participants: 'People',
};

// Chart-label fit estimate (~6.4px/char at caption size + side padding). The
// real track width arrives via onLayout; until it lands no in-bar labels
// render (one frame). Flat math on purpose — chart geometry, like the wheels,
// never Dynamic-Type-scaled.
const SEG_CHAR_W = 6.4;
const segLabelFits = (label: string, px: number) => label.length * SEG_CHAR_W + 10 <= px;

// Rank offset of each pyramid tier (cumulative TOP_AROMAS_SHAPE: 1/2/3/4).
const TOP_SHAPE_OFFSETS = [0, 1, 3, 6];

// A tappable bar segment that can report its window rect for the anchored
// contributors popover (the InspectableAromaChip measure pattern).
function BarSegment({ grow, a11yLabel, onPress, spaced, children }: {
  grow: number;
  a11yLabel: string;
  onPress: (rect: LayoutRectangle) => void;
  /** 2px separator BEFORE this segment (between filled segments only — never
      before the unfilled remainder, Simon's ruling). */
  spaced?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<View>(null);
  return (
    <Pressable
      ref={ref}
      collapsable={false}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() => ref.current?.measureInWindow((x, y, width, height) => onPress({ x, y, width, height }))}
      style={{ flexGrow: grow, flexBasis: 0, minWidth: 0, marginLeft: spaced ? 2 : 0 }}
    >
      {children}
    </Pressable>
  );
}

// The top-aromas TRUE-TRIANGLE pyramid (Simon: "an actual pyramid" —
// supersedes both the plain-text and stepped-tile cuts): one SVG triangle
// sliced by pyramidLayout, cells filled solid in their family colour with
// 2px surface seams (stroke), names in contrast-picked ink, fit-gated to the
// cell's usable width (an unlabelled sliver stays a coloured cell — the tap
// popover names it). Absolute Pressable hotspots over each cell's bbox carry
// a11y + the popover anchor rect (SVG shapes alone can't do either well).
/** The tapped facet's OWN label, rebased to its bbox — the popover connector
    redraws the lifted facet WITH its name (Simon round 5). */
export type FacetLabel = {
  lines: Array<{ text: string; x: number; y: number; mod: boolean; apex: boolean }>;
  ink: string;
};

function TopAromaPyramid({ tiers, keepPair, onPressCell }: {
  tiers: AromaMentionRow[][];
  keepPair: ((a: string, m: string | null) => boolean) | null;
  onPressCell: (row: AromaMentionRow, rect: LayoutRectangle, localPoints: string, facetLabel: FacetLabel) => void;
}) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  const wrapRef = useRef<View>(null);
  const [w, setW] = useState(0);
  const fs = typeScale.caption.size;
  // 47pt per band + ~21pt extra depth for the weighted apex (apexScale 1.45).
  const h = tiers.length * 47 + 21;
  // Per-cell render data, computed ONCE: geometry + fill/ink + the wrapped
  // label lines in absolute coords. Both the SVG pass and the hotspot pass
  // consume this, and the tap hands the SAME lines (rebased) to the popover
  // connector so the lifted facet is a 1:1 duplicate, name included.
  const cells = useMemo(() => {
    if (w <= 0) return [];
    const layout = pyramidLayout(tiers.map((tier) => tier.length), w, h);
    const lineH = fs + 2;
    const charW = fs * 0.5;
    return layout.flatMap((band, ti) => band.map((cell, j) => {
      const row = tiers[ti][j];
      const fill = aromaColor(row.familyId);
      const ink = inkOn(fill, theme.ink, theme.surface);
      const name = capFirstLabel(getAromaNode(row.a)?.label ?? row.a);
      const modifier = row.m ? capFirstLabel(aromaModifierDisplay(row.a, row.m)) : null;
      // Slope-aware word wrap: lines above the anchor shrink at the triangle's
      // edge rate for sloped cells; the modifier takes the bottom line slot
      // when the name leaves room for it.
      const maxLines = Math.max(1, Math.min(3, Math.floor((cell.h - 8) / lineH)));
      const perLineShrink = cell.slopedSides * (w / (2 * h)) * lineH;
      const modFits = modifier != null && modifier.length * charW <= cell.maxW;
      const reserved = modFits ? wrapPyramidLabel(name, cell.maxW - perLineShrink, charW, perLineShrink, maxLines - 1) : null;
      const nameLines = reserved ?? wrapPyramidLabel(name, cell.maxW, charW, perLineShrink, maxLines);
      const showMod = modFits && reserved != null && reserved.length < maxLines;
      const texts = nameLines ? (showMod && modifier ? [...nameLines, modifier] : nameLines) : [];
      const lines = texts.map((text, li) => ({
        text,
        x: cell.cx,
        y: cell.cy + fs * 0.35 - (texts.length - 1 - li) * lineH,
        mod: showMod && li === texts.length - 1,
        apex: ti === 0,
      }));
      return { cell, row, ti, j, fill, ink, lines };
    }));
  }, [aromaColor, fs, h, theme.ink, theme.surface, tiers, w]);
  return (
    <View
      ref={wrapRef}
      collapsable={false}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={{ height: h }}
    >
      {w > 0 ? (
        <Svg width={w} height={h} pointerEvents="none">
          {cells.map(({ cell, row, fill, ink, lines }) => {
            const muted = keepPair != null && !keepPair(row.a, row.m);
            return (
              <G key={pickKey(row.a, row.m)} opacity={muted ? 0.35 : 1}>
                <Polygon points={cell.points} fill={fill} stroke={theme.surface} strokeWidth={2} strokeLinejoin="round" />
                {lines.map((line, li) => (
                  <SvgText
                    key={li}
                    x={line.x}
                    y={line.y}
                    fontSize={fs}
                    fontFamily={line.apex && !line.mod ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium'}
                    fill={ink}
                    fillOpacity={line.mod ? 0.8 : 1}
                    textAnchor="middle"
                  >
                    {line.text}
                  </SvgText>
                ))}
              </G>
            );
          })}
        </Svg>
      ) : null}
      {cells.map(({ cell, row, ti, j, ink, lines }) => {
        const rank = TOP_SHAPE_OFFSETS[ti] + j + 1;
        const name = capFirstLabel(getAromaNode(row.a)?.label ?? row.a)
          + (row.m ? `, ${capFirstLabel(aromaModifierDisplay(row.a, row.m))}` : '');
        return (
          <Pressable
            key={pickKey(row.a, row.m)}
            accessibilityRole="button"
            accessibilityLabel={`Top ${rank}: ${name}, ${row.count} taster${row.count === 1 ? '' : 's'}. Inspect`}
            onPress={() => wrapRef.current?.measureInWindow((wx, wy) =>
              onPressCell(
                row,
                { x: wx + cell.x, y: wy + cell.y, width: cell.w, height: cell.h },
                cell.localPoints,
                { ink, lines: lines.map((line) => ({ ...line, x: line.x - cell.x, y: line.y - cell.y })) },
              ))}
            style={{ position: 'absolute', left: cell.x, top: cell.y, width: cell.w, height: cell.h }}
          />
        );
      })}
    </View>
  );
}

// The head's bar IS the breakdown (Simon's round-3 ruling): the filled region
// is divided by CONTRIBUTING aromas — each sub-segment labelled (when it
// fits) and tappable → contributors popover. Segments partition the head's
// supporters (Σ = head count), so everything lives on the ONE shared scale —
// no second strip width. Every sub-segment is the SAME flat family colour
// (gaps + labels divide, length carries the counts); at n <= OVERVIEW_DOT_MAX
// each segment renders its count as discrete cells (the icon-array
// granularity inside the chart form).
function AgreementBar({ row, n, color, onPressSegment }: {
  row: OverviewHeadRow;
  n: number;
  color: string;
  onPressSegment: (ref: AromaRef, rect: LayoutRectangle) => void;
}) {
  const { theme } = useTheme();
  const [barW, setBarW] = useState(0);
  const discrete = n <= OVERVIEW_DOT_MAX;
  const gapCount = discrete ? n - 1 : row.segments.length - 1;
  const cellPx = barW > 0 ? (barW - 2 * Math.max(0, gapCount)) / n : 0;
  // A lone segment that IS the head would just repeat the row label — skip it.
  const soloSelf = row.segments.length === 1 && row.segments[0].id === row.id;
  // ONE flat family colour for every segment — NO tints/intensities (Simon's
  // ruling, 2026-07-19, after two shade attempts read as broken/meaningless).
  // The gaps + in-bar labels carry the division; length alone carries counts.
  return (
    <View
      onLayout={(e) => setBarW(e.nativeEvent.layout.width)}
      style={{ flexDirection: 'row', height: 22 }}
    >
      {row.segments.map((segment, i) => {
        const fill = color;
        const segPx = cellPx * segment.count + 2 * (segment.count - 1);
        const label = capFirstLabel(segment.label);
        const showLabel = !soloSelf && barW > 0 && segLabelFits(label, segPx);
        return (
          <BarSegment
            key={segment.id}
            grow={segment.count}
            spaced={i > 0}
            a11yLabel={`${label}, ${segment.count} of ${row.count} ${capFirstLabel(row.label)} tasters. Show who perceived it`}
            onPress={(rect) => onPressSegment(segment.ref, rect)}
          >
            {discrete ? (
              <View style={{ flexDirection: 'row', gap: 2, height: 22 }}>
                {Array.from({ length: segment.count }, (_, c) => (
                  <View key={c} style={{ flex: 1, height: 22, backgroundColor: fill }} />
                ))}
              </View>
            ) : (
              <View style={{ height: 22, backgroundColor: fill }} />
            )}
            {showLabel ? (
              <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                <VText numberOfLines={1} variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: inkOn(fill, theme.ink, theme.surface) }}>
                  {label}
                </VText>
              </View>
            ) : null}
          </BarSegment>
        );
      })}
      {row.count < n ? (
        discrete ? (
          <View style={{ flexDirection: 'row', gap: 2, height: 22, flexGrow: n - row.count, flexBasis: 0 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {Array.from({ length: n - row.count }, (_, c) => (
              <View key={c} style={{ flex: 1, height: 22, backgroundColor: theme.surfaceSunk }} />
            ))}
          </View>
        ) : (
          <View style={{ height: 22, flexGrow: n - row.count, flexBasis: 0, backgroundColor: theme.surfaceSunk }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        )
      ) : null}
    </View>
  );
}

// One agreed head as a CHART BLOCK (Simon's "less listy" ruling: no chip, no
// hairline — the label line + the segmented family-coloured bar carry
// everything; taps live on the bar's segments).
function OverviewRow({ row, n, aromaColor, onPressSegment }: {
  row: OverviewHeadRow;
  n: number;
  aromaColor: (familyId: string) => string;
  onPressSegment: (ref: AromaRef, rect: LayoutRectangle) => void;
}) {
  const { theme } = useTheme();
  const color = aromaColor(row.familyId);
  return (
    <View style={{ gap: 7 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <VText numberOfLines={1} variant="small" style={{ flexShrink: 1, fontFamily: 'InstrumentSans_600SemiBold' }}>
          {capFirstLabel(row.label)}
        </VText>
        {row.pronounced ? <Icon name="pronounced" size={13} color={color} /> : null}
        <View style={{ flex: 1 }} />
        <VText variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.inkSoft }}>
          {overviewCountLabel(row.count, n)}
        </VText>
      </View>
      <AgreementBar row={row} n={n} color={color} onPressSegment={onPressSegment} />
    </View>
  );
}

// The family fingerprint strip: segments FADE into their neighbours (the
// Bun's transition treatment, flattened) and are TAPPABLE — the popover names
// the family and its contributors, replacing the legend (Simon round 3).
// Deliberately UNLABELLED (his ruling): tap is the only disclosure.
function FingerprintStrip({ shares, aromaColor, onPressSegment }: {
  shares: ReadonlyArray<FamilyShare>;
  aromaColor: (familyId: string) => string;
  onPressSegment: (ref: AromaRef, rect: LayoutRectangle) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', height: 18, borderRadius: 999, overflow: 'hidden' }}>
      {shares.map((f, i) => {
        const own = aromaColor(f.familyId);
        const prev = i > 0 ? aromaColor(shares[i - 1].familyId) : own;
        const next = i < shares.length - 1 ? aromaColor(shares[i + 1].familyId) : own;
        return (
          <BarSegment
            key={f.familyId}
            grow={f.share}
            a11yLabel={`${f.label} family. Show who perceived it`}
            onPress={(rect) => onPressSegment({ kind: 'node', a: f.familyId }, rect)}
          >
            <LinearGradient
              colors={[mix(own, prev, 0.5), own, own, mix(own, next, 0.5)]}
              locations={[0, 0.25, 0.75, 1]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={{ height: 18 }}
            />
          </BarSegment>
        );
      })}
    </View>
  );
}

function InspectableAromaChip({
  a,
  m,
  count,
  muted,
  onPress,
}: {
  a: string;
  m: string | null;
  count: number;
  muted?: boolean;
  onPress: (rect: LayoutRectangle) => void;
}) {
  const ref = useRef<View>(null);
  return (
    <View ref={ref} collapsable={false}>
      <AromaChip
        a={a}
        m={m}
        count={count}
        vPad={0}
        muted={muted}
        onPress={() => ref.current?.measureInWindow((x, y, width, height) => onPress({ x, y, width, height }))}
      />
    </View>
  );
}

// One People-tab row: the taster + their exact picks (modifier + Pronounced
// preserved — AromaReadChips is THE per-person read primitive). Picks collapse
// to two lines; "+N more" opens the full read sheet, while tapping the name
// remains the participant cross-highlight selection.
function ParticipantRow({ contributor, selected, onToggle, onPressAroma, emphasizeKeys, first = false }: {
  contributor: AromaContributor;
  selected: boolean;
  onToggle: () => void;
  onPressAroma: (a: string, m: string | null, rect: LayoutRectangle, contributorId: string) => void;
  emphasizeKeys?: ReadonlySet<string>;
  first?: boolean;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('compactList');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: phone.lerp(12, 16), paddingVertical: surface.paddingY(phone.lerp(11, 15)), borderTopWidth: first ? 0 : 1, borderTopColor: theme.ruleSoft }}>
      <Avatar name={contributor.displayName} size={phone.grow(40)} />
      <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityState={{ selected }}
          accessibilityLabel={`${selected ? 'Clear' : 'Select'} ${contributor.displayName}`}
          hitSlop={6}
          style={({ pressed }) => ({
            alignSelf: 'flex-start',
            maxWidth: '100%',
            marginHorizontal: -4,
            marginVertical: -3,
            paddingHorizontal: 4,
            paddingVertical: 3,
            borderRadius: radius.sm,
            backgroundColor: pressed ? theme.surfaceSunk : 'transparent',
          })}
        >
          <VText numberOfLines={1} surface="compactList" variant="body" color={selected ? 'accent' : 'ink'} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
            {contributor.displayName}
          </VText>
        </Pressable>
        <AromaReadChips
          aromas={[...contributor.picks]}
          collapse
          overflowSheetStack="push"
          overflowTitle={`${contributor.displayName} Perceived ${contributor.picks.length} Aromas`}
          overflowPillOnSurface
          emphasizeKeys={emphasizeKeys}
          onPressAroma={(selection, rect) => onPressAroma(selection.a, selection.m, rect, contributor.id)}
        />
      </View>
    </View>
  );
}

// Every stat card taps through to the ranking sheet: WHY this verdict + the
// next few places (Simon, 2026-07-17). The quiet › is the affordance.
function TasteStat({ label, value, score, ties, onPress }: { label: string; value: string; score: number; ties: number; onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}${ties > 1 ? ` and ${ties - 1} more tied` : ''}, overlap score ${score}. Show the full ranking`}
      style={({ pressed }) => ({ flex: 1, minWidth: 132, gap: 5, padding: 10, borderRadius: radius.md, backgroundColor: pressed ? theme.surfaceSunk : theme.surface })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <VText variant="label" style={{ flex: 1, color: theme.inkFaint }}>
          {label}
        </VText>
        <VText variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.inkFaint }}>
          ›
        </VText>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <VText numberOfLines={1} variant="small" style={{ flex: 1, fontFamily: 'InstrumentSans_600SemiBold', color: theme.ink }}>
          {value}
        </VText>
        {/* Unitless 0–100 (scientific review, 2026-07-19): weighted Dice ×100
            is not a percentage of any nameable quantity — no % sign. */}
        <VText variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accent }}>
          {score}
        </VText>
      </View>
      {/* A tied extreme is DISCLOSED, never silently crowned (Simon
          2026-07-19) — the ranking sheet shows who shares it. */}
      {ties > 1 ? (
        <VText variant="caption" color="inkFaint">
          {`${ties} tied`}
        </VText>
      ) : null}
    </Pressable>
  );
}

export type TasteDetailKind = 'alike' | 'different' | 'closest' | 'individual';
const TASTE_DETAIL: Record<TasteDetailKind, { title: string; method: string }> = {
  alike: { title: 'Most Alike', method: 'Every pair ranked by overlap — exact shared aromas count most, shared families least.' },
  different: { title: 'Most Different', method: 'Every pair ranked from the least overlap up.' },
  closest: { title: 'Closest to Group', method: 'Each person ranked by their average overlap with every other taster.' },
  individual: { title: 'Most Individual', method: 'Each person ranked from the lowest average overlap up.' },
};

// Only rendered from 3 aroma respondents (aromaTasteSummary returns null
// below that — with two people every stat names the same pair).
function TasteConnections({ summary, onPressStat }: { summary: AromaTasteSummary; onPressStat: (kind: TasteDetailKind) => void }) {
  const { theme } = useTheme();
  const pairName = (pair: AromaTasteSummary['closestPair']) => `${pair.people[0].displayName} + ${pair.people[1].displayName}`;
  return (
    <View style={{ gap: 8, padding: 10, borderRadius: radius.lg, backgroundColor: theme.surfaceSunk }}>
      <View style={{ gap: 1 }}>
        <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.ink }}>
          Taste Connections
        </VText>
        <VText variant="caption" style={{ color: theme.inkFaint }}>
          Overlap scores 0–100, from shared and related aromas
        </VText>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
        <TasteStat label="MOST ALIKE" value={pairName(summary.closestPair)} score={summary.closestPair.score} ties={summary.closestPairTies} onPress={() => onPressStat('alike')} />
        <TasteStat label="MOST DIFFERENT" value={pairName(summary.farthestPair)} score={summary.farthestPair.score} ties={summary.farthestPairTies} onPress={() => onPressStat('different')} />
        <TasteStat label="CLOSEST TO GROUP" value={summary.closestToGroup.person.displayName} score={summary.closestToGroup.score} ties={summary.closestToGroupTies} onPress={() => onPressStat('closest')} />
        <TasteStat label="MOST INDIVIDUAL" value={summary.mostIndividual.person.displayName} score={summary.mostIndividual.score} ties={summary.mostIndividualTies} onPress={() => onPressStat('individual')} />
      </View>
    </View>
  );
}

// Shared/related evidence behind one pair's score — the tap-through "why".
// Chips reuse the canonical AromaChip at compact read height; SHARED = exact
// picks + same-leaf matches, RELATED = subfamily/family territory only.
function TasteEvidence({ a, b }: { a: AromaContributor; b: AromaContributor }) {
  const { theme } = useTheme();
  const ev = useMemo(() => tasteSharedEvidence(a, b), [a, b]);
  const sectionLabel = (text: string) => (
    <VText variant="label" style={{ color: theme.inkFaint }}>
      {text}
    </VText>
  );
  if (!ev.exact.length && !ev.leaves.length && !ev.related.length) {
    return (
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_500Medium', color: theme.inkSoft }}>
        No shared or related aromas — two completely different reads.
      </VText>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {ev.exact.length || ev.leaves.length ? (
        <View style={{ gap: 6 }}>
          {sectionLabel('SHARED')}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: STRIP_GAP }}>
            {ev.exact.map((pick) => <AromaChip key={pickKey(pick.a, pick.m)} a={pick.a} m={pick.m} vPad={0} />)}
            {ev.leaves.map((id) => <AromaChip key={id} a={id} m={null} vPad={0} />)}
          </View>
        </View>
      ) : null}
      {ev.related.length ? (
        <View style={{ gap: 6 }}>
          {sectionLabel('RELATED')}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: STRIP_GAP }}>
            {ev.related.map((node) => <AromaChip key={node.id} a={node.id} m={null} vPad={0} />)}
          </View>
        </View>
      ) : null}
    </View>
  );
}

// The stat-card tap-through (Simon, 2026-07-17): a PUSHED 70% scroll sheet over
// the detail sheet — sheet-over-sheet is the ruled navigation for this (the
// AromaReadChips "+N more" / recents-picker anatomy, cloned verbatim; an
// in-sheet drill variant was rejected as illegible navigation, and the FIRST
// pushed cut stranded the parent sheet on device — cause unproven statically,
// so this rebuild pattern-matches the proven consumers exactly). Pair kinds
// list the top/bottom 8 pairs; group kinds list people by mean overlap. The
// #1 row starts expanded; tapping a row swaps the expansion. Expanded pairs
// show the shared/related evidence chips; expanded people show their closest
// matches (WHY their average is high/low).
export function TasteDetailSheet({ kind, summary, participants, onClose }: {
  kind: TasteDetailKind | null;
  summary: AromaTasteSummary | null;
  participants: ReadonlyArray<AromaContributor>;
  onClose: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(0);
  // Keep the last real kind through the dismiss animation (the house pinned-
  // read pattern) so the sheet doesn't blank while sliding away.
  const shownRef = useRef<TasteDetailKind>('alike');
  if (kind) shownRef.current = kind;
  const shown = kind ?? shownRef.current;
  useEffect(() => { if (kind) setExpanded(0); }, [kind]);
  const byId = useMemo(() => new Map(participants.map((p) => [p.id, p])), [participants]);
  // Ascending = a STABLE re-sort, never reverse(): ties keep their roster
  // encounter order, so row #1 matches the stat card's reduce-picked extreme
  // (reverse() put the LAST tied minimum first — card and sheet disagreed on
  // tied scores).
  const pairRows: readonly AromaTastePair[] | null = summary && (shown === 'alike' || shown === 'different')
    ? (shown === 'alike' ? summary.pairs : [...summary.pairs].sort((x, y) => x.score - y.score)).slice(0, 8)
    : null;
  // Person kinds rank the ELIGIBLE pool (the >=2-pick gate) so row #1 always
  // matches the stat card's pick — ranking the ungated group put a one-pick
  // respondent above the card's person (Codex). Excluded singles are named in
  // the footer, not silently dropped.
  const memberRows: readonly AromaTasteGroupMember[] | null = summary && (shown === 'closest' || shown === 'individual')
    ? (shown === 'closest' ? summary.eligibleGroup : [...summary.eligibleGroup].sort((x, y) => x.score - y.score)).slice(0, 8)
    : null;
  const total = shown === 'alike' || shown === 'different' ? summary?.pairs.length ?? 0 : summary?.eligibleGroup.length ?? 0;
  const ungatedExcluded = summary && (shown === 'closest' || shown === 'individual')
    ? summary.group.length - summary.eligibleGroup.length
    : 0;
  const listed = pairRows?.length ?? memberRows?.length ?? 0;
  // Every row TIED with the leader keeps the accent rank — the sheet is where
  // a "2 tied" stat card resolves to names.
  const rank = (i: number, tied: boolean) => (
    <VText variant="caption" style={{ width: 22, fontFamily: 'InstrumentSans_600SemiBold', color: tied ? theme.accent : theme.inkFaint }}>
      {i + 1}
    </VText>
  );
  const scorePct = (score: number) => (
    <VText variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accent }}>
      {score}
    </VText>
  );
  // A person's strongest matches, from the already-sorted pair list.
  const topPartners = (id: string) => summary
    ? summary.pairs.filter((pair) => pair.people.some((p) => p.id === id)).slice(0, 3)
    : [];
  return (
    <Sheet
      open={kind != null}
      onClose={onClose}
      stackBehavior="push"
      layer={1}
      snapPoints={['70%']}
      enableDynamicSizing={false}
    >
      {/* Plain View wrapper — the sheet-scroll invariant (apps/mobile/CLAUDE.md). */}
      <View style={{ flex: 1, paddingTop: 8, paddingBottom: insets.bottom + 8 }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
              {TASTE_DETAIL[shown].title}
            </VText>
            <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8}>
              <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accent }}>
                Done
              </VText>
            </Pressable>
          </View>
          <VText variant="caption" color="inkSoft">{TASTE_DETAIL[shown].method}</VText>
        </View>
        <BottomSheetScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}>
          {pairRows?.map((pair, i) => (
            <View key={`${pair.people[0].id}|${pair.people[1].id}`} style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: theme.ruleSoft }}>
              <Pressable
                onPress={() => setExpanded((cur) => (cur === i ? -1 : i))}
                accessibilityRole="button"
                accessibilityState={{ expanded: expanded === i }}
                accessibilityLabel={`${pair.people[0].displayName} and ${pair.people[1].displayName}, overlap score ${pair.score}`}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, backgroundColor: pressed ? theme.surfaceSunk : 'transparent' })}
              >
                {rank(i, pair.score === pairRows[0].score)}
                <VText numberOfLines={1} variant="body" style={{ flex: 1, fontFamily: 'InstrumentSans_500Medium' }}>
                  {pair.people[0].displayName} + {pair.people[1].displayName}
                </VText>
                {scorePct(pair.score)}
              </Pressable>
              {expanded === i ? (
                <View style={{ paddingLeft: 22, paddingBottom: 12 }}>
                  {byId.has(pair.people[0].id) && byId.has(pair.people[1].id) ? (
                    <TasteEvidence a={byId.get(pair.people[0].id)!} b={byId.get(pair.people[1].id)!} />
                  ) : null}
                </View>
              ) : null}
            </View>
          ))}
          {memberRows?.map((member, i) => (
            <View key={member.person.id} style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: theme.ruleSoft }}>
              <Pressable
                onPress={() => setExpanded((cur) => (cur === i ? -1 : i))}
                accessibilityRole="button"
                accessibilityState={{ expanded: expanded === i }}
                accessibilityLabel={`${member.person.displayName}, average overlap score ${member.score}`}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, backgroundColor: pressed ? theme.surfaceSunk : 'transparent' })}
              >
                {rank(i, member.score === memberRows[0].score)}
                <Avatar name={member.person.displayName} size={30} />
                <VText numberOfLines={1} variant="body" style={{ flex: 1, fontFamily: 'InstrumentSans_500Medium' }}>
                  {member.person.displayName}
                </VText>
                {scorePct(member.score)}
              </Pressable>
              {expanded === i ? (
                <View style={{ paddingLeft: 62, paddingBottom: 12, gap: 4 }}>
                  <VText variant="label" style={{ color: theme.inkFaint }}>
                    CLOSEST MATCHES
                  </VText>
                  {topPartners(member.person.id).map((pair) => {
                    const other = pair.people[0].id === member.person.id ? pair.people[1] : pair.people[0];
                    return (
                      <View key={other.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <VText numberOfLines={1} variant="small" color="inkSoft" style={{ flexShrink: 1 }}>{other.displayName}</VText>
                        {scorePct(pair.score)}
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </View>
          ))}
          {total > listed ? (
            <VText variant="caption" color="inkFaint" style={{ paddingTop: 12 }}>
              {shown === 'alike' || shown === 'different'
                ? `Top ${listed} of ${total} pairs`
                : `${listed} of ${total} people`}
            </VText>
          ) : null}
          {ungatedExcluded > 0 ? (
            <VText variant="caption" color="inkFaint" style={{ paddingTop: total > listed ? 4 : 12 }}>
              {`${ungatedExcluded} taster${ungatedExcluded === 1 ? '' : 's'} with a single pick ${ungatedExcluded === 1 ? "isn't" : "aren't"} ranked here.`}
            </VText>
          ) : null}
        </BottomSheetScrollView>
      </View>
    </Sheet>
  );
}

export function AromaDetailSheet({
  open,
  onClose,
  model,
  wineName,
  focusId,
  route,
  tasteSummary,
  onOpenTasteDetail,
}: {
  open: boolean;
  onClose: () => void;
  /** The parent-computed compare-aroma model (same instance the strip renders). */
  model: CompareAromaModel;
  wineName: string;
  /** Node the strip popover's "+N more branches" was viewing: opens the
      sheet on All Aromas with the node's supporting picks highlighted (its
      complete uncapped branch detail — the Overview may not even have a row
      for a below-floor head). */
  focusId?: string;
  /** Opening target (slice 3d): tab + optional People filter. The popover's
      Perceived-by tap passes viewContributorsRoute(ref); omitted → the
      default tab (Agreement, or All Aromas in fallback). */
  route?: Tier3Route;
  /** CARD-owned (like the model): the taste rankings + the stat-card
      tap-through target. The ranking sheet mounts as this sheet's SIBLING at
      the card level — its modal lifecycle must not nest inside this
      conditionally-mounted component (see TasteDetailSheet). */
  tasteSummary: AromaTasteSummary | null;
  onOpenTasteDetail: (kind: TasteDetailKind) => void;
}) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<BottomSheetScrollViewMethods>(null);
  const { result, contrib, hasAgreement, allAromas, pronouncedIds } = model;
  const overview = useMemo(() => buildAgreementOverview(model), [model]);

  // Tabs + the active tab. The stored tab is a PREFERENCE; the rendered tab is
  // DERIVED every render (Codex #3) so a poll that flips agreement away while
  // the sheet is open can never leave an impossible active tab.
  const tabs = tier3Tabs(hasAgreement);
  const [tabState, setTabState] = useState<Tier3Mode>(() => {
    // The strip popover's "+N more branches" (focusId): the node's full
    // branch detail lives in All Aromas now — open there with its supporting
    // picks highlighted (the ruled contextual-focus), never a dead default
    // (the node may not even have an Overview row below the floor — Codex).
    // focusId outranks a default 'agreement' route: a caller passing both
    // would otherwise strand the seeded highlight invisibly (Codex re-check).
    if (focusId) return 'all';
    if (route && tabs.includes(route.mode)) return route.mode;
    return tabs[0];
  });
  const tab = tabs.includes(tabState) ? tabState : tabs[0];
  // Reset the shared viewport on ANY effective tab change — user tap or the
  // derived fallback above — so a deep Agreement scroll doesn't leak into the
  // next tab (Codex #4).
  const prevTab = useRef(tab);
  useEffect(() => {
    if (prevTab.current === tab) return;
    prevTab.current = tab;
    setOpenBar(null);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [tab]);

  // The People filter — navigation context, INDEPENDENT of the selection
  // (Simon's round-2 ruling): seeded by the opening route, cleared only by
  // Show All ✕. Expanding a person inside the filtered list never clears it.
  // Validity is derived: a filter whose supporter set vanished (poll churn,
  // re-homed id) simply stops filtering.
  const [peopleFilter, setPeopleFilter] = useState<AromaRef | null>(route?.aromaFilter ?? null);
  const filterContribs = useMemo(
    () => (peopleFilter ? selectionContributors(contrib, peopleFilter) : []),
    [contrib, peopleFilter],
  );
  const activeFilter = peopleFilter && filterContribs.length > 0 ? peopleFilter : null;

  // All Aromas and People each own a single-select reducer (aroma XOR
  // participant, retap clears) and retain their state across tab switches.
  // The Overview does NOT use the selection model: its data objects (the
  // fingerprint's family segments + each head bar's contributing-aroma
  // segments) anchor a contributors POPOVER on tap (Simon round 3 — supersedes
  // both the funnel expansion and the round-2 multi-expand).
  const [openBar, setOpenBar] = useState<{
    ref: AromaRef;
    rect: LayoutRectangle;
    /** Which graphic primitive was tapped — drives the source-matched
        connector (Simon: bar/strip/pyramid must NOT clone the badge). */
    source: 'bar' | 'strip' | 'pyramid' | 'chip';
    familyId: string;
    localPoints?: string;
    facetLabel?: FacetLabel;
  } | null>(null);
  const openBarContent = useMemo(() => {
    if (!openBar) return null;
    const contributors = selectionContributors(contrib, openBar.ref);
    const base = openBar.ref.kind === 'base' ? contrib.byBase.find((b) => b.baseId === openBar.ref.a) : undefined;
    const pairModifier = openBar.ref.kind === 'pair' && openBar.ref.m != null
      ? capFirstLabel(aromaModifierDisplay(openBar.ref.a, openBar.ref.m))
      : null;
    // Fingerprint popovers add the mention total as SECONDARY detail — the
    // one place breadth speaks without outvoting a person (review round 2).
    const familyMentions = openBar.source === 'strip'
      ? contrib.byBase
        .filter((base) => base.familyId === openBar.ref.a)
        .reduce((sum, base) => sum + base.byModifier.reduce((inner, g) => inner + g.count, 0), 0)
      : null;
    return {
      name: capFirstLabel(getAromaNode(openBar.ref.a)?.label ?? openBar.ref.a)
        + (pairModifier ? ` · ${pairModifier}` : ''),
      familyMentions,
      count: contributors.length,
      contributors: contributors.slice(0, PREVIEW_CAP).map((person) => ({ id: person.id, displayName: person.displayName })),
      more: Math.max(0, contributors.length - PREVIEW_CAP),
      modifiers: base && hasModifierDistinction(base.byModifier) ? base.byModifier : [],
    };
  }, [contrib, openBar]);
  const pressBarSegment = (
    ref: AromaRef,
    rect: LayoutRectangle,
    origin: { source: 'bar' | 'strip' | 'pyramid' | 'chip'; familyId: string; localPoints?: string; facetLabel?: FacetLabel },
  ) => setOpenBar({ ref, rect, ...origin });
  const [allSelection, dispatchAll] = useReducer(
    compareSelectionReducer,
    undefined,
    (): CompareSelection => (focusId ? { kind: 'aroma', ref: { kind: 'node', a: focusId } } : { kind: 'none' }),
  );
  const [peopleSelection, dispatchPeople] = useReducer(
    compareSelectionReducer,
    { kind: 'none' } as CompareSelection,
  );
  const selection: CompareSelection = tab === 'all' ? allSelection : tab === 'participants' ? peopleSelection : { kind: 'none' };
  const dispatch = tab === 'participants' ? dispatchPeople : dispatchAll;
  const selRef: AromaRef | null = selection.kind === 'aroma' ? selection.ref : null;
  const selContribs = useMemo(
    () => (selRef ? selectionContributors(contrib, selRef) : []),
    [contrib, selRef],
  );
  const aromaSel = selRef && selContribs.length > 0 ? selRef : null;
  const participantSel = selection.kind === 'participant' && contrib.participants.some((c) => c.id === selection.id) ? selection.id : null;

  const tapAroma = (ref: AromaRef) => dispatch({ type: 'tapAroma', ref });
  const tapParticipant = (id: string) => dispatch({ type: 'tapParticipant', id });
  // Exact-pair inspection shared by All Aromas + the badges inside People.
  // `ownerId` changes only the contributor copy ("Also perceived by") and
  // excludes the row owner from that preview; the focused badge keeps the
  // total distinct-taster count.
  const [openAroma, setOpenAroma] = useState<{
    ref: Extract<AromaRef, { kind: 'pair' }>;
    rect: LayoutRectangle;
    ownerId?: string;
  } | null>(null);
  // The popover anchors at its tap-time window rect, which stays valid only
  // while layout is static — the Modal blocks scrolling, but a live-poll
  // model change re-ranks the chip grids and would strand the duplicated
  // badge over the wrong chip. Close it when the model changes (the strip
  // re-measures instead; here the rect has no live trigger handle — People
  // badges anchor through AromaReadChips — so dismissal is the honest fork).
  useEffect(() => {
    setOpenAroma(null);
    setOpenBar(null);
  }, [contrib]);
  const openAromaContent = useMemo(
    () => (openAroma ? exactAromaPopoverContent(contrib, openAroma.ref, openAroma.ownerId) : null),
    [contrib, openAroma],
  );
  const openAromaContributors = () => {
    if (!openAroma) return;
    setPeopleFilter(openAroma.ref);
    setTabState('participants');
    setOpenAroma(null);
  };

  // Per-tab headline over the shared wineName subtitle. Agreement keeps the
  // strong/weak fork; All Aromas keeps the fallback's respondent fork.
  const title = tab === 'agreement'
    ? (result.hasStrongAgreement ? 'What the group agreed on' : result.n >= 2 ? 'What the group mentioned' : 'Aromas')
    : tab === 'all'
      ? (hasAgreement ? 'All aromas' : result.n >= 2 ? 'Aromas mentioned' : 'Aromas')
      : 'Who perceived what';
  const head = (
    <View style={{ gap: 10, paddingBottom: 12 }}>
      <View style={{ gap: 2 }}>
        <VText variant="heading">{title}</VText>
        <VText variant="small" color="inkSoft">{wineName}</VText>
      </View>
      <Segmented
        segments={tabs.map((t) => ({ key: t, label: TAB_LABELS[t] }))}
        active={tab}
        onSelect={setTabState}
      />
    </View>
  );

  // All Aromas: literal modifier-bearing picks in the canonical badge.
  // Mentions is deliberately flat; Family changes grouping, not the data.
  const [allSort, setAllSort] = useState<AromaMentionSort>('occurrence');
  const [allQuery, setAllQuery] = useState('');
  const sortedAromas = useMemo(() => sortAromaMentions(allAromas, allSort), [allAromas, allSort]);
  const visibleAromas = useMemo(() => filterAromaMentions(sortedAromas, allQuery), [allQuery, sortedAromas]);
  const aromaFamilies = useMemo(() => groupAromaMentions(visibleAromas), [visibleAromas]);
  const keepPair: ((a: string, m: string | null) => boolean) | null = useMemo(() => {
    const fromKeys = (keys: ReadonlySet<string>) => (a: string, m: string | null) => keys.has(pickKey(a, m));
    if (aromaSel) {
      if (aromaSel.kind === 'pair') return (a, m) => a === aromaSel.a && m === aromaSel.m;
      if (aromaSel.kind === 'base') return (a) => a === aromaSel.a;
      return fromKeys(supportingPickKeys(contrib, aromaSel.a));
    }
    if (participantSel) {
      const person = contrib.participants.find((c) => c.id === participantSel);
      return person ? fromKeys(new Set(person.picks.map((p) => pickKey(p.a, p.m)))) : null;
    }
    return null;
  }, [contrib, aromaSel, participantSel]);
  const aromaChip = (row: (typeof visibleAromas)[number]) => (
    <InspectableAromaChip
      key={pickKey(row.a, row.m)}
      a={row.a}
      m={row.m}
      count={row.count}
      muted={keepPair != null && !keepPair(row.a, row.m)}
      onPress={(rect) => {
        tapAroma(row.ref);
        setOpenAroma({ ref: row.ref, rect });
      }}
    />
  );
  const pyramid = useMemo(() => topAromaPyramid(allAromas), [allAromas]);
  const allAromasBody = (
    <View style={{ gap: 12 }}>
      {/* Top-10 pyramid — hidden while a search narrows the field. */}
      {!allQuery.trim() && pyramid.length > 0 ? (
        <View style={{ paddingVertical: 6 }}>
          <TopAromaPyramid
            tiers={pyramid}
            keepPair={keepPair}
            onPressCell={(row, rect, localPoints, facetLabel) => {
              tapAroma(row.ref);
              pressBarSegment(row.ref, rect, { source: 'pyramid', familyId: row.familyId, localPoints, facetLabel });
            }}
          />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {allAromas.length > 1 ? (
          <Segmented
            compact
            segments={[{ key: 'occurrence' as const, label: 'Mentions' }, { key: 'family' as const, label: 'Family' }]}
            active={allSort}
            onSelect={setAllSort}
          />
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <SheetSearchField value={allQuery} onChangeText={setAllQuery} placeholder="Search aromas" />
        </View>
      </View>
      {visibleAromas.length > 0 ? (
        allSort === 'occurrence' ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: STRIP_GAP }}>
            {visibleAromas.map(aromaChip)}
          </View>
        ) : (
          <View style={{ gap: 16 }}>
            {aromaFamilies.map((family) => (
              <View key={family.familyId} style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: aromaColor(family.familyId) }} />
                  <VText variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.inkSoft }}>
                    {family.label}
                  </VText>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: STRIP_GAP }}>
                  {family.rows.map(aromaChip)}
                </View>
              </View>
            ))}
          </View>
        )
      ) : (
        <VText variant="small" color="inkFaint">{allQuery.trim() ? 'No matching aromas.' : 'No aromas yet.'}</VText>
      )}
    </View>
  );

  // People: the popover route may narrow the roster; search then filters that
  // context. Rows use the established Moments/Compare person anatomy and the
  // existing two-line AromaReadChips packer.
  const [peopleQuery, setPeopleQuery] = useState('');
  const peopleSource: ReadonlyArray<AromaContributor> = activeFilter ? filterContribs : contrib.participants;
  const people = useMemo(() => filterAromaParticipants(peopleSource, peopleQuery), [peopleQuery, peopleSource]);
  const peopleBody = (
    <View style={{ gap: 12 }}>
      {tasteSummary && !activeFilter ? <TasteConnections summary={tasteSummary} onPressStat={onOpenTasteDetail} /> : null}
      {activeFilter ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <VText variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold', letterSpacing: 0.3, color: theme.inkSoft }}>Perceived</VText>
          <AromaChip a={activeFilter.a} m={activeFilter.kind === 'pair' ? activeFilter.m : null} count={peopleSource.length} pronounced={activeFilter.kind === 'node' && pronouncedIds.has(activeFilter.a)} vPad={0} />
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => setPeopleFilter(null)} accessibilityRole="button" accessibilityLabel="Show All" hitSlop={8}>
            <VText variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accent }}>Show All ✕</VText>
          </Pressable>
        </View>
      ) : null}
      <SheetSearchField value={peopleQuery} onChangeText={setPeopleQuery} placeholder="Search people or aromas" />
      {people.length > 0 ? (
        <View>
          {people.map((contributor, i) => (
            <ParticipantRow
              key={contributor.id}
              first={i === 0}
              contributor={contributor}
              selected={participantSel === contributor.id}
              onToggle={() => tapParticipant(contributor.id)}
              emphasizeKeys={matchingParticipantPickKeys(contributor, peopleQuery)}
              onPressAroma={(a, m, rect, ownerId) => {
                const ref = { kind: 'pair' as const, a, m };
                tapAroma(ref);
                setOpenAroma({ ref, rect, ownerId });
              }}
            />
          ))}
        </View>
      ) : (
        <View>
          <VText variant="small" color="inkFaint">{peopleQuery.trim() ? 'No matching people.' : 'No aroma respondents yet.'}</VText>
        </View>
      )}
    </View>
  );

  const ALSO_CAP = 8;
  const fingerprint = useMemo(() => familyFingerprint(contrib, allAromas), [allAromas, contrib]);
  // The Aroma Bun (and its Overview|Bun toggle) is REMOVED from production —
  // Simon's ruling, 2026-07-19. The geometry + dev-gallery labs remain.
  const agreementBody = (
    <View style={{ gap: 14 }}>
      <VText variant="caption" color="inkFaint">
        {`${overview.n} taster${overview.n === 1 ? '' : 's'} noted aromas`}
      </VText>
      <>
          {/* The family fingerprint — this wine's mention mix as one strip
              (gestalt garnish: no numbers, ever — the shares are mention-
              weighted). Segments fade into each other and tap to their
              family's contributors; the legend is gone (Simon round 3). */}
          {fingerprint.length > 0 ? (
            <FingerprintStrip
              shares={fingerprint}
              aromaColor={aromaColor}
              onPressSegment={(ref, rect) => pressBarSegment(ref, rect, { source: 'strip', familyId: ref.a })}
            />
          ) : null}
          {overview.rows.length > 0 ? (
            <View style={{ gap: 16 }}>
              {overview.rows.map((row) => (
                <OverviewRow
                  key={row.id}
                  row={row}
                  n={overview.n}
                  aromaColor={aromaColor}
                  onPressSegment={(ref, rect) => pressBarSegment(ref, rect, { source: 'bar', familyId: row.familyId })}
                />
              ))}
            </View>
          ) : overview.n >= 2 ? (
            // Every head fell below the significance floor (or fallback mode:
            // nothing was shared at all) — honest register, never an
            // agreement superlative. Solo panels skip the line: the tail IS
            // the read.
            <VText variant="small" color="inkSoft">
              No aroma was shared by enough tasters.
            </VText>
          ) : null}
          {overview.alsoMentioned.length > 0 ? (
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <VText variant="label" style={{ flex: 1, color: theme.inkFaint }}>
                  {overview.rows.length > 0 ? 'ALSO MENTIONED' : 'MENTIONED'}
                </VText>
                <Pressable onPress={() => setTabState('all')} accessibilityRole="button" accessibilityLabel="Show All Aromas" hitSlop={8}>
                  <VText variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold', color: theme.accent }}>
                    All Aromas ›
                  </VText>
                </Pressable>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: STRIP_GAP }}>
                {/* Tappable like every other Overview data object — the same
                    contributors popover, via the base ref (literal picks). */}
                {overview.alsoMentioned.slice(0, ALSO_CAP).map((chip) => (
                  <InspectableAromaChip
                    key={chip.id}
                    a={chip.id}
                    m={null}
                    count={chip.count}
                    onPress={(rect) => pressBarSegment({ kind: 'base', a: chip.id }, rect, { source: 'chip', familyId: chip.familyId })}
                  />
                ))}
                {overview.alsoMentioned.length > ALSO_CAP ? (
                  <VText variant="caption" color="inkFaint">
                    {`+${overview.alsoMentioned.length - ALSO_CAP} more`}
                  </VText>
                ) : null}
              </View>
            </View>
          ) : null}
          {/* The survey-report multi-select disclosure — one caption doing the
              anti-part-whole-misread work for every row above it. */}
          <VText variant="caption" color="inkFaint">
            Tasters can pick several aromas.
          </VText>
      </>
    </View>
  );

  const body = tab === 'agreement' ? (
    agreementBody
  ) : tab === 'all' ? (
    allAromasBody
  ) : (
    peopleBody
  );

  // One fixed 85% sheet for every tab. Dynamic sizing made the whole modal
  // jump when switching between a short aroma grid and a long People roster;
  // stable chrome is more important here, and every body is scrollable.
  // The Overview's segment popover: who is behind a fingerprint family or a
  // head bar's contributing aroma — with the modifier split when the base has
  // a real distinction, and the people row tapping through to the FULL list
  // (People tab filtered to the segment's ref).
  // Source-matched connector (Simon round 4): the clone riding the tap rect
  // is the PRIMITIVE that was tapped — a flat bar piece, a pill fingerprint
  // segment, or the exact pyramid facet polygon — never the badge (only the
  // Also-mentioned chips, which ARE badges, keep it). The aroma name moves
  // into the card title since no badge carries it.
  const segConnector = openBar && openBar.source !== 'chip' ? (
    openBar.source === 'pyramid' && openBar.localPoints ? (
      <Svg width={openBar.rect.width} height={openBar.rect.height} pointerEvents="none">
        <Polygon points={openBar.localPoints} fill={aromaColor(openBar.familyId)} />
        {openBar.facetLabel?.lines.map((line, li) => (
          <SvgText
            key={li}
            x={line.x}
            y={line.y}
            fontSize={typeScale.caption.size}
            fontFamily={line.apex && !line.mod ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium'}
            fill={openBar.facetLabel!.ink}
            fillOpacity={line.mod ? 0.8 : 1}
            textAnchor="middle"
          >
            {line.text}
          </SvgText>
        ))}
      </Svg>
    ) : (
      <View
        style={{
          width: openBar.rect.width,
          height: openBar.rect.height,
          backgroundColor: aromaColor(openBar.familyId),
          borderRadius: openBar.source === 'strip' ? 999 : 0,
        }}
      />
    )
  ) : undefined;
  const barPopover = openBar && openBarContent ? (
    <AromaBadgePopover
      rect={openBar.rect}
      onClose={() => setOpenBar(null)}
      a={openBar.source === 'chip' ? openBar.ref.a : undefined}
      m={null}
      count={openBar.source === 'chip' ? openBarContent.count : undefined}
      connector={segConnector}
    >
      <View style={{ gap: 10 }}>
        {openBar.source !== 'chip' && !(
          openBar.source === 'pyramid'
          && (openBar.facetLabel?.lines.length ?? 0) > 0
          && (!(openBar.ref.kind === 'pair' && openBar.ref.m != null) || openBar.facetLabel!.lines.some((line) => line.mod))
        ) ? (
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
              {openBarContent.name}
            </VText>
            <VText variant="caption" color="inkFaint">
              {`${openBarContent.count} taster${openBarContent.count === 1 ? '' : 's'}`
                + (openBarContent.familyMentions != null && openBarContent.familyMentions !== openBarContent.count
                  ? ` · ${openBarContent.familyMentions} mentions`
                  : '')}
            </VText>
          </View>
        ) : null}
        {openBarContent.modifiers.length > 0 ? (
          <View style={{ gap: 6 }}>
            <VText variant="caption" style={{ fontFamily: 'InstrumentSans_600SemiBold', letterSpacing: 0.3, color: theme.inkSoft }}>
              How it was described
            </VText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: STRIP_GAP }}>
              {openBarContent.modifiers.map((g) => (
                <AromaChip key={g.m ?? '_'} a={openBar.ref.a} m={g.m} count={g.count} vPad={0} />
              ))}
            </View>
          </View>
        ) : null}
        <AromaPopoverPeople
          contributors={openBarContent.contributors}
          more={openBarContent.more}
          onPress={openBarContent.count > 0 ? () => {
            setPeopleFilter(openBar.ref);
            setTabState('participants');
            setOpenBar(null);
          } : undefined}
        />
      </View>
    </AromaBadgePopover>
  ) : null;

  const popover = openAroma && openAromaContent ? (
    <AromaBadgePopover
      rect={openAroma.rect}
      onClose={() => setOpenAroma(null)}
      a={openAroma.ref.a}
      m={openAroma.ref.m}
      count={openAromaContent.count}
    >
      <AromaPopoverPeople
        label={openAroma.ownerId ? 'Also perceived by' : 'Perceived by'}
        contributors={openAromaContent.contributors}
        more={openAromaContent.moreContributors}
        emptyCopy={openAroma.ownerId ? 'No one else mentioned this aroma.' : undefined}
        onPress={openAromaContent.contributors.length > 0 ? openAromaContributors : undefined}
      />
    </AromaBadgePopover>
  ) : null;

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        snapPoints={['85%']}
        enableDynamicSizing={false}
      >
        {/* Plain View, NEVER BottomSheetView, around a sheet scrollable —
            BottomSheetView's mount effect re-registers the sheet's scrollable
            as type VIEW (it runs after the child scrollable's registration),
            which routes content drags into sheet over-drag and pins the list
            to offset 0 (apps/mobile/CLAUDE.md sheet-scroll invariant). */}
        <View style={{ flex: 1, paddingHorizontal: 18 }}>
          {head}
          <BottomSheetScrollView
            ref={scrollRef}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: insets.bottom + 12 }}
          >
            {body}
          </BottomSheetScrollView>
        </View>
      </Sheet>
      {popover}
      {barPopover}
    </>
  );
}
