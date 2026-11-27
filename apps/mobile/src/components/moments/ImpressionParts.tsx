import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Image, Pressable, useWindowDimensions, View } from 'react-native';
import { countryName } from '@verre/core';
import { Gradient } from '@/components/ui/Gradient';
import { Avatar } from '@/components/ui/Avatar';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { ClampText } from '@/components/ui/ClampText';
import { usePersonPreview } from '@/components/moments/PersonPreviewSheet';
import { type WireWine } from '@/lib/api/sessions';
import { HERO_RATIO, HERO_SCRIM, usePhoneTokens } from '@/lib/layout';
import { kindLabel } from '@/lib/momentFormat';
import { radius, useTheme } from '@/theme';
import { alcoholText, bottleGrapes, bottleOrigin } from '@/lib/bottleFacts';

// The impression's read-only parts (moved verbatim from the old impression
// route, Moment Visibility step-2 plan § 4.7): a look-in's bottle page shows
// the same hero, name block and about block. The impression layer's pages
// (ImpressionPage.tsx, build 2) import them back.
const GUTTER = 20; // 02e vbody runs 20px gutters (vs the line-up's 22) — deliberate override

// ─── name blocks ───────────────────────────────────────

export function posLabel(index: number, total: number) {
  return `#${index + 1} of ${total}`;
}

