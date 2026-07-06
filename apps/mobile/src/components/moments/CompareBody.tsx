import { BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, LayoutAnimation, Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  aggregateFlavourAxes,
  consensusFromRatings,
  fillFlavourZeros,
  groupScoreAverage,
  resolveAxes,
  type ConsensusKey,
} from '@verre/core';
import { ComparisonWheel } from '@/components/scoring/ComparisonWheel';
import { FlavourWheel } from '@/components/scoring/FlavourWheel';
import { RadarOverlay } from '@/components/scoring/RadarOverlay';
import { StarScore } from '@/components/scoring/StarScore';
import { Avatar } from '@/components/ui/Avatar';
import { AnchoredMenu, MenuItem, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { TextField } from '@/components/ui/TextField';
import { Thumb } from '@/components/ui/Thumb';
import { VText } from '@/components/ui/VText';
import { getMyFriends } from '@/lib/api/me';
import { type RatingMeta, type RatingsView, type SessionMetaView, type WireWine } from '@/lib/api/sessions';
import { GUTTER, usePhoneTokens } from '@/lib/layout';
import { wineTypeLabel } from '@/lib/momentFormat';
import { useRegisterInput } from '@/lib/keyboardDismiss';
import { fuzzyIncludes } from '@/lib/search';
import { intensityWord } from '@/lib/scoreWords';
import { motion, radius, useTheme } from '@/theme';
import { useFlavourColors, usePersonColors } from '@/theme/flavourColors';

// 02d Compare — the session screen's second TAB (in-screen swap, Simon's
// ruling 2026-07-02: everything above the tab strip stays, no route change).
// Accordion of rated impressions; ALL collapsed by default; cards open/close
// independently (multi-open — closing is always a deliberate tap).
//
// People-selector: ONE screen-level hidden set drives the WHOLE tab —
// deselected people disappear from every card (rows, charts, sheet), and the
// card header (group ★ + consensus) recomputes over the selection. The inline
// avatar-chip rail (02d·4 variant B) was SUPERSEDED 2026-07-03 (Simon): the
// sticky slot now holds the one-line CompareToolbar — People button (opens the
// picker sheet, now the only select/deselect surface) + sort menu (line-up /
// rated / agreement / ratings-count orders) + an impression search field. The
// toolbar renders STICKY under the title bar like the reveal strip (plain:
// ScrollView stickyHeaderIndices; cover-hero: the strip's Dynamic Overlay
// slot).
//
// Person rows on a card are NOT toggles: tapping a name shows that person's
// rating detail for the impression — their flavour wheel + score (tap again
// to return to the group view).
//
// Per open card the chart is size-adaptive on the SELECTED tasters who rated
// it: 1 → their flavour wheel · 2–4 → overlaid radar · 5+ → C1b range wheel.
// Tapping a wedge (C1b) or an axis label (both group charts) opens the
// per-axis split. All aggregation is client-side (@verre/core — §7 ruling).
//
// Like web Compare, NO block-pair filter (docs/dev/block.md locked ruling:
// omission would itself leak the block). Blind rows arrive pre-redacted.

const CAP = 4; // resting people-rows cap before "Show all N" (design .cmp-showall)
const EMPTY_HIDDEN = new Set<string>(); // stable identity for the unfiltered buildItems probe

const CONSENSUS_COPY: Record<ConsensusKey, string> = {
  harmony: 'In harmony',
  mostly: 'Mostly agreed',
  mixed: 'Mixed feelings',
  divide: 'Polarizing',
};

export type ComparePerson = {
  id: string;
  displayName: string;
  imageUrl: string | null;
  /** Roster position — drives the person series colour (best-effort stable). */
  personIndex: number;
};

type Rater = {
  id: string;
  displayName: string;
  rating: RatingMeta;
  /** fillFlavourZeros-normalized flavours; {} ⟺ no flavour engagement. */
  filled: Record<string, number>;
  personIndex: number;
};

type CmpItem = {
  wine: WireWine;
  index: number;
  /** SELECTED raters of this impression (the rail's hidden set already applied). */
  raters: Rater[];
  scored: Rater[];
  avg: number | null;
  /** Score span (max−min) across scored raters; null under 2 scores. Feeds the agreement sorts. */
  spread: number | null;
  consensus: ConsensusKey | null;
};

// Roster position drives person colours + rail order: participants first, then
// any raters no longer in the roster (kicked/tombstoned) in rating-map order.
function rosterIndexOf(ratings: RatingsView | null, meta: SessionMetaView | null): Map<string, number> {
  const rosterIndex = new Map<string, number>();
  (meta?.participants ?? []).forEach((p, i) => rosterIndex.set(p.id, i));
  let overflow = rosterIndex.size;
  for (const id of Object.keys(ratings ?? {})) {
    if (!rosterIndex.has(id)) rosterIndex.set(id, overflow++);
  }
  return rosterIndex;
}

/** The rail/picker roster: participants (avatars included) + tombstoned raters. */
export function buildComparePeople(ratings: RatingsView | null, meta: SessionMetaView | null): ComparePerson[] {
  const rosterIndex = rosterIndexOf(ratings, meta);
  const byId = new Map<string, ComparePerson>();
  for (const p of meta?.participants ?? []) {
    byId.set(p.id, { id: p.id, displayName: p.displayName, imageUrl: p.imageUrl, personIndex: rosterIndex.get(p.id)! });
  }
  for (const [id, bucket] of Object.entries(ratings ?? {})) {
    if (!byId.has(id)) byId.set(id, { id, displayName: bucket.displayName, imageUrl: null, personIndex: rosterIndex.get(id)! });
  }
  return [...byId.values()].sort((a, b) => a.personIndex - b.personIndex);
}

// Items over the SELECTION: hidden raters are dropped before anything is
// computed, so avg/consensus/rows/charts/ranking all follow the rail.
function buildItems(
  wines: WireWine[] | null,
  ratings: RatingsView | null,
  meta: SessionMetaView | null,
  hidden: Set<string>,
): CmpItem[] {
  if (!wines || !ratings) return [];
  const rosterIndex = rosterIndexOf(ratings, meta);
  // Sorted by roster position: Object.entries follows the server's Redis SCAN
  // order, which is NOT stable across polls — unsorted, radar layering, axis
  // rows, and tied score rows would flicker between refreshes.
  const raterBuckets = Object.entries(ratings)
    .filter(([id]) => !hidden.has(id))
    .map(([id, bucket]) => ({ id, ...bucket }))
    .sort((a, b) => rosterIndex.get(a.id)! - rosterIndex.get(b.id)!);

  const items = wines
    .map((wine, index): CmpItem => {
      const raters: Rater[] = raterBuckets
        .filter((b) => b.ratings[wine.id])
        .map((b) => ({
          id: b.id,
          displayName: b.displayName,
          rating: b.ratings[wine.id],
          filled: fillFlavourZeros(b.ratings[wine.id].flavors, 'wine', wine.type),
          personIndex: rosterIndex.get(b.id)!,
        }))
        // Compare renders scores + structure only — a notes-only (or stale
        // cleared) rating has neither and would make a dead-end card ("No
        // structure detail" + "No scores yet").
        .filter((r) => (r.rating.score || 0) > 0 || Object.keys(r.filled).length > 0);
      const scores = raters.map((r) => r.rating.score || 0);
      const scoredScores = scores.filter((v) => v > 0);
      return {
        wine,
        index,
        raters,
        scored: raters.filter((r) => (r.rating.score || 0) > 0).sort((a, b) => b.rating.score - a.rating.score),
        avg: groupScoreAverage(scores),
        spread: scoredScores.length >= 2 ? Math.max(...scoredScores) - Math.min(...scoredScores) : null,
        consensus: consensusFromRatings(raters.map((r) => ({ score: r.rating.score || 0, flavors: r.rating.flavors })), 'wine', wine.type),
      };
    })
    .filter((it) => it.raters.length > 0);
  // Line-up order (Simon's ruling 2026-07-03, supersedes the score-ranked
  // list) — the default; the toolbar's sort menu reorders in CompareBody.
  return items;
}

// ── toolbar sort + search (Simon's 2026-07-03 spec) ─────────────────────────

export type CompareSort = 'lineup' | 'top' | 'bottom' | 'agree' | 'split' | 'most';
// 'lineup' is the DEFAULT state, not a menu row: tapping the active sort
// again toggles it off, back to line-up order (Simon's ruling; the line-up
// toolbar's sort menu behaves the same).
export const COMPARE_SORTS: { key: Exclude<CompareSort, 'lineup'>; label: string }[] = [
  { key: 'top', label: 'Highest rated' },
  { key: 'bottom', label: 'Lowest rated' },
  { key: 'agree', label: 'Most agreement' },
  { key: 'split', label: 'Least agreement' },
  { key: 'most', label: 'Most ratings' },
];
// Sentinels (not Infinity — Infinity−Infinity is NaN and breaks sort): items
// missing the sort signal (no score avg / <2 scores for a spread) go LAST in
// every mode, line-up order as the universal tiebreak.
const SORT_FNS: Record<CompareSort, (a: CmpItem, b: CmpItem) => number> = {
  lineup: (a, b) => a.index - b.index,
  top: (a, b) => (b.avg ?? -1) - (a.avg ?? -1) || a.index - b.index,
  bottom: (a, b) => (a.avg ?? 999) - (b.avg ?? 999) || a.index - b.index,
  agree: (a, b) => (a.spread ?? 999) - (b.spread ?? 999) || a.index - b.index,
  split: (a, b) => (b.spread ?? -1) - (a.spread ?? -1) || a.index - b.index,
  most: (a, b) => b.raters.length - a.raters.length || a.index - b.index,
};

// Search haystack — the impression's detail fields EXCEPT link, vinification
// and description (Simon's ruling 2026-07-03). Type matches on both the code
// and the written-out label ("non" finds Non-alcoholic). A blind stub matches
// only its displayed "Impression N" label — the server already redacts the
// real fields, so nothing leaks through search.
function searchHay(it: CmpItem): string {
  const w = it.wine;
  if (w._blind) return `Impression ${it.index + 1}`;
  return [w.name, w.producer, w.vintage, w.grape, w.type, wineTypeLabel(w.type), w.region, w.country]
    .filter(Boolean)
    .join(' ');
}

// ── toolbar (.cmp-toolbar) — ONE line: People button (opens the picker sheet,
// the selection surface) + sort button (unfolds the order menu) + impression
// search. Replaces the avatar-chip rail (Simon, 2026-07-03); renders in the
// same sticky slot the rail used. ────────────────────────────────────────────

export function CompareToolbar({
  people, hidden, onPick, sort, onSort, query, onQuery,
}: {
  people: ComparePerson[];
  hidden: Set<string>;
  onPick: () => void;
  sort: CompareSort;
  onSort: (s: CompareSort) => void;
  query: string;
  onQuery: (q: string) => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const { width: screenW } = useWindowDimensions();
  const sortBtn = useRef<View>(null);
  const [sortAnchor, setSortAnchor] = useState<MenuAnchor | null>(null);
  const [sortRight, setSortRight] = useState(16);
  const filtered = hidden.size > 0;
  const visibleCount = people.length - hidden.size;
  const sorted = sort !== 'lineup';
  const sortLabel = COMPARE_SORTS.find((o) => o.key === sort)?.label ?? 'Line-up order';
  // 36pt to line up with the search pill; 44pt targets via vertical slop.
  const chip = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 4,
    minHeight: 36,
    paddingHorizontal: 11,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.rule,
    backgroundColor: theme.surface,
  };
  const openSortMenu = () => {
    sortBtn.current?.measureInWindow((x, y, w, h) => {
      // AnchoredMenu is right-anchored; place the panel's right edge a panel-
      // width from the button's left so it reads as unfolding from the button.
      setSortRight(Math.max(12, screenW - x - 216));
      setSortAnchor({ top: y, bottom: y + h });
    });
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: GUTTER, paddingVertical: 8 }}>
      {/* People — hidden on a roster of one (nothing to select). */}
      {people.length > 1 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={filtered ? `Choose people — ${visibleCount} of ${people.length} selected` : 'Choose people'}
          onPress={onPick}
          hitSlop={{ top: 4, bottom: 4 }}
          style={({ pressed }) => ({ ...chip, opacity: pressed ? 0.6 : 1 })}
        >
          <Icon name="user" size={15} color={filtered ? theme.accent : theme.inkSoft} />
          {filtered ? (
            <VText surface="badge" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small') }}>
              {visibleCount}
            </VText>
          ) : null}
          <Icon name="chevrondown" size={13} color={theme.inkSoft} />
        </Pressable>
      ) : null}
      <Pressable
        ref={sortBtn}
        accessibilityRole="button"
        accessibilityLabel={`Sort impressions — ${sortLabel}`}
        onPress={openSortMenu}
        hitSlop={{ top: 4, bottom: 4 }}
        style={({ pressed }) => ({ ...chip, opacity: pressed ? 0.6 : 1 })}
      >
        <Icon name="sort" size={16} color={sorted ? theme.accent : theme.inkSoft} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <SheetSearchField value={query} onChangeText={onQuery} placeholder="Search impressions" />
      </View>
      <AnchoredMenu anchor={sortAnchor} onClose={() => setSortAnchor(null)} right={sortRight} minWidth={190}>
        {COMPARE_SORTS.map((o) => (
          <MenuItem
            key={o.key}
            label={o.label}
            active={sort === o.key}
            accessibilityState={{ selected: sort === o.key }}
            // Tap the active sort again → OFF (line-up order).
            onPress={() => { onSort(sort === o.key ? 'lineup' : o.key); setSortAnchor(null); }}
          />
        ))}
      </AnchoredMenu>
    </View>
  );
}

