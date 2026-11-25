import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { Alert } from 'react-native';
import { feedItemQueryOptions, findFeedItem } from '@/lib/api/feed';
import { errorText } from '@/lib/errorCopy';
import { listPostIndex, type ListPostTarget } from '@/lib/listPost';
import { setFeedTransitionSource } from '@/lib/feedTransition';
import { viewerCacheEpoch } from '@/lib/query';
import { feedHref, useSessionTab } from '@/lib/sessionStack';
import { ListGoneError, getImpression, impressionKey } from '@/lib/api/lists';
import { impressionRouteId } from '@/lib/impressionRoute';
import type { RowHandle } from './ListParts';

const CARD_OPEN_DEBOUNCE_MS = 700;

// Open an impression's post from a profile list (lists plan D9), like a post
// on the feed. The detail seeds its pager, pager offset and fade at MOUNT, so
// the item is fetched FIRST: 🔒 `fetchInfiniteQuery` (never `fetchQuery`: a
// plain { items } entry under a ['feed', …] key breaks every feed-cache write),
// the viewer epoch checked after the await, the index taken from an EXACT
// match on the row's `target` (lib/listPost.ts: an impression by its rating
// id, a craving by its wine id; a moment post can outlive the tapped rating
// while others remain, and a missing index would clamp to another impression;
// a standalone post is index 0, its one wine IS the post), then the fade and
// the push with that index. The post then GROWS out of the tapped row (feedTransition kind
// 'row', a container transform with the row's face): the row is measured after the fetch, right before the push, so a
// scroll during the fetch can't leave a stale frame; a row gone by then (or no
// measurer) falls back to the fade. A miss (the empty page, or the bottle not in the post) is the alert
// and an in-place refetch of the list (`onMiss`). On a tab stack the push is
// singular (a double tap can't stack two); on an opened post's stack it is a
// fresh card visit with a debounce, like FeedList.
// 🔒 A tap belongs to the place it was made (Codex review): leaving the screen
// (blur, unmount) or its pane going hidden on Discoveries (`active` false)
// bumps a generation, checked after every await, so a slow fetch can't open
// the post (or alert) over wherever you went since.
// 🔒 ONE tap guard per list pane, shared by both openers below (review
// 2026-11-24): a post row and an impression row tapped in quick succession must
// open one screen, not two (the `busy` flag, the card debounce, the tap's
// generation are the pane's, not each opener's).
export type ListTapGuard = { busy: MutableRefObject<boolean>; lastCardOpen: MutableRefObject<number>; gen: MutableRefObject<number> };
export function useListTapGuard(active = true): ListTapGuard {
  const busy = useRef(false);
  const lastCardOpen = useRef(0);
  const gen = useRef(0);
  useFocusEffect(useCallback(() => () => { gen.current += 1; }, []));
  useEffect(() => () => { gen.current += 1; }, []);
  useEffect(() => { if (!active) gen.current += 1; }, [active]);
  return useMemo(() => ({ busy, lastCardOpen, gen }), []);
}

export function useOpenListPost(ownerId: string, onMiss: () => void, guard: ListTapGuard) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const mount = useSessionTab();
  const { busy, lastCardOpen, gen } = guard;
  return useCallback(
    async (postId: number | null, target: ListPostTarget, row?: RowHandle) => {
      if (postId == null || busy.current) return;
      if (mount.post != null && Date.now() - lastCardOpen.current < CARD_OPEN_DEBOUNCE_MS) return;
      busy.current = true;
      const epoch = viewerCacheEpoch();
      const g = gen.current;
      const stale = () => epoch !== viewerCacheEpoch() || g !== gen.current;
      try {
        const data = await queryClient.fetchInfiniteQuery(feedItemQueryOptions(ownerId, postId));
        if (stale()) return;
        const item = findFeedItem(data.pages, postId);
        const index = listPostIndex(item, target);
        if (index < 0) {
          Alert.alert('This impression isn’t available.');
          onMiss();
          return;
        }
        // On an opened post's stack the detail is a card push: it discards
        // any source, so there is nothing to measure.
        const frame = mount.post == null && row ? await row.measure() : null;
        if (stale()) return;
        setFeedTransitionSource(frame && row ? { kind: 'row', ...frame, face: row.face } : { kind: 'fade' });
        const href = feedHref(mount, 'post', { id: String(postId), index: String(index), user: ownerId, source: 'item' });
        if (mount.post == null) {
          router.push(href, { dangerouslySingular: true });
        } else {
          lastCardOpen.current = Date.now();
          router.push(href);
        }
      } catch (e) {
        if (!stale()) Alert.alert('Couldn’t Open', errorText(e));
      } finally {
        busy.current = false;
      }
    },
    [queryClient, router, mount, ownerId, onMiss, busy, lastCardOpen, gen],
  );
}

// Open an impression's PAGE from a profile list (Moment Visibility step 3, R4,
// T13, T14): a row without a post you may open (an Only Inside moment's, a
// check-in hidden from feeds, a rating with no post). The same rules as a post
// above: the read FIRST (['impression', owner, ratingId], never under
// ['feed', …]), the epoch and the tap's generation after every await, the
// row's unfold on a tab stack, a card with a debounce on a post's stack, then
// the push of `r<ratingId>` on the post routes (`user` = the list's owner).
// A 404 is the alert and the list refetched in place.
export function useOpenListImpression(ownerId: string, onMiss: () => void, guard: ListTapGuard) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const mount = useSessionTab();
  const { busy, lastCardOpen, gen } = guard;
  return useCallback(
    async (ratingId: number, row?: RowHandle) => {
      if (busy.current) return;
      if (mount.post != null && Date.now() - lastCardOpen.current < CARD_OPEN_DEBOUNCE_MS) return;
      busy.current = true;
      const epoch = viewerCacheEpoch();
      const g = gen.current;
      const stale = () => epoch !== viewerCacheEpoch() || g !== gen.current;
      try {
        await queryClient.fetchQuery({ queryKey: impressionKey(ownerId, ratingId), queryFn: () => getImpression(ownerId, ratingId) });
        if (stale()) return;
        const frame = mount.post == null && row ? await row.measure() : null;
        if (stale()) return;
        setFeedTransitionSource(frame && row ? { kind: 'row', ...frame, face: row.face } : { kind: 'fade' });
        const href = feedHref(mount, 'post', { id: impressionRouteId(ratingId), user: ownerId });
        if (mount.post == null) {
          router.push(href, { dangerouslySingular: true });
        } else {
          lastCardOpen.current = Date.now();
          router.push(href);
        }
      } catch (e) {
        if (stale()) return;
        if (e instanceof ListGoneError) {
          Alert.alert('This impression isn’t available.');
          onMiss();
        } else {
          Alert.alert('Couldn’t Open', errorText(e));
        }
      } finally {
        busy.current = false;
      }
    },
    [queryClient, router, mount, ownerId, onMiss, busy, lastCardOpen, gen],
  );
}
