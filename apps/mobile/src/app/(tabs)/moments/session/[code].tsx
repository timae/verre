import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { StarScore } from '@/components/scoring/StarScore';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import {
  ApiError,
  getSessionState,
  postVisit,
  type RatingsView,
  type SessionState,
  type WireWine,
} from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { useIsOnline } from '@/lib/query';
import { radius, space, useTheme } from '@/theme';

const POLL_MS = 5000;
const FATAL_KINDS = new Set(['not-found', 'removed', 'invalid']);

// 02b line-up, read-only this milestone: the wine list with ★+value scores,
// blind masking, the pre-tasting lock card, and the hardened 5s /state poll.
// Rating, host actions, and the ⋯ menu land in later milestones.
export default function SessionLineup() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = String(raw ?? '');
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const online = useIsOnline();
  const { data: auth } = authClient.useSession();
  const myIdentityId = auth ? `u:${auth.user.id}` : '';

  // Per-section graceful degradation (mirrors web SessionShell): a null
  // section from a partially-failed /state keeps the previous data.
  const lastRef = useRef<SessionState>({ meta: null, wines: null, ratings: null });

  // /state 401s for non-participants — the visit POST registers this user in
  // the session's identities map first (same ordering as the web SessionShell).
  // visitAttempt re-runs the effect for the "Try again" path on transient
  // failures; the effect also resets all per-session state when `code`
  // changes on a reused screen instance.
  const [visited, setVisited] = useState(false);
  const [fatal, setFatal] = useState<ApiError | null>(null);
  const [visitAttempt, setVisitAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setVisited(false);
    setFatal(null);
    lastRef.current = { meta: null, wines: null, ratings: null };
    postVisit(code)
      .then(() => { if (!cancelled) setVisited(true); })
      .catch((e) => { if (!cancelled) setFatal(e instanceof ApiError ? e : new ApiError('http', 0)); });
    return () => { cancelled = true; };
  }, [code, visitAttempt]);

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

  if (fatal) {
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm }}>
          <VText variant="subhead">{fatalTitle(fatal)}</VText>
          <VText variant="body" color="inkSoft" style={{ textAlign: 'center' }}>{fatalBody(fatal)}</VText>
          {fatal.kind === 'http' ? (
            <Button title="Try again" onPress={() => setVisitAttempt((n) => n + 1)} style={{ marginTop: space.sm }} />
          ) : null}
          <Button title="Back to Moments" variant="secondary" onPress={() => router.back()} style={{ marginTop: space.sm }} />
        </View>
      </>
    );
  }

  // Hosts/cohosts are exempt from the hide-lineup gate (the server returns
  // their wines, and an empty list just means nothing added yet) — only treat
  // it as locked for non-host viewers whose list came back empty.
  const isHostViewer =
    !!meta &&
    (meta.hostIdentityId === myIdentityId ||
      (meta.hostUserId !== null && `u:${meta.hostUserId}` === myIdentityId) ||
      (meta.coHostIds ?? []).includes(myIdentityId));
  const lock = !isHostViewer && wines !== null && wines.length === 0 ? lockState(meta) : null;
  const showReconnecting = !online || (state.isError && (wines !== null || meta !== null));

  return (
    <>
      <Stack.Screen options={{ title: meta?.name ?? '' }} />
      {showReconnecting ? (
        <View style={{ backgroundColor: theme.surfaceSunk, paddingVertical: 6, alignItems: 'center' }}>
          <VText variant="caption" color="inkSoft">Reconnecting…</VText>
        </View>
      ) : null}
      {!visited || (state.isPending && wines === null) ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : lock ? (
        <LockCard revealAt={lock} meta={meta} />
      ) : (
        <FlatList
          data={wines ?? []}
          keyExtractor={(w) => w.id}
          ListHeaderComponent={<SessionMetaLine meta={meta} />}
          contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE, gap: space.sm }}
          renderItem={({ item, index }) => (
            <WineRow wine={item} index={index} myIdentityId={myIdentityId} ratings={ratings} />
          )}
          ListEmptyComponent={
            <View style={{ paddingVertical: space.xl, alignItems: 'center', gap: space.xs }}>
              <VText variant="subhead">Nothing in the line-up yet</VText>
              <VText variant="body" color="inkSoft" style={{ textAlign: 'center' }}>
                Add the first thing you're tasting — a bottle, a cup, a plate.
              </VText>
            </View>
          }
        />
      )}
    </>
  );
}

