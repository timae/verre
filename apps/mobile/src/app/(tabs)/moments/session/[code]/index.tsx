import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, FlatList, Image, Linking, Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Icon } from '@/components/ui/Icon';
import { VBar } from '@/components/VBar';
import { InviteSheet } from '@/components/moments/InviteSheet';
import { PeopleSheet } from '@/components/moments/PeopleSheet';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { StarScore } from '@/components/scoring/StarScore';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import {
  ApiError,
  getRemovedState,
  getSessionState,
  postVisit,
  type RatingsView,
  type SessionState,
  type WireWine,
} from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { sessionWhen } from '@/lib/momentFormat';
import { useIsOnline } from '@/lib/query';
import { motion, radius, useTheme } from '@/theme';

const POLL_MS = 5000;
const GUTTER = 22;
const FATAL_KINDS = new Set(['not-found', 'removed', 'invalid']);

type MetaView = SessionState['meta'];

// 02b line-up to the vero-screens pixel spec: .sess-meta line, .ovc about
// block, .vtabs, .lurow anatomy, .lock-card with countdown cells, .tempty.
// Milestone 3: rows open the impression detail (02e); unrated rows carry the
// .lu-rate pill, rated rows the score chip. Host actions, Compare, and the
// session ⋯ menu land in later milestones (Compare tab renders disabled —
// flagged deviation).
export default function SessionLineup() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = String(raw ?? '');
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const online = useIsOnline();
  const queryClient = useQueryClient();
  const { data: auth } = authClient.useSession();
  const myIdentityId = auth ? `u:${auth.user.id}` : '';

  // Per-section graceful degradation (mirrors web SessionShell): a null
  // section from a partially-failed /state keeps the previous data.
  const lastRef = useRef<SessionState>({ meta: null, wines: null, ratings: null });

  // /state 401s for non-participants — the visit POST registers this user in
  // the session's identities map first. visitAttempt re-runs the effect for
  // retries; the effect also resets all per-session state on a code change.
  const [visited, setVisited] = useState(false);
  const [fatal, setFatal] = useState<ApiError | null>(null);
  const [removedKind, setRemovedKind] = useState<'banned' | 'kicked' | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [sessMenuTop, setSessMenuTop] = useState<number | null>(null); // ⋯ menu anchor
  const [visitAttempt, setVisitAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setVisited(false);
    setFatal(null);
    setRemovedKind(null);
    lastRef.current = { meta: null, wines: null, ratings: null };
    postVisit(code)
      .then(() => {
        if (cancelled) return;
        setVisited(true);
        // Membership just registered — the Moments home pinning depends on it.
        queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
      })
      .catch((e) => { if (!cancelled) setFatal(e instanceof ApiError ? e : new ApiError('http', 0)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, visitAttempt]);

  // A kick is recoverable: rejoining by code clears the server-side kicked
  // marker, but this screen instance may still hold the stale removed state.
  // Re-run the visit whenever the screen regains focus in a recoverable
  // fatal state (never for plain network errors — those have a Try-again).
  const fatalRef = useRef<ApiError | null>(null);
  fatalRef.current = fatal;
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!focusedOnce.current) {
        focusedOnce.current = true;
        return;
      }
      const f = fatalRef.current;
      if (f && (f.kind === 'removed' || f.kind === 'invalid')) setVisitAttempt((n) => n + 1);
    }, []),
  );

  // Banned vs kicked copy (web RemovedView parity).
  useEffect(() => {
    if (fatal?.kind !== 'removed') return;
    let cancelled = false;
    getRemovedState(code)
      .then((s) => { if (!cancelled && (s === 'banned' || s === 'kicked')) setRemovedKind(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fatal, code]);

  const state = useQuery({
    queryKey: ['session-state', code, myIdentityId],
    queryFn: () => getSessionState(code),
    enabled: visited && !fatal,
    refetchInterval: POLL_MS,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && FATAL_KINDS.has(error.kind)) && failureCount < 1,
  });

  useEffect(() => {
    if (state.error instanceof ApiError && FATAL_KINDS.has(state.error.kind)) setFatal(state.error);
  }, [state.error]);

  if (state.data) {
    lastRef.current = {
      meta: state.data.meta ?? lastRef.current.meta,
      wines: state.data.wines ?? lastRef.current.wines,
      ratings: state.data.ratings ?? lastRef.current.ratings,
    };
  }
  const { meta, wines, ratings } = lastRef.current;

  const isHostViewer =
    !!meta &&
    (meta.hostIdentityId === myIdentityId ||
      (meta.hostUserId !== null && `u:${meta.hostUserId}` === myIdentityId) ||
      (meta.coHostIds ?? []).includes(myIdentityId));
  const canAdd = isHostViewer || !!meta?.providerIds?.includes(myIdentityId);

  // Hosts/cohosts are exempt from the hide-lineup gate (the server returns
  // their wines) — only treat it as locked for non-host viewers whose list
  // came back empty.
  const lock = !isHostViewer && wines !== null && wines.length === 0 ? lockState(meta) : null;
  const showReconnecting = !online || (state.isError && (wines !== null || meta !== null));

  // Prototype order (tListEmpty/tHiddenCountdown): vbar → tabs → scroll body
  // (ovc → rows). Tabs sit OUTSIDE the scroll area; the lock variant has none.
  return (
    // BottomSheetModalProvider lives INSIDE the screen (not the root _layout):
    // with expo-router/react-native-screens a root provider's gorhom host gets
    // zero height across the Stack boundary and sheets never present (gorhom
    // #1884/#2035). Hosting it in this screen's flex:1 View gives the sheets a
    // sized provider + portal host.
    <BottomSheetModalProvider>
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar
          title={meta?.name ?? ''}
          right={meta ? <SessionMenuButton onOpen={(top) => setSessMenuTop(top)} /> : undefined}
        />
      </View>
      {/* Session ⋯ menu (.sess-menu): Blind-for-all + Settings land later. */}
      <SessionMenu
        anchorTop={sessMenuTop}
        onClose={() => setSessMenuTop(null)}
        onPeople={() => { setSessMenuTop(null); setPeopleOpen(true); }}
        onShare={() => { setSessMenuTop(null); setInviteOpen(true); }}
      />
      {meta ? (
        <>
          <InviteSheet
            open={inviteOpen}
            onClose={() => setInviteOpen(false)}
            code={code}
            momentName={meta.name}
            // Block-scrub before deriving "Joined": meta.participants ships the
            // FULL list; per-viewer block filtering is client-side via
            // viewerBlocksOut/In (mirrors web SessionPanel). Without this, a
            // blocked friend could light up as "Joined" — a block-boundary leak.
            participantIds={
              new Set(
                (meta.participants ?? [])
                  .filter((p) => !meta.viewerBlocksOut.includes(p.id) && !meta.viewerBlocksIn.includes(p.id))
                  .map((p) => p.id),
              )
            }
          />
          <PeopleSheet
            open={peopleOpen}
            onClose={() => setPeopleOpen(false)}
            code={code}
            meta={meta}
            myIdentityId={myIdentityId}
            onInvite={() => setInviteOpen(true)}
          />
        </>
      ) : null}
      {showReconnecting ? (
        <View style={{ backgroundColor: theme.surfaceSunk, paddingVertical: 6, alignItems: 'center' }}>
          <VText variant="caption" color="inkSoft">Reconnecting…</VText>
        </View>
      ) : null}
      {fatal ? (
        <FatalView fatal={fatal} removedKind={removedKind} sessionLabel={meta?.name ?? null}
          onRetry={() => setVisitAttempt((n) => n + 1)} onBack={() => router.back()} />
      ) : !visited || (state.isPending && wines === null) ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : lock ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}>
          <LockCard revealAt={lock} />
          <OvcAbout meta={meta} isHostViewer={isHostViewer} myIdentityId={myIdentityId} onPeople={() => setPeopleOpen(true)} />
        </ScrollView>
      ) : (
        <>
          <View style={{ paddingHorizontal: GUTTER }}>
            <TabStrip />
          </View>
          <FlatList
            data={wines ?? []}
            keyExtractor={(w) => w.id}
            ListHeaderComponent={
              <OvcAbout meta={meta} isHostViewer={isHostViewer} myIdentityId={myIdentityId} onPeople={() => setPeopleOpen(true)} />
            }
            // flexGrow:1 gives the empty state a flex slot; EmptyLineup freezes its
            // own height there so its centering doesn't jump when the tab bar hides.
            contentContainerStyle={{ flexGrow: 1, paddingHorizontal: GUTTER, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.ruleSoft }} />}
            renderItem={({ item, index }) => (
              <LuRow
                wine={item}
                index={index}
                myIdentityId={myIdentityId}
                ratings={ratings}
                onPress={() =>
                  router.push({
                    pathname: '/(tabs)/moments/session/[code]/impression/[wineId]',
                    params: { code, wineId: item.id },
                  })
                }
              />
            )}
            ListEmptyComponent={<EmptyLineup canAdd={canAdd} />}
          />
        </>
      )}
    </View>
    </BottomSheetModalProvider>
  );
}

