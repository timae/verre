import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useFocusEffect, useRouter, useScrollToTop } from 'expo-router';
import { useCallback, useMemo, useRef } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionFeedCard } from '@/components/feed/SessionFeedCard';
import { StandaloneFeedCard } from '@/components/feed/StandaloneFeedCard';
import { CenteredMessage, ConnectionBanner, ErrorState, connectionView } from '@/components/ui/ConnectionState';
import { VText } from '@/components/ui/VText';
import { getFeed, setFeedItemLike, feedItemId, type FeedItem, type FeedPage } from '@/lib/api/feed';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';
import { space, useTheme } from '@/theme';

// The feed tab (proposal 08). An infinite, focus-refreshed list of the
// caller's network posts. Session-aggregate posts render as the 03·12 glass
// card; standalone check-ins render minimally (Phase 2 redesigns them).
// Scene background comes from the tabs layout's shared sceneStyle.

const FEED_KEY = ['feed'] as const;

export default function Feed() {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  // Tapping the Feed tab while already on Feed scrolls the list to top (Simon)
  // — the standard tabPress→scrollToTop behavior via react-navigation's hook.
  const listRef = useRef<FlatList<FeedItem>>(null);
  useScrollToTop(listRef);

  const feed = useInfiniteQuery({
    queryKey: FEED_KEY,
    queryFn: ({ pageParam }) => getFeed(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 15_000,
  });

  // Refetch on focus — a post liked/created elsewhere (or by a followed user)
  // shows up on return without an app reload. Prefix invalidation is
  // closure-independent (mirrors recents.tsx).
  useFocusEffect(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: FEED_KEY });
    }, [queryClient]),
  );

  const items = useMemo(() => (feed.data?.pages ?? []).flatMap((p) => p.items), [feed.data]);

  // Optimistic like: flip liked + adjust likeCount in the cache immediately,
  // fire the server call, invalidate on error (never a frozen-snapshot
  // restore — a focus refetch may have advanced the cache mid-flight).
  const toggleLike = useCallback(
    async (id: number, nextLiked: boolean) => {
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
        await setFeedItemLike(id, nextLiked);
      } catch {
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
        <View style={{ paddingHorizontal: GUTTER }}>
          <VText variant="title">Feed</VText>
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
          <View style={{ paddingHorizontal: GUTTER, paddingBottom: space.sm }}>
            <VText variant="title">Feed</VText>
          </View>
        }
        contentContainerStyle={{ paddingTop: topPad, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={feed.isRefetching && !feed.isFetchingNextPage}
            onRefresh={() => feed.refetch()}
            tintColor={theme.inkSoft}
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
          <CenteredMessage
            title="Nothing here yet"
            body="Follow other tasters or join a moment — what your network drinks shows up here."
          />
        }
      />
    </View>
  );
}

// Apply an optimistic like flip to whichever payload the target id lives on.
function applyLike(item: FeedItem, id: number, nextLiked: boolean): FeedItem {
  if (feedItemId(item) !== id) return item;
  const delta = nextLiked ? 1 : -1;
  if (item.type === 'session') {
    if (item.session.liked === nextLiked) return item;
    return {
      ...item,
      session: { ...item.session, liked: nextLiked, likeCount: Math.max(0, item.session.likeCount + delta) },
    };
  }
  if (item.checkin.liked === nextLiked) return item;
  return {
    ...item,
    checkin: { ...item.checkin, liked: nextLiked, likeCount: Math.max(0, item.checkin.likeCount + delta) },
  };
}
