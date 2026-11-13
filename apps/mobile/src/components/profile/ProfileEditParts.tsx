import * as Haptics from 'expo-haptics';
import { forwardRef, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, Pressable, TextInput, View, type GestureResponderEvent, type StyleProp, type TextInputInstance, type TextStyle, type ViewStyle } from 'react-native';
import Reanimated, { Easing as REasing, useAnimatedKeyboard, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VText } from '@/components/ui/VText';
import { isRegisteredInput, useRegisterInput } from '@/lib/keyboardDismiss';
import { motion, useTheme } from '@/theme';
import { alpha } from '@/theme/color';

// Own-profile editing pieces (04·R5g2–R5g4, step 2).

const LONG_PRESS_MS = 480;

// A long-press target (name, bio, photo, cover, tile): pressing scales it down
// (`.is-press`, 0.97 / 0.85 opacity; tiles 0.95) over dur-2; at 480 ms it
// fires with a haptic and springs back. `onPress` (optional) is a plain tap.
// Disabled = an inert plain view. `fill`: the child fills the target's box (a photo tile
// sized by its row, not by its own content).
export function LongPressable({
  onLongPress, onPress, disabled, pressedScale = 0.97, dim = true, fill, accessibilityLabel, accessibilityHint, style, children,
}: {
  onLongPress: () => void;
  onPress?: () => void;
  disabled?: boolean;
  pressedScale?: number;
  dim?: boolean;
  fill?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const v = useRef(new Animated.Value(0)).current;
  const to = (value: number) =>
    Animated.timing(v, { toValue: value, duration: motion.dur2, easing: Easing.bezier(...motion.ease), useNativeDriver: true }).start();
  if (disabled) return <View style={style}>{children}</View>;
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      delayLongPress={LONG_PRESS_MS}
      onPressIn={() => to(1)}
      onPressOut={() => to(0)}
      onPress={onPress}
      onLongPress={() => {
        to(0);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        onLongPress();
      }}
      style={style}
    >
      <Animated.View
        style={{
          ...(fill ? { flex: 1 } : null),
          transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, pressedScale] }) }],
          ...(dim ? { opacity: v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.85] }) } : null),
        }}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}

// The in-place editor (R5g3): no field chrome, the text just gets the accent
// caret and, while focused, a soft 2pt accent underline (the mock's
// background-gradient underline). Registered with the global outside-tap
// keyboard dismissal (lib/keyboardDismiss.ts).
export const InlineField = forwardRef<TextInputInstance, {
  value: string;
  onChangeText: (s: string) => void;
  onFocus?: () => void;
  style: StyleProp<TextStyle>;
  multiline?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  placeholder?: string;
  placeholderTextColor?: string;
  onSubmit: () => void;
  accessibilityLabel: string;
}>(function InlineField({ value, onChangeText, onFocus, style, multiline, maxLength, autoFocus, placeholder, placeholderTextColor, onSubmit, accessibilityLabel }, ref) {
  const { theme } = useTheme();
  const own = useRef<TextInputInstance | null>(null);
  useRegisterInput(own);
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <TextInput
        ref={(node) => {
          own.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        maxLength={maxLength}
        autoFocus={autoFocus}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        selectionColor={theme.accent}
        keyboardAppearance={theme.scheme}
        accessibilityLabel={accessibilityLabel}
        returnKeyType="done"
        // Return = Done (one paragraph, no newlines).
        submitBehavior="blurAndSubmit"
        onSubmitEditing={onSubmit}
        onFocus={() => {
          setFocused(true);
          onFocus?.();
        }}
        onBlur={() => setFocused(false)}
        style={[{ padding: 0, margin: 0 }, style]}
      />
      {focused ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: -2, height: 2, backgroundColor: alpha(theme.accent, 0.55) }} />
      ) : null}
    </View>
  );
});

// Cancel / "Editing Profile" / Done (R5g3 `.yo-edbar`). It rides ON the
// keyboard while it is up, and drops to the bottom of the screen when an
// outside tap closes the keyboard (ruling D6), so Cancel / Done stay reachable
// (an InputAccessoryView would leave with the keyboard). Transform-only on the
// UI thread (reanimated's sync fast path). `onHeight` = the bar's own height,
// for the list's bottom clearance. Flagged deviation: theme tokens instead of
// the mock's literal keyboard greys, and no top rule (no borders).
// The bar floats just above the keyboard with the keyboard's own rounded
// corners (ruled 2026-11-12: iOS 26's keyboard is rounded, a square strip on
// it looked foreign). No API exposes the system keyboard's radius: this is an
// estimate, tune it on device. With the keyboard down it floats above the
// home indicator the same way.
const KEYBOARD_RADIUS = 26;
const KEYBOARD_GAP = 6;