function FatalView({
  fatal, removedKind, sessionLabel, onRetry, onBack,
}: {
  fatal: ApiError;
  removedKind: 'banned' | 'kicked' | null;
  sessionLabel: string | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  let title = 'Something went wrong';
  let body = 'Try again in a moment.';
  if (fatal.kind === 'not-found') {
    title = 'This moment has ended';
    body = 'The session is no longer live.';
  } else if (fatal.kind === 'removed') {
    if (removedKind === 'banned') {
      title = 'You have been banned from this session';
      body = `The host${sessionLabel ? ` of ${sessionLabel}` : ''} banned you. Your ratings and notes from this session have been removed.`;
    } else {
      title = 'You were removed';
      body = 'The host removed you from this moment. You can rejoin with the code.';
    }
  } else if (fatal.kind === 'invalid') {
    body = "We couldn't verify you in this moment. Try joining again with the code.";
    title = 'Not part of this moment';
  }
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 }}>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, textAlign: 'center' }}>{title}</VText>
      <VText variant="small" color="inkSoft" style={{ textAlign: 'center', lineHeight: 20, maxWidth: 260 }}>{body}</VText>
      {fatal.kind === 'http' ? <Button title="Try again" onPress={onRetry} style={{ marginTop: 10 }} /> : null}
      <Button title="Back to Moments" variant="secondary" onPress={onBack} style={{ marginTop: fatal.kind === 'http' ? 0 : 10 }} />
    </View>
  );
}

