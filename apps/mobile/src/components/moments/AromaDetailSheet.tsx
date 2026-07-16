import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { findNodeHandle, Pressable, useWindowDimensions, View, type LayoutRectangle } from 'react-native';
import { BottomSheetScrollView, BottomSheetView, type BottomSheetScrollViewMethods } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ConsensusDisplayNode } from '@verre/core';
import { AromaChip } from '@/components/scoring/aroma/parts';
import { AromaReadChips } from '@/components/scoring/aroma/AromaReadChips';
import { AromaBunGraphic } from './AromaBunGraphic';
import { spiralRibbon } from './aromaVizGeometry';
import {
  aromaAncestorIds, aromaTasteSummary, compareSelectionReducer, exactAromaPopoverContent, filterAromaMentions, filterAromaParticipants, groupAromaMentions, matchingParticipantPickKeys, pickKey, selectionContributors, sortAromaMentions, supportedNodeIds, supportingPickKeys, tier3Tabs, STRIP_GAP,
  type AromaMentionSort, type AromaRef, type AromaTasteSummary, type CompareAromaModel, type CompareSelection, type Tier3Mode, type Tier3Route,
} from './aromaCompareView';
import type { AromaContributor } from './aromaContributors';
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
// - Agreement (only when model.hasAgreement): the WHOLE consensus tree
//   (context ancestors, headings, nested peaks the strip omits).
// - All Aromas: searchable canonical modifier-bearing badges. Mentions is one
//   flat occurrence-ranked field; Family groups the same badges under family
//   headings. No analytical base-heading/modifier-tally rows.
// - People: searchable established person rows (40pt Avatar + name + exact
//   AromaReadChips), collapsed to two lines; "+N more" pushes the established
//   full-badge read sheet above this one.
//
// Two INDEPENDENT pieces of state (Simon's round-2 ruling, 2026-07-15):
// - `peopleFilter` — the People tab's navigation context: which aroma's
//   supporters the list shows. Set by the popover's viewContributorsRoute,
//   cleared ONLY by Show All ✕. Expanding a person never touches it.
// - one `selection` PER TAB — each view keeps its own ruled focus
//   (single-select, aroma XOR participant, retap clears, never a nested
//   popover/sheet). Switching tabs preserves that view's state without leaking
//   its muting/highlight into another view. Aroma identity is the three-way
//   AromaRef — node (subsumed) / base (literal, all modifiers) / pair (exact)
//   — because the same id names three different supporter sets.
// Per-tab effects: an agreement chip (node) accents itself + shows its
// subsumed contributors inline; a base/pair selection only DIMS the tree to
// the branches its picks support (accenting a consensus node whose count is a
// broader population than the selection's names would lie — Codex round 2);
// on All Aromas the matching rows stay lit and the rest mute (the ruled
// contextual-focus treatment — a selection never recolours itself); a
// participant expands their row in place and highlights their branches.
// Validity of the filter, each tab's selection, and the active tab is DERIVED
// each render, so poll churn falls back gracefully; tab changes reset only the
// shared scroll viewport.
//
// Role drives emphasis, NOT a debug tag: a primary is the emphasized head
// (accent hairline + bold), a secondary is a plainer counted head, a context
// ancestor is a quieter chip above its primary, a peak is a chip indented under
// its branch, and an uncounted heading is a quiet family grouping label.

const TAB_LABELS: Record<Tier3Mode, string> = {
  agreement: 'Agreement',
  all: 'All Aromas',
  participants: 'People',
};
type AgreementView = 'tree' | 'bun';

