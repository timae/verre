import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions, type TextInputInstance } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { BIO_MAX } from '@verre/core';
import { BadgePill } from '@/components/moments/RoleChip';
import { PhotoTiles } from '@/components/profile/PhotoTiles';
import { InlineField, LongPressable } from '@/components/profile/ProfileEditParts';
import {
  NAME_GAP, NAME_LIFT, NAME_RIGHT, PHOTO_BASE, SHEET_RISE, fitProfileName, notchBox, notchPath,
} from '@/components/profile/coverGeometry';
import { StarScore } from '@/components/scoring/StarScore';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import type { TileKey } from '@/lib/api/profile';
import type { PeopleTab } from '@/lib/api/people';
import type { FullProfile, ProfileFace } from '@/lib/api/users';
import { firstName } from '@/lib/initials';
import { GLASS_FILL, GUTTER, HERO_RATIO, PROFILE_SCRIM, PROFILE_SCRIM_STOPS, phoneTextToken, usePhoneTokens } from '@/lib/layout';
import { radius, useTheme } from '@/theme';
import { mix } from '@/theme/color';

// The profile header (handoff 04). Two layouts, chosen by whether a cover is set:
//   - COVER (04·R5i·b, Mara = someone else): the cover (HERO_RATIO) full-bleed under the
//     status bar, the rounded sheet rising over it with its left corner flowing
//     into the photo's ring (the notch), the name in white ON the cover beside
//     the photo, status ★ + friends · followers on the sheet beside it.
//   - NO COVER (04·R5c / R5d / R5n / R5x): photo · name / status ★ average /
//     friends · followers in one row under a plain bar.
// Then the bio (own + empty = the "Touch and hold to add a bio" hint), the three photo
// tiles and (someone else) the in-common row + follow button.
//
// Own profile, EDITING (R5g3): long-press the name or the bio and BOTH become
// inputs in place; the status line and the tiles dim (0.35) and stop taking
// touches. Long-press the photo / cover (R5g4 → the iPhone's own picker, D5)
// or a tile (R5g2 → its cover sheet). The screen owns the edit session
// (ProfileScreen); this only renders it.
//
// Step 1 rulings (Simon, 2026-11-09): the status line and the tiles are
// visible but INACTIVE (their pages come later); the status pill names OUR
// level (lib/badges.ts), the design's were placeholders. Since the People
// step the counts and the in-common row open People (D10).

// The photo breathes with the device by the title type's own comfort ratio, so
// photo and name stay in proportion (104pt on the smallest phones).
export function useProfilePhotoSize(): number {
  const phone = usePhoneTokens();
  return Math.round((PHOTO_BASE * phone.text('title').fontSize) / phoneTextToken('title', 0).fontSize);
}

// Re-exported for the profile + settings screens (lib/initials.ts owns it).
export { firstName };

