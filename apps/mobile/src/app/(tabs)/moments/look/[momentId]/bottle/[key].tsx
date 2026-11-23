import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { StatusBar } from 'expo-status-bar';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { HeroTopBar } from '@/components/moments/LineupParts';
import { AboutBlock, Hero, NameBlock } from '@/components/moments/ImpressionParts';
import { PersonPreviewProvider, usePersonPreview } from '@/components/moments/PersonPreviewSheet';
import { SessionFatalView } from '@/components/moments/SessionFatalView';
import { StarScore } from '@/components/scoring/StarScore';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ReconnectingBar } from '@/components/ui/ConnectionState';
import { VText } from '@/components/ui/VText';
import type { LookIn, LookInPerson } from '@/lib/api/moments';
import { TAB_BAR_CLEARANCE, heroBarHeight, usePhoneTokens } from '@/lib/layout';
import { lookInPersonId, lookInWine } from '@/lib/lookInCompare';
import { bottleStars } from '@/lib/lookInView';
import { useForwardStatusBarStyle } from '@/lib/forwardedStatusBar';
import { useMeId } from '@/lib/meId';
import { useIsOnline } from '@/lib/query';
import { tabHomeHref, useSessionTab } from '@/lib/sessionStack';
import { lookInFatalOf, useLookIn } from '@/lib/useLookIn';
import { radius, useTheme } from '@/theme';

// A look-in bottle's own page (Moment Visibility step-2 plan § 4.5, R2 + R15):
// the bottle's details as the impression screen shows them, read-only (its
// Hero / NameBlock / AboutBlock, components/moments/ImpressionParts.tsx), the
// average, then each NAMED person's stars in the room's order (R15: no notes,
// no rating photos: a moment's rating has none of its own), and "N more
// ratings from people you can't see". A blind row: "Impression N", no details.
// It reads the look-in's FIRST read (lib/useLookIn.ts: the same query and fetch
// gate as the look-in under it), polling every 5 s while focused; opened by
// link, the same handle (the header goes with it).

const GUTTER = 20; // the impression body's gutters (02e), as on its own screen

export default function LookInBottlePage() {
  const { momentId: raw, key: rawKey, via, h } = useLocalSearchParams<{ momentId: string; key: string; via?: string; h?: string }>();
  const momentId = String(raw ?? '');
  const key = String(rawKey ?? '');
  const meId = useMeId();
  const { q, badLink, viaLink } = useLookIn(momentId, via, h);
  const look: LookIn | null = q.data && q.data.member === false ? q.data : null;
  const fatal = lookInFatalOf({ badLink, viaLink, memberGone: false, error: q.error, hasData: !!look, member: q.data?.member === true });
  const previewIds = useMemo(() => (look?.people.named ?? []).filter((p) => !p.guest && p.id).map((p) => `u:${p.id}`), [look]);
  return (
    <BottomSheetModalProvider>
      <PersonPreviewProvider meta={null} roster={fatal ? null : previewIds} myIdentityId={meId ? `u:${meId}` : ''}>
        <BottleBody look={look} lookKey={key} fatal={fatal} member={q.data?.member === true} reconnecting={!!look && q.isError} onRetry={() => void q.refetch()} />
      </PersonPreviewProvider>
    </BottomSheetModalProvider>
  );
}

