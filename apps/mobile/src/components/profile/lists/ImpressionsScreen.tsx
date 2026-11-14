import { BottomSheetView } from '@gorhom/bottom-sheet';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FilterChip, FilterDates, FilterFooter, FilterLabel, FilterTitle, categoryLabel, dateChipLabel, dayEndISO, dayStartISO, type ActiveFilter } from '@/components/moments/MomentFilters';
import { ToggleCard } from '@/components/moments/settingsParts';
import { ScoreRange, ScoreRangeValue, RANGE_MAX, RANGE_MIN, isAnyRange, rangeLabel } from '@/components/scoring/ScoreRange';
import { AnchoredMenu, MenuItem } from '@/components/ui/AnchoredMenu';
import { CenteredMessage, ErrorState } from '@/components/ui/ConnectionState';
import { Sheet } from '@/components/ui/Sheet';
import { ListGoneError, getImpressionsPage, profileListKey, type ImpressionParams, type ImpressionRow, type ImpressionSort } from '@/lib/api/lists';
import { profileQueryOptions } from '@/lib/api/users';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';
import { useMeId } from '@/lib/meId';
import { wineTypeLabel } from '@/lib/momentFormat';
import { useTheme } from '@/theme';
import { ListNote, ListRow, MonthHeader, ScoreColumn, ToolRow, groupByMonth, type RowHandle } from './ListParts';
import { ToolButton, type ToolAnchor } from '@/components/ui/ToolButton';
import { useListRefresh } from './useListRefresh';
import { useOpenListPost } from './useOpenListPost';

// Someone's (or your) Impressions (lists plan D3 / D8 / D9, design 04·6a /
// herImps): every rating, through their post visibility, newest post first,
// grouped by month. Bar: "Impressions" + (yours, not on an opened post's
// stack) "+ Check In" (the Feed's flow, on this stack). Tool row: filter +
// sort + search. Sorts (ruled 2026-11-14): Newest First (default) / Oldest
// First / Highest Rated / Lowest Rated (unrated last); the month headings show
// for the date sorts only (a score order jumps between months). Someone
// else's: "Only Ones We Both Had" (their rows you rated too, your score under
// theirs; a blind row never counts). A row opens its post like a post on the
// feed (useOpenListPost). The passport card and the structure / aroma
// filters are later (Palate / Passport don't exist).

type ImpFilters = { from: Date | null; to: Date | null; category: string; lo: number; hi: number };
const NO_IMP_FILTERS: ImpFilters = { from: null, to: null, category: 'any', lo: RANGE_MIN, hi: RANGE_MAX };
const SORTS: [ImpressionSort, string][] = [['newest', 'Newest First'], ['oldest', 'Oldest First'], ['highest', 'Highest Rated'], ['lowest', 'Lowest Rated']];
const filterCount = (f: ImpFilters) => (f.from || f.to ? 1 : 0) + (f.category !== 'any' ? 1 : 0) + (isAnyRange(f.lo, f.hi) ? 0 : 1);

