import type { ReactElement } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { ScrollViewMarker } from 'react-native-screens/experimental';

// iOS 26 draws an automatic "scroll edge effect" at the top of a scroll view:
// where content runs under the status bar it blurs it and washes it toward the
// screen's colour, a band the status bar's height (on a photo hero: a haze in
// the theme's colour behind the white clock, device pass 2026-11-24). UIKit
// has no colour for it, only on / off. Hidden at the top here, so the photo's
// own dark scrim (HERO_SCRIM) shows there instead, the same on every theme.
//
// react-native-screens' screen option (`scrollEdgeEffects`) can't reach these
// scroll views (it walks only the first subview from the screen; issues #4369,
// #5249, both answered "use ScrollViewMarker"). The marker needs our build's
// `RNS_GAMMA_ENABLED=1` (apps/mobile/ios/Podfile) and ONE direct native child,
// the scroll view, mounted together with it; a gesture-handler GestureDetector
// (builder API) adds no view of its own, so it may sit in between. iOS only.
// `enabled` false renders the child bare (a list that is full-bleed only
// sometimes, FeedList: keyed on it, so the tree change remounts anyway).
export function NoTopEdgeFade({ style, enabled = true, children }: { style?: StyleProp<ViewStyle>; enabled?: boolean; children: ReactElement }) {
  if (Platform.OS !== 'ios' || !enabled) return children;
  return (
    <ScrollViewMarker style={style} scrollEdgeEffects={TOP_HIDDEN}>
      {children}
    </ScrollViewMarker>
  );
}

const TOP_HIDDEN = { top: 'hidden' } as const;