// .vtabs — Line-up | Compare. Compare arrives in a later milestone; the tab
// renders per spec but disabled.
function TabStrip() {
  const { theme } = useTheme();
  const tab = (label: string, on: boolean, disabled?: boolean) => (
    <View
      key={label}
      style={{
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderBottomWidth: 2,
        borderBottomColor: on ? theme.accent : 'transparent',
        marginBottom: -1,
      }}
    >
      <VText
        style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}
        color={on ? 'ink' : disabled ? 'inkFaint' : 'inkSoft'}
      >
        {label}
      </VText>
    </View>
  );
  return (
    <View style={{ flexDirection: 'row', gap: 2, borderBottomWidth: 1, borderBottomColor: theme.rule, marginBottom: 4 }}>
      {tab('Line-up', true)}
      {tab('Compare', false, true)}
    </View>
  );
}

// .ovc — the session about block: location + Map pill, when, event link,
// clamped description, avatar-stack foot.
function OvcAbout({ meta, isHostViewer, myIdentityId, onPeople }: { meta: MetaView; isHostViewer: boolean; myIdentityId: string; onPeople: () => void }) {
  const { theme } = useTheme();
  const [descOpen, setDescOpen] = useState(false);
  // Character count of the first three laid-out lines (from the invisible
  // measurer), or null when the description fits unclamped.
  const [clampLen, setClampLen] = useState<number | null>(null);
  if (!meta) return null;

  // Word-boundary truncation: slice the original string at the 3-line break,
  // walk back to a word end (freeing room for "… more" on the same line),
  // append the ellipsis. " more" then flows inline — never mid-word, never
  // its own line.
  let truncated: string | null = null;
  if (clampLen !== null && meta.description) {
    let txt = meta.description.slice(0, clampLen).replace(/\s+$/, '');
    let cut = txt.lastIndexOf(' ');
    while (cut > 0 && txt.length - cut < 9) cut = txt.lastIndexOf(' ', cut - 1);
    if (cut > 0) txt = txt.slice(0, cut);
    truncated = txt.replace(/[\s,.;:]+$/, '') + ' …';
  }
  const when = sessionWhen(meta.dateFrom, meta.dateTo);
  const hasAny = meta.address || when || meta.link || meta.description || meta.participants.length > 0;
  if (!hasAny) return null;

  const line = (children: React.ReactNode, key: string, onPress?: () => void) => (
    <Pressable
      key={key}
      disabled={!onPress}
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }}
    >
      {children}
    </Pressable>
  );

  return (
    <View style={{ paddingTop: 12, paddingBottom: 14, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: theme.rule, gap: 0 }}>
      {meta.address
        ? line(
            <>
              <Icon name="pin" size={16} color={theme.inkSoft} />
              <VText variant="small" numberOfLines={1} style={{ flexShrink: 1 }}>{meta.address}</VText>
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 6,
                  // Tuned against the mock with Simon (2026-06-12): tight
                  // 14px label line box + spec 3px v-padding (~20px pill),
                  // seated 2px low. The rendered mock, not the CSS literal,
                  // was the tiebreaker here.
                  marginTop: 2,
                  paddingVertical: 3, paddingHorizontal: 9, borderRadius: radius.pill, backgroundColor: theme.accentTint,
                }}
              >
                <Icon name="pin" size={11} color={theme.accent} />
                <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, lineHeight: 14 }} color="accent">Map</VText>
              </View>
            </>,
            'loc',
            () => Linking.openURL(`https://maps.apple.com/?q=${encodeURIComponent(meta.address!)}`).catch(() => {}),
          )
        : null}
      {when
        ? line(
            <>
              <Icon name="clock" size={16} color={theme.inkSoft} />
              <VText variant="small">{when}</VText>
            </>,
            'when',
          )
        : null}
      {meta.link
        ? line(
            <>
              {/* .ovc-line svg is ink-soft even on the accent line — only
                  the label text carries accent. */}
              <Icon name="link" size={16} color={theme.inkSoft} />
              <VText variant="small" color="accent">Event link</VText>
            </>,
            'link',
            // In-app browser — keep the user inside the moment (the Map
            // line above stays Linking: it should open the Maps app).
            () => WebBrowser.openBrowserAsync(meta.link!).catch(() => {}),
          )
        : null}
      {meta.description ? (
        <Pressable onPress={() => setDescOpen((o) => !o)} disabled={truncated === null && !descOpen}>
          {/* Invisible un-clamped twin: reports the laid-out lines so the
              visible text can be cut at the real 3-line break. */}
          <VText
            variant="small"
            pointerEvents="none"
            onTextLayout={(e) => {
              const lines = e.nativeEvent.lines;
              setClampLen(
                lines.length > 3 ? lines.slice(0, 3).reduce((n, l) => n + l.text.length, 0) : null,
              );
            }}
            style={{ position: 'absolute', left: 0, right: 0, opacity: 0, lineHeight: 20 }}
          >
            {meta.description}
          </VText>
          {descOpen ? (
            // Expanded: "less" flows inline at the end of the last line.
            <VText variant="small" color="inkSoft" style={{ marginTop: 10, lineHeight: 20 }}>
              {meta.description}
              <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }} color="accent">
                {'  less'}
              </VText>
            </VText>
          ) : (
            <VText variant="small" color="inkSoft" numberOfLines={3} style={{ marginTop: 10, lineHeight: 20 }}>
              {truncated ?? meta.description}
              {truncated !== null ? (
                <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 20 }} color="accent">
                  {' more'}
                </VText>
              ) : null}
            </VText>
          )}
        </Pressable>
      ) : null}
      <AvatarFoot meta={meta} isHostViewer={isHostViewer} myIdentityId={myIdentityId} onPress={onPeople} />
    </View>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// .ovc-foot + .ovc-chip: 28px initials circles, -8 overlap, host = accent,