export function ImpressionsPane({ userId, active: shown }: { userId: string; active: boolean }) {
  const { theme } = useTheme();
  const { width: windowW } = useWindowDimensions();
  const meId = useMeId();
  const own = meId === userId;
  const headerQ = useQuery(profileQueryOptions(userId));
  const [sort, setSort] = useState<ImpressionSort>('newest');
  const [menuAt, setMenuAt] = useState<ToolAnchor | null>(null);

  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const [filters, setFilters] = useState<ImpFilters>(NO_IMP_FILTERS);
  // A DRAG of the score range reaches the query debounced like the search (it
  // moves a quarter step at a time, and every step would be a request on the
  // lists' shared rate budget); every other change, Reset included, applies
  // at once, range and all, so no request pairs a stale range with fresh dates.
  const [range, setRange] = useState({ lo: filters.lo, hi: filters.hi });
  const rangeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(rangeTimer.current), []);
  const applyFilters = useCallback((f: ImpFilters) => {
    clearTimeout(rangeTimer.current);
    setFilters(f);
    setRange({ lo: f.lo, hi: f.hi });
  }, []);
  const dragRange = useCallback((lo: number, hi: number) => {
    setFilters((f) => ({ ...f, lo, hi }));
    clearTimeout(rangeTimer.current);
    rangeTimer.current = setTimeout(() => setRange({ lo, hi }), 250);
  }, []);
  const [filterOpen, setFilterOpen] = useState(false);
  const [common, setCommon] = useState(false);
  const both = common && !own;

  const params: ImpressionParams = useMemo(() => ({
    q: search || undefined,
    from: dayStartISO(filters.from),
    to: dayEndISO(filters.to),
    category: filters.category,
    min: isAnyRange(range.lo, range.hi) ? null : range.lo,
    max: isAnyRange(range.lo, range.hi) ? null : range.hi,
    common: both,
    sort,
  }), [search, filters.from, filters.to, filters.category, range, both, sort]);
  const listQ = useInfiniteQuery({
    queryKey: profileListKey('impressions', userId, params),
    queryFn: ({ pageParam }) => getImpressionsPage(userId, params, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    retry: (n, e) => !(e instanceof ListGoneError) && n < 1,
    // `own` is only known once the viewer is (yours read another endpoint).
    enabled: meId != null,
  });
  const rows = useMemo(() => {
    const seen = new Set<number>();
    return (listQ.data?.pages ?? []).flatMap((p) => p.items).filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }, [listQ.data]);
  // Headings follow the sort of the rows ON SCREEN: while a new sort loads,
  // keepPreviousData still shows the last settled sort's rows.
  const [settledSort, setSettledSort] = useState(sort);
  useEffect(() => {
    if (listQ.data && !listQ.isPlaceholderData) setSettledSort(sort);
  }, [listQ.data, listQ.isPlaceholderData, sort]);
  const shownSort = listQ.isPlaceholderData ? settledSort : sort;
  const byDate = shownSort === 'newest' || shownSort === 'oldest';
  const grouped = useMemo(
    () => (byDate ? groupByMonth(rows, (r) => r.hadAt, (r) => String(r.id)) : rows.map((row) => ({ kind: 'row' as const, key: String(row.id), row }))),
    [rows, byDate],
  );

  // "N in common", from the first unfiltered page (kept while a filter runs).
  const [commonCount, setCommonCount] = useState<number | null>(null);
  const firstCommon = listQ.data?.pages[0]?.commonCount;
  useEffect(() => {
    if (firstCommon !== undefined) setCommonCount(firstCommon);
  }, [firstCommon]);

  const { pulling, onPullRefresh, refetchInPlace } = useListRefresh(listQ.refetch, headerQ.refetch);
  const openPost = useOpenListPost(userId, refetchInPlace, shown);
  const active = filterCount(filters);
  const narrowed = search !== '' || active > 0 || both;

  let body: React.ReactNode;
  if (listQ.error instanceof ListGoneError) {
    body = <CenteredMessage title="These impressions aren’t available" />;
  } else if (listQ.isPending) {
    body = <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={theme.inkSoft} /></View>;
  } else if (listQ.isError && rows.length === 0) {
    body = <ErrorState onRetry={() => listQ.refetch()} retrying={listQ.isFetching} />;
  } else {
    body = (
      <FlatList
        data={grouped}
        keyExtractor={(g) => g.key}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: TAB_BAR_CLEARANCE }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPullRefresh} tintColor={theme.inkSoft} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (listQ.hasNextPage && !listQ.isFetchingNextPage && !listQ.isPlaceholderData) void listQ.fetchNextPage();
        }}
        ListEmptyComponent={<ListNote>{narrowed ? 'Nothing matches.' : 'No impressions yet.'}</ListNote>}
        ListFooterComponent={listQ.isFetchingNextPage ? <View style={{ paddingVertical: 16, alignItems: 'center' }}><ActivityIndicator color={theme.inkSoft} /></View> : undefined}
        renderItem={({ item: g }) => g.kind === 'month'
          ? <MonthHeader label={g.label} first={g.first} />
          : <ImpressionListRow row={g.row} showYours={!own} onPress={g.row.postId != null ? (handle) => void openPost(g.row.postId, g.row.wineId, handle) : undefined} />}
      />
    );
  }

  return (
      <View style={{ flex: 1, display: shown ? 'flex' : 'none' }}>
        <View style={{ paddingHorizontal: GUTTER }}>
          <ToolRow query={query} onQuery={setQuery} placeholder="Search impressions">
            <ToolButton icon="funnel" label={active > 0 ? `Filter, ${active} active` : 'Filter'} active={active > 0} count={active} onPress={() => setFilterOpen(true)} />
            <ToolButton icon="sort" label={`Sort, ${SORTS.find(([k]) => k === sort)![1]}`} onPress={setMenuAt} />
          </ToolRow>
          {/* "Show 23 tastes you share" (ruled 2026-11-13: warm, something you
              share with the person, no "only", no helper line; SENTENCE case,
              it reads as a sentence, not a title). Shown once the first page
              brings a count above 0 (never while loading, after a failure,
              with their posts hidden or the list gone), or while it is on (it
              must stay reachable to turn it off). The number is the
              UNFILTERED count, so it is left out while a search or filter
              narrows the list too. */}
          {meId != null && !own && (common || (commonCount ?? 0) > 0) ? (
            <View style={{ paddingBottom: 6 }}>
              <ToggleCard
                title={commonCount && search === '' && active === 0 ? `Show ${commonCount} ${commonCount === 1 ? 'taste' : 'tastes'} you share` : 'Show tastes you share'}
                value={common}
                onChange={setCommon}
              />
            </View>
          ) : null}
        </View>
        {body}
        {/* The sort menu under its button, left edges aligned (Cravings' recipe). */}
        <AnchoredMenu anchor={menuAt ? { top: menuAt.top, bottom: menuAt.bottom } : null} onClose={() => setMenuAt(null)} right={menuAt ? Math.max(GUTTER, windowW - menuAt.x - 210) : GUTTER} minWidth={210}>
          {SORTS.map(([k, label]) => (
            <MenuItem key={k} label={label} active={sort === k} onPress={() => { setSort(k); setMenuAt(null); }} />
          ))}
        </AnchoredMenu>
        <ImpressionFilterSheet open={filterOpen} onClose={() => setFilterOpen(false)} filters={filters} onChange={applyFilters} onRange={dragRange} />
      </View>
  );
}