// 1234 → "1.2k", 12400 → "12.4k", 212000 → "212k" (the design's big-profile
// frame 04·R5x). Floors, so a count never reads higher than it is.
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(Math.floor(n / 100) / 10).toString()}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(Math.floor(n / 100_000) / 10).toString()}M`;
}

// The screen's edit session, as the header needs it (own profile only).
export type ProfileEdit = {
  // Non-null while editing: the two drafts.
  draft: { name: string; bio: string } | null;
  // The field the long-press started (it takes the focus).
  focus: 'name' | 'bio' | null;
  setDraft: (field: 'name' | 'bio', value: string) => void;
  start: (field: 'name' | 'bio') => void;
  done: () => void;
  onFieldFocus: (field: 'name' | 'bio') => void;
  nameRef: RefObject<TextInputInstance | null>;
  bioRef: RefObject<TextInputInstance | null>;
  // An upload in flight (spinner over that image, its long-press off).
  busy: 'avatar' | 'cover' | null;
  onPhoto: () => void;
  onCover: () => void;
  onTile: (key: TileKey) => void;
};

// .yo-cnrow (no cover) — photo left, name + lines right. `children` = the
// lines under the name (absent on the blocked / private views: name and
// initials only). `nameNode` / `photoNode` replace the plain name / photo
// (the own profile's long-press targets and inputs).
export function ProfileIdentity({
  name,
  imageUrl,
  children,
  onNameBottom,
  nameNode,
  photoNode,
}: {
  name: string;
  imageUrl: string | null;
  children?: React.ReactNode;
  // The name's bottom edge within this row (the bar title shows once it has
  // scrolled under the bar).
  onNameBottom?: (y: number) => void;
  nameNode?: React.ReactNode;
  photoNode?: React.ReactNode;
}) {
  const photo = useProfilePhotoSize();
  // Either layout callback can land first: report once both are known.
  const sideY = useRef<number | null>(null);
  const nameBottom = useRef<number | null>(null);
  const report = () => {
    if (sideY.current != null && nameBottom.current != null) onNameBottom?.(sideY.current + nameBottom.current);
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginLeft: -8 }}>
      {photoNode ?? <Avatar imageUrl={imageUrl} name={name} size={photo} tint />}
      <View
        onLayout={(e) => {
          sideY.current = e.nativeEvent.layout.y;
          report();
        }}
        style={{ flex: 1, minWidth: 0, gap: 4, paddingLeft: 2, alignItems: 'flex-start' }}
      >
        <View
          style={{ marginBottom: 2, maxWidth: '100%', alignSelf: 'stretch' }}
          onLayout={(e) => {
            nameBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height;
            report();
          }}
        >
          {nameNode ?? <PlainName name={name} />}
        </View>
        {children}
      </View>
    </View>
  );
}

// .yo-ncname — 700 26px in the mock; the nearest type token is heading (23),
// bold. Flagged deviation: no inline font sizes. Fitted to the column like
// the cover's name, without the ring (ruled 2026-11-12; the mock cut it on
// one line), down to the cover's floor in proportion (22 of 30pt).
const PLAIN_NAME_STYLE = { fontFamily: 'InstrumentSans_700Bold' } as const;
function PlainName({ name }: { name: string }) {
  const { theme } = useTheme();
  const tok = usePhoneTokens().text('heading');
  const base = useMemo(
    () => ({ ...PLAIN_NAME_STYLE, color: theme.ink, fontSize: tok.fontSize, lineHeight: tok.lineHeight, letterSpacing: tok.letterSpacing }),
    [theme.ink, tok.fontSize, tok.lineHeight, tok.letterSpacing],
  );
  const [avail, setAvail] = useState<number | null>(null);
  return (
    <View style={{ alignSelf: 'stretch' }} onLayout={(e) => setAvail(e.nativeEvent.layout.width)}>
      {avail == null ? (
        <Text style={[base, { opacity: 0 }]} numberOfLines={1}>{name}</Text>
      ) : (
        <FittedName name={name} base={base} lineRatio={tok.lineHeight / tok.fontSize} avail={avail} min={Math.round((tok.fontSize * 22) / 30)} />
      )}
    </View>
  );
}

// Instrument Sans (OS/2): cap height 0.72em, x-height 0.51em. The score's
// digits fill the cap height, the all-lowercase "average" only the x-height,
// so with their line boxes centred the word READS low. Half the difference
// would centre its x-height on the digits; two-thirds of that sat right on
// device (Simon, 2026-11-11: the full lift read a touch high).
const X_TO_CAP_LIFT = ((0.72 - 0.51) / 2) * (2 / 3);

// .yo-statline — status pill + ★ average (no average until they rated).
function StatLine({ level, avgScore }: { level: string; avgScore: number | null }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const { fontScale } = useWindowDimensions();
  // The word's RENDERED size (small token, Dynamic Type included: VText
  // without a surface scales uncapped).
  const lift = X_TO_CAP_LIFT * phone.text('small').fontSize * fontScale;
  return (
    // The same visible gap as friends → followers (14): the star glyph sits
    // 2/24 of its 15pt box in from the left, so the box gap is 14 − 1.25
    // (Simon, 2026-11-11; the mock's 8 read tighter than the counts).
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12.75 }}>
      <BadgePill
        label={level}
        bg={theme.accentTint}
        color={mix(theme.accent, theme.ink, 0.6)}
        uppercase={false}
        paddingHorizontal={10}
        style={{ alignSelf: 'center' }}
      />
      {avgScore != null && avgScore > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {/* The house score read (accent ★ + value). ⚠️ The mock draws the
              numeral in ink; StarScore's accent numeral is the canonical read. */}
          <StarScore value={avgScore} size={13} />
          <VText variant="small" color="inkSoft" style={{ fontFamily: 'InstrumentSans_500Medium', transform: [{ translateY: -lift }] }}>
            average
          </VText>
        </View>
      ) : null}
    </View>
  );
}

// .yo-cnfollows — "48 friends  212 followers", count in ink 600. Each opens
// People on its tab (D10); dimmed and inert while you edit your name or bio
// (a push would blur the field and drop the draft), like the status line.
function Counts({ friends, followers, onPeople, editing }: { friends: number; followers: number; onPeople?: (tab: PeopleTab) => void; editing: boolean }) {
  return (
    <View pointerEvents={editing ? 'none' : 'auto'} style={[{ flexDirection: 'row', gap: 14 }, editing ? { opacity: 0.35 } : null]}>
      <Count n={friends} word="friends" onPress={onPeople && (() => onPeople('friends'))} />
      <Count n={followers} word="followers" onPress={onPeople && (() => onPeople('followers'))} />
    </View>
  );
}

function Count({ n, word, onPress }: { n: number; word: string; onPress?: () => void }) {
  const text = (
    <VText variant="small" color="inkSoft" style={{ fontFamily: 'InstrumentSans_500Medium' }}>
      <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', fontVariant: ['tabular-nums'] }}>
        {compactCount(n)}
      </VText>{' '}
      {word}
    </VText>
  );
  if (!onPress) return text;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${n} ${word}`} hitSlop={{ top: 8, bottom: 8 }} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      {text}
    </Pressable>
  );
}

