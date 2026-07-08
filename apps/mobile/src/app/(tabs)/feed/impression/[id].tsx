import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { StarScore } from '@/components/scoring/StarScore';
import { FlavourWheel } from '@/components/scoring/FlavourWheel';
import { TastesLike } from '@/components/feed/TastesLike';
import { buildWheelAxes, topFlavours } from '@/lib/flavourAxes';
import { Avatar } from '@/components/ui/Avatar';
import { feedQueryOptions, findFeedItem, detailFromItem, type FeedAuthor, type FeedItem, type SessionFeedWine } from '@/lib/api/feed';
import { useEnterableMoment } from '@/lib/useEnterableMoment';
import { FOOT_CLEARANCE_IR, GLASS_FILL, GUTTER, HERO_RATIO, HERO_SCRIM } from '@/lib/layout';
import { timeAgo, wineTypeLabel } from '@/lib/momentFormat';
import { scoreWord } from '@/lib/scoreWords';
import { useFlavourColors } from '@/theme/flavourColors';
import { radius, space, useTheme } from '@/theme';
import { countryName } from '@verre/core';

// Full impression detail — a NEW read-only screen (proposal 08 §3; NOT 02e,
// which is a write interface). Reached from a feed card's glass panel. Pure
// client render off the ['feed'] cache — no fetch (findFeedItem/detailFromItem).
//
// Shape: a horizontal PAGER across the moment's impressions (a standalone is one
// page, no dots). Each page is a self-contained collapsing-hero screen (mirrors
// 02e's read surface: full-bleed photo under the status bar, a floating glass
// bar that hands the title in on scroll, tap-hero→FullscreenImage). The bar is
// SHARED chrome overlaid outside the pager; its collapsed/solid state tracks the
// ACTIVE page. Dots live IN-CONTENT under each hero (Simon), so there's no
// "where do dots go when collapsed" problem — they just scroll away.

// The bar's true painted height = safe inset + the 36px row + paddings.
const BAR_ROW = 36;
function barHeight(insetTop: number) {
  return insetTop + BAR_ROW + 4;
}

