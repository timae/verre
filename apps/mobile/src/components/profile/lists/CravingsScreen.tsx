import { Button as MenuButton, ContextMenu, Host, RNHostView } from '@expo/ui/swift-ui';
import { keepPreviousData, useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, View, useWindowDimensions } from 'react-native';
import { StarScore } from '@/components/scoring/StarScore';
import { AnchoredMenu, MenuItem, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { CenteredMessage, ErrorState } from '@/components/ui/ConnectionState';
import {
  ListGoneError, PROFILE_LIST_KEY, getCravingsPage, profileListKey, removeCraving, type CravingRow, type CravingsPage, type CravingsSort,
} from '@/lib/api/lists';
import { errorText } from '@/lib/errorCopy';
import { invalidateProfileHeader } from '@/lib/feedCache';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';
import { useMeId } from '@/lib/meId';
import { wineTypeLabel } from '@/lib/momentFormat';
import { viewerCacheEpoch } from '@/lib/query';
import { useTheme } from '@/theme';
import { ListNote, ListRow, ToolRow, type RowHandle } from './ListParts';
import { ToolButton, type ToolAnchor } from '@/components/ui/ToolButton';
import { useListRefresh } from './useListRefresh';
import { useOpenListPost } from './useOpenListPost';
import { useScreenReaderEnabled } from '@/lib/screenReader';

// Your Cravings (design 04·10) or someone's (lists plan D6): sort + search,
// Recently Saved (default) or Highest Rated (offered only while scores show:
// someone's scores follow their post visibility, the server also serves a
// score sort as recent without it). A row TAP opens the list owner's post of
// that impression, on it (useOpenListPost), when they rated it; otherwise it
// is inert (bookmarks don't remember whose impression they came from).
// 🔒 Ruled Q6 (a deviation): NO heart. Your row's LONG-PRESS is the native iOS
// lift menu (@expo/ui ContextMenu, as on the Moments home carousel) with one
// red "Remove from Cravings": it removes at once (no confirm, no undo), the
// row leaves your Cravings lists immediately, then your header + the in-moment
// save set refresh. The score sits where the heart was. Later: "saved from
// whom" (04·10b) and the Places sorts.

export function CravingsPane({ userId, active: shown }: { userId: string; active: boolean }) {
  const screenReader = useScreenReaderEnabled();
  const { theme } = useTheme();
  const { width: windowW } = useWindowDimensions();
  const queryClient = useQueryClient();
  const meId = useMeId();
  const own = meId === userId;

  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const [sort, setSort] = useState<CravingsSort>('recent');
  const [menuAt, setMenuAt] = useState<ToolAnchor | null>(null);

  const params = useMemo(() => ({ q: search || undefined, sort }), [search, sort]);
  const listQ = useInfiniteQuery({
    queryKey: profileListKey('cravings', userId, params),
    queryFn: ({ pageParam }) => getCravingsPage(userId, params, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    retry: (n, e) => !(e instanceof ListGoneError) && n < 1,
    enabled: meId != null,
  });
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return (listQ.data?.pages ?? []).flatMap((p) => p.items).filter((r) => (seen.has(r.wineId) ? false : (seen.add(r.wineId), true)));
  }, [listQ.data]);
  // Yours always offers the score sort; someone's only once a loaded row shows
  // a score (their scores follow their post visibility).
  const scored = own || rows.some((r) => r.score != null) || sort === 'score';
  const { pulling, onPullRefresh, refetchInPlace } = useListRefresh(listQ.refetch);
  const openPost = useOpenListPost(userId, refetchInPlace, shown);

  // Remove at once: off every one of your Cravings lists (cancel first, so an
  // in-flight page can't put it back), then the server; a failure says so and
  // refetches in place.
  const remove = useCallback(async (key: string) => {
    // The viewer this tap belongs to, before ANY await (a sign-out and another
    // account's sign-in during the cancel must not send the DELETE as them).
    const epoch = viewerCacheEpoch();
    const filters = { queryKey: [...PROFILE_LIST_KEY, 'cravings', userId] };
    await queryClient.cancelQueries(filters);
    if (epoch !== viewerCacheEpoch()) return;
    queryClient.setQueriesData<InfiniteData<CravingsPage>>(filters, (d) =>
      d ? { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.filter((i) => i.key !== key) })) } : d);
    try {
      await removeCraving(key);
    } catch (e) {
      if (epoch !== viewerCacheEpoch()) return;
      Alert.alert('Couldn’t Remove', errorText(e));
    }
    if (epoch !== viewerCacheEpoch()) return;
    void queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
    void invalidateProfileHeader(queryClient, meId);
  }, [queryClient, userId, meId]);

  let body: React.ReactNode;
  if (listQ.error instanceof ListGoneError) {
    body = <CenteredMessage title="These cravings aren’t available" />;
  } else if (listQ.isPending) {
    body = <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={theme.inkSoft} /></View>;
  } else if (listQ.isError && rows.length === 0) {
    body = <ErrorState onRetry={() => listQ.refetch()} retrying={listQ.isFetching} />;
  } else {
    const rowWidth = windowW - 2 * GUTTER;
    body = (
      <FlatList
        removeClippedSubviews={!screenReader}
        data={rows}
        keyExtractor={(r) => r.wineId}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: TAB_BAR_CLEARANCE }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPullRefresh} tintColor={theme.inkSoft} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (listQ.hasNextPage && !listQ.isFetchingNextPage && !listQ.isPlaceholderData) void listQ.fetchNextPage();
        }}
        ListEmptyComponent={<ListNote>{search ? 'Nothing matches.' : 'No cravings yet.'}</ListNote>}
        ListFooterComponent={listQ.isFetchingNextPage ? <View style={{ paddingVertical: 16, alignItems: 'center' }}><ActivityIndicator color={theme.inkSoft} /></View> : undefined}
        renderItem={({ item }) => {
          const row = <CravingListRow row={item} onPress={item.postId != null ? (handle) => void openPost(item.postId, { wineId: item.wineId }, handle) : undefined} />;
          return own && item.key ? <RemovableRow width={rowWidth} onRemove={() => void remove(item.key!)}>{row}</RemovableRow> : row;
        }}
      />
    );
  }

  const menuAnchor: MenuAnchor | null = menuAt ? { top: menuAt.top, bottom: menuAt.bottom } : null;
  return (
    <View style={{ flex: 1, display: shown ? 'flex' : 'none' }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <ToolRow query={query} onQuery={setQuery} placeholder="Search cravings">
          <ToolButton icon="sort" label={`Sort, ${sort === 'score' ? 'Highest Rated' : 'Recently Saved'}`} onPress={setMenuAt} />
        </ToolRow>
      </View>
      {body}
      {/* The sort menu under its button (`.yo-toolrow .sess-menu`, left-aligned
          with the button: AnchoredMenu anchors from the right, so the offset
          puts its left edge at the button's while it keeps its min width). */}
      <AnchoredMenu anchor={menuAnchor} onClose={() => setMenuAt(null)} right={menuAt ? Math.max(GUTTER, windowW - menuAt.x - 210) : GUTTER} minWidth={210}>
        <MenuItem label="Recently Saved" active={sort === 'recent'} onPress={() => { setSort('recent'); setMenuAt(null); }} />
        {scored ? <MenuItem label="Highest Rated" active={sort === 'score'} onPress={() => { setSort('score'); setMenuAt(null); }} /> : null}
      </AnchoredMenu>
    </View>
  );
}

