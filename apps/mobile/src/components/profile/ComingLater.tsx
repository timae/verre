import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BadgePill } from '@/components/moments/RoleChip';
import { Avatar } from '@/components/ui/Avatar';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { VText } from '@/components/ui/VText';
import { VBar } from '@/components/VBar';
import { profileQueryOptions } from '@/lib/api/users';
import { GUTTER, TAB_BAR_CLEARANCE } from '@/lib/layout';
import { useMeId } from '@/lib/meId';
import { mix } from '@/theme/color';
import { useTheme } from '@/theme';
import { firstName } from '@/lib/initials';

// The status line's two pages, as placeholders until they are built (ruled
// 2026-11-14): Status (design 04·R5s, your own: the status pill) and Palate
// (04·R5b / 04·5c: the ★ average on yours, the pill or the average on
// someone's). The mock's `.yo-soon` block under a pushed bar with the owner's
// 26pt photo (Discoveries' bar), centred on the page both ways like a
// CenteredMessage (device pass 2026-11-14). No pronouns for someone else:
// their name.

export function StatusScreen() {
  const meId = useMeId();
  const { theme } = useTheme();
  const { profile } = useOwnerProfile(meId);
  return (
    <ComingLater title="Status" owner={profile}>
      {profile ? (
        // BadgePill hugs the left by default (alignSelf flex-start).
        <BadgePill label={profile.level.name} bg={theme.accentTint} color={mix(theme.accent, theme.ink, 0.6)} uppercase={false} paddingHorizontal={10} style={{ alignSelf: 'center' }} />
      ) : null}
      <Heading>Status, Points and Badges</Heading>
      <Body>Coming later. This page will show your status, how points are earned and the badges you’ve collected.</Body>
    </ComingLater>
  );
}

export function PalateScreen({ userId }: { userId: string }) {
  const meId = useMeId();
  const { profile, settled } = useOwnerProfile(userId);
  const own = meId === userId;
  const name = profile ? firstName(profile.name) : '';
  // Someone's header settled without `ok` (shell, blocked, gone, a failed
  // read, a deep link): the route's own "not available" line.
  if (!own && !profile && settled) {
    return (
      <ComingLater title="Palate" owner={null} fill>
        <CenteredMessage title="This palate isn’t available" />
      </ComingLater>
    );
  }
  return (
    <ComingLater title="Palate" owner={profile}>
      {own ? (
        <>
          <Heading>Your Palate</Heading>
          <Body>Coming later. This page will show how you rate, what you taste and the aromas you notice most.</Body>
        </>
      ) : profile ? (
        <>
          <Heading>{`${name}’s Palate`}</Heading>
          <Body>{`Coming later. Here you’ll see how ${name} rates and tastes, next to your own.`}</Body>
        </>
      ) : null}
    </ComingLater>
  );
}

// The owner's header (cached from the profile that pushed this page), only in
// the `ok` state: nothing of a shell, blocked or gone profile shows here.
function useOwnerProfile(userId: string | null) {
  const q = useQuery({ ...profileQueryOptions(userId ?? ''), enabled: userId != null });
  return { profile: q.data?.state === 'ok' ? q.data : null, settled: !q.isPending };
}

// `fill`: the body is its own full-height message (CenteredMessage) instead of the `.yo-soon` column.
function ComingLater({ title, owner, fill, children }: { title: string; owner: { imageUrl: string | null; name: string } | null; fill?: boolean; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const photo = owner?.imageUrl ? <Avatar imageUrl={owner.imageUrl} name={owner.name} size={26} /> : undefined;
  return (
    <View style={{ flex: 1, paddingTop: insets.top }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title={title} titleLeading={photo} />
      </View>
      {/* .yo-soon: a centred column, gap 10, 28 at the sides; centred
          vertically in what you SEE between the bar and the floating tab bar
          (TAB_BAR_CLEARANCE: centred on the whole area it sat low, device
          pass 2026-11-14; the mock's 80 top padding floated high). */}
      <View style={{ flex: 1, paddingBottom: TAB_BAR_CLEARANCE }}>
        {fill ? children : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 28 }}>{children}</View>}
      </View>
    </View>
  );
}

// .yo-soon-t 700 20 ink (subhead: 18, 20 on the big phones) · .yo-soon p
// 14/1.45 ink-soft (body 15: the scale has no 14).
function Heading({ children }: { children: string }) {
  return <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_700Bold', textAlign: 'center' }}>{children}</VText>;
}
function Body({ children }: { children: string }) {
  return <VText variant="body" color="inkSoft" style={{ textAlign: 'center' }}>{children}</VText>;
}
