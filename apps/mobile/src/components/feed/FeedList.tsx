import * as Haptics from 'expo-haptics';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useNavigation, useRouter, useScrollToTop } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, ScrollView, View, type ScrollViewInstance } from 'react-native';
import { SessionFeedCard } from '@/components/feed/SessionFeedCard';
import { StandaloneFeedCard } from '@/components/feed/StandaloneFeedCard';
import { ConnectionBanner, ErrorState, connectionView } from '@/components/ui/ConnectionState';
import { FEED_STALE_MS, deleteCheckin, feedItemId, feedKey, feedQueryOptions, patchSessionRating, type FeedAuthor, type FeedItem } from '@/lib/api/feed';
import { ApiError } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { invalidateProfileHeader, markFeedPostDeleted, refetchFeedCaches, toggleFeedLike, updateFeedCaches } from '@/lib/feedCache';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { closeOpenedPost, feedHref, useSessionTab } from '@/lib/sessionStack';
import { space, useTheme } from '@/theme';

// The caller's handle on the list's scroll position, whichever layout is
// showing (the list, or the error state's scroll view).
export type FeedScrollHandle = { scrollToOffset: (offset: number) => void };

// A second tap on a card inside an opened post's stack within this window is
// the same tap, not a new visit (card pushes there are not singular).
const CARD_OPEN_DEBOUNCE_MS = 700;

// THE post list (proposal 08), shared by the Feed tab (the caller's network,
// `userId` absent) and the profile screens (one person's posts, `userId`).
// One implementation: paging, empty-page drain, focus refresh, pull-to-refresh,
// the cards, like, owner edit/delete. The caller supplies the header above the
// posts and the empty state. Post routes (detail, edit, profile) are pushed
// stack-relative (lib/sessionStack.ts feedHref) and carry `user` so the detail
// and edit screens read THIS list's cache.