function CravingListRow({ row, onPress }: { row: CravingRow; onPress?: (row: RowHandle) => void }) {
  const title = row.blind ? 'Blind Impression' : row.name;
  const meta = row.blind ? row.momentName ?? null : [row.producer, wineTypeLabel(row.type)].filter(Boolean).join(' · ') || null;
  return (
    <ListRow
      uri={row.imageUrl}
      title={title}
      vintage={row.blind ? null : row.vintage}
      meta={meta}
      right={row.score ? <StarScore value={row.score} /> : null}
      onPress={onPress}
    />
  );
}

// The native lift menu around one of YOUR rows (the carousel's recipe,
// app/(tabs)/moments/index.tsx LiveCard: `<Host>` → ContextMenu →
// `<RNHostView matchContents>` for the RN row). No Preview: iOS lifts the row
// itself. The row has the screen width and its content's height; @expo/ui 58's
// RNHostView follows the RN child's bounds, so a list that loses a row
// re-measures (the carousel's fixed height was for 56's over-fill). The lifted
// row gets LIFT_PAD of the page's own background on each side (Simon, device
// pass 2026-11-13: a bit wider horizontally), reaching into the gutter by
// the same amount, so the row itself stays where it was.
const LIFT_PAD = 12;
function RemovableRow({ width, onRemove, children }: { width: number; onRemove: () => void; children: React.ReactElement }) {
  const { theme } = useTheme();
  const outer = width + 2 * LIFT_PAD;
  return (
    <Host matchContents style={{ width: outer, marginHorizontal: -LIFT_PAD }}>
      <ContextMenu>
        <ContextMenu.Items>
          <MenuButton label="Remove from Cravings" systemImage="trash" role="destructive" onPress={onRemove} />
        </ContextMenu.Items>
        <ContextMenu.Trigger>
          <RNHostView matchContents>
            <View style={{ width: outer, paddingHorizontal: LIFT_PAD, backgroundColor: theme.bg }}>{children}</View>
          </RNHostView>
        </ContextMenu.Trigger>
      </ContextMenu>
    </Host>
  );
}