// The photo: a TAP opens it full screen (when there is one); on your own
// profile a LONG-PRESS changes it (not while editing), the upload spinner
// over it meanwhile.
function PhotoSlot({ profile, size, edit, onView }: { profile: FullProfile; size: number; edit?: ProfileEdit; onView: () => void }) {
  const busy = edit?.busy === 'avatar';
  const view = profile.imageUrl ? onView : undefined;
  const avatar = (
    <View>
      <Avatar imageUrl={profile.imageUrl} name={profile.name} size={size} tint />
      {busy ? <Spinner radius={size / 2} /> : null}
    </View>
  );
  if (!edit) {
    if (!view) return avatar;
    return (
      <Pressable accessibilityRole="imagebutton" accessibilityLabel="Open profile photo full screen" onPress={view}>
        {avatar}
      </Pressable>
    );
  }
  return (
    <LongPressable
      disabled={!!edit.draft || edit.busy != null}
      onPress={view}
      onLongPress={edit.onPhoto}
      accessibilityLabel="Profile Photo"
      accessibilityHint={view ? 'Double-tap to view. Double-tap and hold to change your profile photo.' : 'Double-tap and hold to add a profile photo.'}
    >
      {avatar}
    </LongPressable>
  );
}

function Spinner({ radius: r }: { radius: number }) {
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: r, backgroundColor: GLASS_FILL, alignItems: 'center', justifyContent: 'center' }}
    >
      <ActivityIndicator color="#fff" />
    </View>
  );
}

