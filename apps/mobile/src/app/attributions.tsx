import { useQuery } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { type AttributionEntry } from '@/lib/api/legal';
import { attributionsQueryOptions } from '@/lib/api/legalQuery';
import { WEB_BASE } from '@/lib/config';
import { GUTTER } from '@/lib/layout';
import { motion, radius, space, useTheme } from '@/theme';

// Corpus-level attributions for the wine catalog.
//
// 🔒 This screen satisfies LICENCE OBLIGATIONS (CC BY, OGL-BC, MIT). Three
// rendering rules are load-bearing and must survive any redesign:
//   1. BOTH links render as REAL, tappable links, each labelled: `licence.url`
//      (the compliance-relevant one — CC BY and OGL-BC each require a link to
//      the LICENCE) and `sourceUrl` (where the dataset lives).
//   2. `licence.text` renders VERBATIM in a monospace block: no trim, no
//      re-wrap, no normalisation. MIT requires the full notice reproduced.
//   3. `verified: false` renders its caveat VISIBLY.
// Plus: when the entries come from the bundled snapshot rather than the server,
// the staleness notice must show — see lib/api/legal.ts.

function Entry({ entry }: { entry: AttributionEntry }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const progress = useSharedValue(0);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    progress.value = withTiming(next ? 1 : 0, {
      duration: motion.dur3,
      easing: Easing.bezier(...motion.ease),
    });
  };

  const bodyStyle = useAnimatedStyle(() => ({
    height: contentHeight * progress.value,
    opacity: progress.value,
  }));
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${progress.value * 180}deg` }],
  }));

  return (
    <View
      style={{
        backgroundColor: theme.surface,
        borderRadius: radius.md,
        padding: 16,
        marginBottom: space.md,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${entry.source}, ${entry.licence.spdx}`}
        accessibilityHint={open ? 'Collapses the licence details' : 'Expands the licence details'}
        onPress={toggle}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}
      >
        <View style={{ flex: 1 }}>
          <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
            {entry.source}
          </VText>
          <VText variant="caption" color="inkSoft" style={{ marginTop: 2 }}>
            {entry.licence.spdx}
            {entry.dataPeriod ? ` · Data period: ${entry.dataPeriod}` : ''}
          </VText>
        </View>
        <Animated.View style={chevronStyle}>
          <Icon name="chevron-down" size={18} color={theme.inkSoft} />
        </Animated.View>
      </Pressable>

      {/* 🔒 COLLAPSED, NOT UNMOUNTED. The children below are always rendered and
          measured; only the wrapper's HEIGHT animates. A required attribution
          statement that does not exist in the view until someone taps is a
          materially weaker compliance position than one that is merely folded —
          so never swap this for `{open && <Body/>}`. The inner view is
          absolutely positioned so it reports its NATURAL height even while the
          clipped wrapper sits at 0 (the same measurement trick as
          components/moments/momentForm.tsx Disclosure). */}
      <Animated.View
        style={[{ overflow: 'hidden' }, bodyStyle]}
        pointerEvents={open ? 'auto' : 'none'}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      >
        <View
          // paddingTop (not marginTop) so the lead spacing is INCLUDED in the
          // measured height — a margin would be excluded and the body would
          // open a few pixels short.
          style={{ position: 'absolute', left: 0, right: 0, top: 0, paddingTop: space.xs }}
          onLayout={(e) => setContentHeight(e.nativeEvent.layout.height)}
        >

      {/* Rule 3 — an unverified entry says so, visibly. */}
      {!entry.verified && (
        <View
          style={{
            backgroundColor: theme.surfaceSunk,
            borderRadius: radius.sm,
            padding: 10,
            marginTop: space.xs,
          }}
        >
          <VText variant="small" color="critical">
            Unverified wording. {entry.notes}
          </VText>
        </View>
      )}

      {/* The statement we are obliged to display. Empty for CC0, which waives
          attribution — so nothing is claimed there. */}
      {!!entry.attribution && (
        <VText variant="small" style={{ marginTop: space.xs, lineHeight: 20 }}>
          {entry.attribution}
        </VText>
      )}

      {/* Rule 1 — BOTH links rendered, and LABELLED for what they are. The
          licence link is the compliance-relevant one (CC BY and OGL-BC both
          require a link to the LICENCE); the source link is where the dataset
          lives. Conflating them is what this split fixed. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space['2xs'], marginTop: space.xs }}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open the ${entry.licence.spdx} licence for ${entry.source}`}
          onPress={() => { void WebBrowser.openBrowserAsync(entry.licence.url).catch(() => {}); }}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <VText variant="small" color="accent">{entry.licence.spdx} licence</VText>
        </Pressable>
        <VText variant="small" color="inkFaint">·</VText>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open the ${entry.source} source page`}
          onPress={() => { void WebBrowser.openBrowserAsync(entry.sourceUrl).catch(() => {}); }}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <VText variant="small" color="accent">Source</VText>
        </Pressable>
      </View>

      {/* Rule 2 — verbatim. `selectable` so a reader can copy the notice.
          No trim, no re-wrap: the string renders exactly as received. */}
      {!!entry.licence.text && (
        <View
          style={{
            backgroundColor: theme.bg,
            borderRadius: radius.sm,
            padding: 12,
            marginTop: space.sm,
          }}
        >
          <VText
            variant="caption"
            color="inkSoft"
            selectable
            style={{ fontFamily: 'monospace', lineHeight: 17 }}
          >
            {entry.licence.text}
          </VText>
        </View>
      )}
        </View>
      </Animated.View>
    </View>
  );
}

