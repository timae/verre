import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Path } from 'react-native-svg';
import { STAR_PATH, SCORE_MAX, scoreFromFraction, snapScore, stepScore } from '@verre/core';
import { useRegisterInput } from '@/lib/keyboardDismiss';
import { scoreWord } from '@/lib/scoreWords';
import { usePhoneTokens } from '@/lib/layout';
import { VText } from '@/components/ui/VText';
import { radius, useTheme } from '@/theme';

// 02e overall-score input — the decided "wide slider + editable number"
// (.ir-rate pixel spec): 26px accent star + 40/600 editable number +
// score word right, 6px rail (in a 44pt touch box — see TRACK_H), accent
// fill, 26px thumb.
//
// Input behavior is native-first (Simon's ruling): gesture-handler's
// activeOffsetX/failOffsetY lets the OS arbitrate drag-vs-scroll against
// the surrounding ScrollView (what the web mimics with its 6px SLOP
// dance), the number field is a native decimal-pad TextInput, and
// VoiceOver adjusts via accessibility increment/decrement. Only the
// value policy (0.25 snap, 0 = not rated) comes from @verre/core.

const THUMB = 26;
const THUMB_COMFORT = 30;
// Track BOX = the touch target, rail centered inside. The mock's 30px box
// was hard to grab (Simon's device pass, 2026-07-12) — grown to 50pt on his
// follow-up ruling (44 still felt tight); the root paddingBottom shrinks in
// compensation. Visuals (rail/thumb) are untouched — the box is invisible.
const TRACK_H = 50;
const TRACK_H_COMFORT = 54;
const RAIL_H = 6;
const RAIL_H_COMFORT = 7;

// Sanitize a raw keystroke string into a left-anchored decimal the user is
// typing: keep digits + a single separator, cap the integer part at one digit
// (scores are 0..5), and cap to two fraction digits. NO reformatting to a fixed
// X.XX — that fought the caret and made the field flicker on every keystroke.
// "2" stays "2"; "2.5" stays "2.5"; "25" (no dot) is read as 2.5 by parseScoreDraft.
function sanitizeScoreDraft(text: string) {
  let s = text.replace(/[^0-9.,]/g, '').replace(',', '.');
  const dot = s.indexOf('.');
  if (dot !== -1) {
    const intPart = s.slice(0, dot).slice(0, 1);
    const fracPart = s.slice(dot + 1).replace(/\./g, '').slice(0, 2);
    s = `${intPart}.${fracPart}`;
  } else {
    // No separator yet: a lone "25" means 2.5 — keep first digit as units, the
    // rest flow into the fraction so the bar can track digit-by-digit.
    if (s.length > 1) s = `${s.slice(0, 1)}.${s.slice(1, 3)}`;
  }
  return s;
}

// Parse a typed draft to a raw 0..5 number (pre-snap), for the LIVE bar.
function parseScoreDraft(text: string): number | null {
  if (!text || text === '.') return null;
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) return null;
  return Math.min(SCORE_MAX, Math.max(0, n));
}

interface Props {
  value: number; // 0..5 in 0.25 steps; 0 = not rated
  onChange: (v: number) => void;
}

