import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { normalizeCode, formatCodeInput } from '@verre/core';
import { Icon } from '@/components/ui/Icon';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { ApiError, getMySessions, isLiveSession, joinMoment, type MySessionRow } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { liveMeta } from '@/lib/momentFormat';
import { elevation, radius, useTheme } from '@/theme';

// 02s Moments home, to the vero-screens pixel spec (.vbar-root, .sh-live2,
// .sh-joinblock, .setnav). Page gutter is 22 (the prototype's .vscreen);
// the live strip bleeds to the screen edges. Deviations (flagged): no QR
// button in the code field (camera lands with deep linking), carousel
// doesn't loop (v1).
const GUTTER = 22;

export default function Moments() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: getMySessions, staleTime: 15_000 });

  // Coming back from a session must reflect the just-joined/just-ended state
  // without an app reload.
  useFocusEffect(
    useCallback(() => {
      sessions.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const live = useMemo(() => (sessions.data ?? []).filter(isLiveSession), [sessions.data]);
  const recentCount = (sessions.data?.length ?? 0) - live.length;

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        // The tab host auto-insets this ScrollView below the status bar —
        // adding insets.top here double-counts and sinks the title.
        paddingTop: 8,
        paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
      }}
    >
      {/* .vbar-root — top-right carries the page's primary action as the
          .hv-add accent pill ("+ New" → 02a creation). */}
      <View style={{ paddingHorizontal: GUTTER, paddingTop: 6, paddingBottom: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <VText variant="title" style={{ paddingTop: 2 }}>Moments</VText>
        <NewPill onPress={() => router.push('/moments/create')} />
      </View>

      {sessions.isPending ? (
        <View style={{ paddingVertical: 48, alignItems: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : (
        <View style={{ paddingTop: 12, gap: 14 }}>
          {live.length > 0 ? <LiveStrip moments={live} /> : null}
          <JoinBlock />
          {recentCount > 0 ? (
            <RecentsRow count={recentCount} onPress={() => router.push('/moments/recents')} />
          ) : live.length === 0 ? (
            <VText variant="small" color="inkSoft" style={{ paddingHorizontal: GUTTER }}>
              No moments yet.
            </VText>
          ) : null}
        </View>
      )}
    </ScrollView>
  );
}

// .hv-add — accent pill: 34h, plus 17 + label 13/600, pad 0 14 0 11.
function NewPill({ onPress }: { onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New moment"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 34,
        paddingLeft: 11,
        paddingRight: 14,
        borderRadius: radius.pill,
        backgroundColor: theme.accent,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Icon name="plus" size={17} color={theme.accentInk} />
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 18, color: theme.accentInk }}>
        New
      </VText>
    </Pressable>
  );
}

// .sh-thumb / .sh-thumb-lg with the glass-icon placeholder (.sh-thumb-ph).
function Thumb({ uri, size, r }: { uri?: string | null; size: number; r: number }) {
  const { theme } = useTheme();
  if (uri) return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: r }} />;
  return (
    <View
      style={{ width: size, height: size, borderRadius: r, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon name="glass" size={Math.round(size * 0.42)} color={theme.inkFaint} />
    </View>
  );
}

function LiveStrip({ moments }: { moments: MySessionRow[] }) {
  const { theme } = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const cardWidth = width - GUTTER * 2;

  return (
    // .sh-livewrap: gap 8, margin 12 0 14 — outer gap comes from the parent.
    <View style={{ gap: 8 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={cardWidth + 12}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: GUTTER, gap: 12 }}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / (cardWidth + 12)))}
      >
        {moments.map((m) => (
          // .sh-live2 .sh-liveB: surface, r-lg 16, shadow-sm, 12×14 padding, no border.
          <View
            key={m.id}
            style={{
              width: cardWidth,
              backgroundColor: theme.surface,
              borderRadius: radius.lg,
              paddingVertical: 12,
              paddingHorizontal: 14,
              gap: 12,
              shadowColor: '#000',
              shadowOpacity: elevation.sm.ios.shadowOpacity,
              shadowRadius: elevation.sm.ios.shadowRadius,
              shadowOffset: { width: 0, height: elevation.sm.ios.shadowOffsetY },
              elevation: elevation.sm.android.elevation,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Thumb uri={m.cover_photo_url} size={56} r={radius.md} />
              <View style={{ flex: 1, gap: 2 }}>
                {/* .sh-livetag */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.positive }} />
                  {/* .sh-livetag: 12/700 */}
                  <VText color="positive" style={{ fontFamily: 'InstrumentSans_700Bold', fontSize: 12, lineHeight: 17 }}>
                    Still ongoing
                  </VText>
                </View>
                {/* .sh-livename: 18/600/-0.015em */}
                <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}>
                  {m.name || m.host_name}
                </VText>
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
        // .sh-dots / .sh-dot
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 5 }}>
          {moments.map((m, i) => (
            <View
              key={m.id}
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: i === page ? theme.accent : theme.inkFaint,
                opacity: i === page ? 1 : 0.5,
                transform: [{ scale: i === page ? 1.15 : 1 }],
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
    // .sh-joinblock: gap 10, margin-top 6
    <View style={{ paddingHorizontal: GUTTER, gap: 10, marginTop: 6 }}>
      {/* .sh-sheettitle: 18/600 */}
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}>
        Join a moment
      </VText>
      <VText variant="small" color="inkSoft" style={{ marginTop: -4 }}>Enter the code your host shared.</VText>
      {/* .gs-codewrap: row, gap 8, stretch */}
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          {/* .gs-c: 15/600, 0.14em tracking, uppercase via formatCodeInput */}
          <TextField
            value={input}
            onChangeText={(t) => { setInput(formatCodeInput(t)); setError(null); }}
            placeholder="8H4K – Q2NP"
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={join}
            style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, letterSpacing: 2.1 }}
          />
        </View>
        <Button title="Join" loadingTitle="Joining…" variant="secondary" loading={busy} disabled={!code} onPress={join} style={{ paddingHorizontal: 20 }} />
      </View>
      {error ? <VText variant="caption" color="critical">{error}</VText> : null}
    </View>
  );
}

// .setgroup + .setnav — the "Recent moments" push-row.
function RecentsRow({ count, onPress }: { count: number; onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        marginHorizontal: GUTTER,
        marginTop: 4,
        backgroundColor: theme.surface,
        borderWidth: 1,
        borderColor: theme.rule,
        borderRadius: radius.md,
        overflow: 'hidden',
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 13,
          paddingHorizontal: 14,
          backgroundColor: pressed ? theme.surfaceSunk : 'transparent',
        })}
      >
        <Icon name="clock" size={18} color={theme.inkSoft} />
        <VText style={{ flex: 1, fontFamily: 'InstrumentSans_500Medium', fontSize: 15, lineHeight: 23 }}>Recent moments</VText>
        <VText variant="small" color="inkSoft">{count}</VText>
        <Icon name="chevron-right" size={18} color={theme.inkFaint} />
      </Pressable>
    </View>
  );
}
