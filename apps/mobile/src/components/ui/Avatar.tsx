import { Image, View } from 'react-native';
import { Icon } from '@/components/ui/Icon';
import { VText } from '@/components/ui/VText';
import { initials } from '@/lib/initials';
import { useTheme } from '@/theme';

// Person avatar circle — the canonical image → initials → (anon) user-glyph
// cascade. Extracted from ~6 hand-rolled copies (PeopleSheet PersonRow,
// InviteSheet FriendChip/FriendRow, the line-up AvatarFoot stack). Variants:
//  - `anon`: account-less taster → a `user` glyph on surfaceSunk (never initials).
//  - `host`: tints the initials fallback accent (accent bg + accent-ink text)
//    instead of surfaceSunk/ink-soft.
//  - `ring`: the overlapping-stack treatment (a 2px theme-bg border, with the
//    image inset inside it) used by the avatar-stack foot.
//  - `badge`: an overlay pinned bottom-right (e.g. the FriendChip "+" invite
//    badge) — pass the node; it's rendered over the circle.
// `initialsSize` overrides the initials font size (call sites use 12–16 at
// 30–52px; there's no clean ratio, so the size is explicit where it matters).
export function Avatar({
  imageUrl, name, size, anon, host, ring, badge, initialsSize,
}: {
  imageUrl?: string | null;
  name: string;
  size: number;
  anon?: boolean;
  host?: boolean;
  ring?: boolean;
  badge?: React.ReactNode;
  initialsSize?: number;
}) {
  const { theme } = useTheme();
  const r = size / 2;
  const border = ring ? 2 : 0;
  const inner = size - border * 2; // image/content box inside the ring
  const fontSize = initialsSize ?? Math.round(size * 0.34);

  const circleBase = {
    width: size,
    height: size,
    borderRadius: r,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
    ...(ring ? { borderWidth: 2, borderColor: theme.bg } : null),
  };

  let inside: React.ReactNode;
  if (anon) {
    inside = <Icon name="user" size={Math.round(size * 0.5)} color={theme.inkFaint} />;
  } else if (imageUrl) {
    inside = <Image source={{ uri: imageUrl }} style={{ width: inner, height: inner, borderRadius: inner / 2 }} />;
  } else {
    inside = (
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize }} color={host ? theme.accentInk : 'inkSoft'}>
        {initials(name)}
      </VText>
    );
  }

  // Background: image circles + anon use surfaceSunk; an initials fallback uses
  // accent when host, else surfaceSunk.
  const bg = anon ? theme.surfaceSunk : imageUrl ? theme.surfaceSunk : host ? theme.accent : theme.surfaceSunk;

  const circle = <View style={[circleBase, { backgroundColor: bg }]}>{inside}</View>;
  if (!badge) return circle;
  return (
    <View style={{ width: size, height: size }}>
      {circle}
      {badge}
    </View>
  );
}
