import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from './Button';
import { VText } from './VText';
import { useTheme } from '@/theme';

// Shared connection-failure UI for TanStack-Query-backed screens. Two pieces +
// one decision helper, so every screen treats "couldn't reach the server"
// identically:
//
//   <ErrorState>        full-screen message + Retry — when a query failed and
//                       there is NOTHING cached to show (cold launch offline,
//                       first load of a screen against a dead backend).
//   <ConnectionBanner>  thin top strip — when a query failed but stale data is
//                       still on screen; keep showing the data, warn it's stale.
//                       Auto-clears on the next successful fetch (caller drops
//                       the banner once `isError` goes false).
//   connectionView()    picks which of the two (or neither) a screen should
//                       render, from `isError` + whether any data exists.
//
// Visual vocabulary mirrors the session line-up's FatalView (centered title
// 18/600 + inkSoft body + Buttons) and its "Reconnecting…" strip (surfaceSunk
// + caption inkSoft) — there is no Vero mock for connection states, so we match
// what already ships. Copy is server-reachability framed ("Can't reach the
// server"), NOT "you're offline": the trigger is a failed request, which fires
// even when the device's own network is fine (e.g. the backend is down).

// Full-screen error. Drop into a screen's content area in place of the list /
// spinner when there's no cached data to fall back on.
export function ErrorState({
  title = "Can't reach the server",
  message = 'Check your connection and try again.',
  onRetry,
  retrying,
}: {
  title?: string;
  message?: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 }}>
      <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold', textAlign: 'center' }}>
        {title}
      </VText>
      <VText variant="small" color="inkSoft" style={{ textAlign: 'center', maxWidth: 260 }}>
        {message}
      </VText>
      <Button title="Try again" loading={retrying} onPress={onRetry} style={{ marginTop: 10 }} />
    </View>
  );
}

// Thin top strip shown above otherwise-stale content. Tap to retry (the whole
// strip is the affordance — there's no room for a button at this height).
export function ConnectionBanner({
  // Short by design: the strip is one line (numberOfLines={2} but normally one)
  // and a long string truncates on narrow devices. States the problem + the
  // action. NOTE: the default names "tap to retry", so callers that render this
  // WITHOUT an onRetry (none today) should pass their own label.
  label = "Can't reach server — tap to retry",
  onRetry,
}: {
  label?: string;
  onRetry?: () => void;
}) {
  const { theme } = useTheme();
  const stripStyle = { backgroundColor: theme.surfaceSunk, paddingVertical: 6, paddingHorizontal: 16, alignItems: 'center' as const };
  // 2 lines, centered: lets the label wrap instead of truncating mid-word at
  // large Dynamic Type / on narrow devices (the strip grows a little rather
  // than clipping). One line is the common case.
  const text = (
    <VText variant="caption" color="inkSoft" numberOfLines={2} style={{ textAlign: 'center' }}>
      {label}
    </VText>
  );
  // Passive warning when there's no onRetry (the line-up polls every 5s and
  // recovers on its own); a Pressable with press feedback when a caller wires
  // manual retry.
  if (!onRetry) {
    return <View accessibilityRole="text" accessibilityLabel={label} style={stripStyle}>{text}</View>;
  }
  return (
    <Pressable
      // The button role already conveys "actionable" to VoiceOver, and the
      // label itself says "tap to retry" — don't append it again.
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onRetry}
      style={({ pressed }) => [stripStyle, pressed ? { opacity: 0.6 } : null]}
    >
      {text}
    </Pressable>
  );
}

// Decide what a screen should render for its query's failure, given whether it
// currently has any data to show. Returns a discriminant the caller switches on:
//   'error'  → render <ErrorState> in place of content (no data cached)
//   'banner' → render <ConnectionBanner> above the (stale) content
//   'none'   → render normally (not errored, or still loading with no error)
// `hasData` is the caller's own "do I have something to show" check (usually
// `query.data != null`, or a derived non-empty list). Keeping the boolean at
// the call site avoids guessing the data shape here.
export function connectionView(isError: boolean, hasData: boolean): 'error' | 'banner' | 'none' {
  if (!isError) return 'none';
  return hasData ? 'banner' : 'error';
}

// A passive "reconnecting" bar for screens that POLL and recover on their own
// (the line-up + impression — both share the session-state 5s poll). Pinned
// over the top of the screen (absolute, high zIndex, own safe-area inset) so it
// works identically on plain and full-bleed-photo layouts with no measurement
// or per-screen layout coordination. On a full-bleed photo screen it briefly
// overlays the floating back/⋯ buttons while reconnecting — an accepted
// trade-off for a transient error state (recovers within a poll cycle).
//
// Usage: {showReconnecting ? <ReconnectingBar /> : null}
export function ReconnectingBar({ label = "Can't reach server — reconnecting…" }: { label?: string }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={label}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        paddingTop: insets.top,
        backgroundColor: theme.surfaceSunk,
      }}
    >
      <ConnectionBanner label={label} />
    </View>
  );
}
