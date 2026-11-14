import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SheetSearchField } from '@/components/ui/SheetSearchField';
import { MomentFilterSheet, NO_FILTERS, momentFilterCount, toMomentParams, useMomentFilterOptions, type Filters } from '@/components/moments/MomentFilters';
import { RoleChip } from '@/components/moments/RoleChip';
import { Icon } from '@/components/ui/Icon';
import { Thumb } from '@/components/ui/Thumb';
import { ToolButton } from '@/components/ui/ToolButton';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { ConnectionBanner, ErrorState, connectionView } from '@/components/ui/ConnectionState';
import { ApiError, getMomentsPage, type MomentQuery, type MySessionRow } from '@/lib/api/sessions';
import { GUTTER, TAB_BAR_CLEARANCE, usePhoneTokens } from '@/lib/layout';
import { recentMeta } from '@/lib/momentFormat';
import { useTheme } from '@/theme';

// ── search + filters (Simon's 2026-07-03 spec: date, your role, host) ───────
//
// 02s·B: the search + facets moved SERVER-SIDE (moments-server-filtering.md
// Part B). This screen no longer filters/sorts the payload — it sends the
// query + filter params and pages the whole matching history on nextCursor.
// The `q`/facets debounce into the request key; the server owns accent-folding,
// typo tolerance, the date window, role/host/people/category facets, and the
// list order (upcoming soonest-first, recent newest-first).

// Keep pulling pages until at least this many rows are loaded, so a page that
// under-fills (server-side kicked-row drop leaves fewer than requested) still
// grows a scrollable list rather than stalling — onEndReached can't fire on a
// list too short to scroll. A hair over one screenful of ~72pt rows.
const MIN_SCROLLABLE = 12;

