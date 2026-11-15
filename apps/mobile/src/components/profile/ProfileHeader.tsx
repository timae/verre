import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type TextInputInstance, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { BIO_MAX, USERNAME_MAX } from '@verre/core';
import { BadgePill } from '@/components/moments/RoleChip';
import { PhotoTiles } from '@/components/profile/PhotoTiles';
import { InlineField, LongPressable, markNoShake } from '@/components/ui/InPlaceEdit';
import {
  COVER_SPEC, FONT, NAME_GAP, NAME_LIFT, NAME_RIGHT, PHOTO_BASE, PLAIN_SPEC, SHEET_RISE, anchoredIndent, coverLines, curveLeft, fitProfileName, notchBox, notchPath, plainLines,
  type NameAnchor, type NameRing,
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
import { typedUsername } from '@/lib/usernameCopy';
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
// `@username` (usernames; design spec 2026-11-14, coverGeometry `COVER_SPEC` /
// `PLAIN_SPEC`): its own line under the name, one line, cut at the end. With
// one, the identity block is placed by BASELINES and every line's left edge
// keeps a fixed gap to the photo's ROUND edge at its own height:
//   - cover: the handle's baseline just above the sheet edge (as far as the
//     status pill sits below it), the name's above that; white, the handle
//     medium at 78% with a soft shadow.
//   - no cover: the name's capitals near the photo's top, then handle, status
//     pill and friends line, all four following the circle (name 26pt, one
//     line; handle regular, soft ink).
// Someone WITHOUT a username keeps the layout from before (the legacy paths).
// Then the bio (own + empty = the "Touch and hold to add a bio" hint), the three photo
// tiles and (someone else) the in-common row + follow button.
//
// Own profile, EDITING (R5g3): long-press the name, the `@username` or the bio
// and ALL of them become inputs in place (the username since 2026-11-14, its
// feedback in the edit bar; Edit Profile keeps the full field); the status
// line and the tiles dim (0.35) and stop taking touches. Long-press the photo / cover (R5g4 → the iPhone's own picker, D5)
// or a tile (R5g2 → its cover sheet). The screen owns the edit session
// (ProfileScreen); this only renders it.
//
// Step 1 rulings (Simon, 2026-11-09): the status pill names OUR level
// (lib/badges.ts), the design's were placeholders. Since the People step the
// counts and the in-common row open People (D10), since the lists step the
// tiles their lists, since 2026-11-14 the status line its placeholder pages
// (StatLine).

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
export type EditField = 'name' | 'username' | 'bio';
export type ProfileEdit = {
  // Non-null while editing: the drafts (the username without its `@`).
  draft: { name: string; username: string; bio: string } | null;
  // The field the long-press started (it takes the focus).
  focus: EditField | null;
  setDraft: (field: EditField, value: string) => void;
  start: (field: EditField) => void;
  done: () => void;
  onFieldFocus: (field: EditField) => void;
  nameRef: RefObject<TextInputInstance | null>;
  usernameRef: RefObject<TextInputInstance | null>;
  bioRef: RefObject<TextInputInstance | null>;
  // No username changes left: the handle stays read-only while editing, and
  // a tap on it puts the date in the edit bar.
  usernameLocked: boolean;
  onLockedUsername: () => void;
  // Done is greyed (a refused username): Return keeps the field focused.
  doneBlocked: boolean;
  // An upload in flight (spinner over that image, its long-press off).
  busy: 'avatar' | 'cover' | null;
  onPhoto: () => void;
  onCover: () => void;
  onTile: (key: TileKey) => void;
};

// One line of text whose BASELINE sits exactly `strut` below this row's top:
// a zero-width strut beside the text in a baseline-aligned row (a plain
// View's baseline is its bottom edge). The line box above and below the
// glyphs never enters the position, which is the point: it differs between
// iOS and Android, the baseline does not. `strut` must be at least the text's
// rise above its baseline (its line height is always enough).
function BaselineRow({
  top, left, right = 0, strut, style, children,
}: {
  top: number; left: number; right?: number; strut: number; style?: StyleProp<ViewStyle>; children: React.ReactNode;
}) {
  return (
    <View style={[{ position: 'absolute', top, left, right, flexDirection: 'row', alignItems: 'baseline' }, style]}>
      <View style={{ width: 0, height: strut }} />
      {children}
    </View>
  );
}

// The identity row WITHOUT a cover: photo left; name, `@username`, then
// `stat` (the status line) and `counts` (friends · followers) beside it. The
// blocked and private views pass neither: name and username only. `edit` =
// your own profile (the name is the long-press target / the input in place).
type IdentityProps = {
  name: string;
  username?: string | null;
  imageUrl: string | null;
  // The name's bottom edge within this row (the bar title shows once it has
  // scrolled under the bar).
  onNameBottom?: (y: number) => void;
  photoNode?: React.ReactNode;
  edit?: ProfileEdit;
  stat?: React.ReactNode;
  counts?: React.ReactNode;
};
export function ProfileIdentity(props: IdentityProps) {
  return props.username ? <CurvedIdentity {...props} username={props.username} /> : <StraightIdentity {...props} />;
}

// With a username (PLAIN_SPEC): four lines placed by baseline from the photo's
// top, each left edge `gap` from the photo's round edge at its own height, so
// the block follows the circle. Without `stat` (blocked / private) the two
// lines are centred on the photo instead. Coordinates: the photo's top-left.
function CurvedIdentity({ name, username, imageUrl, onNameBottom, photoNode, edit, stat, counts }: IdentityProps & { username: string }) {
  const photo = useProfilePhotoSize();
  const { fontScale } = useWindowDimensions();
  const small = usePhoneTokens().text('small');
  const base = useCurvedNameStyle();
  const [width, setWidth] = useState<number | null>(null);
  const [pillH, setPillH] = useState(24);
  const [countsH, setCountsH] = useState(() => Math.round(small.lineHeight * fontScale));
  const r = photo / 2;
  const { nameB, handleB, pillTop, countsTop, gap, height, base: baseLeft, handleLeft, pillLeft, countsLeft } = plainLines({
    photo, textScale: fontScale, nameSize: base.fontSize, handleSize: small.fontSize, pillH, countsH, withStat: !!stat,
  });
  const nameBottom = nameB + FONT.descent * base.fontSize * fontScale;
  useEffect(() => { onNameBottom?.(nameBottom); }, [onNameBottom, nameBottom]);
  const placed = useMemo<Placed | null>(
    () => (width == null ? null : {
      ring: { nameLeft: baseLeft, photoCx: r, photo, gap, maxShift: photo / 4 },
      anchor: { dy: r - nameB },
      avail: width - baseLeft,
      place: { baseline: nameB, left: baseLeft },
      maxLines: 1,
    }),
    [width, baseLeft, r, photo, gap, nameB],
  );
  return (
    <View style={{ marginLeft: -8, height }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <View style={{ position: 'absolute', left: 0, top: 0 }}>{photoNode ?? <Avatar imageUrl={imageUrl} name={name} size={photo} tint />}</View>
      {placed ? <ProfileName name={name} variant="plain" edit={edit} placed={placed} /> : null}
      <ProfileHandle username={username} cover={false} edit={edit} baseline={handleB} left={handleLeft} />
      {stat ? (
        <>
          <View style={{ position: 'absolute', top: pillTop, left: pillLeft }} onLayout={(e) => setPillH(Math.round(e.nativeEvent.layout.height))}>{stat}</View>
          <View style={{ position: 'absolute', top: countsTop, left: countsLeft }} onLayout={(e) => setCountsH(Math.round(e.nativeEvent.layout.height))}>{counts}</View>
        </>
      ) : null}
    </View>
  );
}

// .yo-cnrow as before usernames (someone who has not chosen one): photo left,
// the name and the lines in a straight column beside it, centred on the photo.
function StraightIdentity({ name, imageUrl, onNameBottom, photoNode, edit, stat, counts }: IdentityProps) {
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
          <ProfileName name={name} variant="plain" edit={edit} />
        </View>
        {stat}
        {counts}
      </View>
    </View>
  );
}

// .yo-ncname — 700 26px in the mock; the nearest type token is heading (23),
// bold. Flagged deviation: no inline font sizes. Fitted to the column like
// the cover's name, without the ring (ruled 2026-11-12; the mock cut it on
// one line), down to the cover's floor in proportion (22 of 30pt). The
// straight column only: with a username the name is `useCurvedNameStyle`'s.
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

// The handle's text box: a line height no larger than the font's own (1.22
// em). 🔒 On iOS a TALLER line height makes React Native lift the glyphs
// (half the extra, as a baseline offset) while the baseline it reports for
// layout may not move, which would draw the handle above where `BaselineRow`
// puts it; a one-line text needs no leading anyway.
function useHandleStyle() {
  const small = usePhoneTokens().text('small');
  return useMemo(() => ({ flexShrink: 1, lineHeight: Math.floor(small.fontSize * 1.2) }), [small.fontSize]);
}

// The `@username` line (both layouts): its BASELINE at `baseline` in the
// parent's box, from `left` (its gap to the photo's round edge) to `right`.
// Your own (`edit`): a long-press starts the edit with it focused (`swapsOut`:
// the input replaces it); while editing it is the input in place on the same
// baseline, the `@` in front as in UsernameField, its feedback in the edit
// bar (ruled 2026-11-14); with no changes left a dimmed read-only line whose
// tap puts the date in the bar (and never shakes it).
function ProfileHandle({ username, cover, edit, baseline, left, right = 0 }: {
  username: string; cover: boolean; edit?: ProfileEdit; baseline: number; left: number; right?: number;
}) {
  const { theme } = useTheme();
  const { fontScale } = useWindowDimensions();
  const small = usePhoneTokens().text('small');
  const handleStyle = useHandleStyle();
  const strut = Math.ceil(handleStyle.lineHeight * fontScale);
  if (edit?.draft && !edit.usernameLocked) {
    const typed = edit.draft.username;
    // Single-line raw input: no lineHeight, its glyphs on the handle's
    // baseline (as the name's input). The cover's soft text shadow drops
    // while typing (an iOS text field draws none).
    return (
      <View style={{ position: 'absolute', left, right, top: baseline - FONT.ascent * small.fontSize * fontScale }}>
        <InlineField
          ref={edit.usernameRef}
          username
          value={typed ? `@${typed}` : ''}
          onChangeText={(t) => edit.setDraft('username', typedUsername(t).slice(0, USERNAME_MAX))}
          onFocus={() => edit.onFieldFocus('username')}
          autoFocus={edit.focus === 'username'}
          placeholder="@username"
          placeholderTextColor={cover ? COVER_HANDLE_FAINT : theme.inkFaint}
          onSubmit={edit.done}
          keepFocus={edit.doneBlocked}
          accessibilityLabel="Username"
          style={{ fontFamily: cover ? COVER_HANDLE_STYLE.fontFamily : 'InstrumentSans_400Regular', fontSize: small.fontSize, color: cover ? COVER_HANDLE : theme.inkSoft }}
        />
      </View>
    );
  }
  const box = { position: 'absolute', top: baseline - strut, left, right } as const;
  const row = (
    <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
      <View style={{ width: 0, height: strut }} />
      <VText variant="small" color={cover ? COVER_HANDLE : 'inkSoft'} numberOfLines={1} ellipsizeMode="tail" style={cover ? [handleStyle, COVER_HANDLE_STYLE] : handleStyle}>@{username}</VText>
    </View>
  );
  if (edit?.draft) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`@${username}`}
        accessibilityHint="Says when you can change it again."
        onPress={edit.onLockedUsername}
        onStartShouldSetResponderCapture={markNoShake}
        style={[box, { opacity: 0.35 }]}
      >
        {row}
      </Pressable>
    );
  }
  if (!edit) return <View style={box}>{row}</View>;
  return (
    <LongPressable style={box} disabled={edit.busy != null} swapsOut onLongPress={() => edit.start('username')} accessibilityLabel={`@${username}`} accessibilityHint={EDIT_HINT}>
      {row}
    </LongPressable>
  );
}

