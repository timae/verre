import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ActivityIndicator, FlatList, Image, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/Icon';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { RoleChip } from '@/components/moments/RoleChip';
import { VText } from '@/components/ui/VText';
import { getMySessions, isLiveSession, type MySessionRow } from '@/lib/api/sessions';
import { recentMeta } from '@/lib/momentFormat';
import { radius, useTheme } from '@/theme';

const GUTTER = 22;

// 02s·2 — pushed list of past moments to the .sh-row pixel spec: flat rows
// with rule-soft separators (no cards), 46px thumb, name 15/600, meta 13,
// role chip on its own line, chevron. Rows are visually per spec but inert:
// an archived session has no Redis state (the /state poll would 404) — the
// Postgres-backed archive view is a later milestone.
export default function Recents() {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
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
        paddingHorizontal: GUTTER,
        paddingTop: 4,
        paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
      }}
      ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.ruleSoft }} />}
      renderItem={({ item }) => <RecentRow row={item} />}
      ListEmptyComponent={
        <VText variant="small" color="inkSoft">No past moments yet.</VText>
      }
    />
  );
}

function RecentRow({ row }: { row: MySessionRow }) {
  const { theme } = useTheme();
  return (
    // .sh-row: gap 12, 10px vertical padding, transparent.
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}>
      <Thumb46 uri={null} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15 }}>
          {row.name || row.host_name}
        </VText>
        <VText variant="small" color="inkSoft">
          {recentMeta(row.date_from ?? row.created_at, row.wine_count)}
        </VText>
        {row.role ? (
          <View style={{ marginTop: 5, flexDirection: 'row' }}>
            <RoleChip role={row.role} />
          </View>
        ) : null}
      </View>
      <Icon name="chevron-right" size={16} color={theme.inkFaint} />
    </View>
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
