import * as Haptics from 'expo-haptics';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useFocusEffect, useRouter, useScrollToTop } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionFeedCard } from '@/components/feed/SessionFeedCard';
import { StandaloneFeedCard } from '@/components/feed/StandaloneFeedCard';
import { CenteredMessage, ConnectionBanner, ErrorState, connectionView } from '@/components/ui/ConnectionState';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { FEED_KEY, FEED_STALE_MS, feedQueryOptions, setFeedItemLike, feedItemId, type FeedItem, type FeedPage } from '@/lib/api/feed';
import { GUTTER, TAB_BAR_CLEARANCE, usePhoneTokens } from '@/lib/layout';
import { radius, space, useTheme } from '@/theme';

// The feed tab (proposal 08). An infinite, focus-refreshed list of the
// caller's network posts. Session-aggregate posts render as the 03·12 glass
// card; standalone check-ins render minimally (Phase 2 redesigns them).
// Scene background comes from the tabs layout's shared sceneStyle.

export default function Feed() {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  // Tapping the Feed tab while already on Feed scrolls the list to top (Simon)
  // — the standard tabPress→scrollToTop behavior via react-navigation's hook.
  const listRef = useRef<FlatList<FeedItem>>(null);
  useScrollToTop(listRef);

  // The query definition is shared with the detail screen (feedQueryOptions) —
  // the detail is a pure render off this same cache.
  const feed = useInfiniteQuery(feedQueryOptions());

  // NO focus invalidate. `invalidateQueries` on an infinite query resets it
  // toward the first page and re-identifies every item, which (a) shrinks the
  // list mid-refetch so the scroll offset clamps UPWARD — the "feed creeps up a
  // bit every time I nav away and back" bug — and (b) reloads content already
  // on screen. `feed.refetch()` is the safe path: it refetches the LOADED
  // pages IN PLACE (content updates, count preserved, scroll holds) — "update
  // without reloading what's already there." Freshness therefore comes from
  // three refetch()-based triggers: the tab-refocus effect below, the
  // app-foreground `focusManager` refetch (lib/query.tsx), and pull-to-refresh.

  // Tab RE-focus: focusManager only fires on app foreground, and tab screens
  // stay mounted, so switching Moments→Feed triggers no refetch by itself —
  // without this, the list would sit stale until a manual pull. In-place
  // refetch, gated on real staleness so quick tab hops stay silent. The
  // initial mount is skipped (no data yet — the query's own fetch owns it).
  useFocusEffect(
    useCallback(() => {
      const state = queryClient.getQueryState(FEED_KEY);
      if (!state?.data || state.fetchStatus === 'fetching') return;
      if (Date.now() - state.dataUpdatedAt < FEED_STALE_MS) return;
      feed.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const items = useMemo(() => (feed.data?.pages ?? []).flatMap((p) => p.items), [feed.data]);

  // Drain empty pages: /api/feed may legally return items:[] with a cursor
  // (render filters drop rows server-side; the cursor keys on the RAW page —
  // see the route's nextCursor comment). An appended empty page doesn't grow
  // the content height, so onEndReached never re-fires — advance explicitly
  // until a page carries items or paging ends.
  const pages = feed.data?.pages;
  useEffect(() => {
    if (!pages?.length || pages[pages.length - 1].items.length > 0) return;
    if (feed.hasNextPage && !feed.isFetching) feed.fetchNextPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, feed.hasNextPage, feed.isFetching]);

  // Pull-to-refresh (mirrors the moments home pattern): an explicit `pulling`
  // state drives the spinner — NOT feed.isRefetching, which also fires for the
  // app-foreground refetch AND can go true→false within a frame on a fast/cached
  // refetch (spinner never paints). A 600ms min-visible floor guarantees the
  // spinner reads as "it refreshed". feed.refetch() refetches the loaded pages
  // in place, so content updates without dropping what's on screen or moving
  // the scroll.
  const [pulling, setPulling] = useState(false);
  const onPullRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setPulling(true);
    const minVisible = new Promise<void>((r) => setTimeout(r, 600));
    Promise.allSettled([feed.refetch(), minVisible]).then(() => setPulling(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Optimistic like: flip liked + adjust likeCount in the cache immediately,
  // fire the server call, invalidate on error (never a frozen-snapshot
  // restore — a focus refetch may have advanced the cache mid-flight).
  //
  // Per-item mutation seq: the hearts stay tappable while a request is in
  // flight, and responses can arrive OUT OF ORDER (a quick like→unlike where
  // the POST resolves after the DELETE would restore liked:true). Each toggle
  // takes a seq; only the item's LATEST request may reconcile or invalidate —
  // stale responses are dropped.
  const likeSeq = useRef(new Map<number, number>());
  const toggleLike = useCallback(
    async (id: number, nextLiked: boolean) => {
      const seq = (likeSeq.current.get(id) ?? 0) + 1;
      likeSeq.current.set(id, seq);
      await queryClient.cancelQueries({ queryKey: FEED_KEY });
      queryClient.setQueryData<InfiniteData<FeedPage>>(FEED_KEY, (data) => {
        if (!data) return data;
        return {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((it) => applyLike(it, id, nextLiked)),
          })),
        };
      });
      try {
        // Reconcile with the authoritative result — an idempotent double-like
        // or block-pair-hidden likes make the server's count diverge from the
        // optimistic ±1.
        const server = await setFeedItemLike(id, nextLiked);
        if (likeSeq.current.get(id) !== seq) return; // a newer toggle owns this item
        queryClient.setQueryData<InfiniteData<FeedPage>>(FEED_KEY, (data) => {
          if (!data) return data;
          return {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.map((it) => applyLike(it, id, server.liked, server.count)),
            })),
          };
        });
      } catch {
        if (likeSeq.current.get(id) !== seq) return; // ditto — don't clobber a newer toggle
        queryClient.invalidateQueries({ queryKey: FEED_KEY });
      }
    },
    [queryClient],
  );

  const openImpression = useCallback(
    (feedItemIdNum: number, wineIndex: number) => {
      router.push({ pathname: '/feed/impression/[id]', params: { id: String(feedItemIdNum), index: String(wineIndex) } });
    },
    [router],
  );

  const conn = connectionView(feed.isError, items.length > 0);

  const renderItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      const id = feedItemId(item);
      if (item.type === 'session') {
        return (
          <SessionFeedCard
            author={item.author}
            session={item.session}
            createdAt={item.createdAt}
            onOpenImpression={(wineIndex) => openImpression(id, wineIndex)}
            onToggleLike={(next) => toggleLike(id, next)}
          />
        );
      }
      return (
        <StandaloneFeedCard
          author={item.author}
          checkin={item.checkin}
          createdAt={item.createdAt}
          onOpen={() => openImpression(id, 0)}
          onToggleLike={(next) => toggleLike(id, next)}
        />
      );
    },
    [openImpression, toggleLike],
  );

  const topPad = insets.top + space.md;

  if (feed.isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.inkSoft} />
      </View>
    );
  }

  if (conn === 'error') {
    return (
      <View style={{ flex: 1, paddingTop: topPad }}>
        <View style={{ paddingHorizontal: GUTTER, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <VText variant="title">Feed</VText>
          <CheckInPill onPress={() => router.push('/feed/check-in')} />
        </View>
        <ErrorState onRetry={() => feed.refetch()} retrying={feed.isFetching} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {conn === 'banner' && <ConnectionBanner onRetry={() => feed.refetch()} />}
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => `${item.type}:${feedItemId(item)}`}
        renderItem={renderItem}
        ListHeaderComponent={
          // .vbar-root — top-right carries the page's primary action as the
          // .hv-add accent pill ("+ Check In" → the standalone create form).
          <View style={{ paddingHorizontal: GUTTER, paddingBottom: space.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <VText variant="title">Feed</VText>
            <CheckInPill onPress={() => router.push('/feed/check-in')} />
          </View>
        }
        contentContainerStyle={{ paddingTop: topPad, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={onPullRefresh}
            tintColor={theme.inkSoft}
            // The list has a large top contentInset (status bar). Without this
            // the spinner draws ABOVE the visible area (hidden under the status
            // bar) — "the list moves but no spinner shows". Offset it down into
            // view by the same top pad.
            progressViewOffset={topPad}
          />
        }
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (feed.hasNextPage && !feed.isFetchingNextPage) feed.fetchNextPage();
        }}
        ListFooterComponent={
          feed.isFetchingNextPage ? (
            <View style={{ paddingVertical: space.lg }}>
              <ActivityIndicator color={theme.inkSoft} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          feed.hasNextPage || feed.isFetching ? (
            // Nothing rendered yet but paging/refetching is still in motion
            // (e.g. draining an empty page) — keep a spinner, not the
            // terminal empty copy.
            <View style={{ paddingVertical: space.lg }}>
              <ActivityIndicator color={theme.inkSoft} />
            </View>
          ) : (
            <CenteredMessage
              title="Nothing here yet"
              body="Follow other tasters or join a moment — what your network drinks shows up here."
            />
          )
        }
      />
    </View>
  );
}

// .hv-add base — accent pill (the moments-home NewPill shape; still a copy —
// the <IconPill> extraction in apps/mobile/CLAUDE.md stays pending).
function CheckInPill({ onPress }: { onPress: () => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('button');
  const actionLabel = phone.text('small');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New check-in"
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: surface.height(phone.size('actionPillHeight')),
        paddingLeft: phone.lerp(11, 14),
        paddingRight: phone.lerp(14, 17),
        borderRadius: radius.pill,
        backgroundColor: theme.accent,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Icon name="plus" size={phone.size('actionIcon')} color={theme.accentInk} />
      <VText surface="button" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...actionLabel, color: theme.accentInk }}>
        Check In
      </VText>
    </Pressable>
  );
}

// Apply a like flip to whichever payload the target id lives on. Without
// `count` this is the optimistic ±1 (no-op if liked already matches); with
// `count` (server-authoritative) both fields reconcile to the response.
function applyLike(item: FeedItem, id: number, nextLiked: boolean, count?: number): FeedItem {
  if (feedItemId(item) !== id) return item;
  const delta = nextLiked ? 1 : -1;
  if (item.type === 'session') {
    const likeCount = count ?? (item.session.liked === nextLiked ? item.session.likeCount : Math.max(0, item.session.likeCount + delta));
    if (item.session.liked === nextLiked && item.session.likeCount === likeCount) return item;
    return { ...item, session: { ...item.session, liked: nextLiked, likeCount } };
  }
  const likeCount = count ?? (item.checkin.liked === nextLiked ? item.checkin.likeCount : Math.max(0, item.checkin.likeCount + delta));
  if (item.checkin.liked === nextLiked && item.checkin.likeCount === likeCount) return item;
  return { ...item, checkin: { ...item.checkin, liked: nextLiked, likeCount } };
}
