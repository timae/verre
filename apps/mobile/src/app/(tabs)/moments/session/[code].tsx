import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Linking, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/Icon';
import { VBar } from '@/components/VBar';
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
import { radius, useTheme } from '@/theme';

const POLL_MS = 5000;
const GUTTER = 22;
const FATAL_KINDS = new Set(['not-found', 'removed', 'invalid']);

type MetaView = SessionState['meta'];

// 02b line-up, read-only milestone, to the vero-screens pixel spec: .sess-meta
// line, .ovc about block, .vtabs, .lurow anatomy, .lock-card with countdown
// cells, .tempty. Rating input, host actions, Compare, and the ⋯ menu land in
// later milestones (Compare tab renders disabled; unrated rows show no Rate
// pill yet — flagged deviations).
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
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={meta?.name ?? ''} />
      </View>
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
          <OvcAbout meta={meta} isHostViewer={isHostViewer} myIdentityId={myIdentityId} />
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
              <OvcAbout meta={meta} isHostViewer={isHostViewer} myIdentityId={myIdentityId} />
            }
            contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.ruleSoft }} />}
            renderItem={({ item, index }) => (
              <LuRow wine={item} index={index} myIdentityId={myIdentityId} ratings={ratings} />
            )}
            ListEmptyComponent={<EmptyLineup canAdd={canAdd} />}
          />
        </>
      )}
    </View>
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
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, textAlign: 'center' }}>{title}</VText>
      <VText variant="small" color="inkSoft" style={{ textAlign: 'center', lineHeight: 19, maxWidth: 260 }}>{body}</VText>
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
        style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15 }}
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
function OvcAbout({ meta, isHostViewer, myIdentityId }: { meta: MetaView; isHostViewer: boolean; myIdentityId: string }) {
  const { theme } = useTheme();
  const [descOpen, setDescOpen] = useState(false);
  const [descClamped, setDescClamped] = useState(false);
  if (!meta) return null;
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
                  paddingVertical: 3, paddingHorizontal: 9, borderRadius: radius.pill, backgroundColor: theme.accentTint,
                }}
              >
                <Icon name="pin" size={12} color={theme.accent} />
                <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12 }} color="accent">Map</VText>
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
              <Icon name="link" size={16} color={theme.accent} />
              <VText variant="small" color="accent">Event link</VText>
            </>,
            'link',
            () => Linking.openURL(meta.link!).catch(() => {}),
          )
        : null}
      {meta.description ? (
        <Pressable onPress={() => setDescOpen((o) => !o)} disabled={!descClamped && !descOpen}>
          {/* Invisible un-clamped twin measures the real line count — "more"
              only appears when the 3-line clamp actually cuts content. */}
          <VText
            variant="small"
            pointerEvents="none"
            onTextLayout={(e) => setDescClamped(e.nativeEvent.lines.length > 3)}
            style={{ position: 'absolute', left: 0, right: 0, opacity: 0, lineHeight: 19 }}
          >
            {meta.description}
          </VText>
          <VText
            variant="small"
            color="inkSoft"
            numberOfLines={descOpen ? undefined : 3}
            style={{ marginTop: 10, lineHeight: 19 }}
          >
            {meta.description}
          </VText>
          {descClamped ? (
            <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 13, alignSelf: 'flex-end' }} color="accent">
              {descOpen ? 'less' : 'more'}
            </VText>
          ) : null}
        </Pressable>
      ) : null}
      <AvatarFoot meta={meta} isHostViewer={isHostViewer} myIdentityId={myIdentityId} />
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
function AvatarFoot({ meta, isHostViewer, myIdentityId }: { meta: NonNullable<MetaView>; isHostViewer: boolean; myIdentityId: string }) {
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
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 }}>
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
    </View>
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
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, letterSpacing: -0.27 }}>
        Something good awaits you
      </VText>
      <VText variant="small" color="inkSoft" style={{ textAlign: 'center', lineHeight: 19, maxWidth: 250, marginTop: 8, marginBottom: 22 }}>
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
  return (
    <View style={{ alignItems: 'center', paddingTop: 56, paddingBottom: 64 }}>
      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        <Icon name="glass" size={30} color={theme.inkSoft} />
      </View>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18 }}>Nothing in the line-up yet</VText>
      <VText variant="small" color="inkSoft" style={{ textAlign: 'center', maxWidth: 230, lineHeight: 19, marginTop: 6 }}>
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
function LuRow({
  wine, index, myIdentityId, ratings,
}: {
  wine: WireWine;
  index: number;
  myIdentityId: string;
  ratings: RatingsView | null;
}) {
  const { theme } = useTheme();
  const myScore = ratings?.[myIdentityId]?.ratings[wine.id]?.score ?? 0;
  const raters = ratersFor(wine.id, ratings);
  const blind = !!wine._blind;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 }}>
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
            <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15 }}>
              Impression {index + 1}
            </VText>
            <VText variant="small" color="inkSoft" style={{ marginTop: 1 }}>To be revealed</VText>
          </>
        ) : (
          <>
            {/* .lu-name: "Oslavje - 2018", vintage ink-soft regular */}
            <VText numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15 }}>
              {wine.name}
              {wine.vintage ? (
                <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular', fontSize: 15 }}>{` - ${wine.vintage}`}</VText>
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
      {/* .lu-right2 */}
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        {myScore > 0 ? <StarScore value={myScore} /> : null}
        <VText variant="caption" color="inkFaint">
          {raters > 0 ? `Rated by ${raters}` : 'Awaiting'}
        </VText>
      </View>
    </View>
  );
}