// 02s·2 — pushed "All moments" list to the .sh-row pixel spec: flat rows
// with rule-soft separators (no cards), 46px thumb, name 15/600, meta 13,
// role chip on its own line, chevron. Shows EVERY moment (incl. the ones
// surfaced in the home carousel). Sorted by effective date (set date, else
// created) newest-first — NOT by the server's activity order, so a recent
// visit doesn't jump the date sort. Rows push back into the session: a
// date-past moment opens normally (a Postgres-backed one is reopenable
// whatever its age); one deleted since the list loaded lands on the session
// screen's "This moment isn't available" state.
export default function AllMoments() {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const queryClient = useQueryClient();
  const { filter } = useLocalSearchParams<{ filter?: string }>();
  const upcoming = filter === 'upcoming';
  const tense: 'upcoming' | 'past' = upcoming ? 'upcoming' : 'past';
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const activeCount = momentFilterCount(filters);
  const narrowed = query.trim() !== '' || activeCount > 0;

  // Debounce the search text (300ms) so a fresh request key isn't minted on
  // every keystroke — the server owns matching, we just avoid a fetch storm.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  // The full request the server executes — the infinite-query key. Every facet
  // + the debounced q ride it, so changing any filter starts a fresh paged
  // stream from page 1.
  const params: Omit<MomentQuery, 'cursor'> = useMemo(
    () => ({
      tense,
      q: debouncedQuery || undefined,
      ...toMomentParams(filters),
    }),
    [tense, debouncedQuery, filters],
  );

  const sessions = useInfiniteQuery({
    // Prefix is ['my-sessions', …] so the app-wide invalidateQueries({queryKey:
    // ['my-sessions']}) calls (create, PeopleSheet, useSessionPoll, impression,
    // settings) CASCADE to this query too — a role/name change made elsewhere
    // refreshes the filtered list without waiting for the focus refetch below.
    queryKey: ['my-sessions', 'search', params],
    queryFn: ({ pageParam }) => getMomentsPage({ ...params, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 15_000,
    // Keep the previous pages on screen while a new filter/search key loads, so
    // toggling a facet doesn't blank the whole screen to a spinner (the old
    // client-side filtering was zero-flicker; this restores that feel).
    placeholderData: keepPreviousData,
  });
  // Returning from a session must reflect a just-changed role (promoted/
  // demoted in-session) without an app reload — mirrors the moments-home
  // refetch-on-focus (PR #65 review #2). Invalidate by the ['my-sessions']
  // PREFIX (not sessions.refetch()) so it hits the CURRENT filtered key: this
  // effect's deps are empty (fire once per focus), but `sessions` is a fresh
  // observer whenever a filter/search changes — a captured sessions.refetch()
  // would refresh the STALE key. Prefix invalidation is closure-independent.
  useFocusEffect(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
    }, [queryClient]),
  );
  // The server already filtered + ordered every page (upcoming soonest-first,
  // recent newest-first); the client just flattens the pages in order.
  const moments = useMemo(
    () => (sessions.data?.pages ?? []).flatMap((p) => p.rows),
    [sessions.data],
  );
  // Auto-advance when a page under-fills but more pages exist. Two server-side
  // thinners can make a page render fewer rows than requested WITHOUT being the
  // end: kicked-row drop (removed post-SQL, so nextCursor still points past
  // them) and, in principle, any post-enrichment filter. A too-short list
  // doesn't scroll, so onEndReached never fires and paging would stall with
  // visible rows still unreached. This pulls the next page until the list is
  // tall enough to scroll (or the history is exhausted).
  // Guards, all load-bearing: !isPlaceholderData (don't chase the previous
  // query's cursor), !isFetching (any fetch in flight, not just next-page —
  // don't stack), and !isError (a FAILED next-page leaves hasNextPage true +
  // the list short, so without this the effect re-fires immediately → tight
  // retry loop hammering a failing endpoint). Primitive deps so the effect keys
  // on the actual state, not the sessions object's per-render identity.
  const canAutoAdvance =
    sessions.hasNextPage &&
    !sessions.isFetching &&
    !sessions.isPlaceholderData &&
    !sessions.isError &&
    moments.length < MIN_SCROLLABLE;
  const fetchNextPage = sessions.fetchNextPage;
  useEffect(() => {
    if (canAutoAdvance) fetchNextPage();
  }, [canAutoAdvance, fetchNextPage]);

  const { hostOptions, peopleOptions, friendKeys, categoryOptions } = useMomentFilterOptions();

  // The search + filter line shows whenever there's anything to narrow OR a
  // narrow is already active (so an over-narrow that empties the list still
  // lets you widen it back). Only a truly-empty, never-narrowed history hides
  // the line.
  const hasAnything = moments.length > 0 || narrowed;

  // Connection failure: full ErrorState when the filtered list is empty AND the
  // fetch errored (nothing to show); a top banner when we still have rows.
  // When the CURRENT query errored while keepPreviousData is showing the PRIOR
  // query's rows (isPlaceholderData), those rows belong to the OLD filter — don't
  // count them as valid data under the NEW chips, or the user sees mismatched
  // results with only a banner. Treat as "no data" → full ErrorState for the
  // failed filter change.
  const showingStaleOnError = sessions.isError && sessions.isPlaceholderData;
  const conn = connectionView(sessions.isError, moments.length > 0 && !showingStaleOnError);
  // A 429 from the search/friend filters (the only rate-limited params) is a
  // "you searched too fast" wait, not a connectivity failure — surface the
  // server's human wait message instead of the generic "can't reach server".
  const rlError = sessions.error instanceof ApiError && sessions.error.kind === 'rate-limited'
    ? sessions.error.message
    : null;

  // The VBar always renders (back-nav stays available); the body below it
  // switches between spinner / error / banner+list.
  return (
    <BottomSheetModalProvider>
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={upcoming ? 'Upcoming Moments' : 'Recent Moments'} />
      </View>
      {/* Search + filter line (compare-toolbar pattern: pill matches the chip
          skin). Shown whenever there's anything to narrow OR a narrow is
          already active (so an over-narrow can be widened back) — hidden only
          on a truly-empty, never-narrowed history. */}
      {hasAnything ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: GUTTER, paddingTop: 6, paddingBottom: 2 }}>
          <ToolButton
            icon="funnel"
            label={activeCount > 0 ? `Filters, ${activeCount} active` : 'Filters'}
            active={activeCount > 0}
            count={activeCount}
            onPress={() => setFilterOpen(true)}
          />
          <View style={{ flex: 1 }}>
            <SheetSearchField value={query} onChangeText={setQuery} placeholder="Search moments" />
          </View>
        </View>
      ) : null}
      {/* Full-screen spinner ONLY on the genuine first load (no data yet). With
          keepPreviousData a filter/search key change keeps the prior pages up
          and flips isPlaceholderData instead of isPending, so the pill +
          results stay on screen while the new query resolves. */}
      {sessions.isPending && moments.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : conn === 'error' ? (
        rlError ? (
          <ErrorState title="Slow down a moment" message={rlError} onRetry={() => sessions.refetch()} retrying={sessions.isFetching} />
        ) : (
          <ErrorState onRetry={() => sessions.refetch()} retrying={sessions.isFetching} />
        )
      ) : (
        <>
          {conn === 'banner' ? (
            <View style={{ paddingTop: 6 }}>
              <ConnectionBanner onRetry={() => sessions.refetch()} />
            </View>
          ) : null}
          <FlatList
            data={moments}
            keyExtractor={(r) => String(r.id)}
            contentContainerStyle={{
              paddingHorizontal: GUTTER,
              paddingTop: phone.lerp(4, 8),
              paddingBottom: TAB_BAR_CLEARANCE,
            }}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.ruleSoft }} />}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => <RecentRow row={item} />}
            // Infinite scroll on nextCursor — the server pages the whole
            // matching history. Guards: hasNextPage + !isFetchingNextPage (don't
            // double-fire) AND !isPlaceholderData — during a filter/search key
            // change keepPreviousData shows the OLD query's rows + hasNextPage +
            // cursor; fetching "next" then would page the new query with a stale
            // cursor and skip/dupe rows. Wait for the new query to resolve.
            onEndReachedThreshold={0.6}
            onEndReached={() => {
              if (sessions.hasNextPage && !sessions.isFetchingNextPage && !sessions.isPlaceholderData) {
                sessions.fetchNextPage();
              }
            }}
            ListFooterComponent={
              sessions.isFetchingNextPage ? (
                <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                  <ActivityIndicator />
                </View>
              ) : undefined
            }
            ListEmptyComponent={
              <VText variant="small" color="inkSoft">
                {narrowed ? 'No moments match.' : upcoming ? 'Nothing upcoming.' : 'No moments yet.'}
              </VText>
            }
          />
        </>
      )}
      <MomentFilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        filters={filters}
        onChange={setFilters}
        hostOptions={hostOptions}
        peopleOptions={peopleOptions}
        categoryOptions={categoryOptions}
        friendKeys={friendKeys}
      />
    </View>
    </BottomSheetModalProvider>
  );
}