export default function FeedImpression() {
  const { theme } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const { id, index } = useLocalSearchParams<{ id: string; index?: string }>();
  const feedItemId = Number(id);
  const startIndex = Math.max(0, Number(index ?? 0) || 0);

  // Read the feed cache (the list already delivered this). We attach to the
  // SAME query — shared feedQueryOptions, so the two screens can't drift apart
  // on key/options. refetchOnMount: false skips the pointless network round on
  // open; a cold deep-link (no cached data yet) still runs the INITIAL fetch —
  // refetchOnMount only suppresses refetching existing data — so the guard
  // below can resolve.
  const feed = useInfiniteQuery({ ...feedQueryOptions(), refetchOnMount: false });
  const pages = feed.data?.pages;
  const found = Number.isFinite(feedItemId) ? findFeedItem(pages, feedItemId) : null;
  // Pin the last-found item (the house lastRef pattern — cf. the session
  // screens' per-section poll merge). refetchOnMount:false only covers THIS
  // observer's mount: the list observer underneath (and this one, on
  // app-foreground focus) can still refetch the query in place, and a refetch
  // can drop a page-boundary item out of the loaded window. Once this screen
  // has SEEN its item it must never flip to "gone" mid-read — it keeps
  // rendering the pinned copy (a frozen read surface beats a vanishing one);
  // while the item remains in the cache, fresh copies keep flowing through.
  const pinnedRef = useRef<FeedItem | null>(null);
  if (found) pinnedRef.current = found;
  const item = found ?? pinnedRef.current;
  const detail = item ? detailFromItem(item) : null;
  // Clamp seam for the pager index: `index` arrives via route params (a deep
  // link can carry garbage) and onPagerScroll can round past the end on an
  // overscroll bounce — both clamp against the real page count.
  const maxPage = detail ? Math.max(0, detail.wines.length - 1) : 0;

  const [active, setActive] = useState(startIndex);
  // Per-page collapse state, indexed by page. The bar reads active's flag.
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [titles, setTitles] = useState<Record<number, string>>({});

  const onPagerScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.max(0, Math.min(maxPage, Math.round(e.nativeEvent.contentOffset.x / screenW)));
      setActive((cur) => (cur === i ? cur : i));
    },
    [screenW, maxPage],
  );

  const reportCollapse = useCallback((page: number, c: boolean) => {
    setCollapsed((prev) => (prev[page] === c ? prev : { ...prev, [page]: c }));
  }, []);
  const reportTitle = useCallback((page: number, t: string) => {
    setTitles((prev) => (prev[page] === t ? prev : { ...prev, [page]: t }));
  }, []);

  if (!item || !detail) {
    // Post not in the cache (deep link before the feed loaded, or trimmed out).
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <FloatBar solid title="" onBack={() => router.back()} insetTop={insets.top} pending={feed.isPending} />
        <CenteredMessage
          title="This impression is gone"
          body="It may have been removed, or the feed hasn't loaded it yet."
          pending={feed.isPending}
        />
      </View>
    );
  }

  const { wines, author, createdAt, verb, place, momentName, sessionId } = detail;
  const total = wines.length;
  // Read-side clamp: `active` seeds from the raw route param before wines are
  // known, so index the per-page maps through the clamped value.
  const page = Math.min(active, maxPage);
  const barSolid = !!collapsed[page];

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      {/* RNS dead-end — stops react-native-screens flipping the first
          descendant ScrollView's contentInsetAdjustmentBehavior never→automatic
          (which would top-inset the hero below the status bar). Load-bearing;
          see apps/mobile/CLAUDE.md "full-bleed scroll content vs RNS". */}
      <View collapsable={false} style={{ width: 0, height: 0 }} />

      {total === 1 ? (
        <DetailPage
          wine={wines[0]}
          index={0}
          total={1}
          author={author}
          createdAt={createdAt}
          verb={verb}
          place={place}
          momentName={momentName}
          sessionId={sessionId}
          onCollapse={(c) => reportCollapse(0, c)}
          onTitle={(t) => reportTitle(0, t)}
          insetTop={insets.top}
          bottomPad={insets.bottom + FOOT_CLEARANCE_IR}
        />
      ) : (
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={onPagerScroll}
          scrollEventThrottle={16}
          contentOffset={{ x: Math.min(startIndex, maxPage) * screenW, y: 0 }}
          // flex:1 bounds the pager to the screen so each page's own vertical
          // ScrollView (DetailPage root) gets a real viewport height — without
          // it the height chain is unconstrained and vertical scrolling inside
          // a page can collapse. Page wrappers stretch to this height (a
          // horizontal SV's content row defaults to alignItems:stretch).
          style={{ flex: 1 }}
        >
          {wines.map((w, i) => (
            <View key={w.id} style={{ width: screenW }}>
              <DetailPage
                wine={w}
                index={i}
                total={total}
                author={author}
                createdAt={createdAt}
                verb={verb}
                place={place}
                momentName={momentName}
                sessionId={sessionId}
                onCollapse={(c) => reportCollapse(i, c)}
                onTitle={(t) => reportTitle(i, t)}
                insetTop={insets.top}
                bottomPad={insets.bottom + FOOT_CLEARANCE_IR}
              />
            </View>
          ))}
        </ScrollView>
      )}

      {/* Shared floating bar — over ALL pages, collapse tracks the active one. */}
      <FloatBar
        solid={barSolid}
        title={barSolid ? titles[page] ?? '' : ''}
        onBack={() => router.back()}
        insetTop={insets.top}
      />
    </View>
  );
}

// The floating→solid bar. Transparent + glass back button over the hero; solid
// bg + ink title once collapsed. Overlaid, absolute at top. (A lean read-only
// bar — 02e's IrBar carries crave/menu/reveal we don't want here.)
function FloatBar({
  solid,
  title,
  onBack,
  insetTop,
  pending,
}: {
  solid: boolean;
  title: string;
  onBack: () => void;
  insetTop: number;
  pending?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 8,
        paddingTop: insetTop,
        paddingHorizontal: 16,
        paddingBottom: 4,
        // Opaque when collapsed, transparent over the photo (ADR-0003).
        backgroundColor: solid ? theme.bg : 'transparent',
      }}
    >
      <View style={styles.barRow}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          style={[styles.backBtn, solid ? null : { backgroundColor: GLASS_FILL }]}
        >
          <Icon name="back" size={20} color={solid ? theme.ink : '#fff'} />
        </Pressable>
        {solid && !pending ? (
          <VText variant="subhead" numberOfLines={1} style={[styles.barTitle, { color: theme.ink }]}>
            {title}
          </VText>
        ) : null}
      </View>
    </View>
  );
}

