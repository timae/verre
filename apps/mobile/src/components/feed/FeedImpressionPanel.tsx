import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { FlavourWheel } from '@/components/scoring/FlavourWheel';
import { buildWheelAxes } from '@/lib/flavourAxes';
import { wineTypeLabel } from '@/lib/momentFormat';
import { radius, space, useTheme } from '@/theme';
import { formatScore } from '@verre/core';
import type { SessionFeedWine } from '@/lib/api/feed';

// The THEMED (non-glass) impression panel — the info face for a check-in with
// NO photo. Same content as the over-photo glass panel (name · - vintage ·
// producer·type · ★ score · mini-wheel · chevron) but rendered as a themed
// card with INK text, so it integrates into the colour theme instead of
// floating a dark glass pill over a light backdrop (Simon: glass only reads
// over real imagery; on a non-photo hero it looked weird + overlapped). It is
// the DARKER surface (`surfaceSunk`) — Simon's inversion: the card/stage above
// (the wheel) is the lighter `surface`, the panel below is the darker one.
// Used by the standalone non-photo hero AND each slide of an all-photoless
// session carousel. In-flow (not an absolute overlay) so it never overlaps.
// A blind wine CAN reach here (an all-photoless blind moment): it masks IDENTITY
// only — name→"Wine N", no producer/vintage — but KEEPS the subjective rating
// (score + flavour wheel), matching the glass panel + the in-session view. The
// server ships a redacted wine's flavors/score unblanked on purpose.
export function FeedImpressionPanel({
  wine,
  index = 0,
  axisColor,
  onPress,
  surface = 'surfaceSunk',
}: {
  wine: SessionFeedWine;
  // Position in the moment — names a blind slot ("Wine N"). 0 for a standalone.
  index?: number;
  axisColor: (k: string) => string;
  onPress: () => void;
  // Which theme surface the panel sits on. Default `surfaceSunk` (the darker of
  // the two — the panel is the darker element in the standard layout). The
  // wheel-hero colour-swap experiment passes `surface` so the panel is lighter
  // than its (then darker) hero.
  surface?: 'surface' | 'surfaceSunk';
}) {
  const { theme } = useTheme();
  const blind = !!wine._blind;
  const name = blind ? `Wine ${index + 1}` : wine.name;
  // Producer/type sub is identity → hidden on blind; the wheel + score below are
  // the subjective rating → always shown.
  const sub = blind ? 'Hidden until the host reveals it' : [wine.producer, wineTypeLabel(wine.type)].filter(Boolean).join(' · ');
  const axes = buildWheelAxes(wine.flavors, wine.type, axisColor);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Impression details${blind ? '' : name ? `: ${name}` : ''}`}
      style={[styles.panel, { backgroundColor: theme[surface] }]}
    >
      <View style={styles.main}>
        <VText variant="body" numberOfLines={1} style={styles.bold}>
          {name}
          {/* year = same colour as the name, one weight lighter + one size
              smaller (§2b) — same styling as the glass panel, just ink not #fff.
              Vintage is identity → hidden on blind. */}
          {!blind && wine.vintage ? (
            <VText variant="small" style={styles.vin}>
              {' - '}
              {wine.vintage}
            </VText>
          ) : null}
        </VText>
        {sub ? (
          <VText variant="caption" color="inkSoft" numberOfLines={1}>
            {sub}
          </VText>
        ) : null}
        {wine.score != null && wine.score > 0 && (
          <View style={styles.score}>
            <Icon name="starf" size={17} color={theme.accent} />
            <VText variant="subhead" style={styles.bold}>
              {formatScore(wine.score)}
            </VText>
          </View>
        )}
      </View>
      {axes.length > 0 && (
        <View style={styles.mini}>
          <FlavourWheel axes={axes} size={56} labels={false} />
        </View>
      )}
      <Icon name="chevron-right" size={16} color={theme.inkSoft} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: 14,
    borderRadius: radius.md,
  },
  main: { flex: 1, minWidth: 0 },
  bold: { fontFamily: 'InstrumentSans_600SemiBold' },
  vin: { fontFamily: 'InstrumentSans_500Medium' },
  score: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
  mini: { flexShrink: 0 },
});