export function ScoreInput({ value, onChange }: Props) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const scoreSurface = phone.surface('score');
  // Slider chrome (hit area, rail, thumb) scales on BOTH axes: device size
  // (phone.lerp by comfort — Pro Max gets the taller value) AND text size (the
  // score surface, so it grows with the numeral beside it under Dynamic Type).
  // THUMB must stay a single value — the touch-fraction math and the visual
  // thumb both read it.
  const trackH = scoreSurface.height(phone.lerp(TRACK_H, TRACK_H_COMFORT));
  const railH = scoreSurface.height(phone.lerp(RAIL_H, RAIL_H_COMFORT));
  const thumb = scoreSurface.height(phone.lerp(THUMB, THUMB_COMFORT));
  const [trackW, setTrackW] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<TextInput>(null);
  useRegisterInput(inputRef);
  const skipCommitRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const setFromX = (x: number) => {
    if (trackW <= thumb) return;
    if (editingRef.current) {
      // A slider touch while the number field is open abandons the draft —
      // otherwise the field's eventual blur would commit the stale draft
      // over the drag.
      skipCommitRef.current = true;
      setEditing(false);
      inputRef.current?.blur();
    }
    // Range-input semantics: the thumb travels within [thumb/2, W - thumb/2].
    const next = scoreFromFraction((x - thumb / 2) / (trackW - thumb));
    if (next !== valueRef.current) {
      // Selection tick on each 0.25 step while dragging (interaction-spec).
      Haptics.selectionAsync().catch(() => {});
      onChange(next);
    }
  };
  const commitHaptic = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };

  // activeOffsetX claims the gesture natively once movement is clearly
  // horizontal; failOffsetY hands clearly-vertical movement to the parent
  // ScrollView before the pan can activate.
  //
  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-6, 6])
    .failOffsetY([-8, 8])
    .onUpdate((e) => setFromX(e.x))
    .onEnd(() => commitHaptic());
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e, success) => {
      if (!success) return;
      setFromX(e.x);
      commitHaptic();
    });
  const gesture = Gesture.Race(pan, tap);

  const commitDraft = () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    setEditing(false);
    const parsed = parseScoreDraft(draft);
    // Empty/garbage draft leaves the value as last live-tracked (updateDraft
    // already pushed each keystroke through). Only snap+commit a parseable one.
    if (parsed == null) return;
    const next = snapScore(parsed);
    if (next !== value) {
      onChange(next);
      commitHaptic();
    }
  };

  const updateDraft = (text: string) => {
    const clean = sanitizeScoreDraft(text);
    setDraft(clean); // raw as typed — no X.XX reformat, so the field can't flicker
    // Live-track the bar: snap each keystroke's value and push it up. "2" → 2,
    // "2" then "5" → 2.5; an off-grid "2.6" snaps the bar+value to 2.5.
    const parsed = parseScoreDraft(clean);
    const next = parsed == null ? 0 : snapScore(parsed);
    if (next !== valueRef.current) onChange(next);
  };

  const rated = value > 0;
  const pct = Math.min(SCORE_MAX, Math.max(0, value)) / SCORE_MAX;
  const thumbLeft = trackW > thumb ? pct * (trackW - thumb) : 0;

  return (
    // .ir-rate: padding 8 0 18. Inner column gap 6. Two sanctioned mock
    // deviations (Simon, 2026-07-12): paddingBottom shrank to 8 — the space
    // moved INTO the taller touch box (see TRACK_H) — and the border-bottom
    // rule MOVED OUT of this component: it now sits below the note field in
    // RatingSection, so score + note read as one block.
    <View style={{ paddingTop: 8, paddingBottom: 8, gap: 6 }}>
      {/* .rate-m-head */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        {/* .rate-m-numbox: 26px accent star + editable number */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Svg width={26} height={26} viewBox="0 0 24 24">
            <Path d={STAR_PATH} fill={theme.accent} />
          </Svg>
          <TextInput
            {...scoreSurface.textProps}
            ref={inputRef}
            value={editing ? draft : value.toFixed(2)}
            onFocus={() => {
              skipCommitRef.current = false;
              // Seed left-anchored: a rated value as a trim string ("3.5", not
              // "3.50"); unrated (0) starts EMPTY so typing fills from the left.
              setDraft(value > 0 ? String(value) : '');
              setEditing(true);
            }}
            onChangeText={updateDraft}
            onEndEditing={commitDraft}
            keyboardType="decimal-pad"
            accessibilityLabel="Score out of 5"
            selectTextOnFocus
            // The big 40px field renders a tall caret + selection handle that
            // pops out oddly bottom-right; the value's short and selected on
            // focus, so the caret adds nothing — hide it and tint selection.
            caretHidden
            selectionColor={theme.accent}
            style={{
              width: scoreSurface.height(92),
              height: scoreSurface.height(56),
              fontFamily: 'InstrumentSans_600SemiBold',
              fontSize: 40,
              // dynamic-type-ok: fixed-format — the score numeral pins lineHeight
              // 48 inside a tall fixed 56 box (with includeFontPadding:false +
              // textAlignVertical:'center'); device-verified centered, not a
              // paragraph line box like the text fields. See the gate.
              lineHeight: 48,
              letterSpacing: -1.2,
              includeFontPadding: false,
              textAlignVertical: 'center',
              fontVariant: ['tabular-nums'],
              color: editing ? theme.accent : theme.ink,
              backgroundColor: editing ? theme.surfaceSunk : 'transparent',
              borderRadius: radius.sm,
              paddingVertical: 0,
              paddingHorizontal: 4,
            }}
          />
        </View>
        {/* .rateword: accent when rated, ink-soft at 0 */}
        <VText
          variant="subhead"
          numberOfLines={1}
          style={{ flexShrink: 1, fontFamily: 'InstrumentSans_600SemiBold', textAlign: 'right' }}
          color={rated ? 'accent' : 'inkSoft'}
        >
          {scoreWord(value)}
        </VText>
      </View>
      {/* .ir-track: 6px rail centered in the 50pt box, fill + 26px thumb.
          The extra padded wrapper stretches the touch target 6 up (the gap
          to the numeral row) / 8 down (inside the root paddingBottom) with
          negative margins keeping layout identical — the VIEW must own the
          expanded area: RNGH's iOS recognizer can't receive touches outside
          the attached view, so gesture hitSlop only expands on Android
          (codex P3). */}
      <GestureDetector gesture={gesture}>
        <View style={{ marginTop: -6, marginBottom: -8, paddingTop: 6, paddingBottom: 8 }}>
        <View
          onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Score out of 5"
          accessibilityValue={{ min: 0, max: SCORE_MAX, now: value, text: value > 0 ? value.toFixed(2) : 'Not rated' }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            const dir = e.nativeEvent.actionName === 'increment' ? 1 : -1;
            onChange(stepScore(valueRef.current, dir));
          }}
          style={{ height: trackH, justifyContent: 'center' }}
        >
          <View style={{ height: railH, borderRadius: radius.pill, backgroundColor: theme.surfaceSunk }} />
          <View
            style={{
              position: 'absolute',
              left: 0,
              width: `${pct * 100}%`,
              height: railH,
              borderRadius: radius.pill,
              backgroundColor: theme.accent,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: thumbLeft,
              width: thumb,
              height: thumb,
              borderRadius: thumb / 2,
              backgroundColor: theme.accent,
              borderWidth: 3,
              borderColor: theme.surface,
              shadowColor: '#000',
              shadowOpacity: 0.12,
              shadowRadius: 3,
              shadowOffset: { width: 0, height: 1 },
            }}
          />
        </View>
        </View>
      </GestureDetector>
    </View>
  );
}
