import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button as MenuButton, ContextMenu, Host, RNHostView } from '@expo/ui/swift-ui';
import { normalizeCode, formatCodeInput } from '@verre/core';
import { Icon } from '@/components/ui/Icon';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { ApiError, getMySessions, isLiveSession, isUpcomingSession, joinMoment, liveKind, setMomentHidden, type MySessionRow } from '@/lib/api/sessions';
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
  const { theme } = useTheme();
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: getMySessions, staleTime: 15_000 });

  // Coming back from a session must reflect the just-joined/just-ended state
  // without an app reload.
  useFocusEffect(
    useCallback(() => {
      sessions.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // The RefreshControl spinner must show ONLY for a user pull — binding it to
  // the query's isRefetching also fires for the focus refetch above, which
  // would animate the spinner in (and shove the title down) on every back
  // navigation. Track the pull explicitly.
  const [pulling, setPulling] = useState(false);
  const onPullRefresh = useCallback(() => {
    setPulling(true);
    sessions.refetch().finally(() => setPulling(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = useMemo(() => (sessions.data ?? []).filter(isLiveSession), [sessions.data]);
  const upcomingCount = useMemo(() => (sessions.data ?? []).filter(isUpcomingSession).length, [sessions.data]);
  // "Moments you've had" = everything that ISN'T upcoming (incl. the live
  // carousel items — the carousel is a highlight, not a separate set).
  // Upcoming sits in its own row above.
  const hadCount = (sessions.data?.length ?? 0) - upcomingCount;

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        // The tab host auto-insets this ScrollView below the status bar —
        // adding insets.top here double-counts and sinks the title.
        paddingTop: 8,
        paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
      }}
      refreshControl={
        // Pull-to-refresh re-pulls the whole list: live/past status, taster +
        // wine counts, recents. `pulling` (not isRefetching) so the spinner
        // shows ONLY for a user-initiated pull — never the focus/background
        // refetch, which would otherwise animate on every back navigation.
        <RefreshControl refreshing={pulling} onRefresh={onPullRefresh} tintColor={theme.inkSoft} />
      }
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
          {/* Upcoming sits above "had" and only when non-empty. */}
          {upcomingCount > 0 ? (
            <PushRow
              label="Upcoming moments"
              count={upcomingCount}
              onPress={() => router.push({ pathname: '/moments/recents', params: { filter: 'upcoming' } })}
            />
          ) : null}
          {hadCount > 0 ? (
            <PushRow
              label="Moments you've had"
              count={hadCount}
              onPress={() => router.push('/moments/recents')}
            />
          ) : upcomingCount === 0 ? (
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

// The card's inner content (thumb + status + name + meta), shared between the
// live card and the focused copy drawn in the remove overlay so they match.
function LiveCardBody({ m }: { m: MySessionRow }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Thumb uri={m.cover_photo_url} size={56} r={radius.md} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.positive }} />
          {/* 'scheduled' = within its date window → genuinely ongoing;
              'recent' = date-less, recently visited → don't claim live. */}
          <VText color="positive" style={{ fontFamily: 'InstrumentSans_700Bold', fontSize: 12, lineHeight: 17 }}>
            {liveKind(m) === 'recent' ? 'Just visited' : 'Still ongoing'}
          </VText>
        </View>
        <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}>
          {m.name || m.host_name}
        </VText>
        {/* "Hosted by" is suppressed when the moment has no name (host_name
            is already the title above), so we don't repeat the host. */}
        <VText variant="small" color="inkSoft">{liveMeta(m.name ? m.host_name : null, m.taster_count)}</VText>
      </View>
    </View>
  );
}

// The visual card surface (bg + radius + padding + shadow). Shared by the
// live card and its lifted context-menu Preview so they match exactly.
function CardSurface({ width, children }: { width: number; children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        width,
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
      {children}
    </View>
  );
}

// .sh-live2 .sh-liveB card. Pulled out so the loop can render the real cards
// plus a clone of the first/last without duplicating JSX.
//
// Long-press → native iOS context-menu lift (@expo/ui ContextMenu): the OS
// lifts the card (the Preview copy), dims the rest, and shows the "Remove
// from home" action; tap-away dismisses; the strip is frozen while open. This
// replaced a hand-rolled measureInWindow + dim-Modal overlay that desynced
// over the moving/looping carousel.
//
// @expo/ui SwiftUI views must live under a `<Host>` boundary; our RN card is
// brought back into the SwiftUI tree via `<RNHostView matchContents>` (Trigger)
// and rendered directly in `.Preview`. `matchContents` so the host sizes to the
// card inside the horizontal strip rather than collapsing/forcing a size.
// Clones (isClone) get no menu — they have no stable identity; plain card.
function LiveCard({
  m, width, isClone, onRemove,
}: {
  m: MySessionRow;
  width: number;
  isClone: boolean;
  onRemove: () => void;
}) {
  const router = useRouter();
  const card = (
    <CardSurface width={width}>
      <LiveCardBody m={m} />
      <Button
        title="Rejoin"
        block
        onPress={() => router.push({ pathname: '/moments/session/[code]', params: { code: m.code } })}
      />
    </CardSurface>
  );
  if (isClone) return card;
  return (
    <Host matchContents style={{ width }}>
      <ContextMenu>
        <ContextMenu.Items>
          <MenuButton label="Remove from home" systemImage="trash" role="destructive" onPress={onRemove} />
        </ContextMenu.Items>
        <ContextMenu.Preview>
          <RNHostView matchContents>
            <CardSurface width={width}>
              <LiveCardBody m={m} />
            </CardSurface>
          </RNHostView>
        </ContextMenu.Preview>
        <ContextMenu.Trigger>
          <RNHostView matchContents>{card}</RNHostView>
        </ContextMenu.Trigger>
      </ContextMenu>
    </Host>
  );
}

function LiveStrip({ moments }: { moments: MySessionRow[] }) {
  const { theme } = useTheme();
  const { width } = useWindowDimensions();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const cardWidth = width - GUTTER * 2;
  const step = cardWidth + 12;
  const scrollRef = useRef<ScrollView>(null);

  const hideMut = useMutation({
    mutationFn: (code: string) => setMomentHidden(code, true),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-sessions'] }),
  });

  const loop = moments.length > 1;
  // Loop track: [clone(last), ...real, clone(first)]. Start parked on the
  // first REAL card (index 1). When momentum lands on a clone, silently jump
  // to its real twin so it scrolls endlessly both ways.
  const data = loop ? [moments[moments.length - 1], ...moments, moments[0]] : moments;

  // Park on the first real card ONCE per card-set, not on every content-size
  // change — otherwise the 15s poll adding/removing a live moment would
  // re-fire this and yank the user back to card 1 mid-scroll. Reset the
  // latch (+ clamp the dot) only when the live COUNT actually changes.
  const parkedRef = useRef(false);
  useEffect(() => {
    parkedRef.current = false;
    setPage((p) => (p < moments.length ? p : 0));
  }, [moments.length]);
  const onContentSized = () => {
    if (loop && !parkedRef.current) {
      scrollRef.current?.scrollTo({ x: step, animated: false });
      parkedRef.current = true;
    }
  };

  // Dots track the swipe LIVE (on scroll, not just on settle) so they don't
  // lag. Map the raw track index → real dot index, wrapping for the clones.
  const onScroll = (x: number) => {
    const i = Math.round(x / step);
    const dot = loop ? (i - 1 + moments.length) % moments.length : i;
    setPage((p) => (p === dot ? p : dot));
  };

  const onMomentumEnd = (x: number) => {
    if (!loop) return;
    const i = Math.round(x / step);
    if (i === 0) {
      // leading clone (of the last real) → jump to the last real card
      scrollRef.current?.scrollTo({ x: moments.length * step, animated: false });
    } else if (i === data.length - 1) {
      // trailing clone (of the first real) → jump to the first real card
      scrollRef.current?.scrollTo({ x: step, animated: false });
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={step}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: GUTTER, gap: 12 }}
        onContentSizeChange={onContentSized}
        scrollEventThrottle={16}
        onScroll={(e) => onScroll(e.nativeEvent.contentOffset.x)}
        onMomentumScrollEnd={(e) => onMomentumEnd(e.nativeEvent.contentOffset.x)}
      >
        {data.map((m, i) => {
          // Loop clones are the first (i=0) and last (i=len-1) entries.
          const isClone = loop && (i === 0 || i === data.length - 1);
          return (
            <LiveCard
              key={`${m.id}-${i}`}
              m={m}
              width={cardWidth}
              isClone={isClone}
              onRemove={() => hideMut.mutate(m.code)}
            />
          );
        })}
      </ScrollView>
      {moments.length > 1 ? (
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

// .setgroup + .setnav — a labelled push-row into a moments sub-list (reused
// for "Upcoming moments" + "Moments you've had").
function PushRow({ label, count, onPress }: { label: string; count: number; onPress: () => void }) {
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
        <VText style={{ flex: 1, fontFamily: 'InstrumentSans_500Medium', fontSize: 15, lineHeight: 23 }}>{label}</VText>
        <VText variant="small" color="inkSoft">{count}</VText>
        <Icon name="chevron-right" size={18} color={theme.inkFaint} />
      </Pressable>
    </View>
  );
}