// The full header block above the posts (state 'ok', own or someone else).
// Full-bleed: it applies the screen gutter itself (the cover runs edge to edge).
export function ProfileHeader({
  profile,
  own,
  onFollowPress,
  followBusy,
  onNameBottom,
  edit,
  pulled,
  onPeople,
}: {
  profile: FullProfile;
  own: boolean;
  onFollowPress: () => void;
  followBusy: boolean;
  // The counts + in-common row open People (D10): `known` = "Only people you
  // know" on (the in-common row).
  onPeople?: (tab: PeopleTab, known?: boolean) => void;
  // The name's bottom edge in header coordinates (the bar title trigger).
  onNameBottom?: (y: number) => void;
  // Own profile only.
  edit?: ProfileEdit;
  // The list is pulled past its top: the cover's top corners round (the
  // moment cover hero's soft corners).
  pulled?: boolean;
}) {
  const photo = useProfilePhotoSize();
  // Tap a photo → the house full-screen viewer (cover or profile photo).
  const [viewing, setViewing] = useState<'cover' | 'photo' | null>(null);
  const viewers = (
    <>
      {profile.coverPhotoUrl ? (
        <FullscreenImage uri={profile.coverPhotoUrl} visible={viewing === 'cover'} label="Cover Photo" onClose={() => setViewing(null)} />
      ) : null}
      {profile.imageUrl ? (
        <FullscreenImage uri={profile.imageUrl} visible={viewing === 'photo'} label="Profile Photo" onClose={() => setViewing(null)} />
      ) : null}
    </>
  );
  const editing = !!edit?.draft;
  // Only the tiles the owner shows this viewer (step 4: an absent key is a
  // hidden tile, never a zero); the rest share the row.
  const tiles = TILE_LABELS.flatMap(([key, label]) => {
    const t = profile.tiles[key];
    if (!t) return [];
    return [{
      label,
      count: compactCount(t.count),
      imageUrl: t.imageUrl,
      // Every tile of your own, an empty one too: its sheet can add your own
      // photo (ruled 2026-11-12; it used to be inert with nothing to pick).
      onLongPress: edit ? () => edit.onTile(key) : undefined,
    }];
  });
  const stat = (
    <View pointerEvents={editing ? 'none' : 'auto'} style={editing ? { opacity: 0.35 } : null}>
      <StatLine level={profile.level.name} avgScore={profile.flavor.avgScore} />
    </View>
  );
  const below = (
    <>
      <Bio profile={profile} own={own} edit={edit} />
      <PhotoTiles dimmed={editing} tiles={tiles} />
      {own ? null : (
        // .yo-frow — "N in common" faces + names, the follow button right.
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <InCommon inCommon={profile.inCommon} onPress={onPeople && (() => onPeople('friends', true))} />
          <FollowButton
            isFollowing={profile.isFollowing}
            followsYou={profile.followsYou}
            busy={followBusy}
            onPress={onFollowPress}
          />
        </View>
      )}
    </>
  );

  if (!profile.coverPhotoUrl) {
    return (
      <View style={{ gap: 16, paddingHorizontal: GUTTER, paddingBottom: 20 }}>
        <ProfileIdentity
          name={profile.name}
          imageUrl={profile.imageUrl}
          onNameBottom={onNameBottom}
          photoNode={<PhotoSlot profile={profile} size={photo} edit={edit} onView={() => setViewing('photo')} />}
          nameNode={edit ? <EditableName name={profile.name} edit={edit} variant="plain" /> : undefined}
        >
          {stat}
          <Counts friends={profile.friendsCount} followers={profile.stats.followers} onPeople={onPeople} editing={editing} />
        </ProfileIdentity>
        {below}
        {viewers}
      </View>
    );
  }

  return (
    <View style={{ paddingBottom: 20 }}>
      <CoverHero profile={profile} photo={photo} edit={edit} pulled={!!pulled} onView={() => setViewing('cover')} onNameBottom={onNameBottom} />
      <View style={{ paddingHorizontal: GUTTER, gap: 16 }}>
        {/* .yo-cnrow on the sheet: the photo's centre ON the sheet edge (the
            notch assumes it), status + counts beside it, on the sheet. */}
        <View style={{ flexDirection: 'row', gap: 14, marginLeft: -8, marginTop: -(SHEET_RISE + photo / 2) }}>
          <PhotoSlot profile={profile} size={photo} edit={edit} onView={() => setViewing('photo')} />
          <View style={{ flex: 1, minWidth: 0, paddingTop: photo / 2 + 6, gap: 8, alignItems: 'flex-start' }}>
            {/* Mock nudges (.yo-cover-cn .yo-cnside): the pill 2 down / 5 left,
                the counts tucked 20 left under the photo's curve. */}
            <View style={{ top: 2, left: -5 }}>{stat}</View>
            <View style={{ marginLeft: -20 }}>
              <Counts friends={profile.friendsCount} followers={profile.stats.followers} onPeople={onPeople} editing={editing} />
            </View>
          </View>
        </View>
        {below}
      </View>
      {viewers}
    </View>
  );
}