// ── picker sheet (.cmp-sheet + selpres/selrow/selchk) — presets + search +
// toggle rows over the same hidden set. Friends = mutual follows via
// GET /api/me/friends (block-scrubbed server-side), fetched lazily when the
// sheet opens; rows carry the mock's small "Friend" tag. ────────────────────

export function ComparePickerSheet({
  open, onClose, people, hidden, myIdentityId, onToggle, onAll, onJustMe, onMeAndFriends,
}: {
  open: boolean;
  onClose: () => void;
  people: ComparePerson[];
  hidden: Set<string>;
  myIdentityId: string;
  onToggle: (id: string) => void;
  onAll: () => void;
  onJustMe: () => void;
  /** Receives the friend identity-id set resolved by the sheet's lazy fetch. */
  onMeAndFriends: (friendIds: Set<string>) => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const insets = useSafeAreaInsets();
  const { height: windowH, fontScale } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [rowsH, setRowsH] = useState(0);
  const friendsQ = useQuery({
    queryKey: ['my-friends'],
    queryFn: getMyFriends,
    enabled: open && !!myIdentityId,
    staleTime: 60_000,
  });
  const friendIds = useMemo(
    () => new Set((friendsQ.data ?? []).map((f) => `u:${f.id}`)),
    [friendsQ.data],
  );
  const q = query.trim();
  const rows = people.filter((p) => !q || fuzzyIncludes(p.displayName, q));
  const visibleCount = people.length - hidden.size;
  const isAll = hidden.size === 0;
  const isMe = !isAll && visibleCount === 1 && !!myIdentityId && !hidden.has(myIdentityId);
  // "Me + friends" active ⟺ the visible set is exactly me + my friends who are
  // in this session (mock isFr semantics under hide-set representation).
  const isMeFriends =
    !isAll &&
    friendsQ.data !== undefined &&
    people.every((p) => {
      const wanted = p.id === myIdentityId || friendIds.has(p.id);
      return wanted === !hidden.has(p.id);
    });
  const preset = (label: string, on: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => ({
        height: 32, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1,
        borderColor: on ? theme.accentLine : theme.rule,
        backgroundColor: on ? theme.accentTint : theme.surface,
        alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1,
      })}
    >
      <VText variant="caption" color={on ? 'accent' : 'ink'} style={{ fontFamily: on ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium' }}>
        {label}
      </VText>
    </Pressable>
  );
  // Sizing: dynamic fit-to-content (PeopleSheet's pattern — Simon: "the
  // people view does it correctly") for lists that fit under the 85% cap.
  // Dynamic sizing cannot scroll (rows past the cap would clip unreachably),
  // so a roster the estimate says won't fit switches to the CountrySheet
  // recipe instead: fixed 85% snap, pinned head/controls, rows in a
  // BottomSheetScrollView (which needs the fixed snap — it measures 0 under
  // dynamic sizing). The estimate only picks the MODE; near the boundary the
  // two render identically.
  // Row padding + avatar GROW on big phones (phone.lerp/grow), so the estimate
  // feeds the SAME grown values in — a flat estimate would under-count and keep
  // a near-cap roster in dynamic-fit mode where its bottom rows clip (reviewer
  // catch).
  const rowH = Math.max(phone.grow(30), Math.ceil((phone.text('body').lineHeight ?? 22) * fontScale)) + phone.lerp(9, 12) * 2 + 1;
  const needsScroll = 214 + insets.bottom + people.length * rowH > windowH * 0.85;
  const headBlock = (
    <>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.rule }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Compare who?</VText>
            <VText variant="caption" color="inkSoft" style={{ marginTop: 2 }}>
              {isAll ? `Everyone · ${people.length} tasters` : `${visibleCount} of ${people.length} selected`}
            </VText>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            style={({ pressed }) => ({ height: 32, paddingHorizontal: 14, borderRadius: 999, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
          >
            <VText surface="badge" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small'), color: theme.accentInk }}>Done</VText>
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 12 }}>
          {preset('Everyone', isAll, onAll)}
          {myIdentityId ? preset('Just me', isMe, onJustMe) : null}
          {myIdentityId && friendsQ.data !== undefined ? preset('Me + friends', isMeFriends, () => onMeAndFriends(friendIds)) : null}
        </View>
        <View style={{ paddingVertical: 12 }}>
          <SheetSearchField value={query} onChangeText={setQuery} placeholder="Search tasters" />
        </View>
    </>
  );
  // The rows area locks to its UNFILTERED measured height while a search
  // filters it — the dynamically-sized sheet must not slide around with the
  // result count (Simon's ruling; moot in the fixed-snap scroll mode).
  const rowsBlock = (
        <View
          onLayout={(e) => { if (!q && !needsScroll) setRowsH(e.nativeEvent.layout.height); }}
          style={{ paddingBottom: 8, ...(q && !needsScroll && rowsH > 0 ? { minHeight: rowsH } : null) }}
        >
          {rows.map((p, i) => {
            const on = !hidden.has(p.id);
            return (
              <Pressable
                key={p.id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => onToggle(p.id)}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: phone.lerp(10, 13), paddingVertical: phone.lerp(9, 12),
                  borderTopWidth: i === 0 ? 0 : 1, borderTopColor: theme.ruleSoft,
                  backgroundColor: pressed ? theme.surfaceSunk : 'transparent',
                })}
              >
                <Avatar imageUrl={p.imageUrl} name={p.displayName} size={phone.grow(30)} anon={p.id.startsWith('a:')} />
                <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                  {/* Unregistered read QUIETLY, with the SAME tokens as the
                      People sheet's anon rows (regular weight + inkSoft; no
                      badge — the anon avatar glyph is the other cue). */}
                  <VText
                    numberOfLines={1}
                    color={p.id.startsWith('a:') ? 'inkSoft' : 'ink'}
                    style={{ flexShrink: 1, fontFamily: p.id.startsWith('a:') ? 'InstrumentSans_400Regular' : 'InstrumentSans_500Medium', ...phone.text('body') }}
                  >
                    {p.displayName}
                  </VText>
                  {/* .selrow-fr — the mock's quiet Friend tag */}
                  {friendIds.has(p.id) ? (
                    <VText variant="caption" color="inkFaint">Friend</VText>
                  ) : null}
                </View>
                {/* .selchk — check circle, accent-filled when in the comparison */}
                <View
                  style={{
                    width: 22, height: 22, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
                    borderWidth: on ? 0 : 1.5, borderColor: theme.rule,
                    backgroundColor: on ? theme.accent : 'transparent',
                  }}
                >
                  {on ? <Icon name="check" size={13} color={theme.accentInk} /> : null}
                </View>
              </Pressable>
            );
          })}
          {rows.length === 0 ? (
            <VText variant="small" color="inkFaint" style={{ paddingVertical: 16, fontStyle: 'italic' }}>
              No matches
            </VText>
          ) : null}
        </View>
  );
  return (
    <Sheet
      open={open}
      onClose={onClose}
      {...(needsScroll ? { snapPoints: ['85%'], enableDynamicSizing: false } : { maxDynamicContentSize: windowH * 0.85 })}
    >
      {needsScroll ? (
        <BottomSheetView style={{ flex: 1, paddingHorizontal: 18 }}>
          {headBlock}
          <BottomSheetScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 8 }}>
            {rowsBlock}
          </BottomSheetScrollView>
        </BottomSheetView>
      ) : (
        <BottomSheetView style={{ width: '100%', paddingHorizontal: 18, paddingBottom: insets.bottom + 8 }}>
          {headBlock}
          {rowsBlock}
        </BottomSheetView>
      )}
    </Sheet>
  );
}

