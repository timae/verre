import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { fillFlavourZeros, gateAromaSelections, type AromaSelection } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { RatingSection } from '@/components/scoring/RatingSection';
import { useAromaSearchScroll } from '@/components/scoring/aroma/useAromaSearchScroll';
import {
  feedQueryOptions, findFeedItem, patchCheckin, patchSessionRating, FEED_KEY,
  type CheckinPayload, type FeedItem, type FeedPage, type SessionFeedWine,
} from '@/lib/api/feed';
import { clearCheckinEditMeta, getCheckinEditMeta, setCheckinEditMeta } from '@/lib/checkinEdit';
import { FOOT_CLEARANCE, GUTTER } from '@/lib/layout';
import { wineTypeLabel } from '@/lib/momentFormat';
import { type WineTypeCode } from '@/lib/api/sessions';
import { radius, useTheme } from '@/theme';

// Edit a feed post (Simon, 2026-07-17). Reached from the card / detail ⋯
// menus, owner-only. Two variants over ONE screen:
//   - SESSION check-in (`?wine=<wineId>`): edit the RATING of that impression
//     (score · note · structure · aromas) — the wine identity belongs to the
//     moment, so nothing else is editable here.
//   - STANDALONE: the same rating block, topped by the impression SQUARE — a
//     tappable card (photo · name · producer) that pushes ./details for the
//     wine-metadata edit; the square re-reads the shared edit store on focus.
// Save PATCHes /api/checkins/:id (partial semantics; aromas present-replaces)
// and maps the response into the ['feed'] cache IN PLACE (the like-flow
// pattern — never invalidate, that resets the infinite query). An edit that
// EMPTIES a session rating reaps it server-side; if the post itself is gone
// (`feedItemDeleted`) the feed refetches in place instead.

