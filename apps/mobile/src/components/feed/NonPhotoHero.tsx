import { StyleSheet, View } from 'react-native';
import { StructureWheel } from '@/components/scoring/StructureWheel';
import { FeedImpressionPanel } from '@/components/feed/FeedImpressionPanel';
import { TastesLike } from '@/components/feed/TastesLike';
import { buildWheelAxes, topFlavours } from '@/lib/flavourAxes';
import { GUTTER } from '@/lib/layout';
import { space, useTheme } from '@/theme';
import { mix } from '@/theme/color';
import type { SessionFeedWine } from '@/lib/api/feed';

// The no-photo impression hero — NO glass panel (glass reads only over real
// photos, Simon). Two shapes:
//   • has flavour → a FULL-BLEED lighter `surface` HERO, exactly the photo's
//     slot (edge-to-edge, flush under the header). The wheel + "Tastes like"
//     chips fill it, and the DARKER `surfaceSunk` themed panel rides INSIDE it
//     at the bottom — structurally identical to the glass panel riding inside a
//     photo, but themed (ink) since it's a designed surface, not a photo (Simon:
//     card lighter, panel darker; full-width "like an image"; panel inside).
//   • bare (no flavour) → JUST the panel (inset), flush under the header — no
//     hero (Simon: "no card when no tasting details, only the panel").
// A BLIND wine takes the same two shapes (its flavors/score are real + shown);
// only its IDENTITY is masked, inside the panel ("Wine N"). No mystery branch.
// Shared by the standalone card (one impression) AND each slide of an
// all-photoless session carousel. `width` = one screen wide. Optional `height`
// pins a uniform carousel-slide height; the standalone card omits it so the
// hero sizes to its content (the panel sits in the card's bottom padding).
export function NonPhotoHero({
  wine,
  index = 0,
  axisColor,
  width,
  height,
  onOpen,
}: {
  wine: SessionFeedWine;
  index?: number;
  axisColor: (k: string) => string;
  width: number;
  height?: number;
  onOpen: () => void;
}) {
  const { theme, themeKey } = useTheme();
  // Blind masks IDENTITY only — the subjective rating (score + flavour) STAYS.
  // So a blind wine flows through the SAME path as any wine: has-flavour → the
  // wheel hero, else the bare panel. Identity masking ("Wine N", no producer/
  // vintage) happens inside FeedImpressionPanel + the wheel here draws off the
  // server's real (unblanked) flavors. No special mystery-only branch.
  const tastes = topFlavours(wine.flavors, wine.type, axisColor);
  const hasFlavour = tastes.length > 0;

  // Bare: no hero, just the panel — inset by space.xs so its width MATCHES the
  // panel that rides inside the wheel hero AND the glass panel over a photo
  // (all three = W − 2·space.xs; Simon: panels always the same width). Flush
  // under the header. In a fixed-height carousel slide it bottom-aligns so it
  // sits where the hero slides' panels do.
  if (!hasFlavour) {
    return (
      <View style={[styles.bare, { width }, height != null && [{ height }, styles.bottomAlign]]}>
        <FeedImpressionPanel wine={wine} index={index} axisColor={axisColor} onPress={onOpen} />
      </View>
    );
  }

  // Full-bleed hero (photo slot, edge-to-edge, flush). Flex COLUMN — the body
  // flex-grows and centres the wheel, the panel sits below IN-FLOW (never clips
  // the chips). Panel inset space.xs to match the bare + glass panels' width.
  //
  // COLOUR (Simon, checkins with intensity + no image): a TINT card with a
  // distinct panel. Two arrangements, per theme — same visual intent, opposite
  // tokens because Apricot's `surfaceSunk` is too dark to be the card:
  //   • 5 themes (unchanged original) → card = `surfaceSunk` (darker), panel +
  //     chips = `surface` (lighter).
  //   • Apricot → card = a lighter custom blend halfway from `surface` toward
  //     `surfaceSunk` (#f6e6d3 — Apricot's `surfaceSunk` is too dark a card and
  //     its `bg` collides with the scene), panel + chips = `surfaceSunk` (the
  //     darker tone, matching the standalone bare panel).
  // Blind (non-swap) keeps the lighter `surface` card + `surfaceSunk` panel.
  const swap = hasFlavour;
  const apricot = themeKey === 'apricot';
  const heroBg = swap ? (apricot ? mix(theme.surfaceSunk, theme.surface, 0.5) : theme.surfaceSunk) : theme.surface;
  const panelSurface: 'surface' | 'surfaceSunk' = swap ? (apricot ? 'surfaceSunk' : 'surface') : 'surfaceSunk';
  const chipBg: 'surface' | 'surfaceSunk' = swap ? (apricot ? 'surfaceSunk' : 'surface') : 'surfaceSunk';
  return (
    <View style={[styles.hero, { width, backgroundColor: heroBg }, height != null && { height }]}>
      {/* The wheel + chips draw off the wine's REAL flavors — shown for blind too
          (subjective rating isn't masked). Identity masking is the panel's job. */}
      <View style={styles.heroBody}>
        <StructureWheel
          axes={buildWheelAxes(wine.flavors, wine.type, axisColor)}
          size={168}
          labels
          maxWidth={width - GUTTER * 2}
        />
        <View style={styles.chips}>
          <TastesLike flavours={tastes} align="center" chipBg={chipBg} />
        </View>
      </View>
      <View style={styles.panelInside}>
        <FeedImpressionPanel wine={wine} index={index} axisColor={axisColor} onPress={onOpen} surface={panelSurface} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Bare: panel inset by space.xs (SAME width as the in-hero + glass panels),
  // flush under the header.
  bare: { paddingHorizontal: space.xs },
  bottomAlign: { justifyContent: 'flex-end' },
  // Full-bleed hero — edge-to-edge like the photo slot, no radius, no h-inset.
  // Flex column: body grows + centres the wheel, panel sits below in-flow.
  hero: { overflow: 'hidden', flexDirection: 'column' },
  heroBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: GUTTER,
    // A little more breathing room above the wheel + before the panel (Simon).
    // No token between xl(32) and 2xl(48), so xl + xs for a modest +8.
    paddingTop: space.xl + space.xs,
    paddingBottom: space.lg,
  },
  chips: { marginTop: space.sm },
  // Panel below the body, in-flow (never overlaps the chips), inset space.xs to
  // match the bare + glass panels; a small bottom gap inside the hero.
  panelInside: { paddingHorizontal: space.xs, paddingBottom: space.xs },
});