// ── body: the accordion list over the selection ─────────────────────────────

export function CompareBody({
  wines,
  ratings,
  meta,
  locked,
  hidden,
  sort,
  query,
}: {
  wines: WireWine[] | null;
  ratings: RatingsView | null;
  meta: SessionMetaView | null;
  locked: boolean;
  hidden: Set<string>;
  sort: CompareSort;
  query: string;
}) {
  const items = useMemo(() => buildItems(wines, ratings, meta, hidden), [wines, ratings, meta, hidden]);
  const q = query.trim();
  const shown = useMemo(() => {
    const base = q ? items.filter((it) => fuzzyIncludes(searchHay(it), q)) : items;
    return [...base].sort(SORT_FNS[sort]);
  }, [items, q, sort]);
  if (wines === null || ratings === null) {
    // A /state section this tab needs failed server-side and has never
    // delivered — the 5s poll keeps retrying; say that, not "No ratings yet".
    return (
      <View style={{ paddingVertical: 72 }}>
        <CenteredMessage title="Can't load the comparison right now" body="Retrying automatically." />
      </View>
    );
  }
  if (locked) {
    return (
      <View style={{ paddingVertical: 72 }}>
        <CenteredMessage title="Nothing to compare yet" body="The line-up is revealed closer to the start." />
      </View>
    );
  }
  if (items.length === 0) {
    // Distinguish "nobody rated anything comparable" from "the selection
    // excludes every rater" — via the SAME comparable predicate buildItems
    // applies (a session holding only notes-only ratings is empty, not a
    // selection failure).
    const anyComparable = hidden.size > 0 && buildItems(wines, ratings, meta, EMPTY_HIDDEN).length > 0;
    return (
      <View style={{ paddingVertical: 72 }}>
        {anyComparable ? (
          <CenteredMessage title="Nobody selected" body="Pick people with the People button above to compare their ratings." />
        ) : (
          <CenteredMessage title="No ratings yet" body="Rate some impressions and they'll show up here to compare." />
        )}
      </View>
    );
  }
  if (shown.length === 0) {
    // items exist but the search query matched none of them.
    return (
      <View style={{ paddingVertical: 72 }}>
        <CenteredMessage title="No matches" body={`Nothing in the comparison matches “${query.trim()}”.`} />
      </View>
    );
  }
  return (
    <View style={{ paddingHorizontal: GUTTER, paddingTop: 8, gap: 10 }}>
      {shown.map((item) => (
        <CmpAccItem key={item.wine.id} item={item} />
      ))}
    </View>
  );
}

