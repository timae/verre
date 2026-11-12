import * as Haptics from 'expo-haptics';
import { forwardRef, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, TextInput, View, type StyleProp, type TextInputInstance, type TextStyle, type ViewStyle } from 'react-native';
import Reanimated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VText } from '@/components/ui/VText';
import { useRegisterInput } from '@/lib/keyboardDismiss';
import { motion, useTheme } from '@/theme';
import { alpha } from '@/theme/color';

// Own-profile editing pieces (04·R5g2–R5g4, step 2).

const LONG_PRESS_MS = 480;

// A long-press target (name, bio, photo, cover, tile): pressing scales it down
// (`.is-press`, 0.97 / 0.85 opacity; tiles 0.95) over dur-2; at 480 ms it
// fires with a haptic and springs back. `onPress` (optional) is a plain tap
// (the empty-bio hint starts editing on tap too). Disabled = an
// inert plain view. `fill`: the child fills the target's box (a photo tile
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

export function EditBar({ busy, onCancel, onDone, onHeight }: { busy: boolean; onCancel: () => void; onDone: () => void; onHeight: (h: number) => void }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const kb = useAnimatedKeyboard();
  const ride = useAnimatedStyle(() => ({ transform: [{ translateY: -(Math.max(kb.height.value, insets.bottom) + KEYBOARD_GAP) }] }));
  return (
    <Reanimated.View
      style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20, backgroundColor: theme.surfaceSunk, borderRadius: KEYBOARD_RADIUS, borderCurve: 'continuous' }, ride]}
    >
      <View
        // The screen's clearance math adds the keyboard (or the home
        // indicator) itself: report the row + the gap.
        onLayout={(e) => onHeight(e.nativeEvent.layout.height + KEYBOARD_GAP)}
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
