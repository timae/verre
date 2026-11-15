import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Keyboard, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/ui/Avatar';
import { IconPill } from '@/components/ui/IconPill';
import { TabStrip } from '@/components/ui/TabStrip';
import { VBar } from '@/components/VBar';
import type { ListKind } from '@/lib/api/lists';
import { profileQueryOptions } from '@/lib/api/users';
import { GUTTER } from '@/lib/layout';
import { useMeId } from '@/lib/meId';
import { checkinHref, momentCreateHref, useSessionTab } from '@/lib/sessionStack';
import { CravingsPane } from './CravingsScreen';
import { ImpressionsPane } from './ImpressionsScreen';
import { MomentsPane } from './MomentsListScreen';

const KINDS: readonly { key: ListKind; label: string }[] = [
  { key: 'impressions', label: 'Impressions' },
  { key: 'moments', label: 'Moments' },
  { key: 'cravings', label: 'Cravings' },
];

// "Discoveries" (Simon, 2026-11-13): someone's (or your) three tile lists on
// ONE page, switched by People's tab strip without counts. A tile tap opens it
// on that tile's tab (the three routes stay the entry points; a switch is
// in-screen, no navigation). The tabs are the tiles this viewer sees (an
// absent key = hidden by the owner, step 4; yours: all three; while the header
// is unknown: all three), the tapped one always; one tab alone → no strip. A
// pane mounts on its first visit and stays mounted while you are on the page,
// so its search, filters and scroll survive a switch. Bar: the owner's 26pt
// photo before the title (the mock's pushBar `.yo-tav`, shown like the
// profile's bar: only with a photo) and the open tab's button on the right
// (yours, not on an opened post's stack).
export function DiscoveriesScreen({ userId, initial }: { userId: string; initial: ListKind }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const mount = useSessionTab();
  const meId = useMeId();
  const own = meId === userId;
  const headerQ = useQuery(profileQueryOptions(userId));
  const profile = headerQ.data?.state === 'ok' ? headerQ.data : null;

  const tabs = KINDS.filter(({ key }) => own || !profile || key === initial || profile.tiles[key] !== undefined);
  const [picked, setPicked] = useState<ListKind>(initial);
  const tab = tabs.some((t) => t.key === picked) ? picked : initial;
  const [visited, setVisited] = useState<ReadonlySet<ListKind>>(() => new Set([initial]));
  const select = (k: ListKind) => {
    Keyboard.dismiss(); // a focused search must not stay up behind a hidden pane
    setPicked(k);
    setVisited((v) => (v.has(k) ? v : new Set(v).add(k)));
  };

  const right = !own || mount.post != null ? null
    : tab === 'impressions' ? <IconPill icon="plus" label="Check In" accessibilityLabel="New Check-In" onPress={() => router.push(checkinHref(mount))} />
    : tab === 'moments' ? <IconPill icon="plus" label="New" accessibilityLabel="New Moment" onPress={() => router.push(momentCreateHref(mount))} />
    : null;
  const photo = profile?.imageUrl ? <Avatar imageUrl={profile.imageUrl} name={profile.name} size={26} /> : undefined;

  return (
    <BottomSheetModalProvider>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={{ paddingHorizontal: GUTTER }}>
          <VBar title="Discoveries" titleLeading={photo} right={right} />
          {tabs.length > 1 ? <TabStrip tabs={tabs} active={tab} onSelect={select} fit /> : null}
        </View>
        {KINDS.map(({ key }) => {
          if (!visited.has(key)) return null;
          const shown = key === tab;
          if (key === 'impressions') return <ImpressionsPane key={key} userId={userId} active={shown} />;
          if (key === 'moments') return <MomentsPane key={key} userId={userId} active={shown} />;
          return <CravingsPane key={key} userId={userId} active={shown} />;
        })}
      </View>
    </BottomSheetModalProvider>
  );
}
