import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { StatusBar } from 'expo-status-bar';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { CoverHeroLineup, HeroTopBar, LockCard, useTabTransition } from '@/components/moments/LineupParts';
import { LookInAbout, LookInJoinSheet, LookInPeopleSheet, LookInRow } from '@/components/moments/LookInParts';
import { PersonPreviewProvider } from '@/components/moments/PersonPreviewSheet';
import { SessionFatalView } from '@/components/moments/SessionFatalView';
import { ReconnectingBar } from '@/components/ui/ConnectionState';
import { IconPill } from '@/components/ui/IconPill';
import { VText } from '@/components/ui/VText';
import { getMomentMembership, type LookIn, type LookInAroma } from '@/lib/api/moments';
import { ApiError } from '@/lib/api/sessions';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';
import { adaptLookIn } from '@/lib/lookInCompare';
import { useForwardStatusBarStyle } from '@/lib/forwardedStatusBar';
import { useMeId } from '@/lib/meId';
import { useIsOnline } from '@/lib/query';
import { lookHref, sessionHref, tabHomeHref, useSessionTab } from '@/lib/sessionStack';
import { lookInFatalOf, useLookIn } from '@/lib/useLookIn';
import { useTheme } from '@/theme';

// THE LOOK-IN (Moment Visibility step-2 plan § 4.4): a moment seen from
// outside, by its public id. 🔒 Its own screen, never the moment screen in a
// read-only mode: opening the moment screen POSTs /visit, which would make the
// viewer a member (T1). The moment screen's look (the cover hero or the plain
// bar, components/moments/LineupParts.tsx), read-only: no Add, no ⋯, no
// in-place edit, no reveal, and since 2026-11-24 no Compare tab (ruled: each
// bottle's page carries its compare card, bottle/[key].tsx). The Line-up has
// no toolbar (T8: its sorts are your own scores).
//
// Opened by audience (a feed post, someone's Moments list) or by LINK
// (`via=link&h=<handle>`, lib/lookInLinks.ts: the token never enters a route
// param; the screen sends it as `X-Verre-Link` for its whole life, T6). The
// first read answers `{ member: true }` for a member: the moment REPLACES the
// look-in on this stack (T7). Polls every 5 s while focused (lib/useLookIn.ts);
// aromas only on a bottle's page (its details read, T4).

