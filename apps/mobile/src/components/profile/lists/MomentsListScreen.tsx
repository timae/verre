import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';
import {
  MomentFilterSheet, NO_FILTERS, momentFilterCount, toMomentParams, useMomentFilterOptions, type Filters,
} from '@/components/moments/MomentFilters';
import { RoleChip } from '@/components/moments/RoleChip';
import { CenteredMessage, ErrorState } from '@/components/ui/ConnectionState';
import { VText } from '@/components/ui/VText';
import { ListGoneError, getSharedMomentsPage, profileListKey } from '@/lib/api/lists';
import { getMomentsPage, type SessionRole } from '@/lib/api/sessions';
import { profileQueryOptions } from '@/lib/api/users';
import { firstName } from '@/lib/initials';
import { GUTTER, TAB_BAR_CLEARANCE, usePhoneTokens } from '@/lib/layout';
import { useMeId } from '@/lib/meId';
import { recentMeta } from '@/lib/momentFormat';
import { momentEntry, momentRowKey } from '@/lib/momentEntry';
import { lookHref, sessionHref, useSessionTab } from '@/lib/sessionStack';
import { usePushGuard } from '@/lib/usePushGuard';
import { useTheme } from '@/theme';
import { ListNote, ListRow, MonthHeader, ToolRow, groupByMonth } from './ListParts';
import { ToolButton } from '@/components/ui/ToolButton';
import { useListRefresh } from './useListRefresh';
import { useScreenReaderEnabled } from '@/lib/screenReader';

// Your Moments (design 04·9a) or someone's (lists plan D5, herMoms): grouped
// by month (the moment's date, else when it was made), newest first, both
// tenses. Yours read /api/me/sessions (`tense` omitted, `limit` sent) with
// "+ New" in the bar (moment create on this stack, D8; not on an opened post's
// stack); someone's read /api/users/:id/moments: the moments you SHARE (a
// code: the moment itself, and a "You were there" line, Moment Visibility R7)
// and, with Moment Visibility on, those you may only LOOK INTO (a moment id,
// no code: the look-in; no line), then "Mara joined 12 other moments." while
// no search or filter is on. The filter is the shared moments filter (D14):
// your role on yours, THEIR role on theirs; hosts = You (+ them) + your
// friends. Deviation (flagged, plan D5): no "Only Moments We Shared" switch;
// the Invite pill is later.

type Row = {
  key: string; code?: string; momentId?: string; shared: boolean; name: string; when: string | null
  dateFrom: string | null; address: string | null; cover: string | null; role: SessionRole
};