// The cover (`.yo-rhero`): from the screen top to the SHEET EDGE (the card's
// top line) it is `HERO_RATIO` of the screen height, the same as the moment,
// impression and opened-post heroes (ruled 2026-11-11, replacing the mock's
// 3:2 of the width, which sat low under the Dynamic Island); the photo runs
// SHEET_RISE further under the sheet, as theirs run radius.xl. Photo + scrim,
// the notch (the sheet's top edge, bg-filled), the white name
// bottom-anchored beside the photo. A TAP opens
// the cover full screen; on your own profile a LONG-PRESS changes it (and a
// long-press on the name edits in place). Soft top corners while pulled.
function CoverHero({
  profile, photo, edit, pulled, onView, onNameBottom,
}: {
  profile: FullProfile;
  photo: number;
  edit?: ProfileEdit;
  pulled: boolean;
  onView: () => void;
  onNameBottom?: (y: number) => void;
}) {
  const { theme } = useTheme();
  const { width, height: windowH } = useWindowDimensions();
  const heroH = Math.round(windowH * HERO_RATIO) + SHEET_RISE;
  const box = notchBox(photo);
  const photoLeft = GUTTER - 8;
  const photoCx = photoLeft + photo / 2;
  const nameLeft = photoLeft + photo + NAME_GAP;
  const [failed, setFailed] = useState<string | null>(null);
  const uri = profile.coverPhotoUrl!;
  const hero = (
    <View style={{ height: heroH }}>
      <View
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden', backgroundColor: theme.surfaceSunk,
          borderTopLeftRadius: pulled ? radius.xl : 0,
          borderTopRightRadius: pulled ? radius.xl : 0,
        }}
      >
        {failed !== uri ? (
          <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} onError={() => setFailed(uri)} />
        ) : null}
        <LinearGradient pointerEvents="none" colors={PROFILE_SCRIM} locations={PROFILE_SCRIM_STOPS} style={StyleSheet.absoluteFill} />
        {edit?.busy === 'cover' ? (
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : null}
      </View>
      <Svg
        pointerEvents="none"
        width={width}
        height={box.h}
        style={{ position: 'absolute', left: 0, top: heroH + 1 - box.h }}
      >
        <Path d={notchPath(width, photoCx, photo)} fill={theme.bg} />
      </Svg>
      <View
        style={{ position: 'absolute', left: nameLeft, right: NAME_RIGHT, bottom: SHEET_RISE + NAME_LIFT }}
        onLayout={(e) => onNameBottom?.(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
      >
        {edit ? (
          <EditableName name={profile.name} edit={edit} variant="cover" fit={{ avail: width - nameLeft - NAME_RIGHT, nameLeft, photoCx, photo }} />
        ) : (
          <CoverName name={profile.name} avail={width - nameLeft - NAME_RIGHT} nameLeft={nameLeft} photoCx={photoCx} photo={photo} />
        )}
      </View>
    </View>
  );
  if (!edit) {
    return (
      <Pressable accessibilityRole="imagebutton" accessibilityLabel="Open cover photo full screen" onPress={onView}>
        {hero}
      </Pressable>
    );
  }
  return (
    <LongPressable
      disabled={!!edit.draft || edit.busy != null}
      onPress={onView}
      onLongPress={edit.onCover}
      accessibilityLabel="Cover Photo"
      accessibilityHint="Double-tap to view. Double-tap and hold to change your cover."
    >
      {hero}
    </LongPressable>
  );
}

// The white name on the cover, fitted: its size, or ≤ 4pt smaller, or two
// lines with line 1 hugging the photo's ring.
function useCoverNameStyle() {
  const phone = usePhoneTokens();
  const tok = phone.text('title');
  return useMemo(() => {
    const fs = tok.fontSize;
    return { fs, base: { fontFamily: 'InstrumentSans_600SemiBold', color: '#fff', fontSize: fs, lineHeight: Math.round(fs * 1.05), letterSpacing: tok.letterSpacing } };
  }, [tok.fontSize, tok.letterSpacing]);
}

function CoverName({ name, avail, nameLeft, photoCx, photo }: { name: string; avail: number; nameLeft: number; photoCx: number; photo: number }) {
  const { base } = useCoverNameStyle();
  return <FittedName name={name} base={base} lineRatio={1.05} avail={avail} min={22} ring={{ nameLeft, photoCx, photo }} />;
}

// A profile name fitted to `avail` (coverGeometry `fitProfileName`).
// Measured at the base size first (hidden), so Dynamic Type is included.
type NameStyle = { fontFamily: string; color: string; fontSize: number; lineHeight: number; letterSpacing: number };
function FittedName({
  name, base, lineRatio, avail, min, ring,
}: {
  name: string;
  base: NameStyle;
  lineRatio: number;
  avail: number;
  min: number;
  ring?: { nameLeft: number; photoCx: number; photo: number };
}) {
  const fs = base.fontSize;
  // Every candidate break: line 1 = the first i + 1 words, line 2 = the rest.
  const breaks = useMemo(() => {
    const words = name.trim().split(/\s+/);
    return words.slice(1).map((_, i) => [words.slice(0, i + 1).join(' '), words.slice(i + 1).join(' ')] as const);
  }, [name]);
  // Each distinct string is measured once (one line, unconstrained, hidden).
  const texts = useMemo(() => [...new Set([name, ...breaks.flat()])], [name, breaks]);
  const key = `${name}|${fs}`;
  const [m, setM] = useState<{ key: string; h?: number; widths: Record<string, number> }>({ key, widths: {} });
  const cur = m.key === key ? m : { key, widths: {} as Record<string, number> };
  const measured = (t: string, width: number, height: number) =>
    setM((p) => {
      const q = p.key === key ? p : { key, widths: {} };
      if (q.widths[t] === width && (t !== name || q.h === height)) return q;
      return { key, h: t === name ? height : q.h, widths: { ...q.widths, [t]: width } };
    });
  const ready = cur.h != null && texts.every((t) => cur.widths[t] != null);
  const fit = ready
    ? fitProfileName({
        fs, w: cur.widths[name], lineH: cur.h!, scale: cur.h! / base.lineHeight, avail, min, ring,
        splits: breaks.map(([l1, l2]) => ({ w1: cur.widths[l1], w2: cur.widths[l2] })),
      })
    : null;
  const sized = (f: number) => (f === fs ? base : { ...base, fontSize: f, lineHeight: Math.round(f * lineRatio), letterSpacing: (base.letterSpacing * f) / fs });
  return (
    <View accessible accessibilityRole="header" accessibilityLabel={name}>
      {/* Measuring pass: one line each, unconstrained, invisible. */}
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ position: 'absolute', opacity: 0, left: 0, bottom: 0, width: 4000, alignItems: 'flex-start' }}>
        {/* Keyed on the WHOLE measurement key, not just the string: after a
            rename a string both names share ("Simon") would otherwise keep
            its laid-out view, never fire onLayout again, and the fit would
            wait forever with the name invisible. */}
        {texts.map((t) => (
          <Text key={`${key}|${t}`} style={base} onLayout={(e) => measured(t, e.nativeEvent.layout.width, e.nativeEvent.layout.height)}>{t}</Text>
        ))}
      </View>
      {!fit ? (
        <Text style={[base, { opacity: 0 }]} numberOfLines={1}>{name}</Text>
      ) : fit.lines === 1 ? (
        <Text style={sized(fit.fontSize)} numberOfLines={fit.wrap ? 2 : 1}>{name}</Text>
      ) : (
        <View>
          <Text style={[sized(fit.fontSize), { marginLeft: fit.indent }]} numberOfLines={1}>{breaks[fit.split][0]}</Text>
          <Text style={sized(fit.fontSize)} numberOfLines={1}>{breaks[fit.split][1]}</Text>
        </View>
      )}
    </View>
  );
}