// overflow chip = accent tint, "Hosted by <b>…</b>".
function AvatarFoot({ meta, isHostViewer, myIdentityId, onPress }: { meta: NonNullable<MetaView>; isHostViewer: boolean; myIdentityId: string; onPress: () => void }) {
  const { theme } = useTheme();
  if (meta.participants.length === 0) return null;
  const hostId = meta.hostIdentityId ?? (meta.hostUserId !== null ? `u:${meta.hostUserId}` : null);
  const ordered = [...meta.participants].sort((a, b) => (a.id === hostId ? -1 : b.id === hostId ? 1 : 0));
  const shown = ordered.slice(0, 3);
  const extra = ordered.length - shown.length;
  const isSelfHost = hostId === myIdentityId && isHostViewer;
  // Prefer the roster entry (kept fresh by rename propagation) over the
  // create-time meta.host snapshot.
  const hostName = ordered.find((p) => p.id === hostId)?.displayName ?? meta.host;

  const chip = (p: { id: string; displayName: string; imageUrl: string | null }, i: number) => {
    const isHost = p.id === hostId;
    return (
      <View
        key={p.id}
        style={{
          width: 30, height: 30, borderRadius: 15,
          marginLeft: i === 0 ? 0 : -8,
          borderWidth: 2, borderColor: theme.bg,
          backgroundColor: isHost ? theme.accent : theme.surfaceSunk,
          alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        }}
      >
        {p.imageUrl ? (
          <Image source={{ uri: p.imageUrl }} style={{ width: 26, height: 26, borderRadius: 13 }} />
        ) : (
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12 }} color={isHost ? theme.accentInk : 'inkSoft'}>
            {initials(p.displayName)}
          </VText>
        )}
      </View>
    );
  };

  return (
    // Tapping the avatar stack opens People (design behaviour).
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="View people"
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, opacity: pressed ? 0.6 : 1 })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {shown.map(chip)}
        {extra > 0 ? (
          <View
            style={{
              width: 30, height: 30, borderRadius: 15, marginLeft: -8,
              borderWidth: 2, borderColor: theme.bg, backgroundColor: theme.accentTint,
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12 }} color="accent">+{extra}</VText>
          </View>
        ) : null}
      </View>
      <VText variant="small" color="inkSoft">
        Hosted by <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{isSelfHost ? 'you' : hostName}</VText>
      </VText>
    </Pressable>
  );
}