// ── accordion item (.cmp-acc) — owns its open/drill/person-detail/sheet state
// so cards are fully independent (multi-open). All data is selection-scoped. ─

function CmpAccItem({ item }: { item: CmpItem }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const { wine } = item;
  const [open, setOpen] = useState(false);
  const [selAxis, setSelAxis] = useState(-1);
  const [selPerson, setSelPerson] = useState<string | null>(null);
  // Radar mode only (2–4 profiles): per-card chart-layer toggle — tapping a
  // person row hides/shows their LINE on the overlay (Simon's ruling; the
  // rail stays the selection surface, this is purely visual).
  const [hiddenLines, setHiddenLines] = useState<Set<string>>(new Set());
  // Prune line-toggles for raters who left this card's set (rail deselect,
  // kick, poll churn) — a stale id would keep someone's line hidden after
  // they're re-selected (codex repro: hide → deselect → reselect).
  useEffect(() => {
    setHiddenLines((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(item.raters.map((r) => r.id));
      const pruned = new Set([...prev].filter((id) => ids.has(id)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [item]);
  const [sheetOpen, setSheetOpen] = useState(false);

  const agg = useMemo(
    () => aggregateFlavourAxes(item.raters.map((r) => r.rating.flavors), 'wine', wine.type),
    [item, wine.type],
  );

  // .cmp-chev transform dur-2 — native-driven rotate, no re-render per frame.
  const chev = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(chev, { toValue: open ? 1 : 0, duration: motion.dur2, easing: Easing.bezier(...motion.ease), useNativeDriver: true }).start();
  }, [open, chev]);

  const toggleOpen = () => {
    // .cmp-acc-body max-height dur-3 — LayoutAnimation unfolds the body
    // downward while the card top stays put (cards above are unaffected:
    // multi-open, nothing else collapses). iOS only: Android (deferred) is
    // unreliable with LayoutAnimation under Fabric.
    if (Platform.OS === 'ios') LayoutAnimation.configureNext(LayoutAnimation.create(motion.dur3, 'easeInEaseOut', 'opacity'));
    setOpen((v) => !v);
  };
  // Axis drill and person detail are mutually exclusive views of the panel.
  const selectAxis = (i: number) => {
    setSelPerson(null);
    setSelAxis((prev) => (prev === i ? -1 : i));
  };
  const selectPerson = (id: string) => {
    setSelAxis(-1);
    setSelPerson((prev) => (prev === id ? null : id));
  };
  const toggleLine = (id: string) =>
    setHiddenLines((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  // In radar mode rows toggle LINES, so person detail is unreachable there —
  // clear a stale detail carried over from another mode.
  const radarMode = agg.n > 1 && agg.n <= 4;
  useEffect(() => {
    if (radarMode && selPerson) setSelPerson(null);
  }, [radarMode, selPerson]);

  const maker = wine.producer || ''; // producer only — no type/variety here (Simon's ruling)
  // Blind stubs: same mask vocabulary as the line-up ("Impression N", the
  // Moment/Impression copy ruling) — the server stub says "Wine N".
  const displayName = wine._blind ? `Impression ${item.index + 1}` : wine.name;
  const consensusTone: Record<ConsensusKey, string> = {
    harmony: theme.positive,
    mostly: theme.inkSoft,
    mixed: theme.caution,
    divide: theme.critical,
  };
  // A selected person may leave the selection (rail) or the ratings — clear
  // the detail (not just fall back) so re-selecting them on the rail later
  // doesn't snap the card back into their detail unprompted.
  const detail = selPerson ? item.raters.find((r) => r.id === selPerson) : undefined;
  useEffect(() => {
    if (selPerson && !item.raters.some((r) => r.id === selPerson)) setSelPerson(null);
  }, [item, selPerson]);
  const drillAxis = !detail && selAxis >= 0 && agg.n > 0 ? agg.axes[selAxis] : undefined;

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: open ? theme.accentLine : theme.rule,
        borderRadius: radius.md,
        backgroundColor: theme.surface,
        overflow: 'hidden',
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${displayName}${item.avg !== null ? `, group average ${item.avg}` : ''}`}
        onPress={toggleOpen}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: phone.lerp(12, 16), padding: phone.lerp(12, 16),
          backgroundColor: pressed ? theme.surfaceSunk : 'transparent',
        })}
      >
        <Thumb uri={wine._blind ? undefined : wine.imageUrl || wine.image || undefined} size={phone.grow(48)} radius={radius.sm} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <VText surface="compactList" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}>
            {displayName}
            {wine.vintage ? (
              <>
                {' - '}
                <VText surface="compactList" color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular', ...phone.text('body') }}>{wine.vintage}</VText>
              </>
            ) : null}
          </VText>
          {maker ? (
            <VText surface="compactList" color="inkSoft" numberOfLines={1} style={phone.text('small')}>{maker}</VText>
          ) : null}
          {/* Consensus teaser — a GROUP signal only: fewer than two rated
              scores (consensusFromRatings → null) shows no line at all
              (Simon's ruling: no score-word substitute for a single rater). */}
          {item.consensus ? (
            <VText surface="compactList" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small'), marginTop: 2, color: consensusTone[item.consensus] }}>
              {CONSENSUS_COPY[item.consensus]}
            </VText>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {item.avg !== null ? <StarScore value={item.avg} size={15} /> : null}
          <Animated.View style={{ transform: [{ rotate: chev.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] }}>
            <Icon name="chevrondown" size={18} color={theme.inkSoft} />
          </Animated.View>
        </View>
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 14 }}>
          <CmpChart
            item={item}
            agg={agg}
            detail={detail}
            hiddenLines={hiddenLines}
            selAxis={detail ? -1 : selAxis}
            onSelectAxis={selectAxis}
          />
          <View style={{ marginTop: 4, borderTopWidth: 1, borderTopColor: theme.rule, paddingTop: 12, paddingBottom: 16 }}>
            {drillAxis ? (
              <AxisSplit
                item={item}
                axis={drillAxis}
                radarMode={radarMode}
                hiddenLines={hiddenLines}
                onToggleLine={toggleLine}
                selPerson={selPerson}
                onSelectPerson={selectPerson}
                onShowAll={() => setSheetOpen(true)}
              />
            ) : (
              <ScoreRows
                item={item}
                mode={radarMode ? 'radar' : 'plain'}
                structureFirst={agg.n >= 1 && agg.n <= 4}
                hiddenLines={hiddenLines}
                onToggleLine={toggleLine}
                selPerson={selPerson}
                onSelectPerson={selectPerson}
                onShowAll={() => setSheetOpen(true)}
              />
            )}
          </View>
        </View>
      ) : null}
      {sheetOpen ? (
        <ShowAllSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          item={item}
          axis={drillAxis ?? null}
          structureFirst={agg.n >= 1 && agg.n <= 4}
        />
      ) : null}
    </View>
  );
}

type VisibleAgg = ReturnType<typeof aggregateFlavourAxes>;

// Size-adaptive chart block + its .cmp-wheelhead label, over the selection.
// A tapped person row swaps in THAT person's detail (their wheel + score);
// otherwise: 1 → wheel, ≤4 → radar, 5+ → C1b. Axis drill-in triggers: C1b
// wedge OR axis label; radar axis label.
function CmpChart({
  item, agg, detail, hiddenLines, selAxis, onSelectAxis,
}: {
  item: CmpItem;
  agg: VisibleAgg;
  detail: Rater | undefined;
  /** Radar-mode chart-layer toggle — hidden lines stay in rows/aggregates. */
  hiddenLines: Set<string>;
  selAxis: number;
  onSelectAxis: (i: number) => void;
}) {
  const phone = usePhoneTokens();
  const flavourColor = useFlavourColors();
  const personColor = usePersonColors();
  const axes = resolveAxes('wine', item.wine.type);
  // Measured host width → uniform chart scale-down (the design's .radar
  // max-width:100%): the natural canvas (232 + 2×58 label pad = 348) is wider
  // than the card's content column on small phones, and the card clips.
  const [hostW, setHostW] = useState(0);
  const maxWidth = hostW > 0 ? hostW : undefined;

  const flavourRaters = item.raters.filter((r) => Object.keys(r.filled).length > 0);

  let head: string;
  let chart: React.ReactNode;
  let hint: string | null = null;
  // Size-adaptive mode keys on the STRUCTURE-ENGAGED tasters (ruled via
  // review feedback): one structure profile among score-only raters draws
  // that person's wheel, never a one-series radar or a degenerate C1b.
  const person = detail ?? (flavourRaters.length === 1 ? flavourRaters[0] : undefined);
  if (person) {
    // Person detail (row tap) or a single selected rater — same surface. A
    // person WITHOUT structure detail still draws the (empty) wheel when
    // others in the selection have it, so switching people doesn't make the
    // card height jump; their score already shows on their list row.
    head = `${person.displayName} · flavour profile`;
    chart = Object.keys(person.filled).length > 0 || flavourRaters.length > 0 ? (
      <FlavourWheel
        axes={axes.map((a) => ({ label: a.l, color: flavourColor(a.k), value: person.filled[a.k] ?? 0 }))}
        size={232}
        maxWidth={maxWidth}
      />
    ) : (
      <VText variant="caption" color="inkFaint" style={{ textAlign: 'center', paddingVertical: 14, fontStyle: 'italic' }}>
        No structure detail from {person.displayName} yet.
      </VText>
    );
    // Make the one-profile case unmistakable (Simon's ask): when the single
    // wheel is automatic — only one person gave structure detail — say so.
    // A deliberate row tap (detail) needs no disclaimer.
    if (!detail) hint = `Structure detail from ${person.displayName} only.`;
  } else if (flavourRaters.length === 0) {
    return (
      <VText variant="caption" color="inkFaint" style={{ textAlign: 'center', paddingVertical: 14, fontStyle: 'italic' }}>
        No structure detail yet.
      </VText>
    );
  } else if (flavourRaters.length <= 4) {
    head = 'Group flavour';
    hint = 'Tap a flavour name to see the split.';
    chart = (
      <RadarOverlay
        axes={axes.map((a) => a.l)}
        series={flavourRaters
          .filter((r) => !hiddenLines.has(r.id))
          .map((r) => ({
          id: r.id,
            color: personColor(r.personIndex),
            values: axes.map((a) => r.filled[a.k] ?? 0),
          }))}
        size={232}
        maxWidth={maxWidth}
        selected={selAxis}
        onSelectLabel={onSelectAxis}
      />
    );
  } else {
    head = 'Group intensity · range + average';
    hint = 'Tap a wedge to see the split.';
    chart = (
      <ComparisonWheel
        axes={agg.axes.map((a) => ({ label: a.l, color: flavourColor(a.k), min: a.min, max: a.max, avg: a.avg }))}
        size={232}
        selected={selAxis}
        maxWidth={maxWidth}
        onSelect={onSelectAxis}
      />
    );
  }
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 6 }}>
        <VText variant="label" color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', ...phone.text('label') }}>
          {head}
        </VText>
      </View>
      <View onLayout={(e) => setHostW(e.nativeEvent.layout.width)} style={{ alignItems: 'center', marginVertical: -6 }}>{chart}</View>
      {hint ? (
        <VText variant="caption" color="inkSoft" style={{ textAlign: 'center', marginTop: 8, fontStyle: 'italic' }}>
          {hint}
        </VText>
      ) : null}
    </>
  );
}

function PersonDot({ color }: { color: string | null }) {
  const { theme } = useTheme();
  return color ? (
    <View style={{ width: 10, height: 10, borderRadius: 999, backgroundColor: color }} />
  ) : (
    <View style={{ width: 10, height: 10, borderRadius: 999, borderWidth: 1.5, borderColor: theme.rule }} />
  );
}

// One person row (.cmp-prow). `lead` (the person colour dot) sits BEFORE the
// name per the mock. Rows are NOT hide toggles (the rail owns selection):
// tapping shows that person's rating detail on this impression; the active
// row's name reads accent.
function PersonRow({
  first, active, off, accessibilityLabel, onPress, name, lead, children,
}: {
  first: boolean;
  active?: boolean;
  /** Radar line hidden — row dims to 0.42 (.cmp-prow-toggle is-off). */
  off?: boolean;
  accessibilityLabel?: string;
  onPress?: () => void;
  name: string;
  lead?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const inner = (
    <>
      {lead}
      <VText
        numberOfLines={1}
        color={active ? 'accent' : 'ink'}
        style={{ flex: 1, fontFamily: active ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium', ...phone.text('body') }}
      >
        {name}
      </VText>
      {children}
    </>
  );
  if (!onPress) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: phone.lerp(10, 13), paddingVertical: phone.lerp(8, 11), borderTopWidth: first ? 0 : 1, borderTopColor: theme.ruleSoft }}>
        {inner}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: off !== undefined ? !off : !!active }}
      accessibilityLabel={accessibilityLabel ?? (active ? `Hide ${name}'s rating detail` : `Show ${name}'s rating detail`)}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: phone.lerp(10, 13), paddingVertical: phone.lerp(8, 11),
        marginHorizontal: -6, paddingHorizontal: 6, borderRadius: radius.sm,
        borderTopWidth: first ? 0 : 1, borderTopColor: theme.ruleSoft,
        backgroundColor: pressed ? theme.surfaceSunk : 'transparent',
        opacity: off ? 0.42 : 1,
      })}
    >
      {inner}
    </Pressable>
  );
}

function ShowAllButton({ total, onPress }: { total: number; onPress: () => void }) {
  const phone = usePhoneTokens();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ paddingVertical: 4, marginTop: 8, alignSelf: 'flex-start', opacity: pressed ? 0.6 : 1 })}>
      <VText color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small') }}>
        Show all {total}
      </VText>
    </Pressable>
  );
}

// Resting rows: every SELECTED rater with a rated score, high→low. Tap a row
// for that person's rating detail; in the ≤4 radar view a person dot (before
// the name) ties the row to their polygon (empty dot = no flavour profile).
const hasStructure = (r: Rater) => Object.keys(r.filled).length > 0;

// Score-list rows, shared by the resting panel AND the Show-all sheet (they
// must list the same people). With 1–4 structure profiles (Simon's ruling)
// the structure-givers sort to the top — their rows pair with the chart (dot
// colours ↔ polygons) — and a structure-only score-0 rater gets a row too
// (else their polygon would have no legend; rendered with an em-dash score).
function scoreRowsFor(item: CmpItem, structureFirst: boolean): Rater[] {
  if (!structureFirst) return item.scored;
  const unscoredStructure = item.raters.filter((r) => hasStructure(r) && (r.rating.score || 0) === 0);
  // Stable sort: structure-givers first (score-desc within), then the rest.
  return [...item.scored, ...unscoredStructure].sort((a, b) => (hasStructure(b) ? 1 : 0) - (hasStructure(a) ? 1 : 0));
}

function ScoreRows({
  item, mode, structureFirst, hiddenLines, onToggleLine, selPerson, onSelectPerson, onShowAll,
}: {
  item: CmpItem;
  mode: 'radar' | 'plain';
  structureFirst: boolean;
  hiddenLines: Set<string>;
  onToggleLine: (id: string) => void;
  selPerson: string | null;
  onSelectPerson: (id: string) => void;
  onShowAll: () => void;
}) {
  const personColor = usePersonColors();
  const rows = scoreRowsFor(item, structureFirst);
  const shown = rows.length > CAP ? rows.slice(0, CAP) : rows;
  if (rows.length === 0) {
    return (
      <VText variant="caption" color="inkFaint" style={{ fontStyle: 'italic' }}>
        No scores yet.
      </VText>
    );
  }
  return (
    <View>
      {shown.map((r, i) => {
        // Radar mode (Simon's ruling): a structure-giver's row toggles their
        // LINE on the overlay; rows without a line (score-only) do nothing.
        // Other modes: row tap opens that person's rating detail.
        const lineRow = mode === 'radar' && hasStructure(r);
        return (
        <PersonRow
          key={r.id}
          first={i === 0}
          name={r.displayName}
          active={mode !== 'radar' && selPerson === r.id}
          off={lineRow ? hiddenLines.has(r.id) : undefined}
          accessibilityLabel={lineRow ? `${hiddenLines.has(r.id) ? 'Show' : 'Hide'} ${r.displayName}'s line on the chart` : undefined}
          onPress={mode === 'radar' ? (lineRow ? () => onToggleLine(r.id) : undefined) : () => onSelectPerson(r.id)}
          lead={mode === 'radar' ? <PersonDot color={hasStructure(r) ? personColor(r.personIndex) : null} /> : undefined}
        >
          {/* .osv-num min-width 46 (+ star 17 + gap 4) so the score column aligns */}
          <View style={{ minWidth: 67 }}>
            {(r.rating.score || 0) > 0 ? (
              <StarScore value={r.rating.score} size={17} />
            ) : (
              <VText variant="small" color="inkFaint">—</VText>
            )}
          </View>
        </PersonRow>
        );
      })}
      {rows.length > CAP ? <ShowAllButton total={rows.length} onPress={onShowAll} /> : null}
    </View>
  );
}

