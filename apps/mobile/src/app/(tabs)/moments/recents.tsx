import { BottomSheetModalProvider, BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SheetSearchField } from '@/components/moments/CompareBody';
import { DateField, SelectField } from '@/components/moments/momentForm';
import { Avatar } from '@/components/ui/Avatar';
import { RoleChip } from '@/components/moments/RoleChip';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { Thumb } from '@/components/ui/Thumb';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { ConnectionBanner, ErrorState, connectionView } from '@/components/ui/ConnectionState';
import { getMyFriends } from '@/lib/api/me';
import { ApiError, getMomentsPage, type MomentQuery, type MySessionRow } from '@/lib/api/sessions';
import { GUTTER, TAB_BAR_CLEARANCE, usePhoneTokens } from '@/lib/layout';
import { recentMeta } from '@/lib/momentFormat';
import { fuzzyIncludes } from '@/lib/search';
import { useTheme } from '@/theme';

// ── search + filters (Simon's 2026-07-03 spec: date, your role, host) ───────
//
// 02s·B: the search + facets moved SERVER-SIDE (moments-server-filtering.md
// Part B). This screen no longer filters/sorts the payload — it sends the
// query + filter params and pages the whole matching history on nextCursor.
// The `q`/facets debounce into the request key; the server owns accent-folding,
// typo tolerance, the date window, role/host/people/category facets, and the
// list order (upcoming soonest-first, recent newest-first).

type RoleKey = 'host' | 'cohost' | 'provider' | 'taster';
const ROLE_OPTIONS: { key: RoleKey; label: string }[] = [
  { key: 'host', label: 'Host' },
  { key: 'cohost', label: 'Co-host' },
  { key: 'provider', label: 'Provider' },
  { key: 'taster', label: 'Taster' },
];

// v1 category is wine-only (the create form is non-interactive on it); NULL
// rows predate the column and are wine too. The picker offers just Wine; the
// server folds NULL → 'wine'.
const CATEGORY_LABELS: Record<string, string> = { wine: 'Wine' };
const categoryLabel = (code: string) => CATEGORY_LABELS[code] ?? code.charAt(0).toUpperCase() + code.slice(1);

// Multi-select facets: empty array = "any". Roles and hosts OR within the
// facet (a session has ONE of each for you); people is AND — "the moments
// Anna AND Tim were both at" is the find-that-dinner query. People + host
// options are the viewer's FRIENDS (+ "You" for hosts): the server derives
// matches, so the picker only needs candidate ids, not a history scan (a
// non-friend host you shared a moment with is the deferred host-facet — see
// the proposal). Facet keys map 1:1 to the server params.
type Filters = { roles: RoleKey[]; hosts: string[]; people: string[]; category: string; from: Date | null; to: Date | null };
const NO_FILTERS: Filters = { roles: [], hosts: [], people: [], category: 'any', from: null, to: null };

// Keep pulling pages until at least this many rows are loaded, so a page that
// under-fills (server-side kicked-row drop leaves fewer than requested) still
// grows a scrollable list rather than stalling — onEndReached can't fire on a
// list too short to scroll. A hair over one screenful of ~72pt rows.
const MIN_SCROLLABLE = 12;

// The date filter is a plain "which local day" window, but the server compares
// against a stored INSTANT (timestamptz), so we send the picked local day's
// bounds as UTC instants: the START of the local day for `from`, the END of the
// local day for `to`. Because the moment cards render in device-local time too
// (momentFormat.ts toLocaleDateString), "July 5" here means exactly the July 5
// the user sees — no UTC-boundary off-by-a-day. The Date the picker returns is
// some instant on the chosen day; we re-derive local midnight / end-of-day from
// its local Y-M-D so the time-of-day the user happened to pick doesn't leak in.
function dayStartISO(d: Date | null): string | null {
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).toISOString();
}
function dayEndISO(d: Date | null): string | null {
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).toISOString();
}

