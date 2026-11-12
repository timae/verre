import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AddFriendsSheet } from '@/components/people/AddFriendsSheet';
import { PeopleRow } from '@/components/people/PeopleRow';
import { ToggleRow } from '@/components/moments/settingsParts';
import { FollowButton, compactCount } from '@/components/profile/ProfileHeader';
import { CenteredMessage, ErrorState } from '@/components/ui/ConnectionState';
import { Icon } from '@/components/ui/Icon';
import { SheetSearchField } from '@/components/ui/SheetSearchField';
import { TabStrip } from '@/components/ui/TabStrip';
import { VText } from '@/components/ui/VText';
import { VBar } from '@/components/VBar';
import { PeopleGoneError, getPeoplePage, peopleKey, type PeopleTab, type PersonRow } from '@/lib/api/people';
import { profileQueryOptions } from '@/lib/api/users';
import { authClient } from '@/lib/authClient';
import { GUTTER, TAB_BAR_CLEARANCE, usePhoneTokens } from '@/lib/layout';
import { confirmUnfollow, relate, usePersonBusy } from '@/lib/relationship';
import { feedHref, useSessionTab } from '@/lib/sessionStack';
import { usePushGuard } from '@/lib/usePushGuard';
import { radius, useTheme } from '@/theme';

// People (handoff 04·11 / 04·11a / 04·11c): someone's Friends / Followers /
// Following, yours or anyone's whose profile you may see. Pushed from the
// profile's counts and in-common row (lib/sessionStack.ts feedHref 'people').
//
//   bar: "People" + (yours) the + Add pill → Add Friends, (theirs) your
//        connection to them (the FollowButton, D7 confirm on unfollow);
//   tabs: counted from their profile header (`compactCount`);
//   tool row (D12, a flagged deviation: the app's 36pt search standard, not
//        the mock's 46): yours = your code button + search; theirs = search,
//        then "Only people you know" (D4: people you follow, the server's
//        `known=1`; its count is the first page's `knownCount`);
//   rows: PeopleRow, one useInfiniteQuery per (id, tab, known, q); search
//        debounced 250 ms, from 2 characters.
// Relationship writes go through lib/relationship.ts: an unfollow that went
// through takes the row off a list your follow put them on (your Friends and
// Following, their "Only People You Know"); the confirm is the slip guard
// (ruled 2026-11-12).

