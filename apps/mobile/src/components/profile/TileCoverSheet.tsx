import { BottomSheetFooter, BottomSheetScrollView, type BottomSheetFooterProps } from '@gorhom/bottom-sheet';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { VText } from '@/components/ui/VText';
import { getTilePhotos, type TileKey } from '@/lib/api/profile';
import { radius, useTheme } from '@/theme';

const GAP = 8;
const LABEL: Record<TileKey, string> = { impressions: 'Impressions', moments: 'Moments', cravings: 'Cravings' };

// 04·R5g2 — "Cover for <Tile>": pick a tile's cover from that tile's own
// photos (the server's pickable pool: yours, never an unrevealed blind wine;
// the latest 60, the current pin first). Fixed snap + the sheet's own scroll
// view, Cancel | Use Photo pinned by gorhom's footer (apps/mobile/CLAUDE.md
// Sheet notes). Pre-selected = the photo the tile shows when it is in the
// pool; Use Photo is live when the selection is not the current pin (so an
// automatic photo can be pinned, and an unchanged pin is never re-written).
// Selected = the 3pt accent ring + check badge (a selection state, not a card
// border — flagged in the plan). No "back to latest" control (not in the
// design; the server accepts null for it).
export function TileCoverSheet({
  tile, shown, onClose, onUse,
}: {
  tile: TileKey | null;
  // The image the tile shows now (the pre-selection when it is in the pool).
  shown: string | null;
  onClose: () => void;
  // Resolves when saved; throws to keep the sheet open (the caller alerts).
  onUse: (tile: TileKey, url: string) => Promise<void>;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  // Hold the last tile through the close animation (the title mustn't blank).
  const [held, setHeld] = useState<TileKey | null>(tile);
  useEffect(() => {
    if (tile) setHeld(tile);
  }, [tile]);
  // The OPEN tile keys the pool (the held one only covers the close).
  const active = tile ?? held;
  const photos = useQuery({
    queryKey: ['profile-photos', active],
    queryFn: () => getTilePhotos(active!),
    enabled: tile != null,
    staleTime: 0,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [gridW, setGridW] = useState(0);
  const [saving, setSaving] = useState(false);
  // Only THIS opening's fetch counts: a cached pool from an earlier opening
  // can still list a photo that was re-hidden since (Codex). `openedAt` is 0
  // until the opening is stamped, so a cached result never reads as fresh.
  const [openedAt, setOpenedAt] = useState(0);
  useEffect(() => {
    setOpenedAt(tile ? Date.now() : 0);
  }, [tile]);
  const fresh = tile != null && openedAt > 0 && photos.data != null && photos.dataUpdatedAt >= openedAt && !photos.isFetching;
  const pool = fresh ? photos.data!.photos : null;
  // Seed the selection ONCE per opening, from the fresh pool: the shown photo
  // when it is offered, else nothing (a pick made meanwhile is kept).
  const seededFor = useRef<TileKey | null>(null);
  useEffect(() => {
    if (!tile) {
      seededFor.current = null;
      setSelected(null);
      return;
    }
    if (seededFor.current === tile || !pool) return;
    seededFor.current = tile;
    setSelected((cur) => cur ?? (shown && pool.includes(shown) ? shown : null));
  }, [tile, pool, shown]);

  const pin = fresh ? photos.data!.pin : null;
  // Live only for a photo the FRESH pool offers that isn't already the pin.
  const canUse = pool != null && selected != null && pool.includes(selected) && selected !== pin && !saving;
  const use = useCallback(async () => {
    if (!tile || !selected) return;
    setSaving(true);
    try {
      await onUse(tile, selected);
    } catch {
      // The caller alerted; the sheet stays open with the selection.
    } finally {
      setSaving(false);
    }
  }, [tile, selected, onUse]);

  const renderFooter = useCallback(
    (props: BottomSheetFooterProps) => (
      <BottomSheetFooter {...props}>
        <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingTop: 10, paddingBottom: insets.bottom + 12, backgroundColor: theme.surface }}>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={saving} style={{ flex: 1 }} />
          <Button title="Use Photo" variant="primary" onPress={use} disabled={!canUse} loading={saving} style={{ flex: 1 }} />
        </View>
      </BottomSheetFooter>
    ),
    [insets.bottom, theme.surface, onClose, use, canUse, saving],
  );

  const label = active ? LABEL[active] : '';
  return (
    <Sheet open={tile != null} onClose={onClose} snapPoints={['62%']} enableDynamicSizing={false} footerComponent={renderFooter}>
      {/* Plain View, never BottomSheetView, around the scrollable (the
          sheet-scroll invariant, apps/mobile/CLAUDE.md). */}
      <View style={{ flex: 1 }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, gap: 6, paddingBottom: 14 }}>
          <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{`Cover for ${label}`}</VText>
          <VText variant="small" color="inkSoft">{`Pick a photo from your ${label.toLowerCase()}.`}</VText>
        </View>
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 96 }} showsVerticalScrollIndicator={false}>
          {photos.isError ? (
            <VText variant="small" color="inkSoft" style={{ paddingVertical: 16 }}>Couldn’t load your photos. Check your connection and try again.</VText>
          ) : !photos.data ? (
            <ActivityIndicator color={theme.inkSoft} style={{ paddingVertical: 24 }} />
          ) : photos.data.photos.length === 0 ? (
            <VText variant="small" color="inkSoft" style={{ paddingVertical: 16 }}>No photos to choose from yet.</VText>
          ) : (
            <View onLayout={(e) => setGridW(e.nativeEvent.layout.width)} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GAP }}>
              {gridW > 0
                ? photos.data.photos.map((url) => (
                    <Cell key={url} url={url} width={(gridW - 2 * GAP) / 3} on={url === selected} onPress={() => setSelected(url)} />
                  ))
                : null}
            </View>
          )}
        </BottomSheetScrollView>
      </View>
    </Sheet>
  );
}

// .yo-tpimg — a 4:5 photo, radius md; selected = inset 3pt accent ring + the
// check badge (20pt accent disc, white check, 6pt in from the top-right).
function Cell({ url, width, on, onPress }: { url: string; width: number; on: boolean; onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel="Photo"
      onPress={onPress}
      style={{ width, aspectRatio: 4 / 5, borderRadius: radius.md, overflow: 'hidden', backgroundColor: theme.surfaceSunk }}
    >
      <Image source={{ uri: url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} />
      {on ? (
        <>
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radius.md, borderWidth: 3, borderColor: theme.accent }} />
          <View pointerEvents="none" style={{ position: 'absolute', top: 6, right: 6, width: 20, height: 20, borderRadius: 10, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="check" size={14} color={theme.accentInk} />
          </View>
        </>
      ) : null}
    </Pressable>
  );
}
