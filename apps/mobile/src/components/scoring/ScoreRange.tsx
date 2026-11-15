import * as Haptics from 'expo-haptics';
import { formatScore } from '@verre/core';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';
import { radius, useTheme } from '@/theme';

// The score filter's two-dot range (lists plan Q7, design `.yo-rng` 04·6d):
// 0.25 – 5 in quarter steps, both dots draggable (the nearer dot takes a drag
// or a tap), the dots can MEET but never cross. Haptics like ScoreInput (a
// selection tick per step, a light impact on release), each dot its own
// VoiceOver-adjustable element. The track + thumb metrics are ScoreInput's.
// "Any" = the full range = no filter (unscored impressions included); any
// narrower range drops the unscored ones (the server's min / max).

export const RANGE_MIN = 0.25;
export const RANGE_MAX = 5;
const THUMB = 26;
const THUMB_COMFORT = 30;
const TRACK_H = 44;
const RAIL_H = 6;
const RAIL_H_COMFORT = 7;

export const isAnyRange = (lo: number, hi: number) => lo <= RANGE_MIN && hi >= RANGE_MAX;

// "Any" / "★ 4.0" (the dots meet) / "★ 3.5 – 5.0" (en-dash range; whole
// numbers keep the house ".0", formatScore).
export function rangeLabel(lo: number, hi: number): string {
  if (isAnyRange(lo, hi)) return 'Any';
  if (lo === hi) return `★ ${formatScore(lo)}`;
  return `★ ${formatScore(lo)} – ${formatScore(hi)}`;
}

const snap = (v: number) => Math.min(RANGE_MAX, Math.max(RANGE_MIN, Math.round(v * 4) / 4));

export function ScoreRange({ lo, hi, onChange }: { lo: number; hi: number; onChange: (lo: number, hi: number) => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const surface = phone.surface('score');
  const thumb = surface.height(phone.lerp(THUMB, THUMB_COMFORT));
  const railH = surface.height(phone.lerp(RAIL_H, RAIL_H_COMFORT));
  const trackH = Math.max(TRACK_H, thumb + 12);
  const [trackW, setTrackW] = useState(0);
  const val = useRef({ lo, hi });
  val.current = { lo, hi };
  // 'tie' = the dots met under the finger: the first movement decides (left →
  // the low dot, right → the high one), or the touched side on a plain tap.
  const active = useRef<'lo' | 'hi' | 'tie'>('lo');

  const valueAt = (x: number) => snap(RANGE_MIN + ((x - thumb / 2) / Math.max(1, trackW - thumb)) * (RANGE_MAX - RANGE_MIN));
  const xOf = (v: number) => thumb / 2 + ((v - RANGE_MIN) / (RANGE_MAX - RANGE_MIN)) * Math.max(0, trackW - thumb);
  const apply = (which: 'lo' | 'hi', v: number) => {
    const cur = val.current;
    const next = which === 'lo' ? { lo: Math.min(v, cur.hi), hi: cur.hi } : { lo: cur.lo, hi: Math.max(v, cur.lo) };
    if (next.lo === cur.lo && next.hi === cur.hi) return;
    Haptics.selectionAsync().catch(() => {});
    val.current = next;
    onChange(next.lo, next.hi);
  };
  // The nearer dot, or 'tie' when they are equally near (they met).
  const pick = (x: number): 'lo' | 'hi' | 'tie' => {
    const { lo: l, hi: h } = val.current;
    const dl = Math.abs(x - xOf(l));
    const dh = Math.abs(x - xOf(h));
    if (dl === dh) return 'tie';
    return dl < dh ? 'lo' : 'hi';
  };
  const release = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-6, 6])
    .failOffsetY([-8, 8])
    .onBegin((e) => { active.current = pick(e.x); })
    .onUpdate((e) => {
      if (active.current === 'tie') {
        if (e.translationX === 0) return;
        active.current = e.translationX < 0 ? 'lo' : 'hi';
      }
      apply(active.current, valueAt(e.x));
    })
    .onEnd(() => release());
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e, success) => {
      if (!success) return;
      const near = pick(e.x);
      const which = near !== 'tie' ? near : e.x < xOf(val.current.lo) ? 'lo' : 'hi';
      apply(which, valueAt(e.x));
      release();
    });
  const gesture = Gesture.Race(pan, tap);

  const step = (which: 'lo' | 'hi', dir: 1 | -1) => apply(which, snap(val.current[which] + dir * 0.25));
  const dot = (which: 'lo' | 'hi') => {
    const v = which === 'lo' ? lo : hi;
    return (
      <View
        key={which}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={which === 'lo' ? 'Lowest score' : 'Highest score'}
        accessibilityValue={{ min: RANGE_MIN * 4, max: RANGE_MAX * 4, now: v * 4, text: formatScore(v) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => step(which, e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        style={{
          position: 'absolute',
          left: trackW ? xOf(v) - thumb / 2 : 0,
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
    );
  };
  return (
    <GestureDetector gesture={gesture}>
      <View onLayout={(e) => setTrackW(e.nativeEvent.layout.width)} style={{ height: trackH, justifyContent: 'center' }}>
        <View style={{ height: railH, borderRadius: radius.pill, backgroundColor: theme.surfaceSunk }} />
        {trackW ? (
          <View
            style={{
              position: 'absolute',
              left: xOf(lo),
              width: Math.max(0, xOf(hi) - xOf(lo)),
              height: railH,
              backgroundColor: theme.accent,
            }}
          />
        ) : null}
        {dot('lo')}
        {dot('hi')}
      </View>
    </GestureDetector>
  );
}

// The section header's value (the design's `.yo-rng-h` span).
export function ScoreRangeValue({ lo, hi }: { lo: number; hi: number }) {
  return (
    <VText variant="small" color={isAnyRange(lo, hi) ? 'inkSoft' : 'accent'} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
      {rangeLabel(lo, hi)}
    </VText>
  );
}