// 02s·2 — pushed "All moments" list to the .sh-row pixel spec: flat rows
// with rule-soft separators (no cards), 46px thumb, name 15/600, meta 13,
// role chip on its own line, chevron. Shows EVERY moment (incl. the ones
// surfaced in the home carousel). Sorted by effective date (set date, else
// created) newest-first — NOT by the server's activity order, so a recent
// visit doesn't jump the date sort. Rows push back into the session: a
// date-past session is often still Redis-alive and opens normally; a truly
// expired one lands on the session screen's "This moment has ended" state.
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
  // Which facet picker the filter sheet should open WITH (active-chip edit).
  const [editPicker, setEditPicker] = useState<'roles' | 'hosts' | 'people' | null>(null);
  const openFilter = (facet: 'roles' | 'hosts' | 'people' | null = null) => {
    setEditPicker(facet);
    setFilterOpen(true);
  };
  const activeCount =
    (filters.roles.length > 0 ? 1 : 0) +
    (filters.hosts.length > 0 ? 1 : 0) +
    (filters.people.length > 0 ? 1 : 0) +
    (filters.category !== 'any' ? 1 : 0) +
    (filters.from || filters.to ? 1 : 0);
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
      roles: filters.roles,
      hosts: filters.hosts,
      people: filters.people,
      category: filters.category,
      from: dayStartISO(filters.from),
      to: dayEndISO(filters.to),
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

  const friends = useQuery({ queryKey: ['my-friends'], queryFn: getMyFriends, staleTime: 60_000 });
  // Filter-option candidates come from the friend list, NOT the loaded page
  // (paginated — a host/friend on a later page would otherwise vanish from
  // their own option list). The server decides the actual matches; the picker
  // only needs candidate ids. People = all friends (Simon's ruling: no counts,
  // show all — the count was cosmetic and only ever page-accurate). Hosts =
  // "You" + friends (a non-friend host is the deferred host-facet).
  const peopleOptions = useMemo(
    () =>
      (friends.data ?? [])
        .map((f) => ({ key: `u:${f.id}`, label: f.name, imageUrl: f.imageUrl }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [friends.data],
  );
  const hostOptions = useMemo(
    () => [
      { key: 'me', label: 'You' },
      ...(friends.data ?? [])
        .map((f) => ({ key: `u:${f.id}`, label: f.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
    [friends.data],
  );
  // Friend identity keys for the host picker's Friends chip ("u:<id>").
  const friendKeys = useMemo(() => new Set((friends.data ?? []).map((f) => `u:${f.id}`)), [friends.data]);
  // v1: wine only. NULL folds to wine server-side.
  const categoryOptions = useMemo(() => [{ code: 'wine', label: categoryLabel('wine') }], []);

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
        <VBar title={upcoming ? 'Upcoming moments' : 'Recent moments'} />
      </View>
      {/* Search + filter line (compare-toolbar pattern: pill matches the chip
          skin). Shown whenever there's anything to narrow OR a narrow is
          already active (so an over-narrow can be widened back) — hidden only
          on a truly-empty, never-narrowed history. */}
      {hasAnything ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: GUTTER, paddingTop: 6, paddingBottom: 2 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={activeCount > 0 ? `Filters — ${activeCount} active` : 'Filters'}
            onPress={() => openFilter()}
            hitSlop={{ top: 4, bottom: 4 }}
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, paddingHorizontal: 11,
              borderRadius: 999, borderWidth: 1, borderColor: theme.rule, backgroundColor: theme.surface,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Icon name="funnel" size={16} color={activeCount > 0 ? theme.accent : theme.inkSoft} />
            {activeCount > 0 ? (
              <VText surface="badge" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small') }}>
                {activeCount}
              </VText>
            ) : null}
          </Pressable>
          <View style={{ flex: 1 }}>
            <SheetSearchField value={query} onChangeText={setQuery} placeholder="Search moments" />
          </View>
        </View>
      ) : null}
      {activeCount > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: GUTTER, paddingTop: 8 }}>
          {filters.from || filters.to ? (
            <ActiveChip
              label={
                filters.from && filters.to
                  ? `${shortDay(filters.from)} – ${shortDay(filters.to)}`
                  : filters.from
                    ? `From ${shortDay(filters.from)}`
                    : `Until ${shortDay(filters.to!)}`
              }
              onEdit={() => openFilter()}
              onClear={() => setFilters({ ...filters, from: null, to: null })}
            />
          ) : null}
          {filters.roles.length > 0 ? (
            <ActiveChip
              label={summarize(ROLE_OPTIONS.filter((o) => filters.roles.includes(o.key)).map((o) => o.label))}
              onEdit={() => openFilter('roles')}
              onClear={() => setFilters({ ...filters, roles: [] })}
            />
          ) : null}
          {filters.hosts.length > 0 ? (
            <ActiveChip
              // Fall back to a count when a selected key isn't in the current
              // option list (e.g. a host who's no longer a friend) — never a
              // blank pill the user can't read but can still clear.
              label={summarize(hostOptions.filter((o) => filters.hosts.includes(o.key)).map((o) => o.label)) || `${filters.hosts.length} selected`}
              onEdit={() => openFilter('hosts')}
              onClear={() => setFilters({ ...filters, hosts: [] })}
            />
          ) : null}
          {filters.people.length > 0 ? (
            <ActiveChip
              label={summarize(peopleOptions.filter((o) => filters.people.includes(o.key)).map((o) => o.label)) || `${filters.people.length} selected`}
              onEdit={() => openFilter('people')}
              onClear={() => setFilters({ ...filters, people: [] })}
            />
          ) : null}
          {filters.category !== 'any' ? (
            <ActiveChip label={categoryLabel(filters.category)} onEdit={() => openFilter()} onClear={() => setFilters({ ...filters, category: 'any' })} />
          ) : null}
          {activeCount > 1 ? (
            <Pressable accessibilityRole="button" onPress={() => setFilters(NO_FILTERS)} hitSlop={6} style={({ pressed }) => ({ justifyContent: 'center', paddingHorizontal: 6, opacity: pressed ? 0.5 : 1 })}>
              <VText variant="small" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Clear all</VText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {/* Full-screen spinner ONLY on the genuine first load (no data yet). With
          keepPreviousData a filter/search key change keeps the prior pages up
          and flips isPlaceholderData instead of isPending, so the pill + chips
          + results stay on screen while the new query resolves. */}
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
              paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
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
              ) : null
            }
            ListEmptyComponent={
              <VText variant="small" color="inkSoft">
                {narrowed ? 'No moments match.' : upcoming ? 'Nothing upcoming.' : 'No moments yet.'}
              </VText>
            }
          />
        </>
      )}
      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        filters={filters}
        onChange={setFilters}
        hostOptions={hostOptions}
        peopleOptions={peopleOptions}
        categoryOptions={categoryOptions}
        friendKeys={friendKeys}
        initialPicker={editPicker}
      />
    </View>
    </BottomSheetModalProvider>
  );
}

