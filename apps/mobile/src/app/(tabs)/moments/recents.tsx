import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/Icon';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { RoleChip } from '@/components/moments/RoleChip';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { getMySessions, isUpcomingSession, type MySessionRow } from '@/lib/api/sessions';
import { recentMeta } from '@/lib/momentFormat';
import { radius, useTheme } from '@/theme';

const GUTTER = 22;

// 02s·2 — pushed "All moments" list to the .sh-row pixel spec: flat rows
// with rule-soft separators (no cards), 46px thumb, name 15/600, meta 13,
// role chip on its own line, chevron. Shows EVERY moment (incl. the ones
// surfaced in the home carousel), server-sorted most-recently-active first
// — no per-row status tag. Rows push back into the session: a date-past
// session is often still Redis-alive and opens normally; a truly expired one
// lands on the session screen's "This moment has ended" state.
export default function AllMoments() {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const { filter } = useLocalSearchParams<{ filter?: string }>();
  const upcoming = filter === 'upcoming';
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: getMySessions, staleTime: 15_000 });
  // 'upcoming' filter → only future-start sessions, re-sorted SOONEST-first
  // (the server's activity sort puts the furthest-out date on top, which is
  // backwards for an agenda); default → everything that isn't upcoming
  // ("Moments you've had"), keeping the server's most-recently-active order.
  const moments = useMemo(() => {
    const rows = (sessions.data ?? []).filter((r) => (upcoming ? isUpcomingSession(r) : !isUpcomingSession(r)));
    if (upcoming) {
      return [...rows].sort((a, b) => {
        const ta = a.date_from ? new Date(a.date_from).getTime() : Infinity;
        const tb = b.date_from ? new Date(b.date_from).getTime() : Infinity;
        return ta - tb; // soonest start first
      });
    }
    return rows;
  }, [sessions.data, upcoming]);

  if (sessions.isPending) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={upcoming ? 'Upcoming moments' : "Moments you've had"} />
      </View>
      <FlatList
        data={moments}
        keyExtractor={(r) => String(r.id)}
        contentContainerStyle={{
          paddingHorizontal: GUTTER,
          paddingTop: 4,
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        }}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.ruleSoft }} />}
        renderItem={({ item }) => <RecentRow row={item} />}
        ListEmptyComponent={
          <VText variant="small" color="inkSoft">{upcoming ? 'Nothing upcoming.' : 'No moments yet.'}</VText>
        }
      />
    </View>
  );
}

function RecentRow({ row }: { row: MySessionRow }) {
  const { theme } = useTheme();
  const router = useRouter();
  return (
    // .sh-row: gap 12, 10px vertical padding, transparent.
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/moments/session/[code]', params: { code: row.code } })}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Thumb46 uri={row.cover_photo_url} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}>
          {row.name || row.host_name}
        </VText>
        {/* "Hosted by" suppressed when host_name is already the title above;
            "you" when the viewer is the host (id-resolved role, never a name). */}
        <VText variant="small" color="inkSoft">
          {recentMeta(row.date_from ?? row.created_at, row.name ? (row.role === 'host' ? 'you' : row.host_name) : null)}
        </VText>
        {row.role ? (
          <View style={{ marginTop: 5, flexDirection: 'row' }}>
            <RoleChip role={row.role} />
          </View>
        ) : null}
      </View>
      <Icon name="chevron-right" size={16} color={theme.inkFaint} />
    </Pressable>
  );
}

function Thumb46({ uri }: { uri: string | null }) {
  const { theme } = useTheme();
  if (uri) return <Image source={{ uri }} style={{ width: 46, height: 46, borderRadius: radius.sm }} />;
  return (
    <View style={{ width: 46, height: 46, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="glass" size={19} color={theme.inkFaint} />
    </View>
  );
}