export function MomentsPane({ userId, active: shown }: { userId: string; active: boolean }) {
  const screenReader = useScreenReaderEnabled();
  const { theme } = useTheme();
  const router = useRouter();
  const mount = useSessionTab();
  const guard = usePushGuard();
  const meId = useMeId();
  const own = meId === userId;
  const headerQ = useQuery(profileQueryOptions(userId));
  const profile = headerQ.data?.state === 'ok' ? headerQ.data : null;
  const who = profile ? firstName(profile.name) : null;

  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const owner = useMemo(() => (!own && profile ? { key: `u:${userId}`, label: profile.name, imageUrl: profile.imageUrl } : undefined), [own, profile, userId]);
  const { hostOptions, peopleOptions, friendKeys, categoryOptions } = useMomentFilterOptions(owner);
  const params = useMemo(() => ({ q: search || undefined, ...toMomentParams(filters) }), [search, filters]);

  const listQ = useInfiniteQuery({
    // Yours under ['my-sessions', …] so every app-wide my-sessions
    // invalidation (create, roles, settings) cascades here too.
    queryKey: own ? ['my-sessions', 'all', params] : profileListKey('moments', userId, params),
    queryFn: async ({ pageParam }) => {
      if (own) {
        const p = await getMomentsPage({ ...params, cursor: pageParam, limit: 30 });
        return { rows: p.rows.map((r): Row => ({ key: r.code, code: r.code, shared: false, name: r.name || r.host_name, when: r.date_from ?? r.created_at, dateFrom: r.date_from, address: r.address, cover: r.cover_photo_url, role: r.role })), nextCursor: p.nextCursor, otherCount: undefined as number | undefined };
      }
      const p = await getSharedMomentsPage(userId, params, pageParam);
      return {
        rows: p.items.map((r): Row => ({
          key: momentRowKey(r), code: r.code, momentId: r.momentId, shared: r.code != null,
          // An open moment's name is null when it has none and its host is hidden from you.
          name: r.name ?? (r.code ? '' : 'Untitled Moment'),
          when: r.dateFrom ?? r.createdAt, dateFrom: r.dateFrom, address: r.address ?? null, cover: r.coverPhotoUrl, role: r.role,
        })),
        nextCursor: p.nextCursor, otherCount: p.otherCount,
      };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    retry: (n, e) => !(e instanceof ListGoneError) && n < 1,
    // `own` is only known once the viewer is (yours read another endpoint).
    enabled: meId != null,
  });
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return (listQ.data?.pages ?? []).flatMap((p) => p.rows).filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
  }, [listQ.data]);
  const grouped = useMemo(() => groupByMonth(rows, (r) => r.when, (r) => r.key), [rows]);
  const { pulling, onPullRefresh } = useListRefresh(listQ.refetch, headerQ.refetch);
  const active = momentFilterCount(filters);
  const narrowed = search !== '' || active > 0;
  const otherCount = listQ.data?.pages[0]?.otherCount ?? 0;

  let body: React.ReactNode;
  if (listQ.error instanceof ListGoneError) {
    body = <CenteredMessage title="These moments aren’t available" />;
  } else if (listQ.isPending) {
    body = <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={theme.inkSoft} /></View>;
  } else if (listQ.isError && rows.length === 0) {
    body = <ErrorState onRetry={() => listQ.refetch()} retrying={listQ.isFetching} />;
  } else {
    body = (
      <FlatList
        removeClippedSubviews={!screenReader}
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
        ListEmptyComponent={<ListNote>{narrowed ? 'Nothing matches.' : own ? 'No moments yet.' : 'No moments together yet.'}</ListNote>}
        ListFooterComponent={
          <>
            {listQ.isFetchingNextPage ? <View style={{ paddingVertical: 16, alignItems: 'center' }}><ActivityIndicator color={theme.inkSoft} /></View> : null}
            {/* The closing line (D5): their other moments, only as a count, and
                only once the shared ones are all on screen. */}
            {!own && !narrowed && otherCount > 0 && !listQ.hasNextPage && who ? (
              <VText variant="small" color="inkSoft" style={{ paddingTop: 16 }}>
                {`${who} joined ${otherCount} other ${otherCount === 1 ? 'moment' : 'moments'}.`}
              </VText>
            ) : null}
          </>
        }
        renderItem={({ item: g }) => g.kind === 'month'
          ? <MonthHeader label={g.label} first={g.first} />
          : <MomentListRow row={g.row} onPress={() => guard(() => {
              const to = momentEntry(g.row);
              if (to.kind === 'moment') router.push(sessionHref(mount, '', { code: to.code }));
              else if (to.kind === 'look') router.push(lookHref(mount, '', { momentId: to.momentId }));
            })} />}
      />
    );
  }

  return (
      <View style={{ flex: 1, display: shown ? 'flex' : 'none' }}>
        <View style={{ paddingHorizontal: GUTTER }}>
          <ToolRow query={query} onQuery={setQuery} placeholder="Search moments">
            <ToolButton icon="funnel" label={active > 0 ? `Filter, ${active} active` : 'Filter'} active={active > 0} count={active} onPress={() => setFilterOpen(true)} />
          </ToolRow>
        </View>
        {body}
        <MomentFilterSheet
          open={filterOpen}
          onClose={() => setFilterOpen(false)}
          filters={filters}
          onChange={setFilters}
          hostOptions={hostOptions}
          peopleOptions={peopleOptions}
          categoryOptions={categoryOptions}
          friendKeys={friendKeys}
          role={own ? undefined : who ? { title: `${who}’s Role`, a11y: `Filter by ${who}’s role` } : { title: 'Role', a11y: 'Filter by role' }}
        />
      </View>
  );
}

function MomentListRow({ row, onPress }: { row: Row; onPress: () => void }) {
  const phone = usePhoneTokens();
  // When · where: the moment's set date (none shown without one) and its own address.
  const meta = [recentMeta(row.dateFrom, null), row.address].filter(Boolean).join(' · ') || null;
  return (
    <ListRow
      uri={row.cover}
      title={row.name}
      meta={meta}
      chevron
      onPress={onPress}
      below={row.role || row.shared ? (
        <View style={{ marginTop: phone.lerp(5, 8), flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {row.role ? <RoleChip role={row.role} /> : null}
          {/* Someone's list: a moment you were in (Moment Visibility R7). */}
          {row.shared ? <VText variant="small" color="inkSoft">You were there</VText> : null}
        </View>
      ) : null}
    />
  );
}
