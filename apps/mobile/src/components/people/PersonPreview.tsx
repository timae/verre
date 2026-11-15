import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { UsernameLine } from '@/components/ui/UsernameLine';
import { VText } from '@/components/ui/VText';
import { ApiError } from '@/lib/api/sessions';
import { profileQueryOptions, type Profile } from '@/lib/api/users';
import { firstName } from '@/lib/initials';
import { viewerCacheEpoch } from '@/lib/query';
import { relate, usePersonBusy, type RelOp } from '@/lib/relationship';
import { feedHref, useSessionTab } from '@/lib/sessionStack';

// 04·12d's person: THE short preview of someone, before you open their
// profile. One card for a scanned code (`ScanResult`) and a person tapped
// inside a moment (`PersonPreviewSheet`, ruled 2026-11-15): photo, name,
// "@name · Follows you", friends in common, View Profile + Follow / Follow
// Back; private = no photo, same buttons; someone you blocked = "You blocked
// Mara." + Unblock ALONE (ruled 2026-11-15: no View Profile), at once like the
// profile's own Unblock, and the card turns into the normal one once their
// header reads back. Keyed on the PUBLIC id (never a name). `seed` is a header
// already in hand (a scanned `/@name` lookup): 🔒 only ever `initialData`,
// which TanStack writes into an EMPTY entry when this query starts, with the
// lookup's own time, so a write meanwhile (a follow or block through `relate`,
// another screen's read) is never overwritten by the older answer (Codex
// 2026-11-14: a late `setQueryData` from inside the lookup could).
// `leaveTo` closes whatever hosts the card, then pushes.
export function PersonPreview({ id, leaveTo, goneText, seed, seedAt, onRelated }: {
  id: string;
  leaveTo: (push: () => void) => void;
  goneText: string;
  seed?: Profile | null;
  seedAt?: number;
  onRelated?: (op: RelOp) => void;
}) {
  const router = useRouter();
  const mount = useSessionTab();
  const queryClient = useQueryClient();
  const q = useQuery({
    ...profileQueryOptions(id),
    initialData: seed && seed.id === id ? seed : undefined,
    initialDataUpdatedAt: seedAt,
  });
  const busy = usePersonBusy(id);
  const act = (op: RelOp) => {
    const epoch = viewerCacheEpoch();
    void relate(queryClient, id, op).then(({ ok }) => {
      if (ok && viewerCacheEpoch() === epoch) onRelated?.(op);
    });
  };

  if (q.isPending) return <PreviewSpinner />;
  const profile = q.data;
  if (q.isError || !profile) {
    // A room on one Wi-Fi shares the per-address profile budget (rl:profile,
    // 60 a minute): say so rather than "couldn't load".
    const limited = q.error instanceof ApiError && q.error.kind === 'rate-limited';
    return (
      <View style={{ gap: 14 }}>
        <PreviewMessage text={limited ? 'Too many profiles opened on this network. Try again in a minute.' : 'Couldn’t load this profile.'} />
        <Button title="Try Again" variant="secondary" block onPress={() => void q.refetch()} />
      </View>
    );
  }
  if (profile.state === 'gone') return <PreviewMessage text={goneText} />;
  if (profile.state === 'blocked') {
    return (
      <View style={{ gap: 14 }}>
        <Person name={profile.name} username={profile.username} imageUrl={null} line={`You blocked ${firstName(profile.name)}.`} />
        <Button title="Unblock" variant="secondary" loading={busy} block onPress={() => act('unblock')} />
      </View>
    );
  }
  const followsYou = profile.followsYou;
  const line = profile.state === 'ok' && profile.inCommon && profile.inCommon.count > 0
    ? `${profile.inCommon.count} ${profile.inCommon.count === 1 ? 'friend' : 'friends'} in common`
    : null;
  return (
    <View style={{ gap: 14 }}>
      <Person name={profile.name} username={profile.username} followsYou={followsYou} imageUrl={profile.state === 'ok' ? profile.imageUrl : null} line={line} />
      {/* .yo-ffoot — View Profile + their follow button. */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button title="View Profile" variant="secondary" style={{ flex: 1 }} onPress={() => leaveTo(() => router.push(feedHref(mount, 'profile', { id: profile.id })))} />
        {profile.isFollowing ? (
          <Button title={followsYou ? 'Friends' : 'Following'} icon="check" variant="secondary" style={{ flex: 1 }} disabled />
        ) : (
          <Button title={followsYou ? 'Follow Back' : 'Follow'} loading={busy} style={{ flex: 1 }} onPress={() => act('follow')} />
        )}
      </View>
    </View>
  );
}

function Person({ name, username, followsYou, imageUrl, line }: { name: string; username: string | null; followsYou?: boolean; imageUrl: string | null; line: string | null }) {
  return (
    // .yo-cam-person — the photo, the name, "@username · Follows you", one line.
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <Avatar imageUrl={imageUrl} name={name} size={56} initialsSize={20} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} numberOfLines={1}>{name}</VText>
        {/* "Follows you" rides the username's line only: someone without a
            username keeps the result from before (name + line). */}
        {username ? <UsernameLine username={username} suffix={followsYou ? 'Follows you' : null} /> : null}
        {line ? <VText variant="small" color="inkSoft">{line}</VText> : null}
      </View>
    </View>
  );
}

export function PreviewSpinner() {
  return (
    <View style={{ height: 96, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator />
    </View>
  );
}

export function PreviewMessage({ text }: { text: string }) {
  return <VText variant="body" color="inkSoft" style={{ paddingVertical: 8 }}>{text}</VText>;
}
