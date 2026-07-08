import { StyleSheet, View } from 'react-native';
import { VText } from '@/components/ui/VText';
import { radius, useTheme } from '@/theme';
import type { WheelAxis } from '@/components/scoring/FlavourWheel';

// The "Tastes like" chip legend (design `.fpw-chips` / `.fpw-chip` / `.fpw-lead`):
// a lead label + one pill per top flavour (colour swatch + name). The
// un-scientific wheel description — top-N flavours as words instead of axis
// labels. Chips carry their own surface so they read on either a `surface` card
// or a `surfaceSunk` hero (the design's chips are surface-sunk on a plain card;
// on the wheel-hero, which is ITSELF surface-sunk, they need contrast, so the
// caller passes chipBg="surface"). Renders nothing when there are no flavours.
export function TastesLike({
  flavours,
  align = 'flex-start',
  chipBg = 'surface',
}: {
  flavours: WheelAxis[];
  align?: 'flex-start' | 'center';
  chipBg?: 'surface' | 'surfaceSunk';
}) {
  const { theme } = useTheme();
  if (!flavours.length) return null;
  return (
    <View style={[styles.row, { justifyContent: align }]}>
      <VText variant="caption" color="inkSoft" style={styles.lead}>
        Tastes like
      </VText>
      {flavours.map((f) => (
        <View key={f.label} style={[styles.chip, { backgroundColor: theme[chipBg] }]}>
          <View style={[styles.swatch, { backgroundColor: f.color }]} />
          <VText variant="caption" style={styles.chipText} numberOfLines={1}>
            {f.label}
          </VText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  lead: { marginRight: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    // minHeight + vertical padding (not a fixed height) so the chip grows with
    // the label at large accessibility text sizes instead of clipping it.
    minHeight: 26,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
  },
  swatch: { width: 8, height: 8, borderRadius: 999 },
  chipText: { fontFamily: 'InstrumentSans_600SemiBold' },
});