// The coverless name beside a username: the design's 26pt bold as a share of
// the 30pt title token, so it grows with the photo like the cover's name.
function useCurvedNameStyle(): NameStyle {
  const { theme } = useTheme();
  const tok = usePhoneTokens().text('title');
  return useMemo(() => {
    const size = Math.round(tok.fontSize * PLAIN_SPEC.nameSize);
    return { ...PLAIN_NAME_STYLE, color: theme.ink, fontSize: size, lineHeight: Math.round(size * 1.15), letterSpacing: tok.letterSpacing * PLAIN_SPEC.nameSize };
  }, [theme.ink, tok.fontSize, tok.letterSpacing]);
}

// Instrument Sans (OS/2): cap height 0.72em, x-height 0.51em. The score's
// digits fill the cap height, the all-lowercase "average" only the x-height,
// so with their line boxes centred the word READS low. Half the difference
// would centre its x-height on the digits; two-thirds of that sat right on
// device (Simon, 2026-11-11: the full lift read a touch high).
const X_TO_CAP_LIFT = ((0.72 - 0.51) / 2) * (2 / 3);

// .yo-statline — status pill + ★ average (no average until they rated). The
// mock's taps (placeholder pages, 2026-11-14): yours = the pill → Status, the
// average → Palate; someone's = either → their Palate. Two buttons on BOTH
// profiles, each fading on its own (device pass 2026-11-14: one fade over the
// whole line read as a single button). No handler = a plain view.
function StatLine({ level, avgScore, own, onPill, onAverage }: { level: string; avgScore: number | null; own: boolean; onPill?: () => void; onAverage?: () => void }) {
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
      <Tap onPress={onPill} label={own ? `Status: ${level}` : `Status: ${level}. Palate`}>
        <BadgePill
          label={level}
          bg={theme.accentTint}
          color={mix(theme.accent, theme.ink, 0.6)}
          uppercase={false}
          paddingHorizontal={10}
          style={{ alignSelf: 'center' }}
        />
      </Tap>
      {avgScore != null && avgScore > 0 ? (
        <Tap onPress={onAverage} label={`Average ${avgScore}. Palate`} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {/* The house score read (accent ★ + value). ⚠️ The mock draws the
              numeral in ink; StarScore's accent numeral is the canonical read. */}
          <StarScore value={avgScore} size={13} />
          <VText variant="small" color="inkSoft" style={{ fontFamily: 'InstrumentSans_500Medium', transform: [{ translateY: -lift }] }}>
            average
          </VText>
        </Tap>
      ) : null}
    </View>
  );
}

