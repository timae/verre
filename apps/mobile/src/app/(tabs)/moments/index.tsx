import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button as MenuButton, ContextMenu, Host, RNHostView } from '@expo/ui/swift-ui';
import { normalizeCode, formatCodeInput } from '@verre/core';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Thumb } from '@/components/ui/Thumb';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { Button } from '@/components/ui/Button';
import { ConnectionBanner, ErrorState, connectionView } from '@/components/ui/ConnectionState';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { ApiError, getMySessions, isPinnedSession, isUpcomingSession, joinMoment, setMomentHidden, type MySessionRow } from '@/lib/api/sessions';
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

  // The highlight carousel keys on `pinned`, NOT `status` — dismissing a card
  // ("Remove from home") flips `pinned` only, so filtering on status would
  // never drop it. `pinned` overlaps both lists (an upcoming pinned moment sits
  // in the carousel AND the Upcoming row). Full model: docs/dev/moments-home.md.
  const pinned = useMemo(() => (sessions.data ?? []).filter(isPinnedSession), [sessions.data]);
  const upcomingCount = useMemo(() => (sessions.data ?? []).filter(isUpcomingSession).length, [sessions.data]);
  // "Recent moments" = everything that ISN'T upcoming (incl. the pinned
  // carousel items — the carousel is a highlight, not a separate set).
  // Upcoming sits in its own row above.
  const recentCount = (sessions.data?.length ?? 0) - upcomingCount;

  // Connection failure: full ErrorState only when we have NOTHING to show; a
  // top banner (keep the stale list) when a prior fetch left data. A non-empty
  // list is "data" — an errored fetch that only ever yielded [] falls to the
  // full state rather than a banner floating over emptiness.
  const conn = connectionView(sessions.isError, (sessions.data?.length ?? 0) > 0);

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

      {/* Stale-data warning: the list below is the last good fetch; the strip
          taps to retry and clears itself on the next success. */}
      {conn === 'banner' ? (
        <View style={{ paddingTop: 6 }}>
          <ConnectionBanner onRetry={() => sessions.refetch()} />
        </View>
      ) : null}

      {sessions.isPending ? (
        <View style={{ paddingVertical: 48, alignItems: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : conn === 'error' ? (
        // Errored with nothing cached — full message in place of the list.
        // minHeight (not flex:1, which collapses inside a ScrollView) keeps it
        // roughly centered while staying pull-to-refreshable.
        <View style={{ minHeight: 320 }}>
          <ErrorState onRetry={() => sessions.refetch()} retrying={sessions.isFetching} />
        </View>
      ) : (
        <View style={{ paddingTop: 12, gap: 14 }}>
          <JoinBlock />
          {/* Highlight carousel sits between Join and the lists. */}
          {pinned.length > 0 ? <LiveStrip moments={pinned} /> : null}
          {/* Upcoming + "Recent moments" share one carded group (hairline-
              divided, like the settings hub). Each row renders only when non-
              empty; the group itself shows only when at least one row does. */}
          {upcomingCount > 0 || recentCount > 0 ? (
            <PushGroup>
              {upcomingCount > 0 ? (
                <PushRow
                  first
                  icon="clock"
                  label="Upcoming moments"
                  count={upcomingCount}
                  onPress={() => router.push({ pathname: '/moments/recents', params: { filter: 'upcoming' } })}
                />
              ) : null}
              {recentCount > 0 ? (
                <PushRow
                  first={upcomingCount === 0}
                  icon="sparkles"
                  label="Recent moments"
                  count={recentCount}
                  onPress={() => router.push('/moments/recents')}
                />
              ) : null}
            </PushGroup>
          ) : (
            <VText variant="small" color="inkSoft" style={{ paddingHorizontal: GUTTER }}>
              No moments yet.
            </VText>
          )}
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

// The card's inner content (thumb + status + name + meta), shared between the
// live card and the focused copy drawn in the remove overlay so they match.
//
// Every text here is capped + single-line because the live card is FIXED height
// (LIVE_CARD_HEIGHT): an uncapped OS Dynamic-Type scale would grow the body past
// the 64px budget and clip. The cap bounds the growth; numberOfLines={1} stops
// any line wrapping (incl. the status line, whose inline 14px ● can lift the
// used line-height). The Rejoin button is already height-safe — its pill height
// is fixed by control.h, so its label scales/clips within, never grows the card.
const CARD_TEXT_MAX_SCALE = 1.3;
function LiveCardBody({ m }: { m: MySessionRow }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Thumb uri={m.cover_photo_url} size={56} radius={radius.md} />
      <View style={{ flex: 1, gap: 2 }}>
        {/* Status chip — server-computed (m.carouselLabel; see
            docs/dev/moments-home.md). 'now'/'visited' carry the green ●
            (active/recent); 'soon' reads "Starting soon" with NO dot — it isn't
            live yet, so a live dot would mislead. The start time rides the meta
            line below (liveMeta's "Starts …"), so the chip stays generic. */}
        {m.carouselLabel === 'soon' ? (
          <VText color="inkSoft" numberOfLines={1} maxFontSizeMultiplier={CARD_TEXT_MAX_SCALE} style={{ fontFamily: 'InstrumentSans_700Bold', fontSize: 12, lineHeight: 17 }}>
            Starting soon
          </VText>
        ) : (
          <VText color="positive" numberOfLines={1} maxFontSizeMultiplier={CARD_TEXT_MAX_SCALE} style={{ fontFamily: 'InstrumentSans_700Bold', fontSize: 12, lineHeight: 17 }}>
            {/* The nested ● needs its OWN cap — maxFontSizeMultiplier doesn't
                inherit to a nested Text in RN. */}
            <VText color="positive" maxFontSizeMultiplier={CARD_TEXT_MAX_SCALE} style={{ fontSize: 14 }}>● </VText>{m.carouselLabel === 'visited' ? 'Just visited' : 'Happening now'}
          </VText>
        )}
        <VText numberOfLines={1} maxFontSizeMultiplier={CARD_TEXT_MAX_SCALE} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}>
          {m.name || m.host_name}
        </VText>
        {/* "Hosted by" is suppressed when the moment has no name (host_name
            is already the title above); "you" when the viewer is the host
            (id-resolved role, never a name). */}
        <VText variant="small" color="inkSoft" numberOfLines={1} maxFontSizeMultiplier={CARD_TEXT_MAX_SCALE}>{liveMeta(m.date_from, m.name ? (m.role === 'host' ? 'you' : m.host_name) : null)}</VText>
      </View>
    </View>
  );
}

// Fixed height of the LIVE card (the one with the Rejoin button). Derived:
// paddingTop 12 + body 64 (status 17 + gap 2 + title 23 + gap 2 + meta 20, the
// text column being taller than the 56 thumb) + gap 12 + button 44 + padding
// BOTTOM 18 (a touch more breathing room under the button than the top) = 150.
// This is NOT cosmetic. The real card is wrapped in a SwiftUI
// `<Host>` → `<RNHostView matchContents>`; per the RNHostView contract,
// matchContents sizes the host to the RN child's INTRINSIC size — but until
// that re-resolves after a content change (e.g. a card removal), the host
// falls back to "RN fills the parent's proposed frame", and SwiftUI can
// propose an oversized frame. The card then fills it and the spare height
// inflates the bottom child → the Rejoin button stretched in the single-card
// state. A FIXED height (not minHeight — minHeight still lets the fill-fallback
// exceed it) gives matchContents a constant intrinsic size, so there is no
// ambiguous frame to over-fill. Applied to the live card only; the Preview
// (body, no button) keeps its natural height.
const LIVE_CARD_HEIGHT = 150;
// The visual card surface (bg + radius + padding + shadow). Shared by the
// live card and its lifted context-menu Preview so they match exactly.
function CardSurface({ width, height, children }: { width: number; height?: number; children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        width,
        height,
        backgroundColor: theme.surface,
        borderRadius: radius.lg,
        paddingTop: 12,
        paddingBottom: 18,
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
  // Acknowledge the tap immediately. The session screen's first GET/visit can be
  // slow (cold server route, a stale Redis connection), and inside the SwiftUI
  // ContextMenu the first tap can be eaten by the long-press recognizer — both
  // make a plain navigate look like "nothing happened" until the second tap.
  // Dimming + "Opening…" on press (and a re-entry guard) makes the first tap
  // unmistakable. `navigating` resets on screen blur/refocus via the key remount.
  const [navigating, setNavigating] = useState(false);
  // Clear the dim when the user comes BACK to the home screen (the card doesn't
  // unmount on push), so a returned-to "Rejoin" isn't stuck showing "Opening…".
  useFocusEffect(useCallback(() => { setNavigating(false); }, []));
  const open = () => {
    if (navigating) return;
    setNavigating(true);
    router.push({ pathname: '/moments/session/[code]', params: { code: m.code } });
  };
  const card = (
    <CardSurface width={width} height={LIVE_CARD_HEIGHT}>
      <LiveCardBody m={m} />
      {/* flexShrink:0 so the fixed-height card can't compress the button if the
          content ever measures a hair over LIVE_CARD_HEIGHT (the inverse of the
          stretch bug — keep the button a constant 44 either way). */}
      <Button title="Rejoin" loadingTitle="Opening…" loading={navigating} block onPress={open} style={{ flexShrink: 0 }} />
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
  // Loop track: [clone(last), ...real, clone(first)]. The first REAL card sits
  // at track offset `step` (index 1). When momentum lands on a clone, silently
  // jump to its real twin so it scrolls endlessly both ways.
  const data = loop ? [moments[moments.length - 1], ...moments, moments[0]] : moments;

  // The resting scroll offset for REAL card `p`: loop shifts everything right
  // by one clone, so card p lives at (p+1)*step; flat list, p*step. Single
  // helper so every re-anchor (initial park, length change) goes through one
  // place and can't disagree.
  const offsetForPage = (p: number) => (loop ? (p + 1) * step : p * step);

  // The card the viewport is currently centred on, tracked by IDENTITY (id),
  // not numeric index. The list is server-sorted by activity, so the 15s poll
  // can REORDER it without changing its length — index-based tracking would
  // then leave the dot/viewport pointing at a different moment. Following the
  // id keeps the same card under the viewport across reorders, removals, and
  // additions. Updated on every scroll settle (onScroll).
  const focusedId = useRef<number | null>(moments[0]?.id ?? null);

  // Scroll re-anchoring funnels through ONE post-layout positioner. The trap we
  // avoid: scrollTo() called from a commit-phase effect targets an offset the
  // native ScrollView can't honour yet (new content not laid out), then the
  // settle fires onScroll and clobbers the dot. So both the initial park AND a
  // mid-session list change just record the WANTED offset; onContentSizeChange
  // (which fires AFTER native content is sized) applies it.
  //
  // Previously a single latch conflated "park once" with "never re-anchor",
  // which (a) let onContentSizeChange yank the viewport back to card 1 on every
  // removal and (b) never reset the offset when the strip collapsed to 1 card.
  const pendingScrollX = useRef<number | null>(offsetForPage(0));
  // A signature of the id ORDER, so the effect re-anchors on a reorder too, not
  // just a length change (a same-length reorder must still follow focusedId).
  const orderSig = moments.map((m) => m.id).join(',');
  useEffect(() => {
    // List changed mid-session (removal, addition, or reorder): re-find the
    // focused card by id and KEEP the viewport on it. If it's gone (removed),
    // clamp to the nearest valid index. Never reset to card 1.
    const byId = focusedId.current === null ? -1 : moments.findIndex((m) => m.id === focusedId.current);
    const target = byId >= 0 ? byId : Math.min(page, Math.max(0, moments.length - 1));
    focusedId.current = moments[target]?.id ?? null;
    if (target !== page) setPage(target);
    pendingScrollX.current = offsetForPage(target);
    // Nudge immediately too; if content isn't laid out yet, onContentSized
    // re-applies. Harmless double-apply to the same offset.
    scrollRef.current?.scrollTo({ x: pendingScrollX.current, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderSig]);

  const onContentSized = () => {
    if (pendingScrollX.current === null) return;
    scrollRef.current?.scrollTo({ x: pendingScrollX.current, animated: false });
    pendingScrollX.current = null;
  };

  // Dots track the swipe LIVE (on scroll, not just on settle) so they don't
  // lag. Map the raw track index → real dot index, wrapping for the clones.
  const onScroll = (x: number) => {
    // Skip while a re-anchor is mid-flight: the programmatic scrollTo fires
    // onScroll against the OLD (not-yet-relaid-out) content, where `i` can land
    // on a clone and wrap the dot to the wrong real → a one-frame flicker.
    // onContentSized will null this once the new layout settles.
    if (pendingScrollX.current !== null) return;
    const i = Math.round(x / step);
    const dot = loop ? (i - 1 + moments.length) % moments.length : i;
    focusedId.current = moments[dot]?.id ?? focusedId.current;
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
      {/* Section title — the strip mixes now / starting-soon / recently-visited
          moments, so a tense-neutral "Moments of interest" rather than a status
          word. Same heading style as "Join a moment" (18/600, -0.27 tracking).
          Gutter-padded to align with the cards (the ScrollView pads itself). */}
      <VText
        numberOfLines={1}
        maxFontSizeMultiplier={CARD_TEXT_MAX_SCALE}
        style={{ paddingHorizontal: GUTTER, fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}
      >
        Moments of interest
      </VText>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={step}
        decelerationRate="fast"
        // paddingVertical leaves room for the cards' drop shadow (elevation.sm
        // bleeds ~4px below the box) — without it the ScrollView's content box
        // hugs the card height and clips the shadow's bottom falloff.
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingVertical: 6, gap: 12 }}
        onContentSizeChange={onContentSized}
        scrollEventThrottle={16}
        onScroll={(e) => onScroll(e.nativeEvent.contentOffset.x)}
        onMomentumScrollEnd={(e) => onMomentumEnd(e.nativeEvent.contentOffset.x)}
      >
        {data.map((m, i) => {
          // Loop clones are the first (i=0) and last (i=len-1) entries.
          const isClone = loop && (i === 0 || i === data.length - 1);
          // Stable identity keys: reals keyed by id (so a removal shifts no
          // real card's key → no spurious remount that would drop a card's
          // open menu / "Opening…" state); the two clones get fixed sentinels
          // (they share an id with a real, so they MUST be disambiguated).
          const key = isClone ? (i === 0 ? 'clone-head' : 'clone-tail') : String(m.id);
          return (
            <LiveCard
              key={key}
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

// .setgroup — carded group wrapping the moments-sub-list push-rows (Upcoming +
// "Recent moments"), hairline-divided like the settings hub.
function PushGroup({ children }: { children: React.ReactNode }) {
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
      {children}
    </View>
  );
}

// .setnav — a labelled push-row into a moments sub-list. A non-first row draws
// a top hairline so a group reads as one card divided by a line (the group's
// own border covers the first row's edge).
function PushRow({ first, icon, label, count, onPress }: { first: boolean; icon: IconName; label: string; count: number; onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 13,
        paddingHorizontal: 14,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.ruleSoft,
        backgroundColor: pressed ? theme.surfaceSunk : 'transparent',
      })}
    >
      <Icon name={icon} size={19} color={theme.inkSoft} />
      <VText style={{ flex: 1, fontFamily: 'InstrumentSans_500Medium', fontSize: 15, lineHeight: 23 }}>{label}</VText>
      <VText variant="small" color="inkSoft">{count}</VText>
      <Icon name="chevron-right" size={18} color={theme.inkFaint} />
    </Pressable>
  );
}
