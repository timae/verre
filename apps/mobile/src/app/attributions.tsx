import { useQuery } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { fetchAttributions, type AttributionEntry } from '@/lib/api/legal';
import { GUTTER } from '@/lib/layout';
import { radius, space, useTheme } from '@/theme';

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
  return (
    <View
      style={{
        backgroundColor: theme.surface,
        borderRadius: radius.md,
        padding: 16,
        marginBottom: space.md,
      }}
    >
      <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
        {entry.source}
      </VText>
      <VText variant="caption" color="inkSoft" style={{ marginTop: 2 }}>
        {entry.licence.spdx}
        {entry.dataPeriod ? ` · Data period: ${entry.dataPeriod}` : ''}
      </VText>

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
  const { data, isPending } = useQuery({
    queryKey: ['legal-attributions'],
    queryFn: fetchAttributions,
    staleTime: 60 * 60 * 1000,
    networkMode: 'always',
    refetchOnReconnect: 'always',
  });

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

      <VText variant="small" color="inkSoft" style={{ marginBottom: space.md, lineHeight: 20 }}>
        Verre&rsquo;s wine catalog is built from the sources below. Each is used under the
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
                refreshed just now. Connect to the internet to see the latest.
              </VText>
            </View>
          )}
          {data?.entries.map((e) => <Entry key={e.source} entry={e} />)}
        </>
      )}
    </ScrollView>
  );
}
