import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { StatusBar } from 'expo-status-bar';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, useWindowDimensions, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { buildComparePeople, CompareBody, ComparePickerSheet, CompareToolbar, type CompareSort } from '@/components/moments/CompareBody';
import { CoverHeroLineup, HeroTopBar, LockCard, swapIn, swapOut, useTabTransition } from '@/components/moments/LineupParts';
import { LookInAbout, LookInJoinSheet, LookInPeopleSheet, LookInRow } from '@/components/moments/LookInParts';
import { PersonPreviewProvider } from '@/components/moments/PersonPreviewSheet';
import { SessionFatalView } from '@/components/moments/SessionFatalView';
import { SessionTabs } from '@/components/moments/SessionTabs';
import { ReconnectingBar } from '@/components/ui/ConnectionState';
import { VText } from '@/components/ui/VText';
import { getMomentMembership, type LookIn } from '@/lib/api/moments';
import { ApiError } from '@/lib/api/sessions';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';
import { adaptLookIn } from '@/lib/lookInCompare';
import { useForwardStatusBarStyle } from '@/lib/forwardedStatusBar';
import { useMeId } from '@/lib/meId';
import { useIsOnline } from '@/lib/query';
import { lookHref, sessionHref, tabHomeHref, useSessionTab } from '@/lib/sessionStack';
import { lookInFatalOf, useLookIn, useLookInAromas } from '@/lib/useLookIn';
import { useTheme } from '@/theme';