export default function LookInScreen() {
  const { momentId: raw, via, h } = useLocalSearchParams<{ momentId: string; via?: string; h?: string }>();
  const momentId = String(raw ?? '');
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowH, width: windowW } = useWindowDimensions();
  const router = useRouter();
  const navigation = useNavigation();
  const mount = useSessionTab();
  const online = useIsOnline();
  const meId = useMeId();
  const { q, badLink, viaLink, focused } = useLookIn(momentId, via, h);
  const look: LookIn | null = q.data && q.data.member === false ? q.data : null;

  // A member (T7): the moment itself, in place of the look-in on this stack.
  // Only while focused (a bottle page on top handles it by going back here).
  // Only a 404 means "not yours after all"; any other failure (offline, a
  // 429 of its own limiter) offers Try Again (review r1).
  const [memberGone, setMemberGone] = useState(false);
  const [memberError, setMemberError] = useState<ApiError | null>(null);
  const [memberTry, setMemberTry] = useState(0);
  useEffect(() => {
    if (!focused || q.data?.member !== true) return;
    let cancelled = false;
    getMomentMembership(momentId)
      .then(({ code }) => { if (!cancelled) router.replace(sessionHref(mount, '', { code })); })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.kind === 'not-found') setMemberGone(true);
        else setMemberError(e instanceof ApiError ? e : new ApiError('http', 0));
      });
    return () => { cancelled = true; };
  }, [focused, q.data, momentId, mount, router, memberTry]);

  // No Compare tab here (ruled 2026-11-24): each bottle's page carries its
  // compare card, so this screen never asks for aromas.
  const adapted = useMemo(() => (look ? adaptLookIn(look, NO_AROMAS) : null), [look]);
  const bottleByKey = useMemo(() => new Map((look?.lineup ?? []).map((b) => [b.key, b])), [look]);
  const indexByKey = useMemo(() => new Map((look?.lineup ?? []).map((b, i) => [b.key, i])), [look]);

  const heroShown = !!look?.moment.coverPhotoUrl;
  const transition = useTabTransition(windowW, heroShown);
  const [heroCollapsed, setHeroCollapsed] = useState(false);
  // The cover hero installs its scroll here for the in-place edit; a look-in has none.
  const noScrollBy = useRef<((dy: number) => void) | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  const goBack = () => {
    if ((navigation.getState()?.index ?? 0) > 0) router.back();
    else router.replace(tabHomeHref(mount.tab));
  };
  const openBottle = (key: string) =>
    router.push(lookHref(mount, 'bottle/[key]', { momentId, key, ...(viaLink && h ? { via: 'link' as const, h } : {}) }));

  const showReconnecting = !!look && (!online || q.isError);
  const statusBarStyle = heroShown && !heroCollapsed && !showReconnecting ? 'light' : theme.scheme === 'dark' ? 'light' : 'dark';
  useForwardStatusBarStyle(statusBarStyle);

  // ── refusals (lib/useLookIn.ts lookInFatalOf) ─────────────────────────
  const fatal = lookInFatalOf({ badLink, viaLink, memberGone, error: memberError ?? q.error, hasData: !!look, member: q.data?.member === true && !memberError });

  const title = look?.moment.name || 'Untitled Moment';
  const ovc = look ? <LookInAbout look={look} onPeople={() => setPeopleOpen(true)} /> : null;
  // Join, top right in both layouts (ruled 2026-11-24: the "+ New" pill).
  const joinPill = <IconPill icon="plus" label="Join" accessibilityLabel={title ? `Join ${title}` : 'Join This Moment'} onPress={() => setJoinOpen(true)} />;
  const lockTime = look?.lineupHidden && look.moment.lineupRevealsAt ? Date.parse(look.moment.lineupRevealsAt) : null;
  // A hidden line-up is the lock state whether or not the record yields a time.
  const lock = look?.lineupHidden ? (lockTime ?? 1) : null;
  const lockCard = look?.lineupHidden ? <LockCard revealAt={lockTime} /> : null;
  const empty = <VText variant="small" color="inkSoft" style={{ paddingTop: 16 }}>No impressions yet.</VText>;
  const rows = (look?.lineup ?? []).map((b) => (
    <LookInRow key={b.key} bottle={b} index={indexByKey.get(b.key) ?? 0} onPress={() => openBottle(b.key)} />
  ));

  return (
    <BottomSheetModalProvider>
    <PersonPreviewProvider meta={null} roster={fatal ? null : adapted?.previewIds ?? null} myIdentityId={meId ? `u:${meId}` : ''}>
    <View style={{ flex: 1, paddingTop: heroShown && !fatal ? 0 : insets.top + 8 }}>
      <Stack.Screen options={{ statusBarStyle }} />
      <StatusBar style={statusBarStyle} />
      {!heroShown || fatal ? (
        <View style={{ paddingHorizontal: GUTTER }}>
          <VBar title={look ? title : ''} onBack={goBack} right={look && !fatal ? joinPill : undefined} />
        </View>
      ) : null}
      {showReconnecting && !fatal ? <ReconnectingBar /> : null}
      {fatal ? (
        <SessionFatalView
          fatal={fatal.error}
          removedKind={null}
          sessionLabel={null}
          copy={fatal.copy}
          onRetry={() => {
            if (memberError) { setMemberError(null); setMemberTry((n) => n + 1); } else void q.refetch();
          }}
          onBack={goBack}
        />
      ) : !look ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : heroShown ? (
        <CoverHeroLineup
          meta={{ name: title }}
          coverUrl={look.moment.coverPhotoUrl!}
          scrollByRef={noScrollBy}
          bottomPad={TAB_BAR_CLEARANCE}
          lock={lock}
          lockCard={lockCard}
          wines={adapted!.wines}
          indexById={indexByKey}
          luNarrowed={false}
          toolbar={null}
          reorder={{ enabled: false, denied: false, deniedNote: '', onCommit: () => false, onDenied: () => {} }}
          ratings={adapted!.ratings}
          myIdentityId=""
          canAdd={false}
          windowH={windowH}
          windowW={windowW}
          ovc={ovc}
          reveal={NO_REVEAL}
          transition={transition}
          onSelectTab={transition.select}
          compare={null}
          compareRail={null}
          noTabs
          onCollapsedChange={setHeroCollapsed}
          onPressWine={openBottle}
          onAdd={() => {}}
          renderRow={(w, i) => {
            const b = bottleByKey.get(w.id);
            return b ? <LookInRow bottle={b} index={i} onPress={() => openBottle(b.key)} /> : null;
          }}
          empty={empty}
        />
      ) : lock ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: TAB_BAR_CLEARANCE }}>
          {lockCard}
          {ovc}
        </ScrollView>
      ) : (
        // The plain layout: a small copy of the moment screen's Line-up (no
        // toolbar, no drag, no reveal, no tabs: ruled 2026-11-24).
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, paddingHorizontal: GUTTER, paddingBottom: TAB_BAR_CLEARANCE }}>
          {ovc}
          {rows.length === 0 ? empty : rows.map((r, i) => (
            <View key={r.key}>
              {i > 0 ? <View style={{ height: 1, backgroundColor: theme.ruleSoft }} /> : null}
              {r}
            </View>
          ))}
        </ScrollView>
      )}
      {heroShown && look && !fatal ? (
        <HeroTopBar title={title} collapsed={heroCollapsed} canAdd={false} showAdd={false} onAdd={() => {}} onBack={goBack} trailing={joinPill} />
      ) : null}
      {look && !fatal ? (
        <>
          <LookInPeopleSheet open={peopleOpen} onClose={() => setPeopleOpen(false)} look={look} />
          <LookInJoinSheet
            open={joinOpen}
            onClose={() => setJoinOpen(false)}
            momentId={momentId}
            name={look.moment.name ?? ''}
            // Joined: the moment itself, in place of the look-in on this stack.
            onJoined={(code) => { setJoinOpen(false); router.replace(sessionHref(mount, '', { code })); }}
          />
        </>
      ) : null}
    </View>
    </PersonPreviewProvider>
    </BottomSheetModalProvider>
  );
}

const NO_AROMAS: ReadonlyMap<string, ReadonlyMap<string, LookInAroma[]>> = new Map();

// The look-in reveals nothing (CoverHeroLineup's reveal surface, switched off).
const NO_REVEAL = {
  hostRevealUi: false, revealBusy: false, total: 0, hiddenCount: 0, blindForEveryone: false, bfaBusy: false, armedId: null,
  onThumbTap: () => {}, onHideOne: () => {}, onRevealAll: () => {}, onHideAll: () => {}, onToggleBlindForEveryone: () => {},
};
