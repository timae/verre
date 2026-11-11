import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { LongPressable } from '@/components/profile/ProfileEditParts';
import { VText } from '@/components/ui/VText';
import { TILE_SCRIM, TILE_SCRIM_STOPS } from '@/lib/layout';
import { radius, useTheme } from '@/theme';

// .yo-ptiles — the profile's three photo tiles (Impressions · Moments ·
// Cravings): a 3-column grid of 4:5 tiles, each a full-bleed photo under a
// bottom scrim with the count + label in white. Without a photo the tile is
// the plain fill tone with ink text (.yo-ptile-empty). ⚠️ Deviation: the mock
// outlines the empty tile with a 1px rule — dropped per the no-borders ruling
// (surfaces elevate by tone).
//
// The tiles don't open anything yet (their list pages are a later step). On
// your own profile a LONG-PRESS opens the tile's cover picker (R5g2, scale
// 0.95 while held); a tile with no photo to choose from stays inert.
export type PhotoTile = { label: string; count: string; imageUrl: string | null; onLongPress?: () => void };

export function PhotoTiles({ tiles, dimmed }: { tiles: PhotoTile[]; dimmed?: boolean }) {
  return (
    <View pointerEvents={dimmed ? 'none' : 'auto'} style={[styles.grid, dimmed ? { opacity: 0.35 } : null]}>
      {tiles.map((t) =>
        t.onLongPress ? (
          <LongPressable
            key={t.label}
            onLongPress={t.onLongPress}
            pressedScale={0.95}
            dim={false}
            accessibilityHint={`Double-tap and hold to choose the ${t.label.toLowerCase()} cover.`}
            style={{ flex: 1 }}
          >
            <Tile tile={t} />
          </LongPressable>
        ) : (
          <Tile key={t.label} tile={t} />
        ),
      )}
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
      style={[styles.tile, { backgroundColor: theme.surfaceSunk }, tile.onLongPress ? { flex: 0, width: '100%' } : null]}
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
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 8, marginTop: 4 },
  tile: { flex: 1, aspectRatio: 4 / 5, borderRadius: radius.lg, overflow: 'hidden' },
  txt: { position: 'absolute', left: 11, right: 8, bottom: 10, gap: 1 },
});