type AxisAgg = VisibleAgg['axes'][number];

// .cmp-pflav — the selected axis's split: range bar (min→max fill + avg tick
// on a linear 0–5 track) and each selected flavour-engaged taster's intensity.
// Rows switch to that person's detail view on tap (same as resting rows).
function AxisSplit({
  item, axis, radarMode, hiddenLines, onToggleLine, selPerson, onSelectPerson, onShowAll,
}: {
  item: CmpItem;
  axis: AxisAgg;
  radarMode: boolean;
  hiddenLines: Set<string>;
  onToggleLine: (id: string) => void;
  selPerson: string | null;
  onSelectPerson: (id: string) => void;
  onShowAll: () => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const flavourColor = useFlavourColors();
  const color = flavourColor(axis.k);
  const spread = axis.max - axis.min;
  const agree = spread <= 1 ? 'tight agreement' : spread >= 3 ? 'wide spread' : 'some spread';
  const rows = item.raters.filter((r) => Object.keys(r.filled).length > 0);
  const shown = rows.length > CAP ? rows.slice(0, CAP) : rows;
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 12, height: 12, borderRadius: 999, backgroundColor: color }} />
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}>{axis.l}</VText>
        </View>
        <VText color="inkSoft" style={phone.text('small')}>
          avg <VText color="ink" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small') }}>{axis.avg.toFixed(1)}</VText>
        </VText>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 8 }}>
        <VText variant="caption" color="inkSoft" numberOfLines={1}>
          {intensityWord(axis.min)}→{intensityWord(axis.max)}
        </VText>
        <View style={{ flex: 1, height: 6, borderRadius: 999, backgroundColor: theme.surfaceSunk }}>
          <View
            style={{
              position: 'absolute', top: 0, bottom: 0, borderRadius: 999,
              left: `${(axis.min / 5) * 100}%`, right: `${(1 - axis.max / 5) * 100}%`,
              backgroundColor: color, opacity: 0.42,
            }}
          />
          <View
            style={{
              position: 'absolute', top: -3, bottom: -3, width: 3, borderRadius: 999,
              left: `${(axis.avg / 5) * 100}%`, marginLeft: -1.5, backgroundColor: color,
            }}
          />
        </View>
        <VText variant="caption" color="inkSoft" numberOfLines={1}>{agree}</VText>
      </View>
      {shown.map((r, i) => (
        <PersonRow
          key={r.id}
          first={i === 0}
          name={r.displayName}
          active={!radarMode && selPerson === r.id}
          off={radarMode ? hiddenLines.has(r.id) : undefined}
          accessibilityLabel={radarMode ? `${hiddenLines.has(r.id) ? 'Show' : 'Hide'} ${r.displayName}'s line on the chart` : undefined}
          onPress={radarMode ? () => onToggleLine(r.id) : () => onSelectPerson(r.id)}
        >
          <VText color="inkSoft" style={phone.text('small')}>{intensityWord(r.filled[axis.k] ?? 0)}</VText>
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body'), minWidth: 16, textAlign: 'right' }}>
            {r.filled[axis.k] ?? 0}
          </VText>
        </PersonRow>
      ))}
      {rows.length > CAP ? <ShowAllButton total={rows.length} onPress={onShowAll} /> : null}
    </View>
  );
}