export default function EditFeedPost() {
  const { theme } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { id, wine: wineParam } = useLocalSearchParams<{ id: string; wine?: string }>();
  const feedItemId = Number(id);

  // Same cache-read + pin discipline as the detail screen: the poll can drop
  // a page-boundary item mid-edit; once seen, keep editing the pinned copy.
  const feed = useInfiniteQuery({ ...feedQueryOptions(), refetchOnMount: false });
  const found = Number.isFinite(feedItemId) ? findFeedItem(feed.data?.pages, feedItemId) : null;
  const pinnedRef = useRef<FeedItem | null>(null);
  if (found) pinnedRef.current = found;
  const item = found ?? pinnedRef.current;

  const isSession = item?.type === 'session';
  const wine: SessionFeedWine | CheckinPayload | null = item
    ? item.type === 'session'
      ? item.session.wines.find((w) => w.id === wineParam) ?? null
      : item.checkin
    : null;
  const style = wine?.type ?? null;
  const wineName = item?.type === 'session'
    ? (wine as SessionFeedWine | null)?._blind
      ? 'Hidden impression'
      : (wine as SessionFeedWine | null)?.name ?? ''
    : (wine as CheckinPayload | null)?.wineName ?? '';

  const [score, setScore] = useState(0);
  const [notes, setNotes] = useState('');
  const [flavors, setFlavors] = useState<Record<string, number>>({});
  const [aromas, setAromas] = useState<AromaSelection[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed ONCE from the cached payload (the impression screen's pattern) — the
  // feed cache IS the archive truth for these fields. Aromas re-canonicalize
  // through the core gate on seed.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !wine) return;
    seededRef.current = true;
    setScore(wine.score ?? 0);
    setNotes(wine.notes ?? '');
    setFlavors((wine.flavors as Record<string, number>) ?? {});
    setAromas(gateAromaSelections(wine.aromas).value ?? []);
    if (item?.type === 'checkin') {
      const c = item.checkin;
      setCheckinEditMeta({
        feedItemId,
        name: c.wineName,
        vintage: c.vintage ?? '',
        producer: c.producer ?? '',
        type: (c.type as WineTypeCode | null) ?? null,
        grape: c.grape ?? '',
        wineRegion: c.wineRegion ?? '',
        wineCountry: c.wineCountry ?? '',
        vinification: c.vinification ?? '',
        description: c.description ?? '',
        purchaseUrl: c.purchaseUrl ?? '',
        venue: c.venueName ?? '',
        city: c.city ?? '',
        photo: undefined,
        existingImageUrl: c.imageUrl,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wine]);
  // The store is edit-session-scoped: clear on unmount so a later create/edit
  // can't inherit it.
  useEffect(() => () => clearCheckinEditMeta(), []);

  // Re-read the shared meta store when the details sub-screen pops back.
  const [metaTick, setMetaTick] = useState(0);
  useFocusEffect(useCallback(() => { setMetaTick((t) => t + 1); }, []));
  const meta = getCheckinEditMeta();
  void metaTick;

  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);
  const scrollAromaSearchTo = useAromaSearchScroll(scrollRef, scrollYRef, insets.bottom + FOOT_CLEARANCE);

  const onSave = async () => {
    if (!item || saving) return;
    setError(null);
    setSaving(true);
    try {
      if (item.type === 'session') {
        const w = wine as SessionFeedWine;
        const res = await patchSessionRating(feedItemId, {
          wineId: w.id,
          score,
          flavors: fillFlavourZeros(flavors, 'wine', style),
          aromas,
          notes,
        });
        if (res.feedItemDeleted || res.reaped) {
          // The rating (and possibly the post) is gone — in-place refetch is
          // the honest update (create-flow pattern; never invalidate).
          queryClient.refetchQueries({ queryKey: FEED_KEY });
        } else {
          applyToFeedCache((it) => {
            if (it.type !== 'session' || it.session.id !== feedItemId) return it;
            return {
              ...it,
              session: {
                ...it.session,
                wines: it.session.wines.map((sw) =>
                  sw.id === w.id
                    ? { ...sw, score: res.score, flavors: res.flavors, aromas: res.aromas, notes: res.notes }
                    : sw,
                ),
              },
            };
          });
        }
      } else {
        const m = meta;
        if (!m) throw new Error('nothing to save');
        const res = await patchCheckin(feedItemId, {
          wineName: m.name.trim() || undefined,
          producer: m.producer,
          vintage: m.vintage,
          grape: m.grape,
          type: m.type ?? undefined,
          wineRegion: m.wineRegion,
          wineCountry: m.wineCountry,
          vinification: m.vinification,
          description: m.description,
          purchaseUrl: m.purchaseUrl,
          venueName: m.venue,
          city: m.city,
          score,
          flavors: fillFlavourZeros(flavors, 'wine', m.type),
          aromas,
          notes,
          ...(m.photo !== undefined ? { imageData: m.photo === null ? null : m.photo.dataUrl } : {}),
        });
        applyToFeedCache((it) => {
          if (it.type !== 'checkin' || it.checkin.id !== feedItemId) return it;
          return {
            ...it,
            checkin: {
              ...it.checkin,
              wineName: res.wineName,
              producer: res.producer,
              vintage: res.vintage,
              grape: res.grape,
              type: res.type,
              wineRegion: res.wineRegion,
              wineCountry: res.wineCountry,
              vinification: res.vinification,
              description: res.description,
              purchaseUrl: res.purchaseUrl,
              score: res.score,
              flavors: res.flavors,
              aromas: res.aromas,
              notes: res.notes,
              imageUrl: res.imageUrl,
              venueName: res.venueName,
              city: res.city,
              country: res.country,
            },
          };
        });
      }
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const applyToFeedCache = (map: (item: FeedItem) => FeedItem) => {
    queryClient.setQueryData<InfiniteData<FeedPage>>(FEED_KEY, (data) =>
      data
        ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map(map) })) }
        : data,
    );
  };

  if (!item || !wine) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 8, paddingHorizontal: GUTTER }}>
        <VBar title="Edit" />
        <VText variant="small" color="inkSoft" style={{ marginTop: 24 }}>
          This post isn’t available to edit.
        </VText>
      </View>
    );
  }

  const previewUri = meta?.photo === null ? null : meta?.photo?.previewUri ?? meta?.existingImageUrl ?? null;

  return (
    <BottomSheetModalProvider>
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <Stack.Screen options={{ gestureResponseDistance: { start: 15 } }} />
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={isSession ? `Edit: ${wineName}` : 'Edit Check-In'} />
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: insets.bottom + FOOT_CLEARANCE }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
        onScroll={(e) => { scrollYRef.current = e.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
      >
        {isSession ? (
          // The moment's identity line — context, not editable from here.
          <VText variant="small" color="inkSoft" style={{ marginBottom: 6 }}>
            {[(wine as SessionFeedWine).producer, wineTypeLabel(wine.type)].filter(Boolean).join(' · ') || 'Your rating in this moment'}
          </VText>
        ) : meta ? (
          // The impression SQUARE (Simon's spec): tap to edit the wine itself;
          // the rating block sits below.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit Impression Details"
            onPress={() => router.push(`/feed/edit/details`)}
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'center', gap: 12,
              padding: 10, marginBottom: 16, borderRadius: radius.md,
              backgroundColor: pressed ? theme.surfaceSunk : theme.surface,
            })}
          >
            {previewUri ? (
              <Image source={{ uri: previewUri }} alt="" style={{ width: 56, height: 56, borderRadius: radius.sm }} resizeMode="cover" />
            ) : (
              <View style={{ width: 56, height: 56, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="cam" size={20} color={theme.inkFaint} />
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <VText numberOfLines={1} variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                {meta.name || 'Untitled'}
              </VText>
              <VText numberOfLines={1} variant="small" color="inkSoft" style={{ marginTop: 1 }}>
                {[meta.producer, meta.vintage, wineTypeLabel(meta.type)].filter(Boolean).join(' · ') || 'Tap to edit the impression'}
              </VText>
            </View>
            <VText variant="small" color="accent" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>Edit ›</VText>
          </Pressable>
        ) : null}

        <RatingSection
          style={isSession ? style : meta?.type ?? null}
          score={score}
          onScore={setScore}
          notes={notes}
          onNotes={setNotes}
          flavors={flavors}
          onFlavors={setFlavors}
          aromas={aromas}
          onAromas={setAromas}
          onRequestAromaScroll={scrollAromaSearchTo}
        />
      </ScrollView>

      {/* Sticky Save — the create-flow bar anatomy. */}
      <View
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          paddingTop: 14, paddingHorizontal: 16, paddingBottom: insets.bottom + 16,
          backgroundColor: theme.bg,
        }}
      >
        {error ? (
          <VText variant="small" style={{ marginBottom: 10, color: theme.critical }}>{error}</VText>
        ) : null}
        <Button title="Save" loadingTitle="Saving…" loading={saving} onPress={onSave} bar block />
      </View>
    </View>
    </BottomSheetModalProvider>
  );
}
