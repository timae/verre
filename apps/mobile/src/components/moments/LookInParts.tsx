import { BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Linking, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DescriptionBlock } from '@/components/moments/LineupParts';
import { JoinCodeForm } from '@/components/moments/JoinCodeForm';
import { PersonPreviewBridge, usePersonPreview } from '@/components/moments/PersonPreviewSheet';
import { StarScore } from '@/components/scoring/StarScore';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { Thumb } from '@/components/ui/Thumb';
import { VText } from '@/components/ui/VText';
import type { LookIn, LookInBottle, LookInPerson } from '@/lib/api/moments';
import { usePhoneTokens } from '@/lib/layout';
import { lookInPersonId } from '@/lib/lookInCompare';
import { footFaces } from '@/lib/lookInView';
import { sessionWhen } from '@/lib/momentFormat';
import { radius, useTheme } from '@/theme';

// The look-in's own pieces (Moment Visibility step-2 plan § 4.4, § 4.7). The
// look is the moment screen's (components/moments/LineupParts.tsx); where a
// piece there is tangled with host state (in-place edit, reveal, drag), this is
// a SMALL COPY of its read-only half, named here:
//   - LookInRow    ← LuRow (no reveal controls, no drag; the right side is the
//                    average ★ and "N ratings" instead of your own score)
//   - LookInAbout  ← OvcAbout's read-only path (address + Map, the date line,
//                    Event Link, the description through the shared
//                    DescriptionBlock), with LookInFoot under it
//   - LookInFoot   ← AvatarFoot ("+N" counts the named beyond three AND the
//                    people not shown; "Hosted by" only when the host is named)