// One impression's full read screen: a collapsing hero (photo under the status
// bar) + the rating body below. Reports its collapse + on-photo title up so the
// shared bar can track it.
function DetailPage({
  wine,
  index,
  total,
  author,
  createdAt,
  verb,
  place,
  momentName,
  sessionId,
  onCollapse,
  onTitle,
  insetTop,
  bottomPad,
}: {
  wine: SessionFeedWine;
  index: number;
  total: number;
  author: FeedAuthor;
  createdAt: string;
  verb: string;
  place: string | null;
  momentName: string | null;
  sessionId: number | null;
  onCollapse: (collapsed: boolean) => void;
  onTitle: (title: string) => void;
  insetTop: number;
  bottomPad: number;
}) {
  const { theme } = useTheme();
  const { width: screenW, height: windowH } = useWindowDimensions();
  const axisColor = useFlavourColors();
  const { code: momentCode, enter: enterMoment } = useEnterableMoment(sessionId);
  const blind = !!wine._blind;
  const heroH = Math.round(windowH * HERO_RATIO);
  const BAR_H = barHeight(insetTop);

  const [fullscreen, setFullscreen] = useState(false);
  // Collapse is MEASURED: flip solid when the on-photo name's bottom scrolls
  // under the bar (never a magic constant — the hero is proportional height).
  const nameBottom = useRef(0);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    onCollapse(y >= nameBottom.current - BAR_H);
  };

  // Identity is masked for a blind wine ("Wine N"); the subjective rating
  // (score + wheel + note) stays — same contract as the feed cards.
  const name = blind ? `Wine ${index + 1}` : wine.name;
  const hasScore = wine.score != null && wine.score > 0;
  const axes = buildWheelAxes(wine.flavors, wine.type, axisColor);
  const tastes = topFlavours(wine.flavors, wine.type, axisColor);
  const hasPhoto = !blind && !!wine.imageUrl;
  // Report the bar title up AFTER commit (never call a parent setState during
  // render). Re-runs if the name changes.
  useEffect(() => {
    onTitle(name);
  }, [name, onTitle]);

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentInsetAdjustmentBehavior="never"
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={16}
      onScroll={onScroll}
      contentContainerStyle={{ paddingBottom: bottomPad }}
    >
      {/* HERO — full-bleed photo under the status bar (or a masked/no-photo name
          block). The photo runs radius.xl past the seam so the rounded body
          panel below overlaps it. */}
      {hasPhoto ? (
        <View
          style={{ height: heroH + radius.xl, overflow: 'hidden' }}
          onLayout={(e) =>
            // name-bottom in content space ≈ hero bottom minus the caption inset.
            (nameBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height - 16 - radius.xl)
          }
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open photo fullscreen"
            onPress={() => setFullscreen(true)}
            style={{ width: '100%', height: '100%' }}
          >
            <Image source={{ uri: wine.imageUrl! }} style={{ width: '100%', height: '100%' }} contentFit="cover" alt={name} />
          </Pressable>
          <LinearGradient
            pointerEvents="none"
            colors={HERO_SCRIM}
            style={StyleSheet.absoluteFill}
          />
          <View pointerEvents="none" style={{ position: 'absolute', left: GUTTER, right: GUTTER, bottom: 16 + radius.xl }}>
            {total > 1 ? (
              <VText variant="label" style={styles.heroPos}>
                {`#${index + 1} of ${total}`}
              </VText>
            ) : null}
            <VText style={[styles.heroName, { color: '#fff' }]}>
              {name}
              {!blind && wine.vintage ? (
                <VText style={[styles.heroVintage, { color: 'rgba(255,255,255,0.7)' }]}>{` - ${wine.vintage}`}</VText>
              ) : null}
            </VText>
            {!blind && (wine.producer || wine.type) ? (
              <VText style={styles.heroSub}>
                {[wine.producer, wineTypeLabel(wine.type)].filter(Boolean).join(' · ')}
              </VText>
            ) : null}
          </View>
          <FullscreenImage uri={wine.imageUrl!} visible={fullscreen} label={name} onClose={() => setFullscreen(false)} />
        </View>
      ) : (
        // No-photo / masked hero: a dark name block that clears the status bar
        // (no photo to run under it). Same measured collapse.
        <View
          style={{ backgroundColor: theme.surfaceSunk, paddingTop: insetTop + BAR_ROW + 16, paddingHorizontal: GUTTER, paddingBottom: 20 + radius.xl }}
          onLayout={(e) => (nameBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height - radius.xl)}
        >
          {total > 1 ? (
            <VText variant="label" color="inkSoft" style={styles.heroPosDark}>
              {`#${index + 1} of ${total}`}
            </VText>
          ) : null}
          <VText style={[styles.heroName, { color: theme.ink }]}>{name}</VText>
          {blind ? (
            <VText variant="small" color="inkSoft" style={{ marginTop: 4 }}>
              Hidden until the host reveals it
            </VText>
          ) : (wine.producer || wine.type) ? (
            <VText variant="small" color="inkSoft" style={{ marginTop: 4 }}>
              {[wine.producer, wineTypeLabel(wine.type)].filter(Boolean).join(' · ')}
            </VText>
          ) : null}
        </View>
      )}

      {/* BODY — rounded panel overlapping the hero, carrying the rating. */}
      <View
        style={{
          marginTop: -radius.xl,
          backgroundColor: theme.bg,
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          paddingHorizontal: GUTTER,
          paddingTop: space.lg,
        }}
      >
        {/* dots — IN-CONTENT under the hero (Simon), so no collapse question. */}
        {total > 1 ? (
          <View style={styles.dots}>
            {Array.from({ length: total }).map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  { backgroundColor: i === index ? theme.accent : theme.inkFaint },
                  i === index && styles.dotOn,
                ]}
              />
            ))}
          </View>
        ) : null}

        {/* full header — avatar · name + verb · place · time (mirrors the feed
            card's header, in-content below the dots so the hero stays full-bleed;
            Simon). The moment name (the "place" of a session) is TAPPABLE when the
            viewer was a member (momentCode from their own sessions). */}
        <View style={styles.header}>
          <Avatar imageUrl={author.imageUrl} name={author.name} size={38} />
          <View style={styles.headerWho}>
            <VText variant="body" numberOfLines={1}>
              <VText variant="body" style={styles.attribName}>
                {author.name}
              </VText>
              <VText variant="body" color="inkSoft">
                {` ${verb}`}
              </VText>
            </VText>
            <VText variant="caption" color="inkSoft" numberOfLines={1}>
              {/* place: for a session it's the (tappable) moment name; for a
                  standalone it's the venue. Time always trails. */}
              {place && momentName && momentCode ? (
                <VText variant="caption" color="accent" style={styles.attribName} onPress={enterMoment}>
                  {place}
                </VText>
              ) : place ? (
                place
              ) : null}
              {place ? ' · ' : ''}
              {timeAgo(createdAt)}
            </VText>
          </View>
        </View>

        {/* score + word */}
        {hasScore ? (
          <View style={styles.scoreRow}>
            <StarScore value={wine.score!} size={22} />
            <VText variant="body" color="inkSoft" style={{ marginLeft: 10 }}>
              {scoreWord(wine.score!)}
            </VText>
          </View>
        ) : null}

        {/* big labelled wheel */}
        {axes.length > 0 ? (
          <View style={styles.wheelWrap}>
            <FlavourWheel axes={axes} size={182} labels maxWidth={screenW - GUTTER * 2} />
          </View>
        ) : null}

        {/* "Tastes like" chips */}
        {tastes.length > 0 ? (
          <View style={{ marginTop: space.sm }}>
            <TastesLike flavours={tastes} chipBg="surfaceSunk" />
          </View>
        ) : null}

        {/* taste note */}
        {wine.notes ? (
          <VText variant="body" color="ink" style={styles.note}>
            {wine.notes}
          </VText>
        ) : null}

        {/* About this impression — identity metadata; hidden entirely for blind
            (it's all identity) and when the wine carries none. */}
        {!blind ? <AboutBlock wine={wine} /> : null}
      </View>
    </ScrollView>
  );
}

