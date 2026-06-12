import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { normalizeCode, formatCodeInput } from '@verre/core';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { ApiError, getMySessions, isLiveSession, joinMoment, type MySessionRow } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { liveMeta } from '@/lib/momentFormat';
import { radius, space, useTheme } from '@/theme';

// 02s Moments home: live strip (ongoing moments) · inline join block ·
// "Recent moments" push-row. Quiet state = no live strip, the rest stays.
export default function Moments() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: getMySessions, staleTime: 15_000 });

  const live = useMemo(() => (sessions.data ?? []).filter(isLiveSession), [sessions.data]);
  const recentCount = (sessions.data?.length ?? 0) - live.length;

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: insets.top + space.md,
        paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        gap: space.lg,
      }}
    >
      <View style={{ paddingHorizontal: space.lg }}>
        <VText variant="title">Moments</VText>
      </View>

      {sessions.isPending ? (
        <View style={{ paddingVertical: space.xl, alignItems: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : (
        <>
          {live.length > 0 ? <LiveStrip moments={live} /> : null}
          <JoinBlock />
          {recentCount > 0 ? (
            <RecentsRow
              count={recentCount}
              onPress={() => router.push('/moments/recents')}
            />
          ) : live.length === 0 ? (
            <VText variant="body" color="inkSoft" style={{ paddingHorizontal: space.lg }}>
              No moments yet.
            </VText>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function LiveStrip({ moments }: { moments: MySessionRow[] }) {
  const { theme } = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const cardWidth = width - space.lg * 2;

  return (
    <View style={{ gap: space.sm }}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        snapToInterval={cardWidth + space.sm}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm }}
        onMomentumScrollEnd={(e) => {
          setPage(Math.round(e.nativeEvent.contentOffset.x / (cardWidth + space.sm)));
        }}
      >
        {moments.map((m) => (
          <View
            key={m.id}
            style={{
              width: cardWidth,
              backgroundColor: theme.surface,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: theme.rule,
              padding: space.md,
              gap: space.md,
            }}
          >
            <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
              <View
                style={{ width: 56, height: 56, borderRadius: radius.md, backgroundColor: theme.surfaceSunk }}
              />
              <View style={{ flex: 1, gap: 3 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.positive }} />
                  <VText variant="caption" color="positive" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                    Still ongoing
                  </VText>
                </View>
                <VText variant="subhead" numberOfLines={1}>{m.name || m.host_name}</VText>
                <VText variant="small" color="inkSoft">{liveMeta(m.wine_count, m.taster_count)}</VText>
              </View>
            </View>
            <Button
              title="Rejoin"
              block
              onPress={() => router.push({ pathname: '/moments/session/[code]', params: { code: m.code } })}
            />
          </View>
        ))}
      </ScrollView>
      {moments.length > 1 ? (
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6 }}>
          {moments.map((m, i) => (
            <View
              key={m.id}
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: i === page ? theme.accent : theme.rule,
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function JoinBlock() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: auth } = authClient.useSession();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const code = normalizeCode(input);

  const join = async () => {
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    try {
      const joined = await joinMoment(code, auth?.user.name ?? '');
      queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
      setInput('');
      router.push({ pathname: '/moments/session/[code]', params: { code: joined.code } });
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'not-found') setError('No moment found for that code.');
      else if (e instanceof ApiError && e.kind === 'banned') setError("You can't join this moment.");
      else if (e instanceof ApiError && e.kind === 'rate-limited') setError(e.message || 'Too many attempts — try again soon.');
      else setError('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
      <VText variant="heading">Join a moment</VText>
      <VText variant="small" color="inkSoft">Enter the code your host shared.</VText>
      <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <TextField
            value={input}
            onChangeText={(t) => { setInput(formatCodeInput(t)); setError(null); }}
            placeholder="8H4K – Q2NP"
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={join}
          />
        </View>
        <Button title="Join" variant="secondary" loading={busy} disabled={!code} onPress={join} />
      </View>
      {error ? <VText variant="caption" color="critical">{error}</VText> : null}
    </View>
  );
}

function RecentsRow({ count, onPress }: { count: number; onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: space.lg,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        backgroundColor: pressed ? theme.surfaceSunk : theme.surface,
        borderWidth: 1,
        borderColor: theme.rule,
        borderRadius: radius.md,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
      })}
    >
      <VText variant="body" style={{ flex: 1 }}>Recent moments</VText>
      <VText variant="body" color="inkSoft">{count}</VText>
      <VText variant="body" color="inkFaint">›</VText>
    </Pressable>
  );
}