export function FeedList({
  userId,
  header,
  empty,
  contentTopPad,
  onRefresh,
  centerLoading,
  onScrollY,
  fullBleed,
  refreshOffset,
  refreshTint,
  inert,
  bottomInset,
  scrollHandle,
}: {
  userId?: number;
  header: React.ReactElement;
  empty: React.ReactElement;
  // Top padding of the scroll content (status bar, or the screen's fixed bar).
  contentTopPad: number;
  // Runs with every pull-to-refresh and stale-focus refetch (the profile
  // header refreshes with its posts).
  onRefresh?: () => unknown;
  // First load as a centred spinner with no header (the Feed tab's look);
  // otherwise the header renders and the spinner sits under it.
  centerLoading?: boolean;
  // The list's vertical offset, per scroll frame (the profile's bar title).
  onScrollY?: (y: number) => void;
  // A header that runs UNDER the status bar (the profile cover hero):
  // contentInsetAdjustmentBehavior never, behind the zero-size dead-end that
  // stops react-native-screens from flipping it back to automatic
  // (apps/mobile/CLAUDE.md "Full-bleed scroll content"). Key the list on it if
  // it can change while mounted.
  fullBleed?: boolean;
  // The pull-to-refresh spinner's offset (default: contentTopPad) and tint
  // (default: inkSoft) — below a floating bar, white over a photo.
  refreshOffset?: number;
  refreshTint?: string;
  // Edit mode on the header: the posts (and the paging footer) dim to 0.35 and
  // ignore touches; the list still scrolls.
  inert?: boolean;
  // Bottom content padding when it must clear more than the tab bar (the
  // keyboard + the profile's edit bar). Never below TAB_BAR_CLEARANCE.
  bottomInset?: number;
  // Set to a handle on the scroll position (measured scroll-into-view while
  // editing), in both the list and the error layout.
  scrollHandle?: React.RefObject<FeedScrollHandle | null>;
}) {
  const { theme } = useTheme();
  const router = useRouter();
  const tab = useSessionTab();
  const queryClient = useQueryClient();
  // Tapping the tab while on its root scrolls the list to top (Simon) — the
  // standard tabPress→scrollToTop behavior via react-navigation's hook.
  const listRef = useRef<FlatList<FeedItem>>(null);
  const errorScrollRef = useRef<ScrollViewInstance>(null);
  useScrollToTop(listRef);
  useEffect(() => {
    if (!scrollHandle) return;
    scrollHandle.current = {
      scrollToOffset: (offset) => {
        if (errorScrollRef.current) errorScrollRef.current.scrollTo({ y: offset, animated: true });
        else listRef.current?.scrollToOffset({ offset, animated: true });
      },
    };
    return () => {
      scrollHandle.current = null;
    };
  }, [scrollHandle]);

  // The query definition is shared with the detail + edit screens
  // (feedQueryOptions) — they are pure renders off this same cache.
  const feed = useInfiniteQuery(feedQueryOptions(userId));
  const userParam = userId != null ? String(userId) : undefined;

  // NO focus invalidate. `invalidateQueries` on an infinite query resets it
  // toward the first page and re-identifies every item, which (a) shrinks the
  // list mid-refetch so the scroll offset clamps UPWARD — the "feed creeps up a
  // bit every time I nav away and back" bug — and (b) reloads content already
  // on screen. `feed.refetch()` is the safe path: it refetches the LOADED
  // pages IN PLACE (content updates, count preserved, scroll holds) — "update
  // without reloading what's already there." Freshness therefore comes from
  // three refetch()-based triggers: the re-focus effect below, the
  // app-foreground `focusManager` refetch (lib/query.tsx), and pull-to-refresh.

  // Re-focus: focusManager only fires on app foreground, and tab screens stay
  // mounted, so switching tabs triggers no refetch by itself — without this,
  // the list would sit stale until a manual pull. In-place refetch, gated on
  // real staleness so quick hops stay silent. The initial mount is skipped (no
  // data yet — the query's own fetch owns it).
  useFocusEffect(
    useCallback(() => {
      const state = queryClient.getQueryState(feedKey(userId));
      if (!state?.data || state.fetchStatus === 'fetching') return;
      if (Date.now() - state.dataUpdatedAt < FEED_STALE_MS) return;
      feed.refetch();
      onRefresh?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId]),
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
    Promise.allSettled([feed.refetch(), onRefresh?.(), minVisible]).then(() => setPulling(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRefresh]);

  const toggleLike = useCallback((id: number, next: boolean) => toggleFeedLike(queryClient, id, next), [queryClient]);

  // Open a post. On a tab stack it is the transparent-modal detail, pushed
  // singular (a double tap can't stack two). Inside an opened post's own stack
  // (this list is a profile pushed there) it is a CARD push of the detail, and
  // a FRESH visit every time: singular would MOVE an earlier visit of the same
  // post to the top (A → P → B → Q → B, back from Q would skip the B that
  // opened it), so only a quick second tap is swallowed (Codex r2).
  const lastCardOpen = useRef(0);
  const openImpression = useCallback(
    (id: number, wineIndex: number) => {
      const href = feedHref(tab, 'post', { id: String(id), index: String(wineIndex), user: userParam });
      if (tab.post == null) {
        router.push(href, { dangerouslySingular: true });
        return;
      }
      const now = Date.now();
      if (now - lastCardOpen.current < CARD_OPEN_DEBOUNCE_MS) return;
      lastCardOpen.current = now;
      router.push(href);
    },
    [router, tab, userParam],
  );

  // A post's author → their profile, pushed on this stack (or on the opened
  // post's stack). On that person's own profile list the tap is a no-op (it
  // IS the screen underneath).
  const openAuthor = useCallback(
    (author: FeedAuthor) => {
      if (author.id === userId) return;
      router.push(feedHref(tab, 'profile', { id: String(author.id) }));
    },
    [router, tab, userId],
  );

  // Owner gate for the cards' ⋯ Edit (the detail screen's meId/isOwner
  // pattern) — Better Auth user ids are strings, feed author ids numbers.
  const meId = authClient.useSession().data?.user.id;
  const myUserId = meId != null ? Number(meId) : null;

  // Owner delete flows (Simon, 2026-07-18) — both confirm via the house
  // native alert. Standalone = DELETE the whole check-in (post + rating +
  // photo). Session = "Delete Rating": clear the active impression's rating
  // via the empty-PATCH reap path; the post itself only disappears when that
  // was its last content. Either way every feed cache drops it and the lists
  // refetch IN PLACE (never invalidate — the scroll-creep rule above).
  const navigation = useNavigation();
  const deleteBusy = useRef(false);
  const runDelete = useCallback(
    async (postId: number, op: () => Promise<{ feedItemDeleted: boolean } | void>, applyToCache: (item: FeedItem) => FeedItem | null) => {
      if (deleteBusy.current) return;
      deleteBusy.current = true;
      try {
        const res = await op();
        // This list sits on an opened post's stack and the post that went is
        // THAT post (your own post A → your profile → delete A here): close
        // the whole opened post, its modal pins a copy of the deleted post.
        const postGone = !res || res.feedItemDeleted;
        // Every mounted detail of it, on any tab, drops its pinned copy.
        if (postGone) markFeedPostDeleted(postId);
        if (postGone && tab.post === String(postId)) closeOpenedPost(navigation, tab.post);
        // Reflect the delete in the caches IMMEDIATELY (like-flow pattern) —
        // waiting for the refetch alone leaves the deleted card actionable,
        // and a second delete would 404 (Codex). The awaited refetch then
        // reconciles with the server (and holds the busy flag meanwhile).
        await updateFeedCaches(queryClient, applyToCache);
        // Owner-only flows: the author is you — your header counts change too.
        invalidateProfileHeader(queryClient, myUserId);
        await refetchFeedCaches(queryClient);
      } catch (e) {
        const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
        Alert.alert('Could not delete', msg || 'Check your connection and try again.');
      } finally {
        deleteBusy.current = false;
      }
    },
    [queryClient, myUserId, tab, navigation],
  );
  // Destructive confirms always NAME what's being deleted (Simon, 2026-07-18).
  const confirmDeleteCheckin = useCallback(
    (id: number, name: string) => {
      Alert.alert(
        name ? `Delete “${name}”?` : 'Delete this check-in?',
        'This removes the post, its rating, and its photo. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () =>
              runDelete(
                id,
                () => deleteCheckin(id),
                (it) => (feedItemId(it) === id ? null : it),
              ),
          },
        ],
      );
    },
    [runDelete],
  );
  const confirmDeleteRating = useCallback(
    (id: number, wineId: string, name: string) => {
      Alert.alert(
        name ? `Delete your rating of “${name}”?` : 'Delete your rating?',
        'This resets your rating for this impression. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () =>
              runDelete(
                id,
                () => patchSessionRating(id, { wineId, score: 0, flavors: {}, aromas: [], notes: '' }),
                // Drop the cleared wine from the post; drop the whole post
                // when that was its last impression (the server reaps it).
                (it) => {
                  if (it.type !== 'session' || it.session.id !== id) return it;
                  const wines = it.session.wines.filter((w) => w.id !== wineId);
                  if (wines.length === 0) return null;
                  return { ...it, session: { ...it.session, wines } };
                },
              ),
          },
        ],
      );
    },
    [runDelete],
  );

  const conn = connectionView(feed.isError, items.length > 0);

  const renderCard = useCallback(
    (item: FeedItem, id: number, isOwner: boolean) => {
      const onPressAuthor = item.author.id === userId ? undefined : () => openAuthor(item.author);
      if (item.type === 'session') {
        return (
          <SessionFeedCard
            author={item.author}
            session={item.session}
            createdAt={item.createdAt}
            onPressAuthor={onPressAuthor}
            onOpenImpression={(wineIndex) => openImpression(id, wineIndex)}
            onToggleLike={(next) => toggleLike(id, next)}
            onEdit={isOwner ? (wineId) => router.push(feedHref(tab, 'edit', { id: String(id), wine: wineId, user: userParam })) : undefined}
            onDeleteRating={
              isOwner
                ? (wineId) => {
                    // Blind wines carry a redacted empty name — use the card's
                    // own alias ("Wine N") so the confirm still names its target.
                    const idx = item.session.wines.findIndex((w) => w.id === wineId);
                    const w = idx >= 0 ? item.session.wines[idx] : undefined;
                    confirmDeleteRating(id, wineId, w ? (w._blind ? `Wine ${idx + 1}` : w.name) : '');
                  }
                : undefined
            }
          />
        );
      }
      return (
        <StandaloneFeedCard
          author={item.author}
          checkin={item.checkin}
          createdAt={item.createdAt}
          onPressAuthor={onPressAuthor}
          onOpen={() => openImpression(id, 0)}
          onToggleLike={(next) => toggleLike(id, next)}
          onEdit={isOwner ? () => router.push(feedHref(tab, 'edit', { id: String(id), user: userParam })) : undefined}
          onDelete={isOwner ? () => confirmDeleteCheckin(id, item.checkin.wineName) : undefined}
        />
      );
    },
    [openImpression, openAuthor, toggleLike, myUserId, userId, userParam, router, tab, confirmDeleteCheckin, confirmDeleteRating],
  );
  const renderItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      const id = feedItemId(item);
      const isOwner = myUserId != null && item.author.id === myUserId;
      const card = renderCard(item, id, isOwner);
      return inert ? <View pointerEvents="none" style={{ opacity: 0.35 }}>{card}</View> : card;
    },
    [inert, myUserId, renderCard],
  );

  if (feed.isLoading && centerLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.inkSoft} />
      </View>
    );
  }

  const padBottom = Math.max(TAB_BAR_CLEARANCE, bottomInset ?? 0);
  const deadEnd = fullBleed ? <View collapsable={false} style={{ width: 0, height: 0 }} /> : null;

  // A scroll view, not a flex column: a tall header (the cover hero) would
  // otherwise squeeze the retry state off screen.
  if (conn === 'error') {
    return (
      <View style={{ flex: 1 }}>
        {deadEnd}
        <ScrollView
          ref={errorScrollRef}
          contentInsetAdjustmentBehavior={fullBleed ? 'never' : undefined}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onScroll={onScrollY ? (e) => onScrollY(e.nativeEvent.contentOffset.y) : undefined}
          scrollEventThrottle={onScrollY ? 16 : undefined}
          contentContainerStyle={{ flexGrow: 1, paddingTop: contentTopPad, paddingBottom: padBottom }}
        >
          {header}
          <View style={{ flexGrow: 1, minHeight: 220 }}>
            <ErrorState onRetry={() => feed.refetch()} retrying={feed.isFetching} />
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {deadEnd}
      {conn === 'banner' && <ConnectionBanner onRetry={() => feed.refetch()} />}
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => `${item.type}:${feedItemId(item)}`}
        renderItem={renderItem}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingTop: contentTopPad, paddingBottom: padBottom }}
        contentInsetAdjustmentBehavior={fullBleed ? 'never' : undefined}
        // Taps land while a header text field has the keyboard up (the
        // profile's in-place edit: hopping from the name to the bio).
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onScroll={onScrollY ? (e) => onScrollY(e.nativeEvent.contentOffset.y) : undefined}
        scrollEventThrottle={onScrollY ? 16 : undefined}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={onPullRefresh}
            tintColor={refreshTint ?? theme.inkSoft}
            // The list has a top content pad (status bar / fixed bar). Without
            // this the spinner draws ABOVE the visible area — "the list moves
            // but no spinner shows". Offset it down into view by the same pad
            // (or below a floating bar: `refreshOffset`).
            progressViewOffset={refreshOffset ?? contentTopPad}
          />
        }
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (feed.hasNextPage && !feed.isFetchingNextPage) feed.fetchNextPage();
        }}
        ListFooterComponent={
          feed.isFetchingNextPage ? (
            <View style={{ paddingVertical: space.lg, opacity: inert ? 0.35 : 1 }}>
              <ActivityIndicator color={theme.inkSoft} />
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          feed.hasNextPage || feed.isFetching ? (
            // Nothing rendered yet but loading/paging/refetching is still in
            // motion (e.g. draining an empty page) — keep a spinner, not the
            // terminal empty copy.
            <View style={{ paddingVertical: space.lg }}>
              <ActivityIndicator color={theme.inkSoft} />
            </View>
          ) : (
            empty
          )
        }
      />
    </View>
  );
}