// .cmp-sheet-search — 36px borderless pill on surface-sunk with a leading
// search glyph. TextField is kept for its formControl Dynamic Type surface;
// the pill spec overrides its box styles.
export function SheetSearchField({ value, onChangeText, placeholder, highlight }: { value: string; onChangeText: (t: string) => void; placeholder: string; highlight?: boolean }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  // Clearing is part of typing — the ✕ must not bounce the keyboard.
  const clearRef = useRef<View | null>(null);
  useRegisterInput(clearRef, value !== '');
  // ONE skin everywhere (Simon's standard, 2026-07-03): surface + rule
  // border, matching the chip controls — never the sunken fill. Restyle the
  // InviteSheet pseudo-field too if this ever changes. Height rides the
  // formControl surface — 36 at default scale, growing with the text.
  // ⚠️ Known accepted a11y nit (Simon's call, PR #65 review round 3): the
  // clear ✕ target is therefore ~36pt at default scale, under the 44pt
  // guideline — RN clips a child's hitSlop to the parent frame, so the ONLY
  // way to reach 44 was to floor the whole field at 44, which makes the pill
  // taller than the sibling 36pt chips everywhere. Not worth the visual cost
  // for a small, non-destructive button (the wide field-focus target is fine;
  // a ✕ mistap just doesn't clear). Large Dynamic Type grows it past 44 anyway.
  const fieldH = phone.surface('formControl').height(36);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: fieldH, paddingHorizontal: 12, borderRadius: 999, backgroundColor: theme.surface, borderWidth: highlight ? 1.5 : 1, borderColor: highlight ? theme.accent : theme.rule }}>
      <Icon name="search" size={16} color={theme.inkSoft} />
      <View style={{ flex: 1 }}>
        <TextField
          placeholder={placeholder}
          // Placeholder stops being the accessible name once text is entered.
          accessibilityLabel={placeholder}
          value={value}
          onChangeText={onChangeText}
          autoCorrect={false}
          autoCapitalize="none"
          // fontSize override ⇒ lineHeight must match it (TextField's base
          // compact lineHeight is body-sized; a mismatched line box re-biases
          // the glyph — see TextField's header).
          style={{ height: fieldH, borderWidth: 0, backgroundColor: 'transparent', paddingHorizontal: 0, borderRadius: 0, fontSize: phone.text('small').fontSize, lineHeight: Math.round(phone.text('small').fontSize * 1.2) }}
        />
      </View>
      {value !== '' ? (
        <Pressable
          ref={clearRef}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChangeText('')}
          // Fills the field's full height for the tallest reachable target the
          // parent allows (RN clips slop to the parent frame — see fieldH);
          // width 40 + horizontal slop widens it. Icon 14pt; -6 snug to edge.
          hitSlop={{ left: 8, right: 8 }}
          style={{ width: 40, height: fieldH, alignItems: 'center', justifyContent: 'center', marginRight: -6 }}
        >
          <Icon name="x" size={14} color={theme.inkFaint} />
        </Pressable>
      ) : null}
    </View>
  );
}