// .ir-hero — full-bleed photo, scrim, caption (pos · name · maker). On top
// overscroll the image rides down with the rubber band (Simon prefers the
// detach motion over a stretchy-pinned hero); while detached its top
// corners take a soft radius so the exposed edge doesn't read razor-sharp
// (the real device corner radius has no public API — this is a token, not
// a device match). Flush full-bleed again at rest.
export function Hero({
  wine, index, total, pulled, onNameBottom,
}: {
  wine: WireWine;
  index: number;
  total: number;
  pulled: boolean;
  onNameBottom: (bottom: number) => void;
}) {
  const { height: windowH } = useWindowDimensions();
  const phone = usePhoneTokens();
  const [fullscreen, setFullscreen] = useState(false);
  const heroH = Math.round(windowH * HERO_RATIO);
  // Scrim stops scaled to the VISIBLE region (the container runs radius.xl
  // past the seam) so the darkening behind the caption is unchanged; past the
  // last stop the darkest colour continues into the underlap/notches.
  const scrimEnd = heroH / (heroH + radius.xl);
  return (
    <View
      style={{
        // The photo runs radius.xl PAST the visual seam so the content panel
        // below (rounded top corners, negative margin — see the body wrapper in
        // the photo branch) overlaps it and the photo stays visible in the
        // corner notches. The panel is what's rounded, not the photo.
        height: heroH + radius.xl,
        overflow: 'hidden',
        borderTopLeftRadius: pulled ? radius.xl : 0,
        borderTopRightRadius: pulled ? radius.xl : 0,
      }}
      onLayout={(e) => onNameBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height - 16 - radius.xl)}
    >
      <Pressable accessibilityRole="button" accessibilityLabel="Open photo fullscreen" onPress={() => setFullscreen(true)} style={{ width: '100%', height: '100%' }}>
        <Image source={{ uri: wine.imageUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
      </Pressable>
      <Gradient
        pointerEvents="none"
        colors={HERO_SCRIM}
        locations={[0, 0.45 * scrimEnd, scrimEnd]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View pointerEvents="none" style={{ position: 'absolute', left: 20, right: 20, bottom: 16 + radius.xl }}>
        <VText variant="label" style={{ fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', color: 'rgba(255,255,255,0.85)' }}>
          {posLabel(index, total)}
        </VText>
        <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('title'), color: '#fff', marginTop: 4 }}>
          {wine.name}
          {wine.vintage ? (
            <>
              {' - '}
              <VText style={{ fontFamily: 'InstrumentSans_400Regular', ...phone.text('title'), color: 'rgba(255,255,255,0.7)' }}>{wine.vintage}</VText>
            </>
          ) : null}
        </VText>
        {wine.producer || kindLabel(wine) ? (
          <VText style={{ fontFamily: 'InstrumentSans_400Regular', ...phone.text('small'), color: 'rgba(255,255,255,0.82)', marginTop: 2 }}>
            {[wine.producer, kindLabel(wine)].filter(Boolean).join(' · ')}
          </VText>
        ) : null}
      </View>
      <FullscreenImage uri={wine.imageUrl} visible={fullscreen} label={wine.name} onClose={() => setFullscreen(false)} />
    </View>
  );
}

// .ir-noimg — the no-photo norm: pos label, big dark name, maker line.
// A masked (blind) impression is only seen by a guest, or by a host on a
// blind-for-all session (the host opted into being blind too) — `hostBlind`
// picks the host's "reveal to show it" wording over the guest's wait copy.
// `revealing` = a blind-for-all host just tapped reveal (optimistic revealedAt)
// but the un-redacted wine hasn't arrived yet — show a transitional line so the
// body doesn't say "reveal to show it" while the bar already says "Hide".
export function NameBlock({
  wine, blind, hostBlind, revealing, index, total, onNameBottom,
}: {
  wine: WireWine;
  blind: boolean;
  hostBlind?: boolean;
  revealing?: boolean;
  index: number;
  total: number;
  onNameBottom: (bottom: number) => void;
}) {
  const phone = usePhoneTokens();
  return (
    <View
      style={{ paddingTop: 4, paddingHorizontal: GUTTER, paddingBottom: 8 }}
      onLayout={(e) => onNameBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
    >
      <VText variant="label" color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', marginBottom: 6 }}>
        {posLabel(index, total)}
      </VText>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('title') }}>
        {blind ? `Impression ${index + 1}` : wine.name}
        {!blind && wine.vintage ? (
          <>
            {' - '}
            <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular', ...phone.text('title') }}>{wine.vintage}</VText>
          </>
        ) : null}
      </VText>
      <VText color="inkSoft" style={{ ...phone.text('small'), marginTop: 2 }}>
        {blind
          ? revealing
            ? 'Revealing…'
            : hostBlind
              ? 'Hidden from guests. Reveal to show it.'
              : 'Revealed when the host or co-host reveals it'
          : [wine.producer, kindLabel(wine)].filter(Boolean).join(' · ')}
      </VText>
    </View>
  );
}

// ─── about ─────────────────────────────────────────────

// ClampText (line-clamped more/less) is now the shared components/ui/ClampText
// (extracted for the feed impression detail; was a pending catalog extraction).

// .ir-about — Brought-by callout + Origin · Variety · Process rows + clamped
// description + "Where to buy". Renders only the rows the wine actually carries;
// the whole block drops away when there's no metadata AND no provenance at all.
export function AboutBlock({
  wine, broughtBy, broughtBySelf, broughtByAnon, broughtByImageUrl, broughtById,
}: {
  wine: WireWine;
  broughtBy: string | null;
  broughtBySelf: boolean;
  broughtByAnon: boolean;
  broughtByImageUrl: string | null;
  // The adder's identity (`u:<publicId>`), null for a guest adder or with
  // "who brought it" hidden: a tap opens their preview (ruled 2026-11-15),
  // never for a guest look or yourself (the provider's `canOpen`).
  broughtById: string | null;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const preview = usePersonPreview();
  const canPreview = !!broughtById && !!preview?.canOpen(broughtById);
  // wine.country is an ISO 3166-1 alpha-2 code ("IT"); show the full English
  // name ("Italy"), falling back to the raw code for anything off-list —
  // mirrors the web WineInfoPane's `countryName(country) || country`.
  // Origin and variety are the catalogue wine's (ADR-0009), the bottle's own
  // copy only for an unlinked old bottle; a blind row has neither.
  const o = bottleOrigin(wine.entry, wine);
  const country = o.country ? countryName(o.country) || o.country : '';
  const origin = [o.region, country].filter(Boolean).join(' · ');
  const grapes = bottleGrapes(wine.entry, wine.grape);
  const alcohol = alcoholText(wine.abv);
  const rows: Array<[string, React.ReactNode]> = [];
  if (origin) rows.push(['Origin', <VText key="v" style={{ fontFamily: 'InstrumentSans_500Medium', ...phone.text('small') }}>{origin}</VText>]);
  if (grapes) rows.push(['Variety', <ClampText key="v" text={grapes} lines={2} medium />]);
  if (alcohol) rows.push(['Alcohol', <VText key="v" style={{ fontFamily: 'InstrumentSans_500Medium', ...phone.text('small') }}>{alcohol}</VText>]);
  if (wine.vinification) rows.push(['Process', <ClampText key="v" text={wine.vinification} lines={2} medium />]);
  if (!broughtBy && rows.length === 0 && !wine.description && !wine.purchaseUrl) return null;
  // Separator rule: a section's bottom edge draws the line between
  // sections; a row divider must never sit directly on that edge. So the
  // last row drops its divider when nothing (description / buy link)
  // follows it inside the block — otherwise the soft row line + the block
  // edge render as a double line above the score section.
  const rowsHaveTrailer = !!wine.description || !!wine.purchaseUrl;
  return (
    <View style={{ marginTop: 2, marginBottom: 4, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: theme.rule }}>
      {broughtBy ? (
        <Pressable
          disabled={!canPreview}
          onPress={() => broughtById && preview?.open(broughtById)}
          // Not previewable: no element of its own (reads as before).
          accessible={canPreview}
          accessibilityRole={canPreview ? 'button' : undefined}
          accessibilityLabel={canPreview ? `Brought by ${broughtBy}` : undefined}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 10,
            marginBottom: rows.length > 0 || wine.description || wine.purchaseUrl ? 6 : 0,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          {/* Anon adder → user glyph (never initials); a logged-in adder gets
              their profile avatar only when the server exposed it
              (meta.participants is block/tier gated in buildMetaView),
              otherwise the initials fallback — indistinguishable from the
              no-avatar/denied cases, so no block or tier state leaks. */}
          <Avatar name={broughtBy} imageUrl={broughtByImageUrl} anon={broughtByAnon} size={38} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <VText variant="label" color="inkFaint" style={{ fontFamily: 'InstrumentSans_600SemiBold', textTransform: 'uppercase', marginBottom: 2 }}>
              Brought By
            </VText>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              {/* Person-byline parity (PeopleSheet PersonRow, feed caption
                  author): registered adder = 600 semibold ink; anon = 400
                  regular inkSoft. */}
              <VText
                numberOfLines={1}
                color={broughtByAnon ? 'inkSoft' : 'ink'}
                style={{ fontFamily: broughtByAnon ? 'InstrumentSans_400Regular' : 'InstrumentSans_600SemiBold', ...phone.text('small'), flexShrink: 1 }}
              >
                {broughtBy}
              </VText>
              {/* "· You" self-marker — PeopleSheet PersonRow parity: a name-color
                  "·" then the word in inkSoft, both semibold, as flex siblings. */}
              {broughtBySelf ? (
                <>
                  <VText color={broughtByAnon ? 'inkSoft' : 'ink'} style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small') }}>·</VText>
                  <VText color="inkSoft" style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small') }}>You</VText>
                </>
              ) : null}
              {/* No "Unregistered" pill on this read-only callout (Simon
                  2026-07-20) — an anon adder still reads as anon via the glyph
                  avatar + regular-weight inkSoft name. The pill stays in the
                  edit-form bringer picker, where distinguishing registrants
                  matters for reassignment. */}
            </View>
          </View>
        </Pressable>
      ) : null}
      {rows.map(([label, value], i) => {
        const lastRow = !rowsHaveTrailer && i === rows.length - 1;
        return (
          <View
            key={label}
            style={{
              flexDirection: 'row',
              gap: 14,
              paddingVertical: 9,
              borderBottomWidth: lastRow ? 0 : 1,
              borderBottomColor: theme.ruleSoft,
            }}
          >
            <VText color="inkSoft" style={{ width: phone.lerp(72, 82), ...phone.text('small') }}>{label}</VText>
            <View style={{ flex: 1 }}>{value}</View>
          </View>
        );
      })}
      {wine.description ? (
        <View style={{ paddingTop: 12 }}>
          <ClampText text={wine.description} lines={3} />
        </View>
      ) : null}
      {wine.purchaseUrl ? (
        <Pressable
          accessibilityRole="link"
          // In-app browser (not Safari hand-off) — the user stays in the
          // tasting context; sheet dismisses back to the impression.
          onPress={() => WebBrowser.openBrowserAsync(wine.purchaseUrl!).catch(() => {})}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}
        >
          <Icon name="link" size={15} color={theme.accent} />
          <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small') }} color="accent">
            Where to Buy
          </VText>
        </Pressable>
      ) : null}
    </View>
  );
}

