import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { SetGroup, SetNav, SetPage, SettingsScreenFallback } from '@/components/moments/settingsParts';
import { firstName } from '@/components/profile/ProfileHeader';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { BLOCKS_KEY, MUTES_KEY, getBlocks, getMutes, type ListedPerson } from '@/lib/api/settings';
import { setBlocked, setMuted } from '@/lib/api/users';
import { authClient } from '@/lib/authClient';
import { errorText } from '@/lib/errorCopy';
import { refetchNetworkFeed, refetchProfileHeader } from '@/lib/feedCache';
import { viewerCacheEpoch } from '@/lib/query';

// Settings → Privacy → Blocked / Muted (ruling Q-B): your own list, newest
// first. Rows: the initials disc, the name, a tertiary Unblock / Unmute. The
// row leaves on success; the last one leaving shows the empty line. Unblock
// asks once (house native alert); Unmute acts at once. After the write, the
// affected caches refetch IN PLACE (never invalidate a feed cache): the
// person's header, the network feed, and, for an unblock, YOUR header too
// (follower counts are block-scrubbed). For a mutual block this page is the
// only way to unblock (both profiles read as gone).
const KINDS = {
  blocked: {
    title: 'Blocked', key: BLOCKS_KEY, fetch: getBlocks, action: 'Unblock', empty: 'No one blocked.',
    write: (id: number) => setBlocked(id, false), refreshOwnHeader: true,
  },
  muted: {
    title: 'Muted', key: MUTES_KEY, fetch: getMutes, action: 'Unmute', empty: 'No one muted.',
    write: (id: number) => setMuted(id, false), refreshOwnHeader: false,
  },
} as const;

export function PeopleListPage({ kind }: { kind: keyof typeof KINDS }) {
  const k = KINDS[kind];
  const queryClient = useQueryClient();
  const meId = authClient.useSession().data?.user.id;
  const q = useQuery({ queryKey: k.key, queryFn: k.fetch });
  const [busyId, setBusyId] = useState<number | null>(null);

  const run = async (p: ListedPerson) => {
    if (busyId != null) return;
    const epoch = viewerCacheEpoch();
    setBusyId(p.id);
    try {
      await k.write(p.id);
    } catch (e) {
      if (viewerCacheEpoch() === epoch) Alert.alert('Something went wrong', errorText(e));
      setBusyId(null);
      return;
    }
    if (viewerCacheEpoch() !== epoch) return setBusyId(null);
    await queryClient.cancelQueries({ queryKey: k.key, exact: true });
    if (viewerCacheEpoch() === epoch) queryClient.setQueryData<ListedPerson[]>(k.key, (rows) => rows?.filter((r) => r.id !== p.id));
    setBusyId(null);
    if (viewerCacheEpoch() !== epoch) return;
    const jobs: Promise<unknown>[] = [refetchProfileHeader(queryClient, p.id), refetchNetworkFeed(queryClient)];
    if (k.refreshOwnHeader && meId != null) jobs.push(refetchProfileHeader(queryClient, Number(meId)));
    await Promise.allSettled(jobs);
  };
  const onAction = (p: ListedPerson) => {
    if (kind === 'muted') return void run(p);
    const first = firstName(p.name);
    Alert.alert(`Unblock ${first}?`, `${first} will be able to see your profile and posts again.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unblock', onPress: () => void run(p) },
    ]);
  };

  if (q.isError && !q.data) {
    return <SettingsScreenFallback title={k.title} isError errorTitle="Couldn’t load this list" retrying={q.isFetching} onRetry={() => void q.refetch()} />;
  }
  return (
    <SetPage title={k.title}>
      {!q.data ? (
        <View style={{ paddingTop: 24, alignItems: 'center' }}><ActivityIndicator /></View>
      ) : q.data.length === 0 ? (
        <VText variant="body" color="inkSoft">{k.empty}</VText>
      ) : (
        <SetGroup flush>
          {q.data.map((p) => (
            <SetNav
              key={p.id}
              label={p.name}
              leading={<Avatar name={p.name} size={36} initialsSize={12} />}
              trailing={
                <Button
                  title={k.action}
                  variant="tertiary"
                  size="sm"
                  loading={busyId === p.id}
                  disabled={busyId != null && busyId !== p.id}
                  accessibilityLabel={`${k.action} ${p.name}`}
                  onPress={() => onAction(p)}
                />
              }
            />
          ))}
        </SetGroup>
      )}
    </SetPage>
  );
}