function RecentRow({ row }: { row: MySessionRow }) {
  const { theme } = useTheme();
  const router = useRouter();
  const phone = usePhoneTokens();
  const surface = phone.surface('compactList');
  const meta = recentMeta(row.date_from, row.name ? (row.role === 'host' ? 'you' : row.host_name) : null);
  return (
    // .sh-row base: gap 12, 10px vertical padding, transparent.
    <Pressable
      accessibilityRole="button"
      // dangerouslySingular: react-native-screens 4.30 no longer sinks touches
      // during a push transition on iOS 26, so a fast double-tap pushed the
      // same session twice (device pass 2026-11-05). Singular keys the push on
      // name+params: the second tap finds the route already there.
      onPress={() => router.push({ pathname: '/moments/session/[code]', params: { code: row.code } }, { dangerouslySingular: true })}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: phone.lerp(12, 16),
        paddingVertical: surface.paddingY(phone.lerp(10, 16)),
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Thumb uri={row.cover_photo_url} size={phone.size('recentThumb')} />
      <View style={{ flex: 1, minWidth: 0, gap: surface.gap(phone.lerp(2, 4)) }}>
        <VText surface="compactList" numberOfLines={2} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {row.name || row.host_name}
        </VText>
        {/* Show ONLY the set date (date_from); a moment with no set date shows
            no date here (created_at is internal — used for ordering, never
            displayed). "Hosted by" suppressed when host_name is already the
            title; "you" when the viewer is the host (id-resolved, never a name).
            A date-less, name-less moment yields an empty string here — render
            nothing so it doesn't leave a blank line box between title + chip. */}
        {meta ? (
          <VText surface="compactList" variant="small" color="inkSoft" numberOfLines={2}>
            {meta}
          </VText>
        ) : null}
        {row.role ? (
          <View style={{ marginTop: phone.lerp(5, 8), flexDirection: 'row' }}>
            <RoleChip role={row.role} />
          </View>
        ) : null}
      </View>
      <Icon name="chevron-right" size={phone.size('recentChevron')} color={theme.inkFaint} />
    </Pressable>
  );
}