// The name as a long-press target, or (editing) its input in place. On the
// cover it is the white title (one line while editing: the mock unfolds the
// fitted two-line name); without a cover, the ink heading.
function EditableName({
  name, edit, variant, fit,
}: {
  name: string;
  edit: ProfileEdit;
  variant: 'cover' | 'plain';
  fit?: { avail: number; nameLeft: number; photoCx: number; photo: number };
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const { base } = useCoverNameStyle();
  if (edit.draft) {
    // Single-line raw input: no lineHeight (the Dynamic Type gate's single-line
    // policy; iOS centres the glyphs itself).
    const style =
      variant === 'cover'
        ? { fontFamily: base.fontFamily, color: '#fff', fontSize: base.fontSize, letterSpacing: base.letterSpacing }
        : { fontFamily: PLAIN_NAME_STYLE.fontFamily, color: theme.ink, fontSize: phone.text('heading').fontSize, letterSpacing: phone.text('heading').letterSpacing };
    return (
      <InlineField
        ref={edit.nameRef}
        value={edit.draft.name}
        onChangeText={(s) => edit.setDraft('name', s)}
        onFocus={() => edit.onFieldFocus('name')}
        autoFocus={edit.focus === 'name'}
        maxLength={64}
        onSubmit={edit.done}
        accessibilityLabel="Display Name"
        style={style}
      />
    );
  }
  return (
    <LongPressable
      disabled={edit.busy != null}
      onLongPress={() => edit.start('name')}
      accessibilityLabel={name}
      accessibilityHint="Double-tap and hold to edit your name and bio."
    >
      {variant === 'cover' && fit ? <CoverName name={name} {...fit} /> : <PlainName name={name} />}
    </LongPressable>
  );
}

// .yo-bio — one paragraph, small, 1.5 line height. Own + empty: the quiet
// hint (R5n), a pencil + "Touch and hold to add a bio" in the
// placeholder grey (ruled 2026-11-12: it names the gesture and reads as a
// prompt; never shown to anyone else); a TAP starts editing too. Editing: the
// input in place, capped at 200 UTF-16 units (the server's own unit; the
// normalisation only ever shortens), Return = Done, no counter (the mock has
// none).
function Bio({ profile, own, edit }: { profile: FullProfile; own: boolean; edit?: ProfileEdit }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const small = phone.text('small');
  const lineHeight = Math.round(small.fontSize * 1.5);
  if (edit?.draft) {
    return (
      <InlineField
        ref={edit.bioRef}
        value={edit.draft.bio}
        onChangeText={(s) => edit.setDraft('bio', s)}
        onFocus={() => edit.onFieldFocus('bio')}
        autoFocus={edit.focus === 'bio'}
        multiline
        maxLength={BIO_MAX}
        placeholder="Add a bio"
        placeholderTextColor={theme.inkSoft}
        onSubmit={edit.done}
        accessibilityLabel="Bio"
        style={{ fontFamily: 'InstrumentSans_400Regular', fontSize: small.fontSize, lineHeight, color: theme.ink }}
      />
    );
  }
  if (profile.bio) {
    const text = <VText variant="small" style={{ lineHeight }}>{profile.bio}</VText>;
    if (!own || !edit) return text;
    return (
      <LongPressable
        disabled={edit.busy != null}
        onLongPress={() => edit.start('bio')}
        accessibilityHint="Double-tap and hold to edit your name and bio."
      >
        {text}
      </LongPressable>
    );
  }
  if (!own || !edit) return null;
  return (
    <LongPressable
      disabled={edit.busy != null}
      onPress={() => edit.start('bio')}
      onLongPress={() => edit.start('bio')}
      accessibilityLabel="Add a Bio"
    >
      {/* Reads as a prompt, not your text (ruled 2026-11-12): a pencil and
          the app's placeholder grey (the empty search field's). */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="edit" size={Math.round(small.fontSize)} color={theme.inkFaint} />
        <VText variant="small" color="inkFaint" style={{ flexShrink: 1, lineHeight }}>Touch and hold to add a bio</VText>
      </View>
    </LongPressable>
  );
}

// "12 in common" (D4: their friends YOU follow) → their People on Friends,
// "Only people you know" on.
function InCommon({ inCommon, onPress }: { inCommon?: { count: number; faces: ProfileFace[] }; onPress?: () => void }) {
  const phone = usePhoneTokens();
  if (!inCommon || inCommon.count === 0) return <View style={{ flex: 1 }} />;
  const { count, faces } = inCommon;
  const face = phone.grow(26);
  const names = faces.slice(0, 2).map((f) => firstName(f.name));
  const rest = count - names.length;
  const line = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(' and ');
  return (
    <Pressable
      accessible
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${count} in common: ${line}`}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => ({ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: pressed ? 0.6 : 1 })}
    >
      {/* .yo-stack — overlapping 26px faces, 2px bg ring */}
      <View style={{ flexDirection: 'row' }}>
        {faces.map((f, i) => (
          <View key={f.id} style={{ marginLeft: i === 0 ? 0 : -8 }}>
            <Avatar imageUrl={f.imageUrl} name={f.name} size={face} ring initialsSize={Math.round(face * 0.38)} />
          </View>
        ))}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {count} in common
        </VText>
        <VText variant="small" color="inkSoft" numberOfLines={2}>
          {line}
        </VText>
      </View>
    </Pressable>
  );
}

// Follow / Follow Back (primary) · Following / Friends (secondary, ✓). The
// caller confirms an unfollow; following acts immediately.
// `name`: say whom the button is for (a list row, the People bar), e.g.
// "Follow Back, Mara".
export function FollowButton({
  isFollowing,
  followsYou,
  busy,
  onPress,
  name,
}: {
  isFollowing: boolean;
  followsYou: boolean;
  busy: boolean;
  onPress: () => void;
  name?: string;
}) {
  const title = isFollowing ? (followsYou ? 'Friends' : 'Following') : followsYou ? 'Follow Back' : 'Follow';
  const label = name ? `${title}, ${name}` : undefined;
  if (isFollowing) {
    return <Button size="sm" variant="secondary" icon="check" title={title} loading={busy} onPress={onPress} accessibilityLabel={label} />;
  }
  return <Button size="sm" variant="primary" title={title} loading={busy} onPress={onPress} accessibilityLabel={label} />;
}

// .yo-blockedbox — the sentence + one action on the fill tone. Used by the
// blocked view (04·5b: "You blocked Mara." + Unblock) and, per Simon's
// ruling, the private (tier-gated) view with a Follow button.
export function NoticeBox({ text, action }: { text: string; action: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        marginTop: 18,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderRadius: radius.md,
        backgroundColor: theme.surfaceSunk,
      }}
    >
      <VText variant="small" color="inkSoft" style={{ flex: 1 }}>
        {text}
      </VText>
      {action}
    </View>
  );
}

const TILE_LABELS: ReadonlyArray<readonly [TileKey, string]> = [
  ['impressions', 'Impressions'], ['moments', 'Moments'], ['cravings', 'Cravings'],
];

// .yo-emptyfeed — quiet block under the tiles when there are no posts.
export function EmptyPosts({ title, body }: { title: string; body?: string }) {
  return (
    <View style={{ alignItems: 'center', gap: 4, paddingTop: 40, paddingHorizontal: 24, paddingBottom: 40 }}>
      <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold', textAlign: 'center' }}>
        {title}
      </VText>
      {body ? (
        <VText variant="small" color="inkSoft" style={{ textAlign: 'center' }}>
          {body}
        </VText>
      ) : null}
    </View>
  );
}