// "It is still open" (Simon, 2026-11-13): while you edit, a TAP outside the
// fields and the bar shakes the bar, with the warning haptic (the app's "not
// now", as DraggableRows' denied hold) and a VoiceOver announcement. Only a
// real tap: one finger, never more than TAP_SLOP from where it landed over
// the whole touch, lifted within TAP_MS (a drag, a scroll that comes back, a
// hold never shake). The screen's root spreads `editTouchHandlers` ALWAYS (a
// conditional spread would turn its flattened root into a real view and
// re-parent the screen's native children on every edit start), and
// `onOutsideTap` decides whether you are editing. The capture handler records
// each touch start and never claims it (like lib/keyboardDismiss); the
// bubbling move / end decide. Touches that must not shake mark themselves
// with `markNoShake` in their own capture (it runs after the root's, within
// the same start): the edit bar, the back buttons (Back works, and losing
// focus cancels the edit). A field is the keyboard registry's.
const TAP_SLOP = 10;
const TAP_MS = 500;
const SHAKE_X = 6;
let noShake = false;
let touch: { x: number; y: number; at: number; moved: number; skip: boolean } | null = null;
export const markNoShake = () => {
  noShake = true;
  return false;
};
export function editTouchHandlers(onOutsideTap: () => void) {
  return {
    onStartShouldSetResponderCapture: (e: GestureResponderEvent) => {
      noShake = false;
      const n = e.nativeEvent;
      touch = { x: n.pageX, y: n.pageY, at: Date.now(), moved: 0, skip: isRegisteredInput(n.target) || n.touches.length > 1 };
      return false;
    },
    onTouchMove: (e: GestureResponderEvent) => {
      if (!touch) return;
      touch.moved = Math.max(touch.moved, Math.hypot(e.nativeEvent.pageX - touch.x, e.nativeEvent.pageY - touch.y));
    },
    onTouchEnd: (e: GestureResponderEvent) => {
      const t = touch;
      touch = null;
      if (!t || t.skip || noShake || e.nativeEvent.touches.length > 0) return;
      const moved = Math.max(t.moved, Math.hypot(e.nativeEvent.pageX - t.x, e.nativeEvent.pageY - t.y));
      if (moved > TAP_SLOP || Date.now() - t.at > TAP_MS) return;
      onOutsideTap();
    },
    onTouchCancel: () => {
      touch = null;
    },
  };
}

export function EditBar({ busy, onCancel, onDone, onHeight, shake = 0 }: { busy: boolean; onCancel: () => void; onDone: () => void; onHeight: (h: number) => void; shake?: number }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const kb = useAnimatedKeyboard();
  const sx = useSharedValue(0);
  // Each bump of `shake` after mount: a short shake (left, right, left, home)
  // on motion tokens. Transform-only, beside the keyboard ride.
  const shakeAtMount = useRef(shake);
  useEffect(() => {
    if (shake === shakeAtMount.current) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    AccessibilityInfo.announceForAccessibility('Still editing. Tap Done or Cancel.');
    const ease = REasing.bezier(...motion.ease);
    sx.value = withSequence(
      withTiming(-SHAKE_X, { duration: motion.dur1 / 2, easing: ease }),
      withRepeat(withTiming(SHAKE_X, { duration: motion.dur1, easing: ease }), 2, true),
      withTiming(0, { duration: motion.dur1 / 2, easing: ease }),
    );
  }, [shake, sx]);
  const ride = useAnimatedStyle(() => ({ transform: [{ translateX: sx.value }, { translateY: -(Math.max(kb.height.value, insets.bottom) + KEYBOARD_GAP) }] }));
  return (
    <Reanimated.View
      style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20, backgroundColor: theme.surfaceSunk, borderRadius: KEYBOARD_RADIUS, borderCurve: 'continuous' }, ride]}
    >
      <View
        // The screen's clearance math adds the keyboard (or the home
        // indicator) itself: report the row + the gap.
        onLayout={(e) => onHeight(e.nativeEvent.layout.height + KEYBOARD_GAP)}
        onStartShouldSetResponderCapture={markNoShake}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 8 }}
      >
        <Pressable accessibilityRole="button" onPress={onCancel} disabled={busy} hitSlop={8} style={({ pressed }) => ({ paddingVertical: 6, paddingHorizontal: 4, opacity: pressed || busy ? 0.5 : 1 })}>
          <VText variant="body" color="inkSoft" style={{ fontFamily: 'InstrumentSans_500Medium' }}>Cancel</VText>
        </Pressable>
        <VText variant="small" color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Editing Profile</VText>
        <Pressable accessibilityRole="button" onPress={onDone} disabled={busy} hitSlop={8} style={({ pressed }) => ({ paddingVertical: 6, paddingHorizontal: 4, opacity: pressed ? 0.5 : 1, minWidth: 44, alignItems: 'flex-end' })}>
          {busy ? (
            <ActivityIndicator color={theme.accent} />
          ) : (
            <VText variant="body" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Done</VText>
          )}
        </Pressable>
      </View>
    </Reanimated.View>
  );
}
