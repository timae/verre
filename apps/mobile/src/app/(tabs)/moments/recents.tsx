import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/Icon';
import { Thumb } from '@/components/ui/Thumb';
import { GUTTER, TAB_BAR_CLEARANCE, usePhoneTokens } from '@/lib/layout';
import { RoleChip } from '@/components/moments/RoleChip';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { ConnectionBanner, ErrorState, connectionView } from '@/components/ui/ConnectionState';
import { getMySessions, isUpcomingSession, type MySessionRow } from '@/lib/api/sessions';
import { recentMeta } from '@/lib/momentFormat';
import { useTheme } from '@/theme';

// Sort key for the Recent list: the SET date when present, else the created
// date as an internal fallback (never shown). A missing/invalid timestamp
// sinks to the bottom (0).
function effectiveDate(r: MySessionRow): number {
  const iso = r.date_from ?? r.created_at;
  const t = iso ? new Date(iso).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
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
  const { filter } = useLocalSearchParams<{ filter?: string }>();
  const upcoming = filter === 'upcoming';
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: getMySessions, staleTime: 15_000 });
  // 'upcoming' filter → only future-start sessions, re-sorted SOONEST-first
  // (the server's activity sort puts the furthest-out date on top, which is
  // backwards for an agenda); default → everything that isn't upcoming
  // ("Recent moments"), re-sorted by EFFECTIVE DATE newest-first.
  // Both filters key on `status`, NOT `pinned` — the carousel (pinned) overlaps
  // both lists. Full routing model: docs/dev/moments-home.md.
  //
  // The server sorts the raw payload by ACTIVITY (max of last-visit, start,
  // created) so the carousel can float "just visited" cards up. That bump is
  // wrong for these lists — a recently-opened moment shouldn't jump the date
  // order — so both filters impose their own date sort here, leaving the
  // server order for the carousel only.
  const moments = useMemo(() => {
    const rows = (sessions.data ?? []).filter((r) => (upcoming ? isUpcomingSession(r) : !isUpcomingSession(r)));
    if (upcoming) {
      return [...rows].sort((a, b) => {
        const ta = a.date_from ? new Date(a.date_from).getTime() : Infinity;
        const tb = b.date_from ? new Date(b.date_from).getTime() : Infinity;
        return ta - tb; // soonest start first
      });
    }
    // Recent: effective date = the SET date (date_from) if present, else the
    // created date as an internal fallback. Newest first, interleaved (a
    // date-less moment created yesterday can sit above one dated last week).
    return [...rows].sort((a, b) => effectiveDate(b) - effectiveDate(a));
  }, [sessions.data, upcoming]);

  // Connection failure: full ErrorState when the filtered list is empty AND the
  // fetch errored (nothing to show); a top banner when we still have rows.
  const conn = connectionView(sessions.isError, moments.length > 0);

  // The VBar always renders (back-nav stays available); the body below it
  // switches between spinner / error / banner+list.
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={upcoming ? 'Upcoming moments' : 'Recent moments'} />
      </View>
      {sessions.isPending ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : conn === 'error' ? (
        <ErrorState onRetry={() => sessions.refetch()} retrying={sessions.isFetching} />
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
            renderItem={({ item }) => <RecentRow row={item} />}
            ListEmptyComponent={
              <VText variant="small" color="inkSoft">{upcoming ? 'Nothing upcoming.' : 'No moments yet.'}</VText>
            }
          />
        </>
      )}
    </View>
  );
}

function RecentRow({ row }: { row: MySessionRow }) {
  const { theme } = useTheme();
  const router = useRouter();
  const phone = usePhoneTokens();
  const meta = recentMeta(row.date_from, row.name ? (row.role === 'host' ? 'you' : row.host_name) : null);
  const titleText = phone.text('body');
  const metaText = phone.text('small');
  return (
    // .sh-row base: gap 12, 10px vertical padding, transparent.
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/moments/session/[code]', params: { code: row.code } })}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: phone.lerp(12, 16),
        paddingVertical: phone.lerp(10, 16),
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Thumb uri={row.cover_photo_url} size={phone.size('recentThumb')} />
      {/* Tight line boxes on the stacked single-line rows: the body/small
          line-height multipliers (23 / 20) are tuned for multi-line paragraphs
          and here add leading above+below each glyph, inflating the visible
          gaps beyond the design's 2px column gap + 5px chip margin. Snug
          line-heights let those design gaps read true. */}
      <View style={{ flex: 1, minWidth: 0, gap: phone.lerp(2, 4) }}>
        <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', ...titleText }}>
          {row.name || row.host_name}
        </VText>
        {/* Show ONLY the set date (date_from); a moment with no set date shows
            no date here (created_at is internal — used for ordering, never
            displayed). "Hosted by" suppressed when host_name is already the
            title; "you" when the viewer is the host (id-resolved, never a name).
            A date-less, name-less moment yields an empty string here — render
            nothing so it doesn't leave a blank line box between title + chip. */}
        {meta ? (
          <VText color="inkSoft" style={metaText}>
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