// THE LOOK-IN (Moment Visibility step-2 plan § 4.4): a moment seen from
// outside, by its public id. 🔒 Its own screen, never the moment screen in a
// read-only mode: opening the moment screen POSTs /visit, which would make the
// viewer a member (T1). The moment screen's look (the cover hero or the plain
// bar, the same Line-up ⇄ Compare swap, components/moments/LineupParts.tsx),
// read-only: no Add, no ⋯, no in-place edit, no reveal. The Line-up has no
// toolbar (T8: its sorts are your own scores); Compare keeps its toolbar over
// the people named to you (R1, R4, lib/lookInCompare.ts).
//
// Opened by audience (a feed post, someone's Moments list) or by LINK
// (`via=link&h=<handle>`, lib/lookInLinks.ts: the token never enters a route
// param; the screen sends it as `X-Verre-Link` for its whole life, T6). The
// first read answers `{ member: true }` for a member: the moment REPLACES the
// look-in on this stack (T7). Polls every 5 s while focused; the open Compare
// cards' aromas come in batched details reads (lib/useLookIn.ts, T4).

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
  const { q, token, badLink, viaLink, gate, focused } = useLookIn(momentId, via, h);
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

  const eligible = useMemo(() => new Set((look?.ratings ?? []).filter((r) => r.hasAromas).map((r) => r.bottle)), [look]);
  const { aromas, onOpenChange } = useLookInAromas(momentId, token, gate, eligible, focused);
  const adapted = useMemo(() => (look ? adaptLookIn(look, aromas) : null), [look, aromas]);
  const bottleByKey = useMemo(() => new Map((look?.lineup ?? []).map((b) => [b.key, b])), [look]);
  const indexByKey = useMemo(() => new Map((look?.lineup ?? []).map((b, i) => [b.key, i])), [look]);

  const heroShown = !!look?.moment.coverPhotoUrl;
  const transition = useTabTransition(windowW, heroShown);
  const tab = transition.tab;
  const compareMounted = tab === 'compare' || transition.active !== null;
  const [heroCollapsed, setHeroCollapsed] = useState(false);
  // The cover hero installs its scroll here for the in-place edit; a look-in has none.
  const noScrollBy = useRef<((dy: number) => void) | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  // Compare over the named people (one hidden set drives the tab, as inside).
  const [cmpHiddenRaw, setCmpHidden] = useState<Set<string>>(new Set());
  const [cmpPickerOpen, setCmpPickerOpen] = useState(false);
  const [cmpSort, setCmpSort] = useState<CompareSort>('lineup');
  const [cmpQuery, setCmpQuery] = useState('');
  const cmpPeople = useMemo(() => (adapted ? buildComparePeople(adapted.ratings, adapted.roster) : []), [adapted]);
  const cmpHidden = useMemo(() => {
    const ids = new Set(cmpPeople.map((p) => p.id));
    const pruned = new Set([...cmpHiddenRaw].filter((id) => ids.has(id)));
    return pruned.size === cmpHiddenRaw.size ? cmpHiddenRaw : pruned;
  }, [cmpHiddenRaw, cmpPeople]);
  const toggleCmpPerson = useCallback((id: string) => {
    setCmpHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

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
  const ovc = look ? <LookInAbout look={look} onPeople={() => setPeopleOpen(true)} onJoin={() => setJoinOpen(true)} /> : null;
  const lockTime = look?.lineupHidden && look.moment.lineupRevealsAt ? Date.parse(look.moment.lineupRevealsAt) : null;
  // A hidden line-up is the lock state whether or not the record yields a time.
  const lock = look?.lineupHidden ? (lockTime ?? 1) : null;
  const lockCard = look?.lineupHidden ? <LockCard revealAt={lockTime} /> : null;
  const empty = <VText variant="small" color="inkSoft" style={{ paddingTop: 16 }}>No impressions yet.</VText>;
  const compare = adapted ? (
    <CompareBody
      wines={adapted.wines}
      ratings={adapted.ratings}
      meta={adapted.roster}
      locked={false}
      hidden={cmpHidden}
      sort={cmpSort}
      query={cmpQuery}
      groupStats={adapted.groupStats}
      emptyCopy={{ title: 'No ratings yet', body: 'Nobody has rated anything here yet.' }}
      onOpenChange={onOpenChange}
    />
  ) : null;
  const cmpRail = compareMounted && adapted ? (
    <CompareToolbar
      people={cmpPeople}
      hidden={cmpHidden}
      onPick={() => setCmpPickerOpen(true)}
      sort={cmpSort}
      onSort={setCmpSort}
      query={cmpQuery}
      onQuery={setCmpQuery}
      menusSuppressed={transition.active !== null}
    />
  ) : null;
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
          <VBar title={look ? title : ''} onBack={goBack} />
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
          compare={compare}
          compareRail={cmpRail}
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
        // The plain layout: a small copy of the moment screen's (no toolbar on
        // the Line-up, no drag, no reveal; the panes swap the same way).
        <>
          <View style={{ paddingHorizontal: GUTTER }}>
            <SessionTabs active={tab} onSelect={transition.select} />
          </View>
          {tab === 'compare' ? (
            <Reanimated.View key="pane-compare" style={{ flex: 1 }} entering={transition.everSwapped ? swapIn('compare') : undefined} exiting={swapOut('compare')}>
              <ScrollView
                style={{ flex: 1 }}
                stickyHeaderIndices={cmpRail ? [0] : undefined}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentContainerStyle={{ flexGrow: 1, paddingBottom: TAB_BAR_CLEARANCE }}
              >
                {cmpRail ? <View style={{ backgroundColor: theme.bg }}>{cmpRail}</View> : null}
                {compare}
              </ScrollView>
            </Reanimated.View>
          ) : (
            <Reanimated.View key="pane-lineup" style={{ flex: 1 }} entering={transition.everSwapped ? swapIn('lineup') : undefined} exiting={swapOut('lineup')}>
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, paddingHorizontal: GUTTER, paddingBottom: TAB_BAR_CLEARANCE }}>
                {ovc}
                {rows.length === 0 ? empty : rows.map((r, i) => (
                  <View key={r.key}>
                    {i > 0 ? <View style={{ height: 1, backgroundColor: theme.ruleSoft }} /> : null}
                    {r}
                  </View>
                ))}
              </ScrollView>
            </Reanimated.View>
          )}
        </>
      )}
      {heroShown && look && !fatal ? (
        <HeroTopBar title={title} collapsed={heroCollapsed} canAdd={false} showAdd={false} onAdd={() => {}} onBack={goBack} />
      ) : null}
      {look && !fatal ? (
        <>
          <ComparePickerSheet
            open={cmpPickerOpen}
            onClose={() => setCmpPickerOpen(false)}
            people={cmpPeople}
            hidden={cmpHidden}
            myIdentityId=""
            blocksOut={[]}
            blocksIn={[]}
            onToggle={toggleCmpPerson}
            onAll={() => setCmpHidden(new Set())}
            onJustMe={() => {}}
            onMeAndFriends={(friendIds) => setCmpHidden(new Set(cmpPeople.filter((p) => !friendIds.has(p.id)).map((p) => p.id)))}
            lookIn={{ more: look.people.more }}
          />
          <LookInPeopleSheet open={peopleOpen} onClose={() => setPeopleOpen(false)} look={look} />
          <LookInJoinSheet
            open={joinOpen}
            onClose={() => setJoinOpen(false)}
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

// The look-in reveals nothing (CoverHeroLineup's reveal surface, switched off).
const NO_REVEAL = {
  hostRevealUi: false, revealBusy: false, total: 0, hiddenCount: 0, blindForEveryone: false, bfaBusy: false, armedId: null,
  onThumbTap: () => {}, onHideOne: () => {}, onRevealAll: () => {}, onHideAll: () => {}, onToggleBlindForEveryone: () => {},
};