function fatalTitle(e: ApiError): string {
  if (e.kind === 'not-found') return 'This moment has ended';
  if (e.kind === 'removed') return 'You were removed';
  return 'Something went wrong';
}

function fatalBody(e: ApiError): string {
  if (e.kind === 'not-found') return 'The session is no longer live.';
  if (e.kind === 'removed') return 'The host removed you from this moment.';
  if (e.kind === 'invalid') return "We couldn't verify you in this moment. Try joining again with the code.";
  return 'Try again in a moment.';
}

type MetaView = SessionState['meta'];

// Pre-tasting hide-lineup gate: the server returns an empty wine list until
// revealAt (lib/sessionState.ts buildWinesView).
function lockState(meta: MetaView): number | null {
  if (!meta?.hideLineup || !meta.dateFrom) return null;
  const revealAt = new Date(meta.dateFrom).getTime() - (meta.hideLineupMinutesBefore || 0) * 60_000;
  return Date.now() < revealAt ? revealAt : null;
}

function LockCard({ revealAt, meta }: { revealAt: number; meta: MetaView }) {
  const { theme } = useTheme();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, revealAt - Date.now());
  const when = new Date(revealAt).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  return (
    <View style={{ padding: space.lg, gap: space.sm }}>
      <View
        style={{
          backgroundColor: theme.surface,
          borderWidth: 1,
          borderColor: theme.rule,
          borderRadius: radius.lg,
          padding: space.xl,
          alignItems: 'center',
          gap: space.xs,
        }}
      >
        <VText variant="subhead">Something good awaits you</VText>
        <VText variant="body" color="inkSoft" style={{ textAlign: 'center' }}>
          Line-up reveals {when}
        </VText>
        <VText variant="heading" color="accent">{countdown(remaining)}</VText>
      </View>
      <SessionMetaLine meta={meta} />
    </View>
  );
}

function countdown(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function SessionMetaLine({ meta }: { meta: MetaView }) {
  if (!meta) return null;
  const parts: string[] = [];
  if (meta.dateFrom) {
    const d = new Date(meta.dateFrom);
    if (!Number.isNaN(d.getTime())) {
      parts.push(d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
    }
  }
  if (meta.address) parts.push(meta.address);
  if (parts.length === 0) return null;
  return (
    <VText variant="small" color="inkSoft" style={{ marginBottom: space.sm }}>
      {parts.join(' · ')}
    </VText>
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

function WineRow({
  wine,
  index,
  myIdentityId,
  ratings,
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
      <VText variant="small" color="inkFaint" style={{ width: 18, textAlign: 'center' }}>
        {index + 1}
      </VText>
      {!blind && wine.imageUrl ? (
        <Image source={{ uri: wine.imageUrl }} style={{ width: 44, height: 44, borderRadius: radius.sm }} />
      ) : (
        <View style={{ width: 44, height: 44, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk }} />
      )}
      <View style={{ flex: 1, gap: 2 }}>
        {blind ? (
          <>
            <VText variant="body" numberOfLines={1}>Impression {index + 1}</VText>
            <VText variant="small" color="inkSoft">To be revealed</VText>
          </>
        ) : (
          <>
            <VText variant="body" numberOfLines={1}>
              {wine.name}
              {wine.vintage ? <VText variant="body" color="inkSoft">{`  ${wine.vintage}`}</VText> : null}
            </VText>
            {wine.producer || wine.type ? (
              <VText variant="small" color="inkSoft" numberOfLines={1}>
                {[wine.producer, wine.type].filter(Boolean).join(' · ')}
              </VText>
            ) : null}
          </>
        )}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        {myScore > 0 ? (
          <StarScore value={myScore} />
        ) : (
          <VText variant="caption" color="inkFaint">Not rated</VText>
        )}
        <VText variant="caption" color="inkSoft">
          {raters > 0 ? `Rated by ${raters}` : 'Awaiting'}
        </VText>
      </View>
    </View>
  );
}
