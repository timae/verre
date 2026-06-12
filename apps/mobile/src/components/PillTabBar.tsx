// SDK 56's expo-router vendors react-navigation; js-tabs is the classic JS
// Tabs entry (NativeTabs can't render a custom floating pill).
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { elevation, radius, typeScale, useTheme } from '@/theme';
import { VText } from './ui/VText';

// Bottom inset scrollable tab screens need so content clears the floating bar
// (bar ≈ pill + 14 bottom margin; consumers add their own safe-area inset).
export const TAB_BAR_CLEARANCE = 96;

// Floating-pill bottom nav (handoff §7 / .tabbar-float). The 4th slot is the
// undecided explore-or-notifications tab, shown "Soon" (disabled, is-ph) per
// handoff. Icons land with the design's SVG set; labels-only for the skeleton —
// item paddingVertical is a touch-target stopgap until the 24px icons add height.
export function PillTabBar({ state, navigation }: BottomTabBarProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  const items = state.routes
    .filter((r) => ['feed', 'index', 'you'].includes(r.name))
    .map((route) => ({
      key: route.key,
      name: route.name,
      label: route.name === 'index' ? 'Moments' : route.name === 'feed' ? 'Feed' : 'You',
      active: state.index === state.routes.indexOf(route),
    }));
  // Soon slot sits between Moments and You.
  const ordered = [
    items.find((i) => i.name === 'feed'),
    items.find((i) => i.name === 'index'),
    null,
    items.find((i) => i.name === 'you'),
  ];

  const labelStyle = {
    fontFamily: 'InstrumentSans_600SemiBold',
    fontSize: 10.5,
    letterSpacing: 0.105, // .tabbar-item span: 0.01em at 10.5px
  } as const;

  return (
    <View
      style={{
        position: 'absolute',
        left: 14,
        right: 14,
        bottom: insets.bottom + 14,
        flexDirection: 'row',
        backgroundColor: theme.surface,
        borderWidth: 1,
        borderColor: theme.rule,
        borderRadius: radius.pill,
        paddingVertical: 8,
        paddingHorizontal: 6,
        shadowColor: '#000',
        shadowOpacity: elevation.md.ios.shadowOpacity,
        shadowRadius: elevation.md.ios.shadowRadius,
        shadowOffset: { width: 0, height: elevation.md.ios.shadowOffsetY },
        elevation: elevation.md.android.elevation,
      }}
    >
      {ordered.map((item) =>
        !item ? (
          <View key="soon" style={{ flex: 1, alignItems: 'center', paddingVertical: 5, opacity: 0.45 }}>
            <VText color="inkSoft" style={labelStyle}>Soon</VText>
          </View>
        ) : (
          <Pressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: item.active }}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: item.key, canPreventDefault: true });
              if (!item.active && !event.defaultPrevented) navigation.navigate(item.name);
            }}
            style={{ flex: 1, alignItems: 'center', paddingVertical: 5 }}
          >
            <VText color={item.active ? 'accent' : 'inkSoft'} style={labelStyle}>
              {item.label}
            </VText>
          </Pressable>
        ),
      )}
    </View>
  );
}