// A plain View without `onPress`, else a button with the press fade.
function Tap({ onPress, label, style, children }: { onPress?: () => void; label: string; style?: ViewStyle; children: ReactNode }) {
  if (!onPress) return <View style={style}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={{ top: 8, bottom: 8 }} onPress={onPress} style={({ pressed }) => [style, { opacity: pressed ? 0.6 : 1 }]}>
      {children}
    </Pressable>
  );
}

// .yo-cnfollows — "48 friends  212 followers", count in ink 600. Each opens
// People on its tab (D10); dimmed and inert while you edit your name or bio
// (a push would blur the field and drop the draft), like the status line.
function Counts({ friends, followers, onPeople, editing }: { friends: number; followers: number; onPeople?: (tab: PeopleTab) => void; editing: boolean }) {
  return (
    <View pointerEvents={editing ? 'none' : 'auto'} style={[{ flexDirection: 'row', gap: 14 }, editing ? { opacity: 0.35 } : null]}>
      <Count n={friends} word="friends" onPress={onPeople && !editing ? () => onPeople('friends') : undefined} />
      <Count n={followers} word="followers" onPress={onPeople && !editing ? () => onPeople('followers') : undefined} />
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
  onTile,
  onStatus,
  onPalate,
}: {
  profile: FullProfile;
  own: boolean;
  onFollowPress: () => void;
  followBusy: boolean;
  // The counts + in-common row open People (D10): `known` = "Only people you
  // know" on (the in-common row).
  onPeople?: (tab: PeopleTab, known?: boolean) => void;
  // A tile's tap opens its list (the lists step).
  onTile?: (key: TileKey) => void;
  // The status line's pages (StatLine): Status yours only.
  onStatus?: () => void;
  onPalate?: () => void;
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
      // 🔒 While editing the tiles are DISABLED (PhotoTiles `dimmed`):
      // `pointerEvents` only stops touches, and a VoiceOver activation would
      // still push (the blur drops the draft). Disabled, not handler-less: a
      // handler that comes and goes switches the tile's element type, which
      // remounted the tile and reloaded its photo (a flicker, device pass
      // 2026-11-14).
      onPress: onTile ? () => onTile(key) : undefined,
      // Every tile of your own, an empty one too: its sheet can add your own
      // photo (ruled 2026-11-12; it used to be inert with nothing to pick).
      onLongPress: edit ? () => edit.onTile(key) : undefined,
    }];
  });
  const stat = (
    <View pointerEvents={editing ? 'none' : 'auto'} style={editing ? { opacity: 0.35 } : null}>
      <StatLine
        level={profile.level.name}
        avgScore={profile.flavor.avgScore}
        own={own}
        onPill={editing ? undefined : own ? onStatus : onPalate}
        onAverage={editing ? undefined : onPalate}
      />
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
          username={profile.username}
          imageUrl={profile.imageUrl}
          onNameBottom={onNameBottom}
          photoNode={<PhotoSlot profile={profile} size={photo} edit={edit} onView={() => setViewing('photo')} />}
          edit={edit}
          stat={stat}
          counts={<Counts friends={profile.friendsCount} followers={profile.stats.followers} onPeople={onPeople} editing={editing} />}
        />
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
                the counts tucked 20 left under the photo's curve. With a
                username the pill's top sits as far under the sheet edge as
                the handle's baseline sits above it (COVER_SPEC, 8.5 at the
                104pt photo; the column starts 6 under the edge). */}
            <View style={{ top: profile.username ? coverLines(photo, 1).pillDrop - 6 : 2, left: -5 }}>{stat}</View>
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
  const { width, height: windowH, fontScale } = useWindowDimensions();
  const heroH = Math.round(windowH * HERO_RATIO) + SHEET_RISE;
  const box = notchBox(photo);
  const photoLeft = GUTTER - 8;
  const photoCx = photoLeft + photo / 2;
  const nameLeft = photoLeft + photo + NAME_GAP;
  // With a username (COVER_SPEC), in the hero's own coordinates: the handle's
  // baseline just above the sheet edge (the photo's centre line), the name's
  // above it, each left edge its gap from the photo's round edge.
  const username = profile.username;
  const { base: nameStyle } = useCoverNameStyle();
  const small = usePhoneTokens().text('small');
  const k = photo / PHOTO_BASE, r = photo / 2;
  const edgeY = heroH - SHEET_RISE;
  const { handleRise, nameRise } = coverLines(photo, fontScale);
  const curvedLeft = photoCx + r + COVER_SPEC.nameGap * k;
  const placed = useMemo<Placed | undefined>(
    () => (username ? {
      ring: { nameLeft: curvedLeft, photoCx, photo, gap: COVER_SPEC.nameGap * k, maxShift: photo / 4 },
      anchor: { dy: nameRise },
      avail: width - curvedLeft - NAME_RIGHT,
      place: { baseline: edgeY - nameRise, left: curvedLeft },
    } : undefined),
    [username, curvedLeft, photoCx, photo, k, nameRise, width, edgeY],
  );
  // The bar title's trigger is the NAME's bottom (not the handle's).
  const curvedNameBottom = username ? edgeY - nameRise + FONT.descent * nameStyle.fontSize * fontScale : null;
  useEffect(() => { if (curvedNameBottom != null) onNameBottom?.(curvedNameBottom); }, [onNameBottom, curvedNameBottom]);
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
      {placed && username ? (
        <>
          <ProfileName name={profile.name} variant="cover" edit={edit} placed={placed} />
          <ProfileHandle
            username={username}
            cover
            edit={edit}
            baseline={edgeY - handleRise}
            left={curveLeft(photoCx, r, COVER_SPEC.handleGap * k, handleRise + FONT.cap * small.fontSize * fontScale, handleRise)}
            right={NAME_RIGHT}
          />
        </>
      ) : (
        // No username: the name beside the photo as before, NAME_LIFT above
        // the sheet edge.
        <View
          style={{ position: 'absolute', left: nameLeft, right: NAME_RIGHT, bottom: SHEET_RISE + NAME_LIFT }}
          onLayout={(e) => onNameBottom?.(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
        >
          <ProfileName name={profile.name} variant="cover" edit={edit} fit={{ avail: width - nameLeft - NAME_RIGHT, nameLeft, photoCx, photo }} />
        </View>
      )}
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

// The handle on the cover (COVER_SPEC): white at 78%, medium, a soft shadow
// (the profile's secondary ink doesn't read on a photo).
const COVER_HANDLE = 'rgba(255,255,255,0.78)';
// The empty handle input's "@username" on the cover.
const COVER_HANDLE_FAINT = 'rgba(255,255,255,0.5)';
const COVER_HANDLE_STYLE = {
  fontFamily: 'InstrumentSans_500Medium', textShadowColor: 'rgba(0,0,0,0.25)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 8,
} as const;

// The white name on the cover: the title size, semibold.
function useCoverNameStyle() {
  const phone = usePhoneTokens();
  const tok = phone.text('title');
  return useMemo(() => {
    const fs = tok.fontSize;
    return { fs, base: { fontFamily: 'InstrumentSans_600SemiBold', color: '#fff', fontSize: fs, lineHeight: Math.round(fs * 1.05), letterSpacing: tok.letterSpacing } };
  }, [tok.fontSize, tok.letterSpacing]);
}

// Where a name sits when a `@username` is under it: its LAST baseline at
// `place.baseline` and `place.left` = the x `ring.nameLeft` stands for, both
// in the parent's box (the cover hero, the coverless identity row).
type Placed = { ring: NameRing; anchor: NameAnchor; avail: number; place: { baseline: number; left: number }; maxLines?: 1 | 2 };
// Before usernames (no `placed`): the cover's name in its bottom-anchored box.
type CoverFit = { avail: number; nameLeft: number; photoCx: number; photo: number };
type NameStyle = { fontFamily: string; color: string; fontSize: number; lineHeight: number; letterSpacing: number };
type NamePress = { disabled: boolean; onLongPress: () => void; hint: string };

// A profile name fitted to `avail` (coverGeometry `fitProfileName`): its size,
// or ≤ 4pt smaller, or two lines following the photo's ring. Measured at the
// base size first (hidden), so Dynamic Type is included. With `place` each
// line is put by its BASELINE in the parent's box (and `press` makes the block
// the own profile's long-press target); without it the lines flow in place.
function FittedName({
  name, base, lineRatio, avail, min, ring, anchor, maxLines, place, press,
}: {
  name: string;
  base: NameStyle;
  lineRatio: number;
  avail: number;
  min: number;
  ring?: NameRing;
  anchor?: NameAnchor;
  maxLines?: 1 | 2;
  place?: { baseline: number; left: number };
  press?: NamePress;
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
  const scale = ready ? cur.h! / base.lineHeight : 1;
  const fit = ready
    ? fitProfileName({
        fs, w: cur.widths[name], lineH: cur.h!, scale, avail, min, ring, anchor, maxLines,
        splits: breaks.map(([l1, l2]) => ({ w1: cur.widths[l1], w2: cur.widths[l2] })),
      })
    : null;
  const sized = (f: number) => (f === fs ? base : { ...base, fontSize: f, lineHeight: Math.round(f * lineRatio), letterSpacing: (base.letterSpacing * f) / fs });
  // Measuring pass: one line each, unconstrained, invisible.
  const measuring = (
    <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ position: 'absolute', opacity: 0, left: 0, bottom: 0, width: 4000, alignItems: 'flex-start' }}>
      {/* Keyed on the WHOLE measurement key, not just the string: after a
          rename a string both names share ("Simon") would otherwise keep
          its laid-out view, never fire onLayout again, and the fit would
          wait forever with the name invisible. */}
      {texts.map((t) => (
        <Text key={`${key}|${t}`} style={base} onLayout={(e) => measured(t, e.nativeEvent.layout.width, e.nativeEvent.layout.height)}>{t}</Text>
      ))}
    </View>
  );
  if (place) {
    if (!fit) return measuring;
    // One absolute box around the lines; in it each line is a baseline row,
    // `pitch` apart. A one-word name that wraps is ONE two-line text: a text
    // reports its FIRST line's baseline (React Native's paragraph node), so
    // its row sits a pitch higher and the second line lands on the name's
    // last baseline.
    const style = sized(fit.fontSize);
    const pitch = style.lineHeight * scale;
    const rows = fit.lines === 1 ? [{ text: name, indent: fit.indent }] : [{ text: breaks[fit.split][0], indent: fit.indent }, { text: breaks[fit.split][1], indent: fit.indent2 }];
    const wraps = fit.lines === 1 && fit.wrap;
    const visual = wraps ? 2 : rows.length;
    const strut = Math.ceil(pitch);
    const boxLeft = place.left + Math.min(...rows.map((l) => l.indent));
    const box = {
      position: 'absolute' as const,
      left: boxLeft,
      width: place.left + avail - boxLeft,
      top: place.baseline - (visual - 1) * pitch - strut,
      height: strut + (visual - 1) * pitch + Math.ceil(FONT.descent * fit.fontSize * scale) + 2,
    };
    const lines = rows.map((l, i) => (
      <BaselineRow key={i} top={i * pitch} left={place.left + l.indent - boxLeft} strut={strut}>
        <Text style={[style, { flexShrink: 1 }]} numberOfLines={wraps ? 2 : 1}>{l.text}</Text>
      </BaselineRow>
    ));
    return (
      <>
        {measuring}
        {press ? (
          // swapsOut: the input replaces this view (LongPressable).
          <LongPressable fill style={box} disabled={press.disabled} swapsOut onLongPress={press.onLongPress} accessibilityLabel={name} accessibilityHint={press.hint}>
            {lines}
          </LongPressable>
        ) : (
          <View accessible accessibilityRole="header" accessibilityLabel={name} style={box}>{lines}</View>
        )}
      </>
    );
  }
  return (
    <View accessible accessibilityRole="header" accessibilityLabel={name}>
      {measuring}
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

const EDIT_HINT = 'Double-tap and hold to edit your name, username and bio.';

// A profile's name: on the cover the white title, without one the ink
// heading. On your own profile (`edit`) it is the long-press target, or,
// while editing, its input in place (one line: the mock unfolds a fitted
// two-line name). `placed` = a username sits under it (baseline placement in
// the parent's box); otherwise the layout from before usernames (`fit` = the
// cover's ring).
function ProfileName({
  name, variant, edit, placed, fit,
}: {
  name: string;
  variant: 'cover' | 'plain';
  edit?: ProfileEdit;
  placed?: Placed;
  fit?: CoverFit;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const { fontScale } = useWindowDimensions();
  const { base: cover } = useCoverNameStyle();
  const curved = useCurvedNameStyle();
  const base = variant === 'cover' ? cover : curved;
  if (edit?.draft) {
    // Single-line raw input: no lineHeight (the Dynamic Type gate's single-line
    // policy; iOS centres the glyphs itself).
    const heading = phone.text('heading');
    const style =
      variant === 'cover'
        ? { fontFamily: cover.fontFamily, color: '#fff', fontSize: cover.fontSize, letterSpacing: cover.letterSpacing }
        : placed
          ? { fontFamily: curved.fontFamily, color: theme.ink, fontSize: curved.fontSize, letterSpacing: curved.letterSpacing }
          : { fontFamily: PLAIN_NAME_STYLE.fontFamily, color: theme.ink, fontSize: heading.fontSize, letterSpacing: heading.letterSpacing };
    const field = (
      <InlineField
        ref={edit.nameRef}
        value={edit.draft.name}
        onChangeText={(s) => edit.setDraft('name', s)}
        onFocus={() => edit.onFieldFocus('name')}
        autoFocus={edit.focus === 'name'}
        maxLength={64}
        onSubmit={edit.done}
        keepFocus={edit.doneBlocked}
        accessibilityLabel="Name"
        style={style}
      />
    );
    if (!placed) return field;
    // In the name's place: the input's own glyphs on the name's baseline (a
    // one-line input is as tall as the font's ascent + descent), shifted
    // along the photo's curve like the one-line name (`anchoredIndent`).
    const indent = anchoredIndent(placed.ring, placed.anchor.dy, FONT.cap * style.fontSize * fontScale);
    return (
      <View style={{ position: 'absolute', left: placed.place.left + indent, width: placed.avail - indent, top: placed.place.baseline - FONT.ascent * style.fontSize * fontScale }}>
        {field}
      </View>
    );
  }
  if (placed) {
    return (
      <FittedName
        name={name}
        base={base}
        lineRatio={base.lineHeight / base.fontSize}
        avail={placed.avail}
        min={Math.round((base.fontSize * 22) / 30)}
        ring={placed.ring}
        anchor={placed.anchor}
        maxLines={placed.maxLines}
        place={placed.place}
        press={edit ? { disabled: edit.busy != null, onLongPress: () => edit.start('name'), hint: EDIT_HINT } : undefined}
      />
    );
  }
  const plain = variant === 'cover' && fit
    ? <FittedName name={name} base={cover} lineRatio={1.05} avail={fit.avail} min={22} ring={{ nameLeft: fit.nameLeft, photoCx: fit.photoCx, photo: fit.photo }} />
    : <PlainName name={name} />;
  if (!edit) return plain;
  return (
    <LongPressable disabled={edit.busy != null} swapsOut onLongPress={() => edit.start('name')} accessibilityLabel={name} accessibilityHint={EDIT_HINT}>
      {plain}
    </LongPressable>
  );
}

// .yo-bio — one paragraph, small, 1.5 line height. Own + empty: the quiet
// hint (R5n), a pencil + "Touch and hold to add a bio" in the
// placeholder grey (ruled 2026-11-12: it names the gesture and reads as a
// prompt; never shown to anyone else). Touch and hold ONLY, as it says and as
// a written bio (Simon, 2026-11-13: a tap starting it contradicted the copy;
// it was tap-or-hold before). Editing: the
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
        keepFocus={edit.doneBlocked}
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
        swapsOut
        onLongPress={() => edit.start('bio')}
        accessibilityHint={EDIT_HINT}
      >
        {text}
      </LongPressable>
    );
  }
  if (!own || !edit) return null;
  return (
    <LongPressable
      disabled={edit.busy != null}
      swapsOut
      onLongPress={() => edit.start('bio')}
      accessibilityLabel="Add a Bio"
      accessibilityHint={EDIT_HINT}
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