// Pre-tasting hide-lineup gate: the server returns an empty wine list until
// revealAt (lib/sessionState.ts buildWinesView).
function lockState(meta: MetaView): number | null {
  if (!meta?.hideLineup || !meta.dateFrom) return null;
  const revealAt = new Date(meta.dateFrom).getTime() - (meta.hideLineupMinutesBefore || 0) * 60_000;
  return Date.now() < revealAt ? revealAt : null;
}

// .lock-card + .cd countdown cells + .lock-start.
function LockCard({ revealAt }: { revealAt: number }) {
  const { theme } = useTheme();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, revealAt - Date.now());
  const s = Math.floor(remaining / 1000);
  const cells: Array<[string, number]> = [
    ['days', Math.floor(s / 86400)],
    ['hrs', Math.floor((s % 86400) / 3600)],
    ['min', Math.floor((s % 3600) / 60)],
    ['sec', s % 60],
  ];
  const when = new Date(revealAt).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return (
    <View style={{ alignItems: 'center', paddingTop: 30, paddingBottom: 34, borderBottomWidth: 1, borderBottomColor: theme.rule }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        <Icon name="eyeoff" size={24} color={theme.inkSoft} />
      </View>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27 }}>
        Something good awaits you
      </VText>
      <VText variant="small" color="inkSoft" style={{ textAlign: 'center', lineHeight: 20, maxWidth: 250, marginTop: 8, marginBottom: 22 }}>
        The host has kept the line-up under wraps. It opens when the reveal time arrives.
      </VText>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {cells.map(([label, v]) => (
          <View key={label} style={{ width: 58, backgroundColor: theme.surfaceSunk, borderRadius: radius.md, paddingTop: 10, paddingBottom: 7, alignItems: 'center' }}>
            <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 26, letterSpacing: -0.5, lineHeight: 28 }}>
              {String(v).padStart(2, '0')}
            </VText>
            <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', marginTop: 5 }}>
              {label}
            </VText>
          </View>
        ))}
      </View>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, marginTop: 18 }} color="accent">
        Line-up reveals {when}
      </VText>
    </View>
  );
}