// .lurow, read-only: the true line-up number, the thumb (a blind row: the
// mystery placeholder), name / year / producer, and the average.
export function LookInRow({ bottle, index, onPress }: { bottle: LookInBottle; index: number; onPress: () => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const compact = phone.surface('compactList');
  const thumbSize = phone.size('recentThumb');
  const blind = bottle.blind === true;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${blind ? `Impression ${index + 1}` : bottle.name}${bottle.avg !== null ? `, average ${bottle.avg}, ${bottle.count} ${bottle.count === 1 ? 'rating' : 'ratings'}` : ''}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: phone.lerp(12, 16),
        paddingVertical: compact.paddingY(phone.lerp(12, 16)),
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <VText
        surface="badge"
        color="inkFaint"
        style={{ width: phone.lerp(18, 22), textAlign: 'center', fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('small'), fontVariant: ['tabular-nums'] }}
      >
        {index + 1}
      </VText>
      {blind ? (
        <View
          style={{
            width: thumbSize, height: thumbSize, borderRadius: radius.sm, backgroundColor: theme.surfaceSunk,
            borderWidth: 1, borderStyle: 'dashed', borderColor: theme.rule,
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Icon name="eyeoff" size={phone.size('pushChevron')} color={theme.inkFaint} />
        </View>
      ) : (
        <Thumb uri={bottle.imageUrl ?? undefined} size={thumbSize} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        {blind ? (
          <>
            <VText surface="compactList" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}>
              Impression {index + 1}
            </VText>
            <VText surface="compactList" color="inkSoft" style={{ ...phone.text('small'), marginTop: 1 }}>
              Hidden until the host reveals it
            </VText>
          </>
        ) : (
          <>
            <VText surface="compactList" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('body') }}>
              {bottle.name}
              {bottle.vintage ? (
                <>
                  {' - '}
                  <VText surface="compactList" color="inkSoft" style={{ fontFamily: 'InstrumentSans_400Regular', ...phone.text('body') }}>{bottle.vintage}</VText>
                </>
              ) : null}
            </VText>
            {bottle.producer ? (
              <VText surface="compactList" color="inkSoft" numberOfLines={1} style={{ ...phone.text('small'), marginTop: 1 }}>{bottle.producer}</VText>
            ) : null}
          </>
        )}
      </View>
      {bottle.avg !== null && bottle.count > 0 ? (
        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <StarScore value={bottle.avg} size={18} />
          <VText surface="compactList" variant="caption" color="inkSoft">
            {`${bottle.count} ${bottle.count === 1 ? 'rating' : 'ratings'}`}
          </VText>
        </View>
      ) : null}
    </Pressable>
  );
}

// .ovc, read-only: only the lines the look-in sent (Show Address, Show
// Description and Event Link), then the people foot and "Join with Code" (R6).
export function LookInAbout({ look, onPeople, onJoin }: { look: LookIn; onPeople: () => void; onJoin: () => void }) {
  const { theme } = useTheme();
  const [descOpen, setDescOpen] = useState(false);
  const [clampLen, setClampLen] = useState<number | null>(null);
  const m = look.moment;
  const address = m.address || null;
  const link = m.link || null;
  const description = m.description || null;
  const when = sessionWhen(m.dateFrom, m.dateTo);
  // OvcAbout's word-boundary truncation, the same rule.
  let truncated: string | null = null;
  if (clampLen !== null && description) {
    let txt = description.slice(0, clampLen).replace(/\s+$/, '');
    let cut = txt.lastIndexOf(' ');
    while (cut > 0 && txt.length - cut < 9) cut = txt.lastIndexOf(' ', cut - 1);
    if (cut > 0) txt = txt.slice(0, cut);
    truncated = txt.replace(/[\s,.;:]+$/, '') + ' …';
  }
  const footOnly = address == null && !when && link == null && description == null;
  const row = { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 } as const;
  return (
    <View style={{ paddingTop: 12, paddingBottom: 14, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: theme.rule }}>
      {address ? (
        <Pressable onPress={() => Linking.openURL(`https://maps.apple.com/?q=${encodeURIComponent(address)}`).catch(() => {})} style={row}>
          <Icon name="pin" size={16} color={theme.inkSoft} />
          <VText variant="small" numberOfLines={1} style={{ flexShrink: 1 }}>{address}</VText>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 6, marginTop: 2, paddingVertical: 3, paddingHorizontal: 9, borderRadius: radius.pill, backgroundColor: theme.accentTint }}>
            <Icon name="pin" size={11} color={theme.accent} />
            <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 12, lineHeight: 14 }} color="accent">Map</VText>
          </View>
        </Pressable>
      ) : null}
      {when ? (
        <View style={row}>
          <Icon name="clock" size={16} color={theme.inkSoft} />
          <VText variant="small">{when}</VText>
        </View>
      ) : null}
      {link ? (
        <Pressable onPress={() => WebBrowser.openBrowserAsync(link).catch(() => {})} style={row}>
          <Icon name="link" size={16} color={theme.inkSoft} />
          <VText variant="small" color="accent">Event Link</VText>
        </Pressable>
      ) : null}
      {description ? (
        <DescriptionBlock
          text={description}
          descOpen={descOpen}
          truncated={truncated}
          onToggle={truncated === null && !descOpen ? undefined : () => setDescOpen((o) => !o)}
          onLines={setClampLen}
        />
      ) : null}
      <LookInFoot look={look} onPress={onPeople} first={footOnly} />
      <Pressable
        accessibilityRole="button"
        onPress={onJoin}
        hitSlop={{ top: 6, bottom: 6 }}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, opacity: pressed ? 0.6 : 1 })}
      >
        <Icon name="qr" size={16} color={theme.inkSoft} />
        <VText variant="small" color="inkSoft">Join with Code</VText>
      </Pressable>
    </View>
  );
}

// .ovc-foot: up to three named faces (the host first when named), "+N" for the
// rest (named or not), "Hosted by <name>" only when the host is named to you.
export function LookInFoot({ look, onPress, first }: { look: LookIn; onPress: () => void; first?: boolean }) {
  const { theme } = useTheme();
  const { faces, extra } = footFaces(look);
  const host = look.moment.host;
  if (faces.length === 0 && extra === 0 && !host) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="View people"
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: first ? 0 : 14, opacity: pressed ? 0.6 : 1 })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {faces.map((p, i) => (
          <View key={p.key} style={{ marginLeft: i === 0 ? 0 : -8 }}>
            <Avatar imageUrl={p.imageUrl} name={p.name} size={30} ring host={!!host && p.key === host.id} anon={!!p.guest} initialsSize={12} />
          </View>
        ))}
        {extra > 0 ? (
          <View
            style={{
              width: 30, height: 30, borderRadius: 15, marginLeft: faces.length ? -8 : 0,
              borderWidth: 2, borderColor: theme.bg, backgroundColor: theme.accentTint,
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} color="accent">+{extra}</VText>
          </View>
        ) : null}
      </View>
      {host ? (
        <VText variant="small" color="inkSoft" style={{ flexShrink: 1 }} numberOfLines={1}>
          Hosted by <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{host.name}</VText>
        </VText>
      ) : null}
    </Pressable>
  );
}

