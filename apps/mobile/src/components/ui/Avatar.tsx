import { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { initials } from '@/lib/initials';
import { usePhoneTokens } from '@/lib/layout';
import { useTheme } from '@/theme';
import { mix } from '@/theme/color';

// Person avatar circle — the canonical image → initials → (anon) user-glyph
// cascade. Extracted from ~6 hand-rolled copies (PeopleSheet PersonRow,
// InviteSheet FriendChip/FriendRow, the line-up AvatarFoot stack). Variants:
//  - `anon`: account-less taster → a `user` glyph on surfaceSunk (never initials).
//  - `host`: tints the initials fallback accent (accent bg + accent-ink text)
//    instead of surfaceSunk/ink-soft.
//  - `tint`: the profile's initials disc (.yo-rav-ini) — accent-TINT bg with
//    accent-toward-ink initials; softer than `host`.
//  - `ring`: the overlapping-stack treatment (a 2px theme-bg border, with the
//    image inset inside it) used by the avatar-stack foot.
//  - `badge`: an overlay pinned bottom-right (e.g. the FriendChip "+" invite
//    badge) — pass the node; it's rendered over the circle.
// `initialsSize` overrides the initials font size (call sites use 12–16 at
// 30–52px; there's no clean ratio, so the size is explicit where it matters).
const INITIALS_AFTER_MS = 1200;

export function Avatar({
  imageUrl, name, size, anon, host, tint, ring, badge, initialsSize,
}: {
  imageUrl?: string | null;
  name: string;
  size: number;
  anon?: boolean;
  host?: boolean;
  tint?: boolean;
  ring?: boolean;
  badge?: React.ReactNode;
  initialsSize?: number;
}) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  // A photo that fails (gone from the store) or HANGS (stored under a host
  // this device can't reach: iOS only errors after its ~60s network timeout)
  // shows the initials, never an empty circle. The initials sit UNDER the
  // image and appear once it has failed or hasn't loaded within
  // INITIALS_AFTER_MS; a normal (or cached) load lands first and covers them,
  // so lists don't flicker. All keyed on the URL: a new photo gets a fresh try.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [slowUrl, setSlowUrl] = useState<string | null>(null);
  const photo = !anon && imageUrl && imageUrl !== failedUrl ? imageUrl : null;
  const loaded = photo != null && loadedUrl === photo;
  useEffect(() => {
    if (!photo || loaded) return;
    const t = setTimeout(() => setSlowUrl(photo), INITIALS_AFTER_MS);
    return () => clearTimeout(t);
  }, [photo, loaded]);
  const showInitials = !anon && (!photo || (!loaded && slowUrl === photo));
  const r = size / 2;
  const border = ring ? 2 : 0;
  const inner = size - border * 2; // image/content box inside the ring
  const fontSize = initialsSize ?? Math.round(size * 0.34);
  // VText's default (body) line box is ~23pt; Instrument Sans needs 1.22× its
  // size, so initials past ~18pt (the profile's 104pt disc) had their tops
  // clipped by iOS (Simulator, 2026-11-09). Give big initials a line box that
  // fits; the small avatars keep the body line exactly as before.
  const fitLine = Math.ceil(fontSize * 1.25);
  const lineHeight = fitLine > phone.text('body').lineHeight ? fitLine : undefined;

  const circleBase = {
    width: size,
    height: size,
    borderRadius: r,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
    ...(ring ? { borderWidth: 2, borderColor: theme.bg } : null),
  };

  const inside = (
    <>
      {anon ? <Icon name="user" size={Math.round(size * 0.5)} color={theme.inkFaint} /> : null}
      {showInitials ? (
        <VText
          style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize, lineHeight, letterSpacing: tint ? -0.02 * fontSize : undefined }}
          color={host ? theme.accentInk : tint ? mix(theme.accent, theme.ink, 0.6) : 'inkSoft'}
        >
          {initials(name)}
        </VText>
      ) : null}
      {photo ? (
        <Image
          // A fresh native view per URL: iOS keeps the previous bitmap while a
          // new source loads, which would hide the initials under the OLD
          // photo while the new one hangs (Codex).
          key={photo}
          source={{ uri: photo }}
          onLoad={() => setLoadedUrl(photo)}
          onError={() => setFailedUrl(photo)}
          style={{ position: 'absolute', width: inner, height: inner, borderRadius: inner / 2 }}
        />
      ) : null}
    </>
  );

  // Background: image circles + anon use surfaceSunk; the initials (none, or a
  // photo that failed / is hanging) use accent when host, else the tint /
  // surfaceSunk.
  const bg = anon || (photo && !showInitials) ? theme.surfaceSunk : host ? theme.accent : tint ? theme.accentTint : theme.surfaceSunk;

  const circle = <View style={[circleBase, { backgroundColor: bg }]}>{inside}</View>;
  if (!badge) return circle;
  return (
    <View style={{ width: size, height: size }}>
      {circle}
      {badge}
    </View>
  );
}