export function PeopleScreen({ userId, initialTab, initialKnown }: { userId: number; initialTab: PeopleTab; initialKnown: boolean }) {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const router = useRouter();
  const mount = useSessionTab();
  const queryClient = useQueryClient();
  const guard = usePushGuard();
  const sessionId = authClient.useSession().data?.user.id;
  const meId = sessionId != null ? Number(sessionId) : null;
  const own = meId === userId;

  const headerQ = useQuery(profileQueryOptions(userId));
  const profile = headerQ.data;
  const full = profile?.state === 'ok' ? profile : null;

  const [tab, setTab] = useState<PeopleTab>(initialTab);
  const [knownOn, setKnown] = useState(initialKnown);
  const known = knownOn && !own;
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const q = query.trim();
    const t = setTimeout(() => setSearch(q.length >= 2 ? q : ''), 250);
    return () => clearTimeout(t);
  }, [query]);
  const [addOpen, setAddOpen] = useState(false);

  const listQ = useInfiniteQuery({
    queryKey: peopleKey(userId, tab, known, search),
    queryFn: ({ pageParam }) => getPeoplePage(userId, tab, { known, q: search || undefined, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
    staleTime: 15_000,
    retry: (n, e) => !(e instanceof PeopleGoneError) && n < 1,
  });

  // "Friends and people you follow · N" per tab, kept while a search runs
  // (a q page carries no count). Before the Friends tab's first page, the
  // header's in-common count is the same number (lib/profileHeader.ts).
  const [knownCounts, setKnownCounts] = useState<Partial<Record<PeopleTab, number>>>({});
  const firstKnown = listQ.data?.pages[0]?.knownCount;
  useEffect(() => {
    if (firstKnown !== undefined) setKnownCounts((c) => (c[tab] === firstKnown ? c : { ...c, [tab]: firstKnown }));
  }, [firstKnown, tab]);
  const knownCount = knownCounts[tab] ?? (tab === 'friends' ? full?.inCommon?.count : undefined);

  const rows = useMemo(() => {
    const seen = new Set<number>();
    return (listQ.data?.pages ?? []).flatMap((p) => p.users).filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }, [listQ.data]);
  const onFollowRow = (row: PersonRow) => {
    if (row.isFollowing) confirmUnfollow({ name: row.name, followsYou: row.followsViewer }, () => void relate(queryClient, row.id, 'unfollow', meId));
    else void relate(queryClient, row.id, 'follow');
  };

  // Your connection to them, top right (theirs only).
  const ownerBusy = usePersonBusy(userId);
  const relOwner = profile && !own && (profile.state === 'ok' || profile.state === 'shell') ? profile : null;
  const ownerFollow = () => {
    if (!relOwner) return;
    if (relOwner.isFollowing) confirmUnfollow(relOwner, () => void relate(queryClient, userId, 'unfollow', meId));
    else void relate(queryClient, userId, 'follow');
  };
  const barRight = own ? (
    <AddPill onPress={() => setAddOpen(true)} />
  ) : relOwner ? (
    <FollowButton isFollowing={relOwner.isFollowing} followsYou={relOwner.followsYou} busy={ownerBusy} onPress={ownerFollow} name={relOwner.name} />
  ) : null;

  const counts: Record<PeopleTab, number | null> = {
    friends: full?.friendsCount ?? null,
    followers: full?.stats.followers ?? null,
    following: full?.stats.following ?? null,
  };
  const tabs = (['friends', 'followers', 'following'] as const).map((key) => {
    const word = key === 'friends' ? 'Friends' : key === 'followers' ? 'Followers' : 'Following';
    const n = counts[key];
    return { key, label: n == null ? word : `${word} ${compactCount(n)}`, accessibilityLabel: n == null ? word : `${word}, ${n}` };
  });

  // Pull-to-refresh, the house pattern (FeedList / Moments home): an explicit
  // `pulling` state with a 600 ms floor, never `isRefetching` (the trailing
  // refresh after every follow would spin it).
  const [pulling, setPulling] = useState(false);
  const onPullRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setPulling(true);
    const minVisible = new Promise<void>((r) => setTimeout(r, 600));
    Promise.allSettled([headerQ.refetch(), listQ.refetch(), minVisible]).then(() => setPulling(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerQ.refetch, listQ.refetch]);

  const gone = listQ.error instanceof PeopleGoneError;
  const emptyText = search
    ? 'No matches.'
    : known
      ? 'No one you know here yet.'
      : !own
        ? 'No one here yet.'
        : tab === 'friends' ? 'No friends yet.' : tab === 'followers' ? 'No followers yet.' : 'Not following anyone yet.';

  let body: React.ReactNode;
  if (gone) {
    body = <CenteredMessage title="These people aren’t available" />;
  } else {
    const listBody = listQ.isPending ? (
      <View style={{ paddingVertical: 40, alignItems: 'center' }}>
        <ActivityIndicator color={theme.inkSoft} />
      </View>
    ) : listQ.isError && !listQ.data ? (
      <View style={{ height: 320 }}>
        <ErrorState onRetry={() => listQ.refetch()} retrying={listQ.isFetching} />
      </View>
    ) : null;
    body = (
      <>
        <View style={{ paddingHorizontal: GUTTER }}>
          <TabStrip tabs={tabs} active={tab} onSelect={setTab} fit />
          {/* .yo-toolrow — 36pt round button + the app's search pill (D12). */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
            {own ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Your Code and Scan"
                onPress={() => setAddOpen(true)}
                hitSlop={{ top: 4, bottom: 4 }}
                style={({ pressed }) => ({
                  width: 36, height: 36, borderRadius: 999, borderWidth: 1, borderColor: theme.rule, backgroundColor: theme.surface,
                  alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1,
                })}
              >
                <Icon name="qr" size={17} color={theme.inkSoft} />
              </Pressable>
            ) : null}
            <View style={{ flex: 1 }}>
              <SheetSearchField value={query} onChangeText={setQuery} placeholder="Search people" />
            </View>
          </View>
        </View>
        <FlatList
          data={listBody ? [] : rows}
          keyExtractor={(r) => String(r.id)}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: TAB_BAR_CLEARANCE }}
          refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPullRefresh} tintColor={theme.inkSoft} />}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (listQ.hasNextPage && !listQ.isFetchingNextPage) void listQ.fetchNextPage();
          }}
          ListHeaderComponent={
            own ? undefined : (
              <View style={{ paddingBottom: 6 }}>
                <ToggleRow
                  flush
                  title="Only People You Know"
                  subtitle={knownCount == null ? 'Friends and people you follow' : `Friends and people you follow · ${knownCount}`}
                  value={known}
                  onChange={setKnown}
                />
              </View>
            )
          }
          ListEmptyComponent={
            listBody ?? (
              <VText variant="small" color="inkSoft" style={{ paddingVertical: 16 }}>
                {emptyText}
              </VText>
            )
          }
          ListFooterComponent={
            <>
              {listQ.isFetchingNextPage ? (
                <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                  <ActivityIndicator color={theme.inkSoft} />
                </View>
              ) : null}
              {own ? (
                // .yo-foot
                <VText variant="caption" color="inkFaint" style={{ marginTop: 12 }}>
                  Friends = you follow each other.
                </VText>
              ) : null}
            </>
          }
          renderItem={({ item }) => (
            <PeopleRow
              row={item}
              self={item.id === meId}
              onPress={() => guard(() => router.push(feedHref(mount, 'profile', { id: String(item.id) })))}
              onFollow={() => onFollowRow(item)}
            />
          )}
        />
      </>
    );
  }

  return (
    // A SCREEN-LOCAL provider for the Add Friends sheet (apps/mobile/CLAUDE.md:
    // there is no root provider).
    <BottomSheetModalProvider>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={{ paddingHorizontal: GUTTER }}>
          <VBar title="People" right={barRight} />
        </View>
        {body}
        {own ? <AddFriendsSheet open={addOpen} onClose={() => setAddOpen(false)} meId={userId} /> : null}
      </View>
    </BottomSheetModalProvider>
  );
}

// .hv-add — the bar's accent pill (34h, glyph 17, label small 600, pad 0 14 0
// 11): Moments home's NewPill metrics, copied (the pending <IconPill>
// extraction in apps/mobile/CLAUDE.md), with the design's user-plus glyph.
function AddPill({ onPress }: { onPress: () => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('button');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add Friends"
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
      <Icon name="user-plus" size={phone.size('actionIcon')} color={theme.accentInk} />
      <VText surface="button" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small'), color: theme.accentInk }}>
        Add
      </VText>
    </Pressable>
  );
}
