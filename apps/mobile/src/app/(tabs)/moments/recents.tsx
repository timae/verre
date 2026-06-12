import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { RoleChip } from '@/components/moments/RoleChip';
import { VText } from '@/components/ui/VText';
import { getMySessions, isLiveSession, type MySessionRow } from '@/lib/api/sessions';
import { recentMeta } from '@/lib/momentFormat';
import { radius, space, useTheme } from '@/theme';

// 02s·2 — pushed list of past moments: name, date · impressions, your role as
// a chip on its own line (plain = taster). No scores on these rows.
export default function Recents() {
  const insets = useSafeAreaInsets();
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: getMySessions, staleTime: 15_000 });
  const recents = useMemo(() => (sessions.data ?? []).filter((r) => !isLiveSession(r)), [sessions.data]);

  if (sessions.isPending) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <FlatList
      data={recents}
      keyExtractor={(r) => String(r.id)}
      contentContainerStyle={{
        padding: space.lg,
        paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        gap: space.sm,
      }}
      renderItem={({ item }) => <RecentRow row={item} />}
      ListEmptyComponent={
        <VText variant="body" color="inkSoft">No past moments yet.</VText>
      }
    />
  );
}

// Rows are static in this milestone: an archived session has no Redis state
// (the /state poll would 404), and the Postgres-backed archive view is a
// later milestone. Tap-through lands together with that screen.
function RecentRow({ row }: { row: MySessionRow }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        backgroundColor: theme.surface,
        borderWidth: 1,
        borderColor: theme.rule,
        borderRadius: radius.md,
        padding: space.md,
      }}
    >
      <View style={{ width: 44, height: 44, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk }} />
      <View style={{ flex: 1, gap: 3 }}>
        <VText variant="body" numberOfLines={1}>{row.name || row.host_name}</VText>
        <VText variant="small" color="inkSoft">
          {recentMeta(row.date_from ?? row.created_at, row.wine_count)}
        </VText>
        <RoleChip role={row.role} />
      </View>
    </View>
  );
}