// .tempty — role-aware: only viewers with add-rights get the "add the first
// thing" invitation (guest copy is unspecced in the handoff; flagged).
function EmptyLineup({ canAdd }: { canAdd: boolean }) {
  const { theme } = useTheme();
  // The empty state lives in a flex:1 slot. When the tab bar hides for a sheet,
  // that slot grows (the freed bar space), and center-justified content would
  // shift down by half the delta — then back on close: the "jump". Fix: freeze
  // this view's FIRST measured height (bar present) and pin it as a FIXED height.
  // A fixed-height block doesn't grow with the slot, so the centering holds.
  const [h, setH] = useState(0);
  return (
    <View
      onLayout={(e) => { const m = e.nativeEvent.layout.height; if (h === 0 && m > 0) setH(m); }}
      style={[h > 0 ? { height: h } : { flex: 1 }, { alignItems: 'center', justifyContent: 'center', paddingVertical: 32 }]}
    >
      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        <Icon name="glass" size={30} color={theme.inkSoft} />
      </View>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23 }}>Nothing in the line-up yet</VText>
      <VText variant="small" color="inkSoft" style={{ textAlign: 'center', maxWidth: 230, lineHeight: 20, marginTop: 6 }}>
        {canAdd
          ? "Add the first thing you're tasting — a bottle, a cup, a plate."
          : 'The host is still putting the line-up together.'}
      </VText>
    </View>
  );
}

function ratersFor(wineId: string, ratings: RatingsView | null): number {
  if (!ratings) return 0;
  let n = 0;
  for (const entry of Object.values(ratings)) {
    const r = entry.ratings[wineId];
    if (r && r.score > 0) n += 1;
  }
  return n;
}