function ConsensusRow({ dn, depth, pronouncedIds, highlightId, highlightNames, supportedIds, onTapAroma, focusId, focusRef }: {
  dn: ConsensusDisplayNode;
  depth: number;
  pronouncedIds: ReadonlySet<string>;
  /** A NODE selection — accent rail + tint + the inline names line. */
  highlightId: string | null;
  /** "Perceived by …" copy rendered under the highlighted row. */
  highlightNames: string | null;
  /** Contextual dim (participant or base/pair selection): counted nodes NOT in
      this set dim to 0.35. */
  supportedIds: ReadonlySet<string> | null;
  onTapAroma: (id: string) => void;
  /** Scroll anchor (the popover "+N more" target) — visuals key on highlightId. */
  focusId?: string;
  focusRef?: React.RefObject<View | null>;
}) {
  const { theme } = useTheme();
  const { counted, role, node, children } = dn;
  const highlighted = highlightId != null && node.id === highlightId;
  const dimmed = !highlighted && supportedIds != null && counted && !supportedIds.has(node.id);
  // SELECTION overrides every role — an accent rail + accent-tinted backing,
  // whatever the node's role (a selected secondary must read as selected too).
  // Otherwise the role distinction: primary = ink rail, secondary = faint rail,
  // context = quieter (0.75), peak = slightly quieted (0.9), heading = label.
  const rail: { w: number; c: string } = highlighted
    ? { w: 2, c: theme.accent }
    : role === 'primary' ? { w: 2, c: theme.ink }
      : role === 'secondary' ? { w: 2, c: theme.rule }
        : { w: 0, c: 'transparent' };
  const rowOpacity = dimmed ? 0.35 : highlighted ? 1 : role === 'context' ? 0.75 : role === 'peak' ? 0.9 : 1;
  return (
    <View style={{ gap: 8 }}>
      <View
        ref={focusId != null && node.id === focusId ? focusRef : undefined}
        collapsable={false}
        style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: depth * 18 }}
      >
        <View style={{ borderLeftWidth: rail.w, borderLeftColor: rail.c, paddingLeft: rail.w > 0 ? 8 : 0, opacity: rowOpacity, backgroundColor: highlighted ? theme.accentTint : 'transparent', borderRadius: highlighted ? radius.sm : 0 }}>
          {counted ? (
            <AromaChip a={node.id} m={null} count={node.count} pronounced={pronouncedIds.has(node.id)} vPad={0} onPress={() => onTapAroma(node.id)} />
          ) : (
            // Uncounted grouping heading — a quiet family label, no chip fill (its
            // count would read as additive with its children, §rule 6).
            <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12.5, color: theme.inkFaint }}>
              {node.label}
            </VText>
          )}
        </View>
      </View>
      {highlighted && highlightNames ? (
        <View style={{ paddingLeft: depth * 18 + 10 }}>
          <VText surface="badge" style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 12, lineHeight: 15, color: theme.inkSoft }}>
            {`Perceived by ${highlightNames}`}
          </VText>
        </View>
      ) : null}
      {children.map((c) => (
        <ConsensusRow key={c.node.id} dn={c} depth={depth + 1} pronouncedIds={pronouncedIds} highlightId={highlightId} highlightNames={highlightNames} supportedIds={supportedIds} onTapAroma={onTapAroma} focusId={focusId} focusRef={focusRef} />
      ))}
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

function TasteStat({ label, value, score }: { label: string; value: string; score: number }) {
  const { theme } = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 132, gap: 5, padding: 10, borderRadius: radius.md, backgroundColor: theme.surface }}>
      <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 10.5, letterSpacing: 0.25, color: theme.inkFaint }}>
        {label}
      </VText>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <VText numberOfLines={1} surface="badge" style={{ flex: 1, fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12.5, color: theme.ink }}>
          {value}
        </VText>
        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: theme.accent }}>
          {score}%
        </VText>
      </View>
    </View>
  );
}

function TasteConnections({ summary }: { summary: AromaTasteSummary }) {
  const { theme } = useTheme();
  const pairName = (pair: AromaTasteSummary['closestPair']) => `${pair.people[0].displayName} + ${pair.people[1].displayName}`;
  const twoPeople = summary.respondents === 2;
  return (
    <View style={{ gap: 8, padding: 10, borderRadius: radius.lg, backgroundColor: theme.surfaceSunk }}>
      <View style={{ gap: 1 }}>
        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, color: theme.ink }}>
          Taste connections
        </VText>
        <VText surface="badge" style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 11.5, color: theme.inkFaint }}>
          Based on shared and related aromas
        </VText>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
        {twoPeople ? (
          <TasteStat label="TASTE OVERLAP" value={pairName(summary.closestPair)} score={summary.closestPair.score} />
        ) : (
          <>
            <TasteStat label="MOST ALIKE" value={pairName(summary.closestPair)} score={summary.closestPair.score} />
            <TasteStat label="MOST DIFFERENT" value={pairName(summary.farthestPair)} score={summary.farthestPair.score} />
            {summary.closestToGroup ? <TasteStat label="CLOSEST TO GROUP" value={summary.closestToGroup.person.displayName} score={summary.closestToGroup.score} /> : null}
            {summary.mostIndividual ? <TasteStat label="MOST INDIVIDUAL" value={summary.mostIndividual.person.displayName} score={summary.mostIndividual.score} /> : null}
          </>
        )}
      </View>
    </View>
  );
}

