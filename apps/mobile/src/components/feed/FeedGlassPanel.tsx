import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { StructureWheel } from '@/components/scoring/StructureWheel';
import { buildWheelAxes } from '@/lib/flavourAxes';
import { GLASS_FILL } from '@/lib/layout';
import { wineTypeLabel } from '@/lib/momentFormat';
import { radius, space, useTheme } from '@/theme';
import { formatScore } from '@verre/core';
import type { SessionFeedWine } from '@/lib/api/feed';

// The shared over-photo glass panel used by BOTH the session card (per photo,
// switches with the carousel) and the standalone card (one photo). Content:
// name · - vintage · producer·type · ★ score (no word) · mini-wheel · chevron.
// A redacted (_blind) wine masks IDENTITY only — "Wine N", no producer/vintage —
// but STILL shows the subjective rating (★ score + flavour wheel), matching the
// in-session view + what the server ships. Keyed on `_blind` alone; the client
// never re-derives the predicate (root CLAUDE.md cross-cutting rule).
// Year = smaller (small) + thinner (medium) + same colour (#fff) as the name
// (§2b). Extracted from SessionFeedCard so the two cards share one panel face.

// The panel content only. Compose it inside a Pressable via <FeedGlassPanel>
// below, or place it directly (e.g. over a non-photo hero) with its own wrap.
export function GlassPanelInner({
  wine,
  index,
  axisColor,
}: {
  wine: SessionFeedWine | undefined;
  // Position in the moment — names a blind slot ("Wine 3"). 0 for a standalone.
  index: number;
  axisColor: (k: string) => string;
}) {
  const { theme } = useTheme();
  if (!wine) return null;
  const blind = !!wine._blind;
  const typeLabel = wineTypeLabel(wine.type);
  const sub = blind ? 'Hidden until the host reveals it' : [wine.producer, typeLabel].filter(Boolean).join(' · ');
  // Blind masks IDENTITY only (name→"Wine N", no producer/vintage) — the
  // subjective rating STAYS: the score (below) AND the flavour wheel. The
  // server ships a redacted wine's flavors/score unblanked on purpose (the
  // author's own take; same as the in-session view). So the wheel is NOT gated
  // on blind — only identity fields are. (Simon, reverses an earlier over-redact.)
  const axes = buildWheelAxes(wine.flavors, wine.type, axisColor);
  return (
    <>
      <View style={styles.panelMain}>
        <VText variant="body" numberOfLines={1} style={[styles.panelName, { color: '#fff' }]}>
          {blind ? `Wine ${index + 1}` : wine.name}
          {/* year = smaller (small=13 vs the name's body=15) + thinner (medium)
              + same colour as the name. color="#fff" is REQUIRED: VText defaults
              color='ink' and re-injects its resolved colour, so a nested VText
              does NOT inherit the parent's #fff — it'd paint the year theme-ink. */}
          {!blind && wine.vintage ? (
            <VText variant="small" color="#fff" style={styles.vin}>
              {' - '}
              {wine.vintage}
            </VText>
          ) : null}
        </VText>
        {sub ? (
          <VText variant="caption" numberOfLines={1} style={styles.panelSub}>
            {sub}
          </VText>
        ) : null}
        {wine.score != null && wine.score > 0 && (
          <View style={styles.panelScore}>
            {/* accent star (matches the themed panel), white value — Simon:
                the star carries the colour, over-photo the number stays white
                for contrast on the scrim. */}
            <Icon name="starf" size={17} color={theme.accent} />
            <VText variant="subhead" style={[styles.bold, { color: '#fff' }]}>
              {formatScore(wine.score)}
            </VText>
          </View>
        )}
      </View>
      {axes.length > 0 && (
        <View style={styles.mini}>
          <StructureWheel axes={axes} size={62} labels={false} />
        </View>
      )}
      {/* disclosure chevron (design .fpg-chev = i-back rotated 180° = a
          right-pointing chevron) — signals the panel opens the detail page. */}
      <View style={styles.chev}>
        <Icon name="chevron-right" size={16} color="#fff" />
      </View>
    </>
  );
}

// The full tappable panel: a glass-filled Pressable wrapping GlassPanelInner,
// absolutely pinned to the bottom of its parent (the photo/hero). Both cards
// place this the same way (Simon: the standalone panel is identical to the
// session panel).
export function FeedGlassPanel({
  wine,
  index,
  axisColor,
  onPress,
}: {
  wine: SessionFeedWine | undefined;
  index: number;
  axisColor: (k: string) => string;
  onPress: () => void;
}) {
  return (
    <View style={styles.panelWrap} pointerEvents="box-none">
      <Pressable
        style={[styles.panel, { backgroundColor: GLASS_FILL }]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Impression details${wine?._blind || !wine?.name ? '' : `: ${wine.name}`}`}
      >
        <GlassPanelInner wine={wine} index={index} axisColor={axisColor} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bold: { fontFamily: 'InstrumentSans_600SemiBold' },
  panelWrap: { position: 'absolute', left: space.xs, right: space.xs, bottom: space.xs },
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: 14,
    borderRadius: radius.md,
  },
  panelMain: { flex: 1, minWidth: 0 },
  panelName: { fontFamily: 'InstrumentSans_600SemiBold' },
  // Same colour as the name (Simon) — the year is distinguished by weight
  // (medium vs semibold) alone, not colour. No opacity dim.
  vin: { fontFamily: 'InstrumentSans_500Medium' },
  panelSub: { color: '#fff', opacity: 0.78, marginTop: 1 },
  panelScore: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
  mini: { flexShrink: 0 },
  chev: { flexShrink: 0, opacity: 0.65 },
});