// .lurow: idx · thumb · name/vintage + maker + style · score/rated column.
// The whole row opens the impression detail (02e); unrated rows carry the
// .lu-rate pill, rated rows the one-star score chip.
function LuRow({
  wine, index, myIdentityId, ratings, onPress,
}: {
  wine: WireWine;
  index: number;
  myIdentityId: string;
  ratings: RatingsView | null;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  const myScore = ratings?.[myIdentityId]?.ratings[wine.id]?.score ?? 0;
  const raters = ratersFor(wine.id, ratings);
  const blind = !!wine._blind;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {/* .lu-idx: 18w, 13/600, ink-faint, tabular */}
      <VText
        color="inkFaint"
        style={{ width: 18, textAlign: 'center', fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, fontVariant: ['tabular-nums'] }}
      >
        {index + 1}
      </VText>
      {blind ? (
        // .lu-masked: sunk bg, dashed rule border, eye-off
        <View
          style={{
            width: 46, height: 46, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk,
            borderWidth: 1, borderStyle: 'dashed', borderColor: theme.rule,
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Icon name="eyeoff" size={18} color={theme.inkFaint} />
        </View>
      ) : wine.imageUrl ? (
        <Image source={{ uri: wine.imageUrl }} style={{ width: 46, height: 46, borderRadius: radius.sm }} />
      ) : (
        <View style={{ width: 46, height: 46, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="glass" size={19} color={theme.inkFaint} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        {blind ? (
          <>
            <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}>
              Impression {index + 1}
            </VText>
            <VText variant="small" color="inkSoft" style={{ marginTop: 1 }}>To be revealed</VText>
          </>
        ) : (
          <>
            {/* .lu-name: "Oslavje - 2018" — the dash stays in the name
                colour; only the year itself is ink-soft regular */}
            <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 23 }}>
              {wine.name}
              {wine.vintage ? (
                <>
                  {' - '}
                  <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular', fontSize: 15, lineHeight: 23 }}>{wine.vintage}</VText>
                </>
              ) : null}
            </VText>
            {wine.producer ? (
              <VText variant="small" color="inkSoft" numberOfLines={1} style={{ marginTop: 1 }}>{wine.producer}</VText>
            ) : null}
            {wine.grape || wine.type ? (
              <VText variant="caption" color="inkFaint" numberOfLines={1} style={{ marginTop: 1 }}>
                {wine.grape || wine.type}
              </VText>
            ) : null}
          </>
        )}
      </View>
      {/* .lu-right2: score chip when rated, .lu-rate pill when not */}
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        {myScore > 0 ? (
          <StarScore value={myScore} />
        ) : (
          <View
            style={{
              borderWidth: 1,
              borderColor: theme.accentLine,
              borderRadius: radius.pill,
              paddingVertical: 5,
              paddingHorizontal: 13,
            }}
          >
            <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, lineHeight: 16 }} color="accent">
              Rate
            </VText>
          </View>
        )}
        {raters > 0 ? (
          <VText variant="caption" color="inkFaint">{`Rated by ${raters}`}</VText>
        ) : null}
      </View>
    </Pressable>
  );
}

// VBar ⋯ button — measures its position so the menu anchors under it.
function SessionMenuButton({ onOpen }: { onOpen: (anchorBottomY: number) => void }) {
  const { theme } = useTheme();
  const ref = useRef<View>(null);
  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Session menu"
        hitSlop={8}
        onPress={() => ref.current?.measureInWindow((_x, y, _w, h) => onOpen(y + h))}
        style={({ pressed }) => ({ width: 30, height: 30, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
      >
        <Icon name="more" size={20} color={theme.ink} />
      </Pressable>
    </View>
  );
}

// Session ⋯ menu (.sess-menu): Blind-for-all + Settings are later milestones, so
// they render disabled ("Soon") for now; People + Share invite are active.
// Anchored dropdown (the 02e .ir-menu pattern).
function SessionMenu({ anchorTop, onClose, onPeople, onShare }: { anchorTop: number | null; onClose: () => void; onPeople: () => void; onShare: () => void }) {
  const { theme } = useTheme();
  const anim = useRef(new Animated.Value(0)).current;
  const lastTop = useRef(0);
  if (anchorTop !== null) lastTop.current = anchorTop;
  useEffect(() => {
    if (anchorTop === null) { anim.setValue(0); return; }
    Animated.timing(anim, { toValue: 1, duration: motion.dur1, easing: Easing.bezier(...motion.ease), useNativeDriver: true }).start();
  }, [anchorTop, anim]);
  const Item = ({ icon, label, onPress, disabled }: { icon: 'eyeoff' | 'user' | 'glass' | 'share'; label: string; onPress?: () => void; disabled?: boolean }) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: pressed && !disabled ? theme.surfaceSunk : 'transparent' })}
    >
      <Icon name={icon} size={18} color={disabled ? theme.inkFaint : theme.ink} />
      <VText style={{ fontFamily: 'InstrumentSans_500Medium', fontSize: 15, flex: 1 }} color={disabled ? 'inkFaint' : 'ink'}>{label}</VText>
      {disabled ? <VText variant="caption" color="inkFaint">Soon</VText> : null}
    </Pressable>
  );
  return (
    <Modal transparent visible={anchorTop !== null} animationType="none" onRequestClose={onClose} presentationStyle="overFullScreen" statusBarTranslucent>
      <Pressable style={{ flex: 1 }} accessibilityLabel="Close menu" onPress={onClose}>
        <Animated.View
          style={{
            position: 'absolute', top: lastTop.current + 6, right: GUTTER, minWidth: 200,
            backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule, borderRadius: radius.md, padding: 6,
            opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) }],
            shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 8,
          }}
        >
          <Item icon="eyeoff" label="Blind for all" disabled />
          <View style={{ height: 1, backgroundColor: theme.ruleSoft, marginVertical: 4 }} />
          <Item icon="user" label="People" onPress={onPeople} />
          <Item icon="share" label="Share invite" onPress={onShare} />
          <Item icon="glass" label="Settings" disabled />
        </Animated.View>
      </Pressable>
    </Modal>
  );
}
