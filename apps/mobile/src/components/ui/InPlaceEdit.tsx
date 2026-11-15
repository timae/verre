import * as Haptics from 'expo-haptics';
import { forwardRef, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, Pressable, TextInput, View, type GestureResponderEvent, type StyleProp, type TextInputInstance, type TextStyle, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { Easing as REasing, useAnimatedKeyboard, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VText } from '@/components/ui/VText';
import { isRegisteredInput, useRegisterInput } from '@/lib/keyboardDismiss';
import { motion, useTheme } from '@/theme';
import { alpha } from '@/theme/color';

// In-place editing pieces: your own profile (04·R5g2–R5g4, step 2) and a
// moment's top for its hosts (2026-11-14). One look and one gesture for both.

const LONG_PRESS_MS = 480;

// A long-press target (name, bio, photo, cover, tile): pressing scales it down
// (`.is-press`, 0.97 / 0.85 opacity; tiles 0.95) over dur-2; at 480 ms it
// fires with a haptic and springs back. `onPress` (optional) is a plain tap.
// Disabled = inert (no touch, no VoiceOver activation, not focusable) but the
// SAME element tree: a plain View in its place remounted everything inside,
// so the cover, the photo and the tiles reloaded and flickered each time an
// edit started or ended (device pass 2026-11-14). `fill`: the child fills the
// target's box (a photo tile sized by its row, not by its own content).
// 🔒 `swapsOut`: the action REPLACES the pressed view (the name and the bio
// become inputs). RN 0.88 drops a touch's end when its target view is gone
// (no instance to dispatch to), so a swap under a held finger leaves the
// responder stuck on the removed view and the NEXT touch negotiates from the
// common ancestor down: it never reaches its button (the edit bar's first
// Done was swallowed and the bar shook, device pass 2026-11-14). So the hold
// is iOS's own long-press recognizer (gesture-handler): when it fires it
// CANCELS React Native's touch while the view still exists
// (`cancelsJSResponder`), and the swap waits until the Pressable has seen
// that touch end (`onPressOut`), whichever of the two reaches JS first; a
// hold for a touch this Pressable never held (no press-in) swaps at once,
// nothing of ours to strand. Nothing carries over between touches. The
// edit still starts at the hold, finger down (ruled 2026-11-14, over starting
// on release). The Pressable stays: it keeps the touch from reaching a
// pressable around it (the cover's own long-press holds the cover name).
export function LongPressable({
  onLongPress, onPress, disabled, swapsOut, pressedScale = 0.97, dim = true, fill, accessibilityLabel, accessibilityHint, style, children,
}: {
  onLongPress: () => void;
  onPress?: () => void;
  disabled?: boolean;
  swapsOut?: boolean;
  pressedScale?: number;
  dim?: boolean;
  fill?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const v = useRef(new Animated.Value(0)).current;
  // `swapsOut`: `pressed` = this Pressable holds the touch (press-in to
  // press-out), `held` = the hold fired during it and waits for the press-out.
  const sync = useRef({ pressed: false, held: false });
  const to = (value: number) =>
    Animated.timing(v, { toValue: value, duration: motion.dur2, easing: Easing.bezier(...motion.ease), useNativeDriver: true }).start();
  const answerHold = () => {
    to(0);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  };
  // Once per hold, whichever of the two arrives second.
  const swap = () => {
    sync.current = { pressed: false, held: false };
    onLongPress();
  };
  const pressable = (
    <Pressable
      disabled={disabled}
      // Disabled: its children (the name input inside the cover, a tile's
      // label) stay reachable for VoiceOver, as with a plain View.
      accessible={!disabled}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      delayLongPress={LONG_PRESS_MS}
      onPressIn={() => {
        sync.current = { pressed: true, held: false };
        to(1);
      }}
      onPressOut={() => {
        to(0);
        if (!swapsOut) return;
        if (sync.current.held) swap();
        else sync.current = { pressed: false, held: false };
      }}
      onPress={onPress}
      onLongPress={swapsOut ? undefined : () => {
        answerHold();
        onLongPress();
      }}
      // swapsOut: the wrapper below takes `style`; this fills it.
      style={swapsOut ? (fill ? { flex: 1 } : undefined) : style}
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
  if (!swapsOut) return pressable;
  const hold = Gesture.LongPress()
    .enabled(!disabled)
    .runOnJS(true)
    .minDuration(LONG_PRESS_MS)
    .onStart(() => {
      answerHold();
      // Still pressed: the cancel (or the release) is on its way, wait for
      // it. Otherwise the touch is already over for the responder: swap.
      if (sync.current.pressed) sync.current.held = true;
      else swap();
    });
  return (
    <GestureDetector gesture={hold}>
      <View collapsable={false} style={style}>{pressable}</View>
    </GestureDetector>
  );
}

// The in-place editor (R5g3): no field chrome, the text just gets the accent
// caret and, while focused, a soft 2pt accent underline (the mock's
// background-gradient underline). Registered with the global outside-tap
// keyboard dismissal (lib/keyboardDismiss.ts). `username`: the Username
// field's input traits (UsernameField): no capitals, autocorrect or
// autofill; 🔒 never `textContentType="username"` (the EMAIL is the login for
// password managers). `keepFocus`: Return submits WITHOUT leaving the field
// (while Done is greyed: it would only close the keyboard and do nothing).
// `url`: the link keyboard, no capitals or autocorrect. `textProps`: the
// Dynamic Type cap of the text it replaces (`phone.surface(…).textProps`,
// the moment's bar title). `newlines` (multiline only): Return writes a new
// line instead of submitting (the moment's description; saving is the edit
// bar's Done), so `onSubmit` isn't needed there.
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
  onSubmit?: () => void;
  accessibilityLabel: string;
  username?: boolean;
  url?: boolean;
  keepFocus?: boolean;
  newlines?: boolean;
  textProps?: { maxFontSizeMultiplier?: number };
}>(function InlineField({ value, onChangeText, onFocus, style, multiline, maxLength, autoFocus, placeholder, placeholderTextColor, onSubmit, accessibilityLabel, username, url, keepFocus, newlines, textProps }, ref) {
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
        {...(username ? { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'off', textContentType: 'none', importantForAutofill: 'no' } as const : null)}
        {...(url ? { autoCapitalize: 'none', autoCorrect: false, keyboardType: 'url', textContentType: 'URL' } as const : null)}
        {...textProps}
        // Return = Done (one paragraph, no newlines), unless `newlines`.
        returnKeyType={newlines ? 'default' : 'done'}
        submitBehavior={newlines ? 'newline' : keepFocus ? 'submit' : 'blurAndSubmit'}
        onSubmitEditing={newlines ? undefined : onSubmit}
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

// `line` REPLACES "Editing Profile" while there is something to say about the
// username (ruled 2026-11-14: the bar is where your eyes are while typing):
// the broken rule, taken, "Available", the changes left (quiet until the last
// two, as on Edit Profile), the date once none are. Two caption lines at most,
// so at the default text size it stays within the buttons' height (no jump).
// `more` = a second sentence in soft ink after a coloured first one;
// `transient` = shown, not read out ("Checking availability…").
// `doneDisabled`: Done greyed while the username can't be saved (the line says
// why).
export type EditBarLine = { text: string; tone: 'critical' | 'positive' | 'inkSoft'; more?: string; transient?: boolean };

// `title`: the centre's words ("Editing Profile", "Editing Moment"). `center`
// REPLACES the centre (the moment's Add Fields button, then its wheel; it wins
// over `line`). `doneLabel`: the right button's word (the moment's "Add" while
// its wheel is open).
export function EditBar({ busy, onCancel, onDone, onHeight, shake = 0, line, doneDisabled, title = 'Editing Profile', center, doneLabel = 'Done' }: {
  busy: boolean; onCancel: () => void; onDone: () => void; onHeight: (h: number) => void; shake?: number; line?: EditBarLine | null; doneDisabled?: boolean;
  title?: string; center?: React.ReactNode; doneLabel?: string;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const kb = useAnimatedKeyboard();
  const sx = useSharedValue(0);
  // VoiceOver hears each new line (a live region only works on Android).
  const spoken = line && !line.transient ? `${line.text}${line.more ? ` ${line.more}` : ''}` : null;
  useEffect(() => {
    if (spoken) AccessibilityInfo.announceForAccessibility(spoken);
  }, [spoken]);
  // Each bump of `shake` after mount: a quick shake (left, right, left,
  // right, home: 60 ms swings, 240 ms in all) on motion tokens; twice the
  // speed of the first cut, which read too soft to notice (device pass
  // 2026-11-14). Transform-only, beside the keyboard ride.
  const shakeAtMount = useRef(shake);
  useEffect(() => {
    if (shake === shakeAtMount.current) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    AccessibilityInfo.announceForAccessibility('Still editing. Tap Done or Cancel.');
    const ease = REasing.bezier(...motion.ease);
    const swing = motion.dur1 / 2;
    sx.value = withSequence(
      withTiming(-SHAKE_X, { duration: swing / 2, easing: ease }),
      withRepeat(withTiming(SHAKE_X, { duration: swing, easing: ease }), 3, true),
      withTiming(0, { duration: swing / 2, easing: ease }),
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
        <View style={{ flex: 1, marginHorizontal: 10, alignItems: 'center' }}>
          {center ? center : line ? (
            <VText variant="caption" color={line.tone} numberOfLines={2} style={{ textAlign: 'center' }}>
              {line.text}
              {line.more ? <VText variant="caption" color="inkSoft">{` ${line.more}`}</VText> : null}
            </VText>
          ) : (
            <VText variant="small" color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{title}</VText>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || !!doneDisabled }}
          onPress={onDone}
          disabled={busy || doneDisabled}
          hitSlop={8}
          style={({ pressed }) => ({ paddingVertical: 6, paddingHorizontal: 4, opacity: pressed ? 0.5 : doneDisabled ? 0.4 : 1, minWidth: 44, alignItems: 'flex-end' })}
        >
          {busy ? (
            <ActivityIndicator color={theme.accent} />
          ) : (
            <VText variant="body" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{doneLabel}</VText>
          )}
        </Pressable>
      </View>
    </Reanimated.View>
  );
}