function ImpressionListRow({ row, showYours, onPress }: { row: ImpressionRow; showYours: boolean; onPress?: (row: RowHandle) => void }) {
  const title = row.blind ? 'Blind Impression' : row.name;
  // A blind row's line is its moment (what the post shows); else producer · type.
  const meta = row.blind ? row.momentName ?? null : [row.producer, wineTypeLabel(row.type)].filter(Boolean).join(' · ') || null;
  return (
    <ListRow
      uri={row.imageUrl}
      title={title}
      vintage={row.blind ? null : row.vintage}
      meta={meta}
      right={<ScoreColumn score={row.score} yours={showYours ? row.yourScore : null} />}
      onPress={onPress}
    />
  );
}

// "Filter Impressions" (04·6d): the applied chips · Date · Category · Score
// (the two-dot range) · Reset / Done, the Filter Moments anatomy. Aromas +
// Structure are later. The chips' bodies are plain labels (every control is
// in the sheet); a chip's ✕ applies at once, the range included.
function ImpressionFilterSheet({ open, onClose, filters, onChange, onRange }: {
  open: boolean; onClose: () => void; filters: ImpFilters; onChange: (f: ImpFilters) => void; onRange: (lo: number, hi: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const applied: ActiveFilter[] = [];
  if (filters.from || filters.to) applied.push({ key: 'date', label: dateChipLabel(filters.from, filters.to), onClear: () => onChange({ ...filters, from: null, to: null }) });
  if (filters.category !== 'any') applied.push({ key: 'category', label: categoryLabel(filters.category), onClear: () => onChange({ ...filters, category: 'any' }) });
  if (!isAnyRange(filters.lo, filters.hi)) applied.push({ key: 'score', label: rangeLabel(filters.lo, filters.hi), onClear: () => onChange({ ...filters, lo: RANGE_MIN, hi: RANGE_MAX }) });
  return (
    <Sheet open={open} onClose={onClose}>
      <BottomSheetView style={{ width: '100%', paddingHorizontal: 20, paddingTop: 12, paddingBottom: insets.bottom + 16, gap: 18 }}>
        <FilterTitle applied={applied}>Filter Impressions</FilterTitle>
        <View style={{ gap: 10 }}>
          <FilterLabel>DATE</FilterLabel>
          <FilterDates from={filters.from} to={filters.to} onChange={(from, to) => onChange({ ...filters, from, to })} />
        </View>
        <View style={{ gap: 10 }}>
          <FilterLabel>CATEGORY</FilterLabel>
          {/* v1: wine only, like Filter Moments. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <FilterChip label="Any" on={filters.category === 'any'} onPress={() => onChange({ ...filters, category: 'any' })} />
            <FilterChip label={categoryLabel('wine')} on={filters.category === 'wine'} onPress={() => onChange({ ...filters, category: 'wine' })} />
          </View>
        </View>
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <FilterLabel>SCORE</FilterLabel>
            <ScoreRangeValue lo={filters.lo} hi={filters.hi} />
          </View>
          <ScoreRange lo={filters.lo} hi={filters.hi} onChange={onRange} />
        </View>
        <FilterFooter onReset={() => onChange(NO_IMP_FILTERS)} onDone={onClose} />
      </BottomSheetView>
    </Sheet>
  );
}