// ── "Show all N" full-list sheet (.cmp-sheet — the List-overflow pattern) ────
// Search + high/low sort over the open impression's SELECTED rows: scores, or
// the drilled axis's intensities. Read-only rows — selection lives on the
// rail. (The mock's Friends filter chip is omitted here; friends live in the
// picker sheet's preset.)
function ShowAllSheet({
  open, onClose, item, axis, structureFirst,
}: {
  open: boolean;
  onClose: () => void;
  item: CmpItem;
  axis: AxisAgg | null;
  structureFirst: boolean;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const insets = useSafeAreaInsets();
  const { height: windowH, fontScale } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [rowsH, setRowsH] = useState(0);
  const [dir, setDir] = useState<'high' | 'low'>('high');
  const sign = dir === 'high' ? -1 : 1;
  const q = query.trim();
  // Score mode lists EXACTLY what the resting panel counts (scoreRowsFor —
  // incl. structure-only score-0 raters), else "Show all N" would open a
  // sheet missing people.
  const base = axis ? item.raters.filter(hasStructure) : scoreRowsFor(item, structureFirst);
  const rows = base
    .filter((r) => !q || fuzzyIncludes(r.displayName, q))
    .sort((a, b) => sign * (axis ? (a.filled[axis.k] ?? 0) - (b.filled[axis.k] ?? 0) : (a.rating.score || 0) - (b.rating.score || 0)));
  const total = base.length;
  // Same cap-aware sizing as the picker: dynamic fit-to-content while the
  // unfiltered list fits under 85%; else the CountrySheet recipe (fixed snap,
  // pinned head/controls, scrollable rows).
  const rowH = Math.max(17, Math.ceil((phone.text('body').lineHeight ?? 22) * fontScale)) + 17;
  const needsScroll = 178 + insets.bottom + total * rowH > windowH * 0.85;
  const headBlock = (
    <>
        <View style={{ paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.rule }}>
          <VText variant="subhead" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
            {item.wine._blind ? `Impression ${item.index + 1}` : item.wine.name}
            {item.wine.vintage ? (
              <VText variant="subhead" color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular' }}>{` - ${item.wine.vintage}`}</VText>
            ) : null}
          </VText>
          <VText variant="caption" color="inkSoft" style={{ marginTop: 2 }}>
            {axis ? axis.l : 'Scores'} · {total} {total === 1 ? 'person' : 'people'}
          </VText>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 }}>
          <View style={{ flex: 1 }}>
            <SheetSearchField value={query} onChangeText={setQuery} placeholder="Search people" />
          </View>
          <Pressable
            accessibilityRole="button"
            // Announce the ACTION the tap performs, not the current state —
            // high-first is active, so the button offers "lowest first".
            accessibilityLabel={`Sort ${dir === 'high' ? 'lowest' : 'highest'} first`}
            hitSlop={4}
            onPress={() => setDir((d) => (d === 'high' ? 'low' : 'high'))}
            style={({ pressed }) => ({
              width: 36, height: 36, borderRadius: 999, borderWidth: 1,
              borderColor: dir === 'low' ? theme.accentLine : theme.rule,
              backgroundColor: theme.bg,
              alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1,
            })}
          >
            <Icon name="sort" size={18} color={dir === 'low' ? theme.accent : theme.inkSoft} />
          </Pressable>
        </View>
    </>
  );
  // Same unfiltered-height lock as the picker — stable sheet while searching
  // (moot in the fixed-snap scroll mode).
  const rowsBlock = (
        <View
          onLayout={(e) => { if (!q && !needsScroll) setRowsH(e.nativeEvent.layout.height); }}
          style={{ paddingBottom: 8, ...(q && !needsScroll && rowsH > 0 ? { minHeight: rowsH } : null) }}
        >
          {rows.map((r, i) => (
            <PersonRow key={r.id} first={i === 0} name={r.displayName}>
              {axis ? (
                <>
                  <VText color="inkSoft" style={phone.text('small')}>{intensityWord(r.filled[axis.k] ?? 0)}</VText>
                  <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body'), minWidth: 16, textAlign: 'right' }}>
                    {r.filled[axis.k] ?? 0}
                  </VText>
                </>
              ) : (
                <View style={{ minWidth: 67 }}>
                  {(r.rating.score || 0) > 0 ? (
                    <StarScore value={r.rating.score} size={17} />
                  ) : (
                    <VText variant="small" color="inkFaint">—</VText>
                  )}
                </View>
              )}
            </PersonRow>
          ))}
          {rows.length === 0 ? (
            <VText variant="small" color="inkFaint" style={{ paddingVertical: 16, fontStyle: 'italic' }}>
              No matches
            </VText>
          ) : null}
        </View>
  );
  return (
    <Sheet
      open={open}
      onClose={onClose}
      {...(needsScroll ? { snapPoints: ['85%'], enableDynamicSizing: false } : { maxDynamicContentSize: windowH * 0.85 })}
    >
      {needsScroll ? (
        <BottomSheetView style={{ flex: 1, paddingHorizontal: 18 }}>
          {headBlock}
          <BottomSheetScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 8 }}>
            {rowsBlock}
          </BottomSheetScrollView>
        </BottomSheetView>
      ) : (
        <BottomSheetView style={{ width: '100%', paddingHorizontal: 18, paddingBottom: insets.bottom + 8 }}>
          {headBlock}
          {rowsBlock}
        </BottomSheetView>
      )}
    </Sheet>
  );
}
