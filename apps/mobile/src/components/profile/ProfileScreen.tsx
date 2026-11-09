import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedList } from '@/components/feed/FeedList';
import { EmptyPosts, FollowButton, NoticeBox, ProfileHeader, ProfileIdentity, firstName } from '@/components/profile/ProfileHeader';
import { AnchorButton, AnchoredMenu, MenuItem, MenuSeparator, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { Button } from '@/components/ui/Button';
import { CenteredMessage, ErrorState } from '@/components/ui/ConnectionState';
import { VBar } from '@/components/VBar';
import { ApiError } from '@/lib/api/sessions';
import { profileKey, profileQueryOptions, setBlocked, setFollowing, setMuted, type Profile } from '@/lib/api/users';
import { authClient } from '@/lib/authClient';
import { refetchNetworkFeed, refetchProfileHeader } from '@/lib/feedCache';
import { viewerCacheEpoch } from '@/lib/query';
import { GUTTER, usePhoneTokens } from '@/lib/layout';
import { useTheme } from '@/theme';

// A person's profile (handoff 04 "You", step 1 — no bio, cover or editing):
// the You tab's root for yourself (`root`), and a screen pushed on the Feed /
// You stacks for anyone (including yourself from a feed card, with back).
// Below the header, that person's posts through the SAME FeedList as the Feed
// tab (`/api/feed?user=`, cache ['feed', 'user', id]) — no second feed.
//
// States off GET /api/users/:id?view=header: ok (own / someone else),
// private (tier-gated "shell"), blocked by you, gone (no such user, or they
// blocked you — indistinguishable by design), plus loading / error.

export function ProfileScreen({ userId, root }: { userId: number; root?: boolean }) {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const meId = authClient.useSession().data?.user.id;
  const own = meId != null && Number(meId) === userId;

  const profileQ = useQuery(profileQueryOptions(userId));
  const profile = profileQ.data;

  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [busy, setBusy] = useState(false);

  // Relationship writes. Afterwards the profile header AND the network feed
  // (['feed'], exact — whose authors follow / mute / block change) refetch IN
  // PLACE, cancel-first (lib/feedCache.ts; never invalidate a feed cache).
  // This person's own post list is untouched: mute never filters it, and
  // block / private states unmount it. An optimistic patch makes the header
  // answer at once. On failure the pre-action header is put back FIRST (the
  // refetch below can fail too, e.g. offline, and must not leave the button
  // claiming a write that failed). Every cache write after an await checks the
  // viewer epoch (lib/query.tsx): a sign-out meanwhile cleared this viewer's
  // cache, and nothing of theirs may be written back into it.
  const act = useCallback(
    async (op: () => Promise<void>, optimistic?: (p: Profile) => Profile) => {
      if (busy) return;
      setBusy(true);
      const epoch = viewerCacheEpoch();
      const key = profileKey(userId);
      // An in-flight read must not land over the optimistic patch.
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const before = queryClient.getQueryData<Profile>(key);
      if (optimistic && before && viewerCacheEpoch() === epoch) queryClient.setQueryData<Profile>(key, optimistic(before));
      try {
        await op();
      } catch (e) {
        // Signed out (or switched) meanwhile: this viewer's cache is gone and
        // must not be recreated; neither the rollback nor the refetch runs.
        if (viewerCacheEpoch() !== epoch) return;
        if (optimistic && before) queryClient.setQueryData<Profile>(key, before);
        const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
        Alert.alert('Something went wrong', msg || 'Check your connection and try again.');
      } finally {
        if (viewerCacheEpoch() === epoch) {
          await Promise.allSettled([refetchProfileHeader(queryClient, userId), refetchNetworkFeed(queryClient)]);
        }
        setBusy(false);
      }
    },
    [busy, queryClient, userId],
  );

  const follow = () =>
    act(
      () => setFollowing(userId, true),
      (p) => (p.state === 'ok' || p.state === 'shell' ? { ...p, isFollowing: true } : p),
    );
  // Unfollow asks first (it can end a friendship); following acts immediately.
  const confirmUnfollow = (name: string) =>
    Alert.alert(`Unfollow ${firstName(name)}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unfollow',
        style: 'destructive',
        onPress: () =>
          act(
            () => setFollowing(userId, false),
            (p) => (p.state === 'ok' || p.state === 'shell' ? { ...p, isFollowing: false } : p),
          ),
      },
    ]);
  const onFollowPress = (p: { name: string; isFollowing: boolean }) => (p.isFollowing ? confirmUnfollow(p.name) : follow());
  // Mute doesn't ask (design 04·5a note); it only filters YOUR network feed.
  const setMute = (on: boolean) => act(() => setMuted(userId, on), (p) => (p.state === 'ok' ? { ...p, viewerMutes: on } : p));
  // Block asks once more — the house native destructive alert naming the
  // person, with the design's BLOCKSHEET copy (docs/dev/block.md semantics).
  const confirmBlock = (name: string) => {
    const first = firstName(name);
    Alert.alert(
      `Block ${first}?`,
      `${first} won’t see your profile, impressions, moments or cravings, and can’t find you in search. You won’t see theirs either. They aren’t told.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Block', style: 'destructive', onPress: () => act(() => setBlocked(userId, true)) },
      ],
    );
  };
  const unblock = () => act(() => setBlocked(userId, false));

  const close = () => setMenu(null);
  // Your own ⋯ never depends on the profile query: Settings holds the only
  // signed-in Sign Out, so it must survive a failed or slow profile load.
  const menuButton = own || (profile && profile.state !== 'gone') ? (
    <AnchorButton onOpen={setMenu} accessibilityLabel="Profile Options" />
  ) : null;

  // ⋯ menus (MY_MENU / HER_MENU). Rows marked "Soon" are inactive in step 1
  // (their screens come later); MenuItem `disabled` renders that tag.
  const menuItems = own ? (
    <>
      <MenuItem icon="edit" label="Edit Profile" disabled />
      <MenuItem icon="user-plus" label="Add Friends" disabled />
      <MenuItem icon="share" label="Share Profile" disabled />
      <MenuSeparator />
      <MenuItem
        icon="settings"
        label="Settings"
        onPress={() => {
          close();
          router.push('/you/settings');
        }}
      />
    </>
  ) : !profile ? null : profile.state === 'ok' ? (
    <>
      <MenuItem icon="share" label="Share Profile" disabled />
      <MenuItem icon="glass" label="Invite to a Moment" disabled />
      <MenuSeparator />
      <MenuItem
        icon={profile.viewerMutes ? 'eye' : 'eyeoff'}
        label={profile.viewerMutes ? 'Unmute in Feed' : 'Mute in Feed'}
        onPress={() => {
          close();
          setMute(!profile.viewerMutes);
        }}
      />
      {profile.isFollowing ? (
        <MenuItem
          icon="user"
          label="Unfollow"
          onPress={() => {
            close();
            confirmUnfollow(profile.name);
          }}
        />
      ) : null}
      <MenuItem
        icon="block"
        label="Block"
        tone="danger"
        onPress={() => {
          close();
          confirmBlock(profile.name);
        }}
      />
    </>
  ) : profile.state === 'shell' ? (
    <>
      <MenuItem icon="share" label="Share Profile" disabled />
      <MenuSeparator />
      {profile.isFollowing ? (
        <MenuItem
          icon="user"
          label="Unfollow"
          onPress={() => {
            close();
            confirmUnfollow(profile.name);
          }}
        />
      ) : null}
      <MenuItem
        icon="block"
        label="Block"
        tone="danger"
        onPress={() => {
          close();
          confirmBlock(profile.name);
        }}
      />
    </>
  ) : profile.state === 'blocked' ? (
    <>
      <MenuItem icon="share" label="Share Profile" disabled />
      <MenuSeparator />
      <MenuItem
        icon="block"
        label="Unblock"
        onPress={() => {
          close();
          unblock();
        }}
      />
    </>
  ) : null;

  const bar = root ? <RootBar right={menuButton} /> : <VBar title="" right={menuButton} />;

  let body: React.ReactNode;
  if (!profile) {
    body = profileQ.isError ? (
      <ErrorState onRetry={() => profileQ.refetch()} retrying={profileQ.isFetching} />
    ) : (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.inkSoft} />
      </View>
    );
  } else if (profile.state === 'gone') {
    body = <CenteredMessage title="This profile isn’t available" />;
  } else if (profile.state === 'blocked') {
    // 04·5b: looks like a new profile — initials and name only, no images,
    // status, numbers or posts. Unblock right there.
    body = (
      <View style={{ paddingHorizontal: GUTTER, paddingTop: 4 }}>
        <ProfileIdentity name={profile.name} imageUrl={null} />
        <NoticeBox
          text={`You blocked ${firstName(profile.name)}.`}
          action={<Button size="sm" variant="secondary" title="Unblock" loading={busy} onPress={unblock} />}
        />
      </View>
    );
  } else if (profile.state === 'shell') {
    // Private (their tier doesn't admit you): the blocked layout + Follow and
    // one sentence (Simon's ruling).
    body = (
      <View style={{ paddingHorizontal: GUTTER, paddingTop: 4 }}>
        <ProfileIdentity name={profile.name} imageUrl={null} />
        <NoticeBox
          text={`Only people ${firstName(profile.name)} shares with can see this profile.`}
          action={
            <FollowButton isFollowing={profile.isFollowing} followsYou={false} busy={busy} onPress={() => onFollowPress(profile)} />
          }
        />
      </View>
    );
  } else {
    body = (
      <FeedList
        userId={userId}
        contentTopPad={4}
        onRefresh={() => profileQ.refetch()}
        header={
          <View style={{ paddingHorizontal: GUTTER, paddingBottom: 20 }}>
            <ProfileHeader profile={profile} own={own} followBusy={busy} onFollowPress={() => onFollowPress(profile)} />
          </View>
        }
        empty={
          own ? (
            <EmptyPosts title="No check-ins yet" body="Your impressions and moments will show up here." />
          ) : (
            <EmptyPosts title="No check-ins yet" />
          )
        }
      />
    );
  }

  return (
    <View style={{ flex: 1, paddingTop: insets.top }}>
      <View style={{ paddingHorizontal: GUTTER }}>{bar}</View>
      {body}
      <AnchoredMenu anchor={menu} onClose={close} right={16} minWidth={220}>
        {menuItems}
      </AnchoredMenu>
    </View>
  );
}

// The root tab's bar: no back (it IS the tab), the ⋯ on the right. Same
// height as VBar so the header sits where a pushed profile's does.
function RootBar({ right }: { right: React.ReactNode }) {
  const phone = usePhoneTokens();
  const height = phone.surface('topBar').height(phone.size('topBar'));
  return <View style={{ height, marginBottom: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>{right}</View>;
}
