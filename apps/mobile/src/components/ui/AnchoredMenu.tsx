import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { usePhoneMetrics } from '@/lib/layout';
import { elevation, motion, radius, useTheme } from '@/theme';

// AnchoredMenu — the brand `.ir-menu` anchored dropdown (a transparent Modal +
// an absolute surface card anchored under a measured ⋯/trigger button, with the
// dur-1 fade + 4px rise and outside-press-to-close). Extracted from 3 hand-rolled
// copies (impression IrMenu, line-up SessionMenu, PeopleSheet RowMenu) + their 4
// measure-anchor buttons — the design's per-element exception to the
// native-chrome "context menus" tag (Simon's ruling). Use `<AnchorButton>` to
// open it.
//
// Standardized on the most general (PeopleSheet) contract: a `{top, bottom}`
// anchor that opens DOWN from the trigger's bottom but FLIPS UP (anchored to the
// trigger's top) when opening down would clip off the screen bottom. Pass a
// single value to both top+bottom if you don't need the flip.
//
// Content is `children`, not a fixed item schema — call sites differ (icon rows,
// a press-to-activate field, label-only rows). Use the exported `<MenuItem>` for
// the common icon+label (or label-only) row.

export type MenuAnchor = { top: number; bottom: number };

export function AnchoredMenu({
  anchor, onClose, children, right = 16, minWidth = 196, gap = 6,
}: {
  // null = closed. {top, bottom} in window coords from the trigger's measure.
  anchor: MenuAnchor | null;
  onClose: () => void;
  children: React.ReactNode;
  right?: number;
  minWidth?: number;
  // Vertical gap between the trigger and the panel.
  gap?: number;
}) {
  const { theme } = useTheme();
  const { height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;
  // Hold the last anchor so the panel keeps its place during the close fade (the
  // Modal renders a frame after `anchor` nulls while it dismisses).
  const last = useRef<MenuAnchor>({ top: 0, bottom: 0 });
  if (anchor) last.current = anchor;
  // Measured panel height → exact flip decision (vs guessing from item count).
  // Reset on close so a different-height next target re-measures (a stale value
  // would compute the flip from the previous menu for one frame).
  const [menuH, setMenuH] = useState(0);
  useEffect(() => {
    if (!anchor) {
      anim.setValue(0);
      setMenuH(0);
      return;
    }
    Animated.timing(anim, {
      toValue: 1,
      duration: motion.dur1,
      easing: Easing.bezier(...motion.ease),
      useNativeDriver: true,
    }).start();
  }, [anchor, anim]);
  if (!anchor) return null;

  const bottomLimit = screenH - insets.bottom - 8;
  // Flip up only once measured AND the down-position would overflow; before the
  // first measure (menuH === 0) default to opening down.
  const flipUp = menuH > 0 && last.current.bottom + gap + menuH > bottomLimit;
  const top = flipUp ? last.current.top - gap - menuH : last.current.bottom + gap;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={{ flex: 1 }} accessibilityLabel="Close menu" onPress={onClose}>
        <Animated.View
          onLayout={(e) => setMenuH(e.nativeEvent.layout.height)}
          style={{
            position: 'absolute',
            top,
            right,
            minWidth,
            backgroundColor: theme.surface,
            borderWidth: 1,
            borderColor: theme.rule,
            borderRadius: radius.md,
            padding: 6,
            opacity: anim,
            // Slide from the side it opens toward: down → from above (-4), up → from below (+4).
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [flipUp ? 4 : -4, 0] }) }],
            shadowColor: '#000',
            shadowOpacity: elevation.menu.ios.shadowOpacity,
            shadowRadius: elevation.menu.ios.shadowRadius,
            shadowOffset: { width: 0, height: elevation.menu.ios.shadowOffsetY },
            elevation: elevation.menu.android.elevation,
          }}
        >
          {children}
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// .sess-menu-item / .ir-menu row — the common icon (optional) + label menu row.
// `tone`: 'default' = ink label + ink-soft icon; 'danger' = critical label.
// `disabled` greys it + shows a trailing "Soon" caption (the line-up menu's
// Compare-soon convention). `active` styles the whole row accent (the
// Blind-for-all press-field state) — accent label/icon + accent-tint bg.
export function MenuItem({
  label, icon, onPress, tone = 'default', disabled, active, accessibilityState,
}: {
  label: string;
  icon?: IconName;
  onPress?: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  active?: boolean;
  accessibilityState?: { disabled?: boolean; selected?: boolean };
}) {
  const { theme } = useTheme();
  const labelColor = disabled
    ? theme.inkFaint
    : active
      ? theme.accent
      : tone === 'danger'
        ? theme.critical
        : theme.ink;
  const iconColor = disabled ? theme.inkFaint : active ? theme.accent : theme.inkSoft;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState ?? { disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        borderRadius: radius.sm,
        paddingVertical: 10,
        paddingHorizontal: 12,
        backgroundColor: active ? theme.accentTint : pressed && !disabled ? theme.surfaceSunk : 'transparent',
      })}
    >
      {icon ? <Icon name={icon} size={18} color={iconColor} /> : null}
      <VText
        style={{ fontFamily: active ? 'InstrumentSans_600SemiBold' : 'InstrumentSans_500Medium', fontSize: 15, flex: 1 }}
        color={labelColor}
      >
        {label}
      </VText>
      {disabled ? <VText variant="caption" color="inkFaint">Soon</VText> : null}
    </Pressable>
  );
}

// .sess-menu-sep — the hairline divider between menu groups.
export function MenuSeparator() {
  const { theme } = useTheme();
  return <View style={{ height: 1, backgroundColor: theme.ruleSoft, marginVertical: 4 }} />;
}

// The measure-anchor trigger: a 30px borderless ⋯-style button that measures its
// own window rect and reports {top, bottom} to open an AnchoredMenu beneath it.
// Replaces the 4 hand-rolled `measureInWindow((_x,y,_w,h)=>…)` buttons. Pass
// custom `children` to anchor something other than the default ⋯ glyph.
export function AnchorButton({
  onOpen, accessibilityLabel = 'Open menu', icon = 'more', iconColor, size = 30, hitSlop = 8, children,
}: {
  onOpen: (anchor: MenuAnchor) => void;
  accessibilityLabel?: string;
  icon?: IconName;
  iconColor?: string;
  size?: number;
  hitSlop?: number;
  children?: React.ReactNode;
}) {
  const { theme } = useTheme();
  const phone = usePhoneMetrics();
  const controlSize = size === 30 ? phone.lerp(30, 34) : size;
  const iconSize = size === 30 ? phone.lerp(20, 21) : 20;
  const ref = useRef<View>(null);
  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        hitSlop={hitSlop}
        onPress={() => ref.current?.measureInWindow((_x, y, _w, h) => onOpen({ top: y, bottom: y + h }))}
        style={({ pressed }) => ({ width: controlSize, height: controlSize, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
      >
        {children ?? <Icon name={icon} size={iconSize} color={iconColor ?? theme.ink} />}
      </Pressable>
    </View>
  );
}