// The people sheet: the named people (a registered one opens the person
// preview; guests are inert), and who isn't shown, as a count.
export function LookInPeopleSheet({ open, onClose, look }: { open: boolean; onClose: () => void; look: LookIn }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const insets = useSafeAreaInsets();
  const { height: windowH } = useWindowDimensions();
  // Read here, bridged into the sheet's content (gorhom portals it outside the provider).
  const preview = usePersonPreview();
  const named = look.people.named;
  const more = look.people.more;
  const row = (p: LookInPerson, i: number) => {
    const id = lookInPersonId(p);
    const tappable = !!preview?.canOpen(id);
    return (
      <Pressable
        key={p.key}
        disabled={!tappable}
        accessibilityRole={tappable ? 'button' : undefined}
        onPress={() => preview?.open(id)}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: phone.lerp(10, 13), paddingVertical: phone.lerp(9, 12),
          borderTopWidth: i === 0 ? 0 : 1, borderTopColor: theme.ruleSoft,
          backgroundColor: pressed && tappable ? theme.surfaceSunk : 'transparent',
        })}
      >
        <Avatar imageUrl={p.imageUrl} name={p.name} size={phone.grow(30)} anon={!!p.guest} host={look.moment.host?.id === p.key} />
        <VText
          numberOfLines={1}
          color={p.guest ? 'inkSoft' : 'ink'}
          style={{ flex: 1, fontFamily: p.guest ? 'InstrumentSans_400Regular' : 'InstrumentSans_500Medium', ...phone.text('body') }}
        >
          {p.name}
        </VText>
      </Pressable>
    );
  };
  return (
    <Sheet open={open} onClose={onClose} snapPoints={named.length > 8 ? ['85%'] : undefined} enableDynamicSizing={named.length <= 8} maxDynamicContentSize={windowH * 0.85}>
      <PersonPreviewBridge value={preview}>
        {named.length > 8 ? (
          <View style={{ flex: 1, paddingHorizontal: 18 }}>
            <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold', paddingBottom: 12 }}>People</VText>
            <BottomSheetScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 8 }}>
              {named.map(row)}
              {more > 0 ? <VText variant="small" color="inkSoft" style={{ paddingTop: 12 }}>{`${more} more ${more === 1 ? 'taster isn’t' : 'tasters aren’t'} shown to you.`}</VText> : null}
            </BottomSheetScrollView>
          </View>
        ) : (
          <BottomSheetView style={{ width: '100%', paddingHorizontal: 18, paddingBottom: insets.bottom + 8 }}>
            <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold', paddingBottom: 12 }}>People</VText>
            {named.map(row)}
            {more > 0 ? <VText variant="small" color="inkSoft" style={{ paddingTop: 12 }}>{`${more} more ${more === 1 ? 'taster isn’t' : 'tasters aren’t'} shown to you.`}</VText> : null}
          </BottomSheetView>
        )}
      </PersonPreviewBridge>
    </Sheet>
  );
}

// "Join with Code" (R6): the Moments home's join form in a sheet. A moment
// joined by code or by scan REPLACES the look-in (Codex r1: a scanned one was
// pushed on top of it).
export function LookInJoinSheet({ open, onClose, onJoined }: { open: boolean; onClose: () => void; onJoined: (code: string) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Sheet open={open} onClose={onClose}>
      <BottomSheetView style={{ width: '100%', paddingTop: 8, paddingBottom: insets.bottom + 16 }}>
        {open ? <JoinCodeForm onJoined={onJoined} resultLayer={1} scannedJoins /> : null}
      </BottomSheetView>
    </Sheet>
  );
}