export function AromaDetailSheet({
  open,
  onClose,
  model,
  wineName,
  focusId,
  route,
}: {
  open: boolean;
  onClose: () => void;
  /** The parent-computed compare-aroma model (same instance the strip renders). */
  model: CompareAromaModel;
  wineName: string;
  /** Node the popover "+N more" was viewing; seeds the selection + scroll. */
  focusId?: string;
  /** Opening target (slice 3d): tab + optional People filter. The popover's
      Perceived-by tap passes viewContributorsRoute(ref); omitted → the
      default tab (Agreement, or All Aromas in fallback). */
  route?: Tier3Route;
}) {
  const { theme } = useTheme();
  const aromaColor = useAromaColors();
  const insets = useSafeAreaInsets();
  const { width: windowW } = useWindowDimensions();
  const scrollRef = useRef<BottomSheetScrollViewMethods>(null);
  const focusRef = useRef<View | null>(null);
  const { result, contrib, hasAgreement, allAromas, pronouncedIds } = model;

  // Tabs + the active tab. The stored tab is a PREFERENCE; the rendered tab is
  // DERIVED every render (Codex #3) so a poll that flips agreement away while
  // the sheet is open can never leave an impossible active tab.
  const tabs = tier3Tabs(hasAgreement);
  const [tabState, setTabState] = useState<Tier3Mode>(() => (route && tabs.includes(route.mode) ? route.mode : tabs[0]));
  const tab = tabs.includes(tabState) ? tabState : tabs[0];
  const [agreementView, setAgreementView] = useState<AgreementView>('tree');
  // Reset the shared viewport on ANY effective tab change — user tap or the
  // derived fallback above — so a deep Agreement scroll doesn't leak into the
  // next tab (Codex #4).
  const prevTab = useRef(tab);
  useEffect(() => {
    if (prevTab.current === tab) return;
    prevTab.current = tab;
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

  // Each tab owns its selection. Agreement is seeded from the strip's "+N
  // more" focus node; All Aromas and People start clean and retain their own
  // state when the user moves between tabs. This prevents a People badge tap
  // from paling All Aromas while still preserving the user's place on return.
  const [agreementSelection, dispatchAgreement] = useReducer(
    compareSelectionReducer,
    undefined,
    (): CompareSelection => (focusId ? { kind: 'aroma', ref: { kind: 'node', a: focusId } } : { kind: 'none' }),
  );
  const [allSelection, dispatchAll] = useReducer(
    compareSelectionReducer,
    { kind: 'none' } as CompareSelection,
  );
  const [peopleSelection, dispatchPeople] = useReducer(
    compareSelectionReducer,
    { kind: 'none' } as CompareSelection,
  );
  const selection = tab === 'agreement'
    ? agreementSelection
    : tab === 'all'
      ? allSelection
      : peopleSelection;
  const dispatch = tab === 'agreement'
    ? dispatchAgreement
    : tab === 'all'
      ? dispatchAll
      : dispatchPeople;
  const selRef: AromaRef | null = selection.kind === 'aroma' ? selection.ref : null;
  const selContribs = useMemo(
    () => (selRef ? selectionContributors(contrib, selRef) : []),
    [contrib, selRef],
  );
  const aromaSel = selRef && selContribs.length > 0 ? selRef : null;
  const participantSel = selection.kind === 'participant' && contrib.participants.some((c) => c.id === selection.id) ? selection.id : null;
  const selNames = aromaSel ? selContribs.map((c) => c.displayName).join(', ') : null;

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

  // In scroll mode, bring the focused node (the popover "+N more" target) into
  // view once the content has laid out — ONCE per open (the sheet remounts per
  // open, so a plain ref suffices). Without the guard, any later content resize
  // (poll update, font change) would yank the user's scroll back to the focus
  // row. `onContentSizeChange` CAN fire before the refs are usable, so this
  // retries on a bounded rAF chain until both refs resolve.
  const didScroll = useRef(false);
  const scrollToFocus = (attempt = 0) => {
    if (!focusId || didScroll.current || tab !== 'agreement' || agreementView !== 'tree') return;
    const node = focusRef.current;
    const scroll = scrollRef.current;
    // gorhom exposes the underlying scrollable node via getScrollableNode() —
    // measureLayout needs THAT node handle, not the methods wrapper.
    const scrollNode = scroll?.getScrollableNode?.();
    const scrollHandle = scrollNode != null ? findNodeHandle(scrollNode) : null;
    if (!node || !scroll || scrollHandle == null) {
      if (attempt < 5) requestAnimationFrame(() => scrollToFocus(attempt + 1));
      return;
    }
    node.measureLayout(
      scrollHandle,
      (_x, y) => {
        didScroll.current = true;
        scroll.scrollTo({ y: Math.max(0, y - 24), animated: true });
      },
      () => { if (attempt < 5) requestAnimationFrame(() => scrollToFocus(attempt + 1)); },
    );
  };

  // Per-tab headline over the shared wineName subtitle. Agreement keeps the
  // strong/weak fork; All Aromas keeps the fallback's respondent fork.
  const title = tab === 'agreement'
    ? (result.hasStrongAgreement ? 'What the group agreed on' : 'What the group mentioned')
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
  const allAromasBody = (
    <View style={{ gap: 12 }}>
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
                  <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12.5, color: theme.inkSoft }}>
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
  const tasteSummary = useMemo(() => aromaTasteSummary(contrib.participants), [contrib.participants]);
  const peopleBody = (
    <View style={{ gap: 12 }}>
      {tasteSummary && !activeFilter ? <TasteConnections summary={tasteSummary} /> : null}
      {activeFilter ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11, letterSpacing: 0.3, color: theme.inkSoft }}>Perceived</VText>
          <AromaChip a={activeFilter.a} m={activeFilter.kind === 'pair' ? activeFilter.m : null} count={peopleSource.length} pronounced={activeFilter.kind === 'node' && pronouncedIds.has(activeFilter.a)} vPad={0} />
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => setPeopleFilter(null)} accessibilityRole="button" accessibilityLabel="Show All" hitSlop={8}>
            <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 11.5, color: theme.accent }}>Show All ✕</VText>
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

  const bunSize = Math.min(430, windowW - 36);
  const bunFontSize = typeScale.caption.size;
  const bunLayout = useMemo(
    () => spiralRibbon(model.bun, 0, { size: bunSize, fontSize: bunFontSize, callouts: false, fadePx: 9, labelPaddingPx: 6 }),
    [bunFontSize, bunSize, model.bun],
  );
  const bunSpoken = bunLayout.segments
    .map((segment) => segment.others ? `${segment.count} other agreement mentions` : `${segment.label}, ${segment.count}`)
    .join('. ');
  const agreementBody = (
    <View style={{ gap: 12 }}>
      <Segmented
        compact
        style={{ alignSelf: 'flex-end' }}
        segments={[{ key: 'tree' as const, label: 'Tree' }, { key: 'bun' as const, label: 'Aroma Bun' }]}
        active={agreementView}
        onSelect={(next) => {
          setAgreementView(next);
          scrollRef.current?.scrollTo({ y: 0, animated: false });
        }}
      />
      {agreementView === 'bun' ? (
        <View style={{ gap: 10, alignItems: 'center' }}>
          <AromaBunGraphic
            layout={bunLayout}
            width={bunSize}
            fontSize={bunFontSize}
            accessibilityLabel={`Aroma Bun. Longer sections mean more aroma respondents supported that agreement aroma. ${bunSpoken}`}
          />
          <VText variant="small" color="inkSoft" style={{ textAlign: 'center' }}>
            Longer sections were shared by more aroma respondents.
          </VText>
        </View>
      ) : (
        result.roots.map((r) => (
          <ConsensusRow
            key={r.node.id}
            dn={r}
            depth={0}
            pronouncedIds={pronouncedIds}
            highlightId={aromaSel?.kind === 'node' ? aromaSel.a : null}
            highlightNames={aromaSel?.kind === 'node' ? selNames : null}
            supportedIds={
              participantSel ? supportedNodeIds(contrib, participantSel)
                : aromaSel && aromaSel.kind !== 'node' ? aromaAncestorIds(aromaSel.a)
                  : null
            }
            onTapAroma={(id) => tapAroma({ kind: 'node', a: id })}
            focusId={focusId}
            focusRef={focusRef}
          />
        ))
      )}
    </View>
  );

  // Agreement: only a NODE selection accents a consensus node + attaches its
  // names (their populations match). A base/pair selection dims the tree to
  // the branches its picks support — its contributor set is NARROWER than any
  // consensus count, so pairing them would mislead (Codex round 2).
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
        <BottomSheetView style={{ flex: 1, paddingHorizontal: 18 }}>
          {head}
          <BottomSheetScrollView
            ref={scrollRef}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: insets.bottom + 12 }}
            onContentSizeChange={() => scrollToFocus()}
          >
            {body}
          </BottomSheetScrollView>
        </BottomSheetView>
      </Sheet>
      {popover}
    </>
  );
}