function BottleBody({ look, lookKey, fatal, member, reconnecting, onRetry }: {
  look: LookIn | null;
  lookKey: string;
  fatal: ReturnType<typeof lookInFatalOf>;
  member: boolean;
  reconnecting: boolean;
  onRetry: () => void;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  const mount = useSessionTab();
  const online = useIsOnline();
  const preview = usePersonPreview();
  const goBack = () => {
    if ((navigation.getState()?.index ?? 0) > 0) router.back();
    else router.replace(tabHomeHref(mount.tab));
  };
  // A member after all: back to the look-in, which hands them the moment.
  useEffect(() => {
    if (!member) return;
    if ((navigation.getState()?.index ?? 0) > 0) router.back();
    else router.replace(tabHomeHref(mount.tab));
  }, [member, navigation, router, mount.tab]);
  const index = look ? look.lineup.findIndex((b) => b.key === lookKey) : -1;
  const bottle = index >= 0 ? look!.lineup[index] : null;
  const wine = bottle ? lookInWine(bottle) : null;
  const stars = look ? bottleStars(look, lookKey) : null;
  const photo = !!bottle && !bottle.blind && !!bottle.imageUrl;
  const [nameBottom, setNameBottom] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [pulled, setPulled] = useState(false);
  const collapsedRef = useRef(false);
  const BAR_H = heroBarHeight(insets.top, phone.size('heroAction'));
  const statusBarStyle = photo && !collapsed && !reconnecting ? 'light' : theme.scheme === 'dark' ? 'light' : 'dark';
  useForwardStatusBarStyle(statusBarStyle);
  const title = bottle ? (bottle.blind ? `Impression ${index + 1}` : bottle.name) : '';

  const by = bottle && !bottle.blind ? bottle.broughtBy : null;
  const byPerson = by ? look?.people.named.find((p) => p.id === by.id) : undefined;
  const row = (p: LookInPerson, score: number, i: number) => {
    const id = lookInPersonId(p);
    const tappable = !!preview?.canOpen(id);
    return (
      <Pressable
        key={p.key}
        disabled={!tappable}
        accessibilityRole={tappable ? 'button' : undefined}
        accessibilityLabel={`${p.name}, ${score}`}
        onPress={() => preview?.open(id)}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: phone.lerp(10, 13), paddingVertical: phone.lerp(9, 12),
          borderTopWidth: i === 0 ? 0 : 1, borderTopColor: theme.ruleSoft, opacity: pressed && tappable ? 0.6 : 1,
        })}
      >
        <Avatar imageUrl={p.imageUrl} name={p.name} size={phone.grow(30)} anon={!!p.guest} />
        <VText numberOfLines={1} color={p.guest ? 'inkSoft' : 'ink'} style={{ flex: 1, fontFamily: p.guest ? 'InstrumentSans_400Regular' : 'InstrumentSans_500Medium', ...phone.text('body') }}>
          {p.name}
        </VText>
        <StarScore value={score} size={16} />
      </Pressable>
    );
  };

  const body = !bottle || !wine ? null : (
    <>
      {photo ? (
        <Hero wine={wine} index={index} total={look!.lineup.length} pulled={pulled} onNameBottom={setNameBottom} />
      ) : (
        <NameBlock wine={wine} blind={!!bottle.blind} index={index} total={look!.lineup.length} onNameBottom={setNameBottom} />
      )}
      <View style={{ paddingHorizontal: GUTTER, backgroundColor: theme.bg, ...(photo ? { marginTop: -radius.xl, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: 12 } : null) }}>
        {!bottle.blind ? (
          <AboutBlock
            wine={wine}
            broughtBy={by?.name ?? null}
            broughtBySelf={false}
            broughtByAnon={false}
            broughtByImageUrl={byPerson?.imageUrl ?? null}
            broughtById={by ? `u:${by.id}` : null}
          />
        ) : null}
        {/* The average over everyone counted (the line-up's), then the named people's stars. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 14, paddingBottom: 6 }}>
          {bottle.avg !== null ? <StarScore value={bottle.avg} size={18} /> : null}
          <VText variant="small" color="inkSoft">
            {bottle.count > 0 ? `${bottle.count} ${bottle.count === 1 ? 'rating' : 'ratings'}` : 'No ratings yet'}
          </VText>
        </View>
        {(stars?.rows ?? []).map((r, i) => row(r.person, r.score, i))}
        {stars && stars.more > 0 ? (
          <VText variant="small" color="inkSoft" style={{ paddingTop: 10 }}>
            {`${stars.more} more ${stars.more === 1 ? 'rating' : 'ratings'} from people you can’t see`}
          </VText>
        ) : null}
      </View>
    </>
  );

  return (
    <View style={{ flex: 1, paddingTop: photo && !fatal ? 0 : insets.top + 8 }}>
      <Stack.Screen options={{ statusBarStyle }} />
      <StatusBar style={statusBarStyle} />
      {!photo || fatal ? (
        <View style={{ paddingHorizontal: GUTTER }}>
          <VBar title={collapsed ? title : ''} onBack={goBack} />
        </View>
      ) : null}
      {(reconnecting || (!online && !!look)) && !fatal ? <ReconnectingBar /> : null}
      {fatal ? (
        <SessionFatalView fatal={fatal.error} removedKind={null} sessionLabel={null} copy={fatal.copy} onRetry={onRetry} onBack={goBack} />
      ) : !look ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator /></View>
      ) : !bottle ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 }}>
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('subhead'), textAlign: 'center' }}>This impression isn’t in the line-up any more.</VText>
          <Button title="Back" variant="secondary" onPress={goBack} style={{ marginTop: 10 }} />
        </View>
      ) : (
        <ScrollView
          scrollEventThrottle={16}
          contentInsetAdjustmentBehavior="never"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: TAB_BAR_CLEARANCE }}
          onScroll={(e) => {
            const y = e.nativeEvent.contentOffset.y;
            const next = y >= nameBottom - (photo ? BAR_H : 0);
            if (next !== collapsedRef.current) { collapsedRef.current = next; setCollapsed(next); }
            const p = y < -1;
            setPulled((prev) => (prev === p ? prev : p));
          }}
        >
          {body}
        </ScrollView>
      )}
      {photo && !fatal ? <HeroTopBar title={title} collapsed={collapsed} canAdd={false} showAdd={false} onAdd={() => {}} onBack={goBack} /> : null}
    </View>
  );
}

