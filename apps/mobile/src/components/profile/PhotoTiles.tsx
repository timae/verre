import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { LongPressable } from '@/components/profile/ProfileEditParts';
import { VText } from '@/components/ui/VText';
import { Icon } from '@/components/ui/Icon';
import { GLASS_FILL, TILE_SCRIM, TILE_SCRIM_STOPS } from '@/lib/layout';
import { radius, useTheme } from '@/theme';

// .yo-ptiles — the profile's three photo tiles (Impressions · Moments ·
// Cravings): a 3-column grid of 4:5 tiles, each a full-bleed photo under a
// bottom scrim with the count + label in white. Without a photo the tile is
// the plain fill tone with ink text (.yo-ptile-empty). ⚠️ Deviation: the mock
// outlines the empty tile with a 1px rule — dropped per the no-borders ruling
// (surfaces elevate by tone).
//
// A TAP opens the tile's list (Impressions / Moments / Cravings, the lists
// step); on your own profile a LONG-PRESS still opens the tile's cover picker
// (R5g2, scale 0.95 while held). Inert while you edit your name or bio
// (`dimmed`): dimmed, and every tile DISABLED in place (no touch, no
// VoiceOver activation), never swapped for a plain tile, which remounted it
// and reloaded its photo.
//
// Fewer than three (step 4: a tile the owner hides is absent, Q6 / Q10): the
// rest SHARE THE ROW (two → halves, one → full width) at the SAME HEIGHT as
// the three-up tile, so a lone tile is a wide banner (its photo cropped
// wider). The height comes from a hidden three-column sizer row in the flow,
// with the tiles laid over it: no measuring, no first-frame jump. None → no
// row at all.
// `editable` (Edit Profile's "Profile Tiles", ruled 2026-11-13: the tiles as
// on the profile, a pen on each, a single TAP edits): a small glass pen
// top-right, the cover / photo edit buttons' look at the tile's scale; it
// only marks the tile, the whole tile is the button.
export type PhotoTile = {
  label: string; count: string; imageUrl: string | null; onPress?: () => void; onLongPress?: () => void;
  editable?: boolean; accessibilityLabel?: string; accessibilityHint?: string;
};

export function PhotoTiles({ tiles, dimmed }: { tiles: PhotoTile[]; dimmed?: boolean }) {
  if (tiles.length === 0) return null;
  return (
    <View pointerEvents={dimmed ? 'none' : 'auto'} style={[{ marginTop: 4 }, dimmed ? { opacity: 0.35 } : null]}>
      <View style={styles.grid} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={styles.sizer} />
        <View style={styles.sizer} />
        <View style={styles.sizer} />
      </View>
      <View style={[styles.grid, StyleSheet.absoluteFill]}>
        {tiles.map((t) =>
          t.onLongPress ? (
            <LongPressable
              key={t.label}
              disabled={dimmed}
              onLongPress={t.onLongPress}
              onPress={t.onPress}
              accessibilityLabel={`${t.count} ${t.label}`}
              pressedScale={0.95}
              dim={false}
              fill
              accessibilityHint={`Double-tap and hold to choose the ${t.label.toLowerCase()} cover.`}
              style={{ flex: 1 }}
            >
              <Tile tile={t} />
            </LongPressable>
          ) : t.onPress ? (
            <Pressable
              key={t.label}
              disabled={dimmed}
              accessible={!dimmed}
              accessibilityRole="button"
              accessibilityLabel={t.accessibilityLabel ?? `${t.count} ${t.label}`}
              accessibilityHint={t.accessibilityHint}
              onPress={t.onPress}
              style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.85 : 1 })}
            >
              <Tile tile={t} />
            </Pressable>
          ) : (
            <Tile key={t.label} tile={t} />
          ),
        )}
      </View>
    </View>
  );
}

function Tile({ tile }: { tile: PhotoTile }) {
  const { theme } = useTheme();
  // A photo that fails to load falls back to the empty tile — never the dark
  // scrim over a blank fill. Keyed on the URL so a new photo gets a fresh try.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const photo = !!tile.imageUrl && tile.imageUrl !== failedUrl;
  return (
    <View
      accessible
      accessibilityLabel={`${tile.count} ${tile.label}`}
      style={[styles.tile, { backgroundColor: theme.surfaceSunk }]}
    >
      {photo ? (
        <>
          <Image
            source={{ uri: tile.imageUrl! }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
            onError={() => setFailedUrl(tile.imageUrl)}
          />
          <LinearGradient colors={TILE_SCRIM} locations={TILE_SCRIM_STOPS} style={StyleSheet.absoluteFill} />
        </>
      ) : null}
      <View style={styles.txt}>
        {/* .yo-ptile-txt b — subhead size, 600, tight tracking, tabular */}
        <VText
          variant="subhead"
          surface="badge"
          color={photo ? '#ffffff' : 'ink'}
          style={{ fontFamily: 'InstrumentSans_600SemiBold', letterSpacing: -0.36, fontVariant: ['tabular-nums'] }}
        >
          {tile.count}
        </VText>
        {/* .yo-ptile-txt span — caption, 500, 90% white */}
        <VText
          variant="caption"
          numberOfLines={1}
          color={photo ? 'rgba(255,255,255,0.9)' : 'inkSoft'}
        >
          {tile.label}
        </VText>
      </View>
      {tile.editable ? (
        <View pointerEvents="none" style={styles.pen}>
          <Icon name="edit" size={14} color="#fff" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 8 },
  // The three-up tile: 4:5. Every shown tile takes this row's height.
  sizer: { flex: 1, aspectRatio: 4 / 5 },
  tile: { flex: 1, borderRadius: radius.lg, overflow: 'hidden' },
  txt: { position: 'absolute', left: 11, right: 8, bottom: 10, gap: 1 },
  pen: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, backgroundColor: GLASS_FILL, alignItems: 'center', justifyContent: 'center' },
});