// About this impression — Origin · Variety · Process rows + description +
// "Where to buy". Renders only what the wine carries; the block drops when
// there's no metadata (e.g. a standalone check-in with only country/grape shows
// just those rows). Mirrors 02e's AboutBlock, read-only.
function AboutBlock({ wine }: { wine: SessionFeedWine }) {
  const { theme } = useTheme();
  const country = wine.country ? countryName(wine.country) || wine.country : '';
  const origin = [wine.region, country].filter(Boolean).join(' · ');
  const rows: Array<[string, string]> = [];
  if (origin) rows.push(['Origin', origin]);
  if (wine.grape) rows.push(['Variety', wine.grape]);
  if (wine.vinification) rows.push(['Process', wine.vinification]);
  const hasTrailer = !!wine.description || !!wine.purchaseUrl;
  if (rows.length === 0 && !hasTrailer) return null;
  return (
    <View style={styles.about}>
      <VText variant="label" color="inkSoft" style={styles.aboutLabel}>
        About this impression
      </VText>
      {rows.map(([label, value], i) => {
        const lastRow = !hasTrailer && i === rows.length - 1;
        return (
          <View key={label} style={[styles.aboutRow, { borderBottomColor: theme.ruleSoft, borderBottomWidth: lastRow ? 0 : 1 }]}>
            <VText variant="small" color="inkSoft" style={styles.aboutKey}>
              {label}
            </VText>
            <VText variant="small" color="ink" style={{ flex: 1, fontFamily: 'InstrumentSans_500Medium' }}>
              {value}
            </VText>
          </View>
        );
      })}
      {wine.description ? (
        <VText variant="small" color="inkSoft" style={{ marginTop: rows.length ? 12 : 0 }}>
          {wine.description}
        </VText>
      ) : null}
      {wine.purchaseUrl ? (
        <Pressable
          onPress={() => WebBrowser.openBrowserAsync(wine.purchaseUrl!).catch(() => {})}
          style={{ marginTop: 12 }}
        >
          <VText variant="small" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
            Where to buy
          </VText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // 44pt frame (negative margins keep the painted bar at the 36pt row) so the
  // back button's touch target isn't clipped short: RN clips hitSlop to the
  // PARENT's frame — a 44pt target needs a ≥44pt parent, not more slop
  // (apps/mobile CLAUDE.md gotcha).
  barRow: { height: 44, marginVertical: (BAR_ROW - 44) / 2, flexDirection: 'row', alignItems: 'center', gap: 10 },
  backBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  barTitle: { flex: 1, fontFamily: 'InstrumentSans_600SemiBold' },
  heroPos: { fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', color: 'rgba(255,255,255,0.85)' },
  heroPosDark: { fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase' },
  heroName: { fontFamily: 'InstrumentSans_600SemiBold', fontSize: 26, lineHeight: 31, marginTop: 4 },
  heroVintage: { fontFamily: 'InstrumentSans_400Regular', fontSize: 26, lineHeight: 31 },
  heroSub: { fontFamily: 'InstrumentSans_400Regular', fontSize: 14, color: 'rgba(255,255,255,0.82)', marginTop: 2 },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, paddingBottom: space.md },
  dot: { width: 6, height: 6, borderRadius: 999 },
  dotOn: { transform: [{ scale: 1.15 }] },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginBottom: space.md },
  headerWho: { flex: 1, minWidth: 0 },
  attribName: { fontFamily: 'InstrumentSans_600SemiBold' },
  scoreRow: { flexDirection: 'row', alignItems: 'center', marginBottom: space.md },
  wheelWrap: { alignItems: 'center', marginTop: space.xs },
  note: { marginTop: space.lg, lineHeight: 22 },
  about: { marginTop: space.lg },
  aboutLabel: { fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', marginBottom: 6 },
  aboutRow: { flexDirection: 'row', gap: 14, paddingVertical: 9 },
  aboutKey: { width: 78 },
});
