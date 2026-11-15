import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

type Refetch = () => Promise<unknown>;

// The tile lists' freshness (lists plan D12): refreshed IN PLACE, never
// blanked. Every list refetches when it regains focus (a write inside a moment
// (rate, Crave) only marks your header stale), not on its first focus. Pull to
// refresh is the house pattern (PeopleScreen / FeedList): an explicit
// `pulling` state with a 600 ms floor, never `isRefetching`.
export function useListRefresh(refetchList: Refetch, refetchHeader?: Refetch) {
  const [pulling, setPulling] = useState(false);
  const listRef = useRef(refetchList);
  listRef.current = refetchList;
  const headerRef = useRef(refetchHeader);
  headerRef.current = refetchHeader;
  const onPullRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setPulling(true);
    const minVisible = new Promise<void>((r) => setTimeout(r, 600));
    Promise.allSettled([listRef.current(), headerRef.current?.(), minVisible]).then(() => setPulling(false));
  }, []);
  const refetchInPlace = useCallback(() => { void listRef.current(); }, []);
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current) void listRef.current();
      focused.current = true;
    }, []),
  );
  return { pulling, onPullRefresh, refetchInPlace };
}
