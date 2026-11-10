import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';
import { motion, useTheme } from '@/theme';

// .vbar — the design's variant-B in-flow header: borderless back chevron +
// left-aligned 18/600 title (h 36, icon optically outdented -6). Replaces the
// native stack header on in-flow screens, where iOS's centered title and
// glass back-circle fight the spec. Right-side slot for the ⋯ menu.
//
// `titleShown` makes the title a SCROLL title (the profile: it appears once
// the header's name has scrolled under the bar); unset = always shown.
// `titleLeading` sits before it (the profile's 26pt photo). `back={false}`
// drops the chevron (a tab root) and its optical outdent.
export function VBar({
  title,
  right,
  titleShown,
  titleLeading,
  back = true,
  onBack,
}: {
  title: string;
  right?: React.ReactNode;
  titleShown?: boolean;
  titleLeading?: React.ReactNode;
  back?: boolean;
  /** Replaces the default router.back() (e.g. a stack-root fallback). */
  onBack?: () => void;
}) {
  const { theme } = useTheme();
  const router = useRouter();
  const phone = usePhoneTokens();
  const surface = phone.surface('topBar');
  const barHeight = surface.height(phone.size('topBar'));
  const controlSize = surface.height(phone.size('compactAction'));
  const iconSize = phone.size('topBarBackIcon');
  const progress = useBarTitleProgress(titleShown ?? true);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: barHeight, marginBottom: 2, marginLeft: back ? -6 : 0 }}>
      {back ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack ?? (() => router.back())}
          hitSlop={8}
          style={({ pressed }) => ({ width: controlSize, height: controlSize, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
        >
          <Icon name="back" size={iconSize} color={theme.ink} />
        </Pressable>
      ) : null}
      <BarTitle
        title={title}
        leading={titleLeading}
        progress={titleShown === undefined ? undefined : progress}
        hidden={titleShown === false}
      />
      {right}
    </View>
  );
}

// THE bar title. Every bar in the app renders its title through this (VBar,
// the moment cover bar, the rate-impression bar), so the type and the
// scroll-in motion have one definition. The feed post detail's tappable
// title still pops in on its own (a pending extraction, apps/mobile/CLAUDE.md).
//   - type: subhead 600, the topBar Dynamic Type surface; ink, or white over a
//     photo (`onGlass`).
//   - `progress` (0 → 1, from useBarTitleProgress or a bar's own value that
//     also drives its background): fade + a 4pt rise. Absent = static.
//   - `inset`: horizontal padding — 0 beside VBar's chevron (its row gap),
//     10 beside a cover bar's 34pt glass circle.
export function BarTitle({
  title,
  progress,
  leading,
  onGlass,
  inset = 0,
  hidden,
}: {
  title: string;
  progress?: Animated.Value;
  leading?: React.ReactNode;
  onGlass?: boolean;
  inset?: number;
  // Out of the accessibility tree while scrolled away.
  hidden?: boolean;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  return (
    <Animated.View
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      style={{
        flex: 1,
        minWidth: 0,
        paddingHorizontal: inset,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        ...(progress
          ? { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }] }
          : null),
      }}
    >
      {leading}
      <VText
        numberOfLines={1}
        surface="topBar"
        style={{ flex: 1, fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('subhead'), color: onGlass ? '#fff' : theme.ink }}
      >
        {title}
      </VText>
    </Animated.View>
  );
}

// The bar-title motion: 0 → 1 (and back) over dur-2 with the house ease, on
// the native driver. Starts at the current state (no animation on mount). A
// bar may drive more than the title off the same value (the moment cover bar
// fades its solid background with it).
export function useBarTitleProgress(shown: boolean): Animated.Value {
  const v = useRef(new Animated.Value(shown ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(v, {
      toValue: shown ? 1 : 0,
      duration: motion.dur2,
      easing: Easing.bezier(...motion.ease),
      useNativeDriver: true,
    }).start();
  }, [shown, v]);
  return v;
}
