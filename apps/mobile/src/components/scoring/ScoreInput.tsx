import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Path } from 'react-native-svg';
import { STAR_PATH, SCORE_MAX, scoreFromFraction, snapScore, stepScore } from '@verre/core';
import { scoreWord } from '@/lib/scoreWords';
import { VText } from '@/components/ui/VText';
import { radius, useTheme } from '@/theme';

// 02e overall-score input — the decided "wide slider + editable number"
// (.ir-rate pixel spec): 26px accent star + 40/600 editable number +
// score word right, 30px track with 6px rail, accent fill, 26px thumb.
//
// Input behavior is native-first (Simon's ruling): gesture-handler's
// activeOffsetX/failOffsetY lets the OS arbitrate drag-vs-scroll against
// the surrounding ScrollView (what the web mimics with its 6px SLOP
// dance), the number field is a native decimal-pad TextInput, and
// VoiceOver adjusts via accessibility increment/decrement. Only the
// value policy (0.25 snap, 0 = not rated) comes from @verre/core.

const THUMB = 26;
const TRACK_H = 30;
const RAIL_H = 6;

interface Props {
  value: number; // 0..5 in 0.25 steps; 0 = not rated
  onChange: (v: number) => void;
}

export function ScoreInput({ value, onChange }: Props) {
  const { theme } = useTheme();
  const [trackW, setTrackW] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<TextInput>(null);
  const skipCommitRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const setFromX = (x: number) => {
    if (trackW <= THUMB) return;
    if (editingRef.current) {
      // A slider touch while the number field is open abandons the draft —
      // otherwise the field's eventual blur would commit the stale draft
      // over the drag.
      skipCommitRef.current = true;
      setEditing(false);
      inputRef.current?.blur();
    }
    // Range-input semantics: the thumb travels within [THUMB/2, W - THUMB/2].
    const next = scoreFromFraction((x - THUMB / 2) / (trackW - THUMB));
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
    const parsed = Number.parseFloat(draft.replace(',', '.'));
    if (!Number.isFinite(parsed)) return;
    const next = snapScore(parsed);
    if (next !== value) {
      onChange(next);
      commitHaptic();
    }
  };

  const rated = value > 0;
  const pct = Math.min(SCORE_MAX, Math.max(0, value)) / SCORE_MAX;
  const thumbLeft = trackW > THUMB ? pct * (trackW - THUMB) : 0;

  return (
    // .ir-rate: padding 8 0 18, border-bottom rule. Inner column gap 6.
    <View style={{ paddingTop: 8, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: theme.rule, gap: 6 }}>
      {/* .rate-m-head */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        {/* .rate-m-numbox: 26px accent star + editable number */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Svg width={26} height={26} viewBox="0 0 24 24">
            <Path d={STAR_PATH} fill={theme.accent} />
          </Svg>
          <TextInput
            ref={inputRef}
            value={editing ? draft : value.toFixed(2)}
            onFocus={() => {
              skipCommitRef.current = false;
              setDraft(value.toFixed(2));
              setEditing(true);
            }}
            onChangeText={setDraft}
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
              width: 92,
              fontFamily: 'InstrumentSans_600SemiBold',
              fontSize: 40,
              letterSpacing: -1.2,
              fontVariant: ['tabular-nums'],
              color: editing ? theme.accent : theme.ink,
              backgroundColor: editing ? theme.surfaceSunk : 'transparent',
              borderRadius: radius.sm,
              paddingVertical: 2,
              paddingHorizontal: 4,
            }}
          />
        </View>
        {/* .rateword: 18/600, accent when rated, ink-soft at 0 */}
        <VText
          numberOfLines={1}
          style={{ flexShrink: 1, fontFamily: 'InstrumentSans_600SemiBold', fontSize: 18, lineHeight: 23, letterSpacing: -0.27, textAlign: 'right' }}
          color={rated ? 'accent' : 'inkSoft'}
        >
          {scoreWord(value)}
        </VText>
      </View>
      {/* .ir-track: 30px hit area, 6px rail centered, fill + 26px thumb */}
      <GestureDetector gesture={gesture}>
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
          style={{ height: TRACK_H, justifyContent: 'center' }}
        >
          <View style={{ height: RAIL_H, borderRadius: radius.pill, backgroundColor: theme.surfaceSunk }} />
          <View
            style={{
              position: 'absolute',
              left: 0,
              width: `${pct * 100}%`,
              height: RAIL_H,
              borderRadius: radius.pill,
              backgroundColor: theme.accent,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: thumbLeft,
              width: THUMB,
              height: THUMB,
              borderRadius: THUMB / 2,
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
      </GestureDetector>
    </View>
  );
}