export default function Attributions() {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  // Never throws and never returns empty (see lib/api/legal.ts), so there is
  // no error state to render — only a brief pending state.
  //
  // 🔒 `networkMode: 'always'` IS LOAD-BEARING, NOT A TWEAK. TanStack's default
  // is 'online', and lib/query.tsx wires NetInfo into onlineManager — so while
  // offline the query would be PAUSED and `fetchAttributions` would never run
  // to return its bundled fallback. The screen would sit on a spinner forever,
  // in precisely the offline case the fallback exists to serve. The fetcher
  // handles its own failures and always resolves, so pausing buys nothing.
  //
  // ⚠️ `refetchOnReconnect: 'always'` is REQUIRED ALONGSIDE IT: setting
  // networkMode to 'always' disables the default reconnect refetch, and the
  // literal 'always' (not `true`) is needed because a bundled result is fresh
  // for an hour and `true` would honour staleTime and skip the refetch. Without
  // this, the screen tells the user "connect to see the latest" and then does
  // not fetch when they do.
  // 🔒 Options come from lib/api/legalQuery.ts and are passed THROUGH, not
  // restated. That module is the single source of truth shared with the
  // lifecycle suite — see its header for why each option is load-bearing
  // (data-dependent staleTime, networkMode, and why refetchOnMount /
  // refetchOnWindowFocus must NOT be 'always'). Never inline them here.
  const { data, isPending } = useQuery(attributionsQueryOptions);

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: insets.top + space.md,
        paddingHorizontal: GUTTER,
        paddingBottom: insets.bottom + space.xl,
      }}
    >
      <VBar title="Attributions" />

      {/* Gratitude, kept DELIBERATELY SEPARATE from the obligation text below.
          Thanking a source is ours to offer; it must never read as if the
          source requires it — CC0 waives attribution outright, and blurring the
          two would misstate a licence on a screen whose whole job is to state
          licences accurately. */}
      <VText variant="small" style={{ marginBottom: space.sm, lineHeight: 21 }}>
        These projects made their data public so others could build on it. Verre started
        with a real catalog because of them. Thank you.
      </VText>
      <VText variant="small" color="inkSoft" style={{ marginBottom: space.md, lineHeight: 20 }}>
        Verre&rsquo;s wine catalog is built from these sources. Each is used under the
        licence shown, and these acknowledgements are required by those licences.
      </VText>

      {isPending ? (
        <ActivityIndicator color={theme.inkSoft} style={{ marginTop: space.xl }} />
      ) : (
        <>
          {/* 🔒 The staleness tell. Two copies of legal text can disagree; the
              bundled one must never masquerade as current. Do not remove. */}
          {data?.origin === 'bundled' && (
            <View
              style={{
                backgroundColor: theme.surfaceSunk,
                borderRadius: radius.sm,
                padding: 12,
                marginBottom: space.md,
              }}
            >
              <VText variant="caption" color="inkSoft" style={{ lineHeight: 17 }}>
                Showing the version included with this app — these details couldn&rsquo;t be
                refreshed just now. The latest version is published here:
              </VText>
              {/* 🔒 The link is what makes the offline contract honest (Simon,
                  2026-07-26). The bundled snapshot is compiled into the binary,
                  so a legal change made after this release cannot reach it; the
                  web page is served by the running server and is where the
                  newest wording appears. ⚠️ The copy deliberately says "the
                  latest version is published here" rather than an ABSOLUTE
                  freshness claim — the server process-caches its config and the
                  API sets max-age, so even the web is the running server's
                  snapshot rather than an instantaneous mirror. A CI pin
                  (§3a of the offline suite) fails on such a claim in this file,
                  including inside a comment, so it stays simple. The
                  bundled text still renders ABOVE this notice, so the licences
                  are never absent: the link is the route to the newest wording,
                  not a replacement for showing any. */}
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="Open the current attributions on the web"
                onPress={() => { void WebBrowser.openBrowserAsync(`${WEB_BASE}/legal/attributions`).catch(() => {}); }}
                hitSlop={8}
                style={({ pressed }) => ({ marginTop: 4, opacity: pressed ? 0.5 : 1 })}
              >
                <VText variant="caption" color="accent">{`${WEB_BASE}/legal/attributions`}</VText>
              </Pressable>
            </View>
          )}
          {data?.entries.map((e) => <Entry key={e.id} entry={e} />)}
        </>
      )}
    </ScrollView>
  );
}