// ── filter sheet — Date / Your role / Host / People / Category ──────────────
// Role, host and people are MULTI-select dropdowns (Simon's spec: "like the
// impression type"): a SelectField row summarising the picks opens a stacked
// check-list picker sheet (Sheet stackBehavior='push' returns here on close).

// Short day label for the active-date chip ("12 Jun").
const shortDay = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// .active-chip — one applied filter. Body tap EDITS (reopens the filter on
// that facet); only the ✕ removes (Simon's ruling — the inner Pressable wins
// the touch, same nesting pattern as the line-up row pills).
function ActiveChip({ label, onEdit, onClear }: { label: string; onEdit: () => void; onClear: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Edit filter ${label}`}
      onPress={onEdit}
      hitSlop={{ top: 5, bottom: 5 }}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 28, paddingLeft: 11,
        borderRadius: 999, borderWidth: 1, borderColor: theme.accentLine, backgroundColor: theme.accentTint,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <VText variant="small" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} numberOfLines={1}>
        {label}
      </VText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove filter ${label}`}
        onPress={onClear}
        hitSlop={{ top: 8, bottom: 8, left: 2, right: 4 }}
        style={({ pressed }) => ({ paddingHorizontal: 8, alignSelf: 'stretch', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
      >
        <Icon name="x" size={12} color={theme.accent} />
      </Pressable>
    </Pressable>
  );
}

// Empty → '' so SelectField shows its placeholder ("Any role" / "Anyone").
function summarize(labels: string[]): string {
  if (labels.length <= 2) return labels.join(', ');
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
}

function FilterSheet({
  open, onClose, filters, onChange, hostOptions, peopleOptions, categoryOptions, friendKeys, initialPicker,
}: {
  open: boolean;
  onClose: () => void;
  filters: Filters;
  onChange: (f: Filters) => void;
  hostOptions: { key: string; label: string }[];
  peopleOptions: { key: string; label: string; imageUrl: string | null }[];
  categoryOptions: { code: string; label: string }[];
  friendKeys: Set<string>;
  /** Facet picker to open immediately (active-chip edit path). */
  initialPicker: 'roles' | 'hosts' | 'people' | null;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [picker, setPicker] = useState<'roles' | 'hosts' | 'people' | null>(null);
  // Jump straight to the tapped facet's picker when opened from an active
  // chip (both sheets present this tick — parent mounts first, child stacks).
  useEffect(() => {
    if (open) setPicker(initialPicker);
  }, [open, initialPicker]);
  const roleLabels = ROLE_OPTIONS.filter((o) => filters.roles.includes(o.key)).map((o) => o.label);
  const hostLabels = hostOptions.filter((o) => filters.hosts.includes(o.key)).map((o) => o.label);
  const peopleLabels = peopleOptions.filter((o) => filters.people.includes(o.key)).map((o) => o.label);
  const chip = (k: string, label: string, on: boolean, onPress: () => void) => (
    <Pressable
      key={k}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      hitSlop={{ top: 5, bottom: 5 }}
      style={({ pressed }) => ({
        minHeight: 32, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1,
        borderColor: on ? theme.accentLine : theme.rule,
        backgroundColor: on ? theme.accentTint : theme.surface,
        alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1,
      })}
    >
      <VText variant="small" style={{ fontFamily: on ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium' }} color={on ? 'accent' : 'ink'}>
        {label}
      </VText>
    </Pressable>
  );
  const section = (label: string) => (
    <VText variant="label" color="inkSoft" style={{ letterSpacing: 1.54 }}>{label}</VText>
  );
  return (
    <>
      <Sheet open={open} onClose={onClose}>
        <BottomSheetView style={{ width: '100%', paddingHorizontal: 20, paddingTop: 12, paddingBottom: insets.bottom + 16, gap: 18 }}>
          <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Filter moments</VText>
          <View style={{ gap: 10 }}>
            {section('DATE')}
            {/* Whole days — the moment's shown date (or its created date when no
                date is set, matching the list order). */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <DateField label="From" mode="date" value={filters.from} onChange={(d) => onChange({ ...filters, from: d })} defaultValue={() => new Date()} maximumDate={filters.to ?? undefined} />
              <DateField label="To" mode="date" value={filters.to} onChange={(d) => onChange({ ...filters, to: d })} defaultValue={() => new Date()} minimumDate={filters.from ?? undefined} />
            </View>
          </View>
          <View style={{ gap: 10 }}>
            {section('YOUR ROLE')}
            <SelectField value={summarize(roleLabels)} placeholder="Any role" onPress={() => setPicker('roles')} accessibilityLabel="Filter by your role" />
          </View>
          <View style={{ gap: 10 }}>
            {section('HOST')}
            <SelectField value={summarize(hostLabels)} placeholder="Anyone" onPress={() => setPicker('hosts')} accessibilityLabel="Filter by host" />
          </View>
          {/* Friends only — anon guests aren't stable identities across
              moments and don't survive expiry; hidden with no friends. */}
          {peopleOptions.length > 0 ? (
            <View style={{ gap: 10 }}>
              {section('FRIENDS THERE')}
              <SelectField value={summarize(peopleLabels)} placeholder="Anyone" onPress={() => setPicker('people')} accessibilityLabel="Filter by friends who were part of the moment" />
            </View>
          ) : null}
          <View style={{ gap: 10 }}>
            {section('CATEGORY')}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {chip('any', 'Any', filters.category === 'any', () => onChange({ ...filters, category: 'any' }))}
              {categoryOptions.map((c) => chip(c.code, c.label, filters.category === c.code, () => onChange({ ...filters, category: c.code })))}
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 2 }}>
            <Button title="Reset" variant="secondary" block style={{ flex: 1 }} onPress={() => onChange(NO_FILTERS)} />
            <Button title="Done" block style={{ flex: 1 }} onPress={onClose} />
          </View>
        </BottomSheetView>
      </Sheet>
      <MultiPickSheet
        open={picker === 'roles'}
        onClose={() => setPicker(null)}
        title="Your role"
        options={ROLE_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
        selected={filters.roles}
        onClear={() => onChange({ ...filters, roles: [] })}
        onToggle={(k) =>
          onChange({ ...filters, roles: filters.roles.includes(k as RoleKey) ? filters.roles.filter((x) => x !== k) : [...filters.roles, k as RoleKey] })
        }
      />
      <MultiPickSheet
        open={picker === 'hosts'}
        onClose={() => setPicker(null)}
        title="Host"
        options={hostOptions}
        selected={filters.hosts}
        withAvatars
        search
        friendKeys={friendKeys}
        onClear={() => onChange({ ...filters, hosts: [] })}
        onToggle={(k) => onChange({ ...filters, hosts: filters.hosts.includes(k) ? filters.hosts.filter((x) => x !== k) : [...filters.hosts, k] })}
      />
      <MultiPickSheet
        open={picker === 'people'}
        onClose={() => setPicker(null)}
        title="Friends there"
        options={peopleOptions}
        selected={filters.people}
        withAvatars
        search
        onClear={() => onChange({ ...filters, people: [] })}
        onToggle={(k) => onChange({ ...filters, people: filters.people.includes(k) ? filters.people.filter((x) => x !== k) : [...filters.people, k] })}
      />
    </>
  );
}

// ── stacked multi-select picker (compare people-picker pattern: rows + round
// checks; search over long lists; pinned Clear|Apply footer). Sizing is the
// cap-aware recipe (ComparePickerSheet): CONTENT-SIZED while the estimate fits
// (dynamic sizing — but that mode can't scroll, rows past the cap would clip
// unreachably), else a snap sized to the CONTENT estimate capped at 85%, with
// rows in a BottomSheetScrollView. A searchable list always takes the snap
// mode so the sheet doesn't resize under every keystroke. layer=1: the pushed
// sheet's backdrop must dim the filter sheet BELOW it (see Sheet's layer doc).

function MultiPickSheet({
  open, onClose, title, options, selected, onToggle, onClear, withAvatars, search, friendKeys,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  options: { key: string; label: string; anon?: boolean; imageUrl?: string | null; caption?: string }[];
  selected: string[];
  onToggle: (key: string) => void;
  onClear: () => void;
  withAvatars?: boolean;
  /** Force the search row on (default: auto — lists past 7 rows get one). */
  search?: boolean;
  /** Enables the Friends chip beside the search row (host picker): narrows the
   *  options to keys in this set. Chip renders only when a friend is listed. */
  friendKeys?: Set<string>;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const phone = usePhoneTokens();
  const { height: windowH, fontScale } = useWindowDimensions();
  const [q, setQ] = useState('');
  const [friendsOnly, setFriendsOnly] = useState(false);
  const hasFriendOption = !!friendKeys && options.some((o) => friendKeys.has(o.key));
  const rows = options
    .filter((o) => !friendsOnly || !friendKeys || friendKeys.has(o.key))
    .filter((o) => !q.trim() || fuzzyIncludes(o.label, q));
  const searchable = search || options.length > 7;
  // Row = paddingVertical (comfort-scaled) ×2 + the taller of the text line
  // and the comfort-grown avatar; chrome = handle/title/paddings + the pinned
  // footer. The row's padding + avatar GROW on big phones (phone.lerp/grow),
  // so the estimate must feed the SAME grown values in — a flat estimate would
  // under-count and keep a near-cap roster in dynamic-fit mode where its bottom
  // rows clip unreachably (reviewer catch).
  const rowH = Math.max(phone.grow(30), Math.ceil((phone.text('body').lineHeight ?? 22) * fontScale)) + phone.lerp(10, 13) * 2 + 1;
  const chrome = 92 + (searchable ? 48 : 0) + 78 + insets.bottom;
  const estimate = chrome + options.length * rowH;
  const needsSnap = searchable || estimate > windowH * 0.85;
  const footer = (
    <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingTop: 10, paddingBottom: insets.bottom + 12, borderTopWidth: 1, borderTopColor: theme.rule }}>
      <Button title="Clear" variant="secondary" block style={{ flex: 1 }} disabled={selected.length === 0} onPress={onClear} />
      <Button
        title={selected.length > 0 ? `Apply (${selected.length})` : 'Apply'}
        block
        style={{ flex: 1 }}
        onPress={() => { setQ(''); setFriendsOnly(false); onClose(); }}
      />
    </View>
  );
  const head = (
    <View style={{ paddingHorizontal: 20, gap: 12 }}>
      <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{title}</VText>
      {searchable ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <SheetSearchField value={q} onChangeText={setQ} placeholder={`Search ${title.toLowerCase()}`} />
          </View>
          {hasFriendOption ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: friendsOnly }}
              accessibilityLabel={friendsOnly ? 'Show everyone' : 'Show friends only'}
              hitSlop={{ top: 5, bottom: 5 }}
              onPress={() => setFriendsOnly((f) => !f)}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 34,
                paddingHorizontal: 11, borderRadius: 999, borderWidth: 1,
                borderColor: friendsOnly ? theme.accentLine : theme.rule,
                backgroundColor: friendsOnly ? theme.accentTint : theme.surface,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Icon name="users" size={14} color={friendsOnly ? theme.accent : theme.inkSoft} />
              <VText surface="badge" variant="small" color={friendsOnly ? 'accent' : 'inkSoft'} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                Friends
              </VText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
  const renderRow = (o: (typeof options)[number], i: number) => {
    const on = selected.includes(o.key);
    return (
      <Pressable
        key={o.key}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={`${on ? 'Remove' : 'Add'} ${o.label}`}
        onPress={() => onToggle(o.key)}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: phone.lerp(12, 16), paddingVertical: phone.lerp(10, 13),
          borderTopWidth: i === 0 ? 0 : 1, borderTopColor: theme.ruleSoft,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {withAvatars ? <Avatar imageUrl={o.imageUrl ?? null} name={o.label} size={phone.grow(30)} anon={o.anon} /> : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <VText
            variant="body"
            numberOfLines={1}
            color={o.anon ? 'inkSoft' : 'ink'}
            style={{ fontFamily: o.anon ? 'InstrumentSans_400Regular' : 'InstrumentSans_500Medium' }}
          >
            {o.label}
          </VText>
          {o.caption ? (
            <VText variant="caption" color="inkSoft" numberOfLines={1}>{o.caption}</VText>
          ) : null}
        </View>
        <View
          style={{
            width: 22, height: 22, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
            borderWidth: on ? 0 : 1.5, borderColor: theme.rule,
            backgroundColor: on ? theme.accent : 'transparent',
          }}
        >
          {on ? <Icon name="check" size={13} color={theme.accentInk} /> : null}
        </View>
      </Pressable>
    );
  };
  const empty = <VText variant="small" color="inkSoft" style={{ paddingVertical: 12 }}>No matches.</VText>;
  return (
    <Sheet
      open={open}
      onClose={() => { setQ(''); setFriendsOnly(false); onClose(); }}
      stackBehavior="push"
      layer={1}
      {...(needsSnap ? { snapPoints: [Math.min(estimate, windowH * 0.85)], enableDynamicSizing: false } : { maxDynamicContentSize: windowH * 0.85 })}
    >
      <BottomSheetView style={needsSnap ? { flex: 1, paddingTop: 12 } : { width: '100%', paddingTop: 12 }}>
        {head}
        {needsSnap ? (
          <BottomSheetScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 }}>
            {rows.length === 0 ? empty : rows.map(renderRow)}
          </BottomSheetScrollView>
        ) : (
          <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 }}>
            {rows.length === 0 ? empty : rows.map(renderRow)}
          </View>
        )}
        {footer}
      </BottomSheetView>
    </Sheet>
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
      onPress={() => router.push({ pathname: '/moments/session/[code]', params: { code: row.code } })}
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
