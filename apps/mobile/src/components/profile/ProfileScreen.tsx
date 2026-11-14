import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Keyboard, Platform, Pressable, View, useWindowDimensions, type TextInputInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { checkUsername, normalizeBio, validateDisplayName } from '@verre/core';
import { FeedList, type FeedScrollHandle } from '@/components/feed/FeedList';
import { pickPhotoOrRemove } from '@/components/moments/momentForm';
import { AddFriendsSheet } from '@/components/people/AddFriendsSheet';
import { EditBar, editTouchHandlers, markNoShake, type EditBarLine } from '@/components/profile/ProfileEditParts';
import { EmptyPosts, FollowButton, NoticeBox, ProfileHeader, ProfileIdentity, firstName, type EditField, type ProfileEdit } from '@/components/profile/ProfileHeader';
import { TileCoverSheet } from '@/components/profile/TileCoverSheet';
import { AnchorButton, AnchoredMenu, MenuItem, MenuSeparator, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { CenteredMessage, ErrorState } from '@/components/ui/ConnectionState';
import { Icon } from '@/components/ui/Icon';
import { RESERVED_TEXT, useUsernameCheck } from '@/components/ui/UsernameField';
import { BarTitle, VBar, useBarTitleProgress } from '@/components/VBar';
import {
  applyOwnProfileChange, freshOwnName, patchProfile, removeAvatar, removeCover, uploadAvatar, uploadCover, uploadTilePhoto, type TileKey,
} from '@/lib/api/profile';
import type { PeopleTab } from '@/lib/api/people';
import { type CheckinVisibility } from '@/lib/api/settings';
import { profileKey, profileQueryOptions } from '@/lib/api/users';
import { USERNAME_KEY, getUsernameState } from '@/lib/api/username';
import { authClient } from '@/lib/authClient';
import { useForwardStatusBarStyle } from '@/lib/forwardedStatusBar';
import { errorText, sentence } from '@/lib/errorCopy';
import { confirmUnfollow, relate, usePersonBusy, type RelOp } from '@/lib/relationship';
import { shareProfile } from '@/lib/shareProfile';
import { usePushGuard } from '@/lib/usePushGuard';
import { viewerCacheEpoch } from '@/lib/query';
import { GLASS_FILL, GUTTER, heroBarHeight, usePhoneTokens } from '@/lib/layout';
import { feedHref, settingsHref, useSessionTab } from '@/lib/sessionStack';
import { popSheet, pushSheet } from '@/lib/sheetVisibility';
import { useTheme } from '@/theme';
import { useMeId } from '@/lib/meId';
import { DATE_LOCALE } from '@/lib/locale';
import { usernameBarLine, usernameQuotaLine } from '@/lib/usernameCopy';
import { saveUsername } from '@/lib/usernameSave';

// A person's profile (handoff 04 "You"): the You tab's root for yourself
// (`root`), and a screen pushed on the Feed / You stacks for anyone (including
// yourself from a feed card, with back). Below the header, that person's posts
// through the SAME FeedList as the Feed tab (`/api/feed?user=`, cache
// ['feed', 'user', id]) — no second feed.
//
// States off GET /api/users/:id?view=header: ok (own / someone else),
// private (tier-gated "shell"), blocked by you, gone (no such user, or they
// blocked you — indistinguishable by design), plus loading / error.
//
// With a cover (step 2, 04·R5i·b) the header runs full-bleed under the status
// bar and the bar floats over it: glass back / ⋯ over the photo, collapsing to
// the solid bar + photo · name once the name on the cover passes under it (the
// moment cover bar's look). Your own profile is editable in place (R5g2–R5g4):
// this screen owns the edit session; ProfileHeader renders it.

export function ProfileScreen({ userId, root }: { userId: string; root?: boolean }) {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const router = useRouter();
  const phone = usePhoneTokens();
  const { height: windowH } = useWindowDimensions();
  // Where this profile is mounted (a tab stack or an opened post's stack):
  // the Settings / Edit Profile pushes follow it (lib/sessionStack.ts).
  const mount = useSessionTab();
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  const authSession = session.data;
  const meId = useMeId();
  const own = meId != null && meId === userId;

  const profileQ = useQuery(profileQueryOptions(userId));
  // A write inside a moment only MARKS your header stale
  // (`markProfileHeaderStale`): it refetches here, once the profile is in front.
  useFocusEffect(
    useCallback(() => {
      const state = queryClient.getQueryState(profileKey(userId));
      if (state?.isInvalidated && state.fetchStatus === 'idle') void queryClient.refetchQueries({ queryKey: profileKey(userId), exact: true });
    }, [queryClient, userId]),
  );
  const profile = profileQ.data;
  const ok = profile?.state === 'ok';
  const hero = ok && !!profile.coverPhotoUrl;

  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const barControl = phone.size('heroAction');
  const BAR_H = heroBarHeight(insets.top, barControl);

  // Bar title (04·R5c .ir-floathead): once the header's name has scrolled
  // under the bar, the bar shows the photo + name. `nameBottom` = the name's
  // bottom edge in list-content coordinates. Plain: the bar sits ABOVE the
  // list (LIST_TOP_PAD of content padding), so the trigger is the name
  // reaching the list's top. Cover: the bar floats over the list, so it is the
  // name passing under the bar's bottom. Recomputed from BOTH inputs — a
  // scroll AND a re-measure (a relayout moves the name without any scroll).
  const nameBottom = useRef(Number.POSITIVE_INFINITY);
  const scrollY = useRef(0);
  const [titled, setTitled] = useState(false);
  const heroRef = useRef(hero);
  heroRef.current = hero;
  const syncTitle = useCallback(() => {
    const on = scrollY.current >= nameBottom.current - (heroRef.current ? BAR_H : 0);
    setTitled((cur) => (cur === on ? cur : on));
  }, [BAR_H]);
  // Pulled past the top: the cover's corners round (the moment hero's rule).
  const [pulled, setPulled] = useState(false);
  const onScrollY = useCallback(
    (y: number) => {
      scrollY.current = y;
      syncTitle();
      const p = y < -1;
      setPulled((cur) => (cur === p ? cur : p));
    },
    [syncTitle],
  );
  const onNameBottom = useCallback(
    (y: number) => {
      nameBottom.current = (heroRef.current ? 0 : LIST_TOP_PAD) + y;
      syncTitle();
    },
    [syncTitle],
  );
  // The post list only exists in the 'ok' state, and it REMOUNTS when the
  // layout switches between cover and no cover: reset so the bar doesn't keep
  // a title for a header that is in view (Codex).
  useEffect(() => {
    scrollY.current = 0;
    nameBottom.current = Number.POSITIVE_INFINITY;
    setTitled(false);
  }, [ok, hero]);

  // Status bar: light glyphs while the cover is under it, the theme's once the
  // bar is solid. A screen option (iOS asks screen traits) AND forwarded to
  // the root when this profile sits on an opened post's stack
  // (lib/forwardedStatusBar.ts); expo-status-bar for Android.
  const themed = theme.scheme === 'dark' ? 'light' : 'dark';
  const statusBarStyle = hero && !titled ? 'light' : themed;
  useForwardStatusBarStyle(statusBarStyle);

  // Relationship writes: lib/relationship.ts (`relate`), shared with People
  // and Add Friends. It patches this header (and every list row of this
  // person) at once, refetches the header, the network feed and (a follow
  // change) this person's post list IN PLACE afterwards (your own header in
  // the trailing refresh ~1 s later), and
  // puts back only this person's fields on failure. One write per person at
  // a time across the app (`usePersonBusy`), so a mute can't race a follow.
  // The Settings lists (Blocked / Muted) are invalidated there too.
  const busy = usePersonBusy(userId);
  const act = (op: RelOp) => void relate(queryClient, userId, op, meId);
  // D7: unfollow asks first ("Remove Mara as Friend?" when you are friends);
  // following acts immediately.
  const askUnfollow = (p: { name: string; followsYou: boolean }) => confirmUnfollow(p, () => act('unfollow'));
  const onFollowPress = (p: { name: string; isFollowing: boolean; followsYou: boolean }) => (p.isFollowing ? askUnfollow(p) : act('follow'));
  // Mute doesn't ask (design 04·5a note); it only filters YOUR network feed.
  const setMute = (on: boolean) => act(on ? 'mute' : 'unmute');
  // Block asks once more — the house native destructive alert naming the
  // person, with the design's BLOCKSHEET copy (docs/dev/block.md semantics).
  const confirmBlock = (name: string) => {
    const first = firstName(name);
    Alert.alert(
      `Block ${first}?`,
      `${first} won’t see your profile, impressions, moments or cravings, and can’t find you in search. You won’t see theirs either. They aren’t told.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Block', style: 'destructive', onPress: () => act('block') },
      ],
    );
  };
  const unblock = () => act('unblock');

  // People (D10): the counts and the in-common row. A plain push (A → B → A
  // must keep its history), double taps swallowed.
  const guard = usePushGuard();
  const openPeople = (tab: PeopleTab, known?: boolean) =>
    guard(() => router.push(feedHref(mount, 'people', { id: userId, tab, known: known ? '1' : undefined })));
  // A tile → its list (the lists step), the same plain push.
  const openList = (key: TileKey) => guard(() => router.push(feedHref(mount, key, { id: userId })));
  // The status line's placeholder pages (2026-11-14): Status yours only.
  const openStatus = () => guard(() => router.push(feedHref(mount, 'status')));
  const openPalate = () => guard(() => router.push(feedHref(mount, 'palate', { id: userId })));
  const [addOpen, setAddOpen] = useState(false);

  // ── Own profile: the in-place edit session (R5g3) ──────────────────────────
  // Long-press the name, the username or the bio: ALL become inputs, the
  // pressed one focused; the rest of the header dims and the posts go inert.
  // Done = the username first (its own request, the one someone else can
  // refuse: taken), then ONE PATCH of the changed name / bio (each pre-checked
  // with the server's own rules); errors keep you editing (the username's in
  // the edit bar, the rest alert). Losing focus (a push, a tab switch — tab
  // screens stay mounted) cancels.
  const [draft, setDraft] = useState<{ name: string; username: string; bio: string } | null>(null);
  const [focus, setFocus] = useState<EditField | null>(null);
  const [focusedField, setFocusedField] = useState<EditField | null>(null);
  const [saving, setSaving] = useState(false);
  const [imageBusy, setImageBusy] = useState<'avatar' | 'cover' | null>(null);
  const [tileSheet, setTileSheet] = useState<TileKey | null>(null);
  const nameRef = useRef<TextInputInstance | null>(null);
  const usernameRef = useRef<TextInputInstance | null>(null);
  const bioRef = useRef<TextInputInstance | null>(null);
  const fieldRef = (f: EditField) => (f === 'name' ? nameRef : f === 'username' ? usernameRef : bioRef);
  const scrollHandle = useRef<FeedScrollHandle | null>(null);
  const editing = draft != null;
  const [shake, setShake] = useState(0);

  // The username in place (ruled 2026-11-14): Edit Profile's rules, its
  // feedback in the edit bar. The limit (5 changes per 90 days) is read up
  // front, so a spent one is known before the edit starts: the handle then
  // stays read-only and a tap on it shows the date (`lockedShown`).
  // `usernameError` = a refusal of the text now typed (the pre-check or the
  // server's answer); it blocks Done until the text changes.
  const currentUsername = profile?.state === 'ok' ? profile.username : null;
  const usernameQ = useQuery({ queryKey: USERNAME_KEY, queryFn: getUsernameState, enabled: own && ok && currentUsername != null, staleTime: 60_000 });
  const quota = usernameQ.data ? usernameQuotaLine(usernameQ.data, DATE_LOCALE) : { locked: false, text: null };
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [lockedShown, setLockedShown] = useState(false);
  const usernameDraft = draft?.username ?? '';
  const usernameChanged = editing && usernameDraft !== (currentUsername ?? '');
  const usernameCheck = useUsernameCheck(editing && !quota.locked ? usernameDraft : '', { availability: true, current: currentUsername });

  const cancelEdit = useCallback(() => {
    Keyboard.dismiss();
    setDraft(null);
    setFocus(null);
    setFocusedField(null);
    setUsernameError(null);
    setLockedShown(false);
  }, []);
  // The limit can turn out spent mid-edit (a slow read, the save's 409): a
  // read-only handle can't hold a changed draft, or every Done would re-send
  // the refused change.
  useEffect(() => {
    if (!quota.locked) return;
    setDraft((d) => (d && d.username !== (currentUsername ?? '') ? { ...d, username: currentUsername ?? '' } : d));
    setUsernameError(null);
  }, [quota.locked, currentUsername]);
  // The pill stays hidden for the WHOLE session, not just while the keyboard
  // is up (the tabs layout shows it again on keyboard hide): one ref-counted
  // hold, released in this one cleanup (Cancel, Done, blur, unmount).
  useEffect(() => {
    if (!editing) return;
    pushSheet();
    return popSheet;
  }, [editing]);
  const editingRef = useRef(false);
  editingRef.current = editing;
  useFocusEffect(
    useCallback(
      () => () => {
        if (editingRef.current) cancelEdit();
      },
      [cancelEdit],
    ),
  );

  const startEdit = (field: EditField) => {
    if (profile?.state !== 'ok' || imageBusy) return;
    // No changes left: the handle can't take the focus, the bar says when.
    const locked = field === 'username' && quota.locked;
    if (locked) setLockedShown(true);
    if (draft) {
      if (!locked) fieldRef(field).current?.focus();
      return;
    }
    setDraft({ name: profile.name, username: profile.username ?? '', bio: profile.bio ?? '' });
    setFocus(locked ? null : field);
  };

  // A username the bar already refuses (a broken rule, taken): Done is greyed.
  const usernameBlocked = usernameChanged && (usernameError != null || usernameCheck.kind === 'invalid' || usernameCheck.kind === 'taken');
  // What the bar says about the username (EditBar `line`; the order lives in
  // lib/usernameCopy `usernameBarLine`, pinned in username-ui-units.ts).
  const editLine: EditBarLine | null = usernameBarLine({
    active: editing && (focusedField === 'username' || usernameChanged || lockedShown),
    refusal: usernameError ?? (usernameCheck.kind === 'invalid' || usernameCheck.kind === 'taken' ? usernameCheck.message : null),
    checking: usernameCheck.kind === 'pending' || usernameCheck.kind === 'checking',
    available: usernameCheck.kind === 'available',
    changed: usernameChanged,
    locked: quota.locked,
    quotaText: quota.text,
  });

  const doneEdit = async () => {
    if (!draft || saving || profile?.state !== 'ok' || usernameBlocked) return;
    // The name is validated (and sent) only when it CHANGED: an untouched
    // grandfathered name (from before today's rules) must not block a bio save.
    let name = profile.name;
    let bio: string | null;
    if (draft.name !== profile.name) {
      try {
        name = validateDisplayName(draft.name);
      } catch (e) {
        Alert.alert('Check Your Name', sentence((e as Error).message));
        return;
      }
    }
    try {
      bio = normalizeBio(draft.bio);
    } catch (e) {
      Alert.alert('Check Your Bio', sentence((e as Error).message));
      return;
    }
    // Like the name: checked (and sent) only when it CHANGED; the refusal
    // goes to the bar (and greys Done until the text changes).
    let nextUsername: string | null = null;
    if (!quota.locked && draft.username !== (profile.username ?? '')) {
      const handle = checkUsername(draft.username);
      if (!handle.ok) {
        setUsernameError(handle.reason === 'reserved' ? RESERVED_TEXT : sentence(handle.message));
        return;
      }
      if (handle.username !== profile.username) nextUsername = handle.username;
    }
    const body: { name?: string; bio?: string | null } = {};
    if (name !== profile.name) body.name = name;
    if (bio !== (profile.bio ?? null)) body.bio = bio;
    if (nextUsername == null && Object.keys(body).length === 0) {
      cancelEdit();
      return;
    }
    setSaving(true);
    const epoch = viewerCacheEpoch();
    let usernameSaved = false;
    try {
      if (nextUsername != null) {
        // lib/usernameSave.ts (Edit Profile's too); `null` = the viewer changed.
        const r = await saveUsername(queryClient, userId, nextUsername, { epoch, current: profile.username, locale: DATE_LOCALE });
        if (r == null) return;
        if (!r.ok) {
          if (r.kind === 'field') setUsernameError(r.message);
          // None left after all: the effect above drops the draft, the bar
          // names the date; name and bio stay in the edit to save.
          else if (r.kind === 'locked') setLockedShown(true);
          else Alert.alert('Couldn’t Save', r.message);
          return;
        }
        usernameSaved = true;
        // The saved form (trimmed): the draft must not stay "changed" against
        // it if the PATCH below fails (review 2026-11-14).
        const saved = nextUsername;
        setDraft((d) => (d ? { ...d, username: saved } : d));
        // Better Auth's session carries the username too.
        void session.refetch();
      }
      // 🔒 The viewer the save started for (lib/query.tsx epoch): after a
      // sign-out (and another sign-in) during the username step, the PATCH
      // would carry the NEW account's cookie (review 2026-11-14; Edit Profile
      // checks between every step the same way).
      if (viewerCacheEpoch() !== epoch) return;
      if (Object.keys(body).length > 0) {
        const r = await patchProfile(body);
        await applyOwnProfileChange(queryClient, userId, {
          ...(r.name !== undefined ? { name: r.name } : {}),
          ...(r.bio !== undefined ? { bio: r.bio } : {}),
        }, epoch);
      }
      cancelEdit();
    } catch (e) {
      if (viewerCacheEpoch() !== epoch) return;
      // The username went through on its own: say so (it is no longer a change).
      Alert.alert('Couldn’t Save', usernameSaved ? `Your new username is saved. ${errorText(e)}` : errorText(e));
    } finally {
      setSaving(false);
    }
  };

  // Keyboard + edit-bar clearance: the list's bottom padding grows by both
  // while editing, and the focused field is scrolled above them (measured) on
  // focus, on a field switch and as the bio grows.
  const [kbH, setKbH] = useState(0);
  const [editBarH, setEditBarH] = useState(0);
  useEffect(() => {
    if (!editing) return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, (e) => setKbH(e.endCoordinates.height));
    const h = Keyboard.addListener(hideEvt, () => setKbH(0));
    return () => {
      s.remove();
      h.remove();
      setKbH(0);
    };
  }, [editing]);
  const bioLen = draft?.bio.length ?? 0;
  useEffect(() => {
    if (!editing || !focusedField || kbH === 0) return;
    const input = fieldRef(focusedField).current;
    const t = setTimeout(() => {
      input?.measureInWindow((_x, y, _w, h) => {
        const visibleBottom = windowH - kbH - editBarH - 12;
        const over = y + h - visibleBottom;
        if (over > 0) scrollHandle.current?.scrollToOffset(scrollY.current + over);
      });
    }, 60);
    return () => clearTimeout(t);
  }, [editing, focusedField, kbH, editBarH, bioLen, windowH]);

  // Long-press the photo / the cover (R5g4 → the iPhone's own menu, D5): it
  // uploads at once (the Edit Profile page holds a draft instead).
  const changeImage = async (kind: 'avatar' | 'cover') => {
    if (profile?.state !== 'ok' || imageBusy || draft) return;
    const has = kind === 'avatar' ? !!profile.imageUrl : !!profile.coverPhotoUrl;
    const picked = await pickPhotoOrRemove(has ? (kind === 'avatar' ? 'Remove Photo' : 'Remove Cover') : null);
    if (!picked) return;
    if (picked !== 'remove' && 'failed' in picked) {
      Alert.alert('Couldn’t Use That Photo', 'Try another photo.');
      return;
    }
    setImageBusy(kind);
    const epoch = viewerCacheEpoch();
    try {
      if (kind === 'avatar') {
        const imageUrl = picked === 'remove' ? (await removeAvatar(), null) : await uploadAvatar(picked.dataUrl);
        await applyOwnProfileChange(queryClient, userId, { imageUrl }, epoch);
      } else {
        const coverPhotoUrl = picked === 'remove' ? (await removeCover(), null) : await uploadCover(picked.dataUrl);
        await applyOwnProfileChange(queryClient, userId, { coverPhotoUrl }, epoch);
      }
    } catch (e) {
      Alert.alert(kind === 'avatar' ? 'Couldn’t Update Your Photo' : 'Couldn’t Update Your Cover', errorText(e));
    } finally {
      setImageBusy(null);
    }
  };

  // R5g2: a tile's cover. Throws to keep the sheet open (after alerting).
  const pinTilePhoto = useCallback(
    async (tile: TileKey, url: string | null) => {
      const epoch = viewerCacheEpoch();
      try {
        const r = await patchProfile({ tiles: { [tile]: url } });
        if (r.tiles) await applyOwnProfileChange(queryClient, userId, { tiles: r.tiles }, epoch);
        setTileSheet(null);
      } catch (e) {
        Alert.alert('Couldn’t Save', errorText(e));
        throw e;
      }
    },
    [queryClient, userId],
  );

  // Your own photo on a tile (Take Photo / Choose from Library in the sheet).
  const uploadTileCover = useCallback(
    async (tile: TileKey, dataUrl: string) => {
      const epoch = viewerCacheEpoch();
      try {
        const tiles = await uploadTilePhoto(tile, dataUrl);
        await applyOwnProfileChange(queryClient, userId, { tiles }, epoch);
        setTileSheet(null);
      } catch (e) {
        Alert.alert('Couldn’t Save', errorText(e));
        throw e;
      }
    },
    [queryClient, userId],
  );

  const edit: ProfileEdit | undefined =
    own && ok
      ? {
          draft,
          focus,
          setDraft: (field, value) => {
            setDraft((d) => (d ? { ...d, [field]: value } : d));
            if (field === 'username') setUsernameError(null);
          },
          start: startEdit,
          done: doneEdit,
          onFieldFocus: (field) => {
            setFocusedField(field);
            if (field !== 'username') setLockedShown(false);
          },
          nameRef,
          usernameRef,
          bioRef,
          usernameLocked: quota.locked,
          onLockedUsername: () => setLockedShown(true),
          doneBlocked: usernameBlocked,
          busy: imageBusy,
          onPhoto: () => changeImage('avatar'),
          onCover: () => changeImage('cover'),
          onTile: (key) => !draft && setTileSheet(key),
        }
      : undefined;

  const close = () => setMenu(null);
  // Share Profile presents the OS share sheet, which must wait until the
  // menu's Modal has gone (it presents from the top view controller): the row
  // only records the action, AnchoredMenu's `onClosed` runs it (every close
  // fires that, so the ref is cleared there).
  const pending = useRef<(() => void) | null>(null);
  const afterClose = (run: () => void) => {
    pending.current = run;
    close();
  };
  const onMenuClosed = useCallback(() => {
    const run = pending.current;
    pending.current = null;
    run?.();
  }, []);
  const shareOwn = () =>
    afterClose(async () => {
      const name = ok ? profile.name : await freshOwnName(queryClient, authSession?.user.name);
      await shareProfile(name ?? '', { id: userId, username: ok ? profile.username : authSession?.user.username });
    });
  const shareTheirs = (name: string, username: string | null) => afterClose(() => void shareProfile(name, { id: userId, username }));
  // Your own ⋯ never depends on the profile query: Settings holds the only
  // signed-in Sign Out, so it must survive a failed or slow profile load.
  const showMenuButton = own || (profile && profile.state !== 'gone');

  // ⋯ menus (MY_MENU / HER_MENU). Rows marked "Soon" are inactive (their
  // screens come later); MenuItem `disabled` renders that tag. Your own has
  // no Edit Profile row (ruled 2026-11-11, a deviation from MY_MENU): editing
  // lives in Settings (→ your card), as a moment's does (⋯ → Settings).
  const menuItems = own ? (
    <>
      <MenuItem
        icon="user-plus"
        label="Add Friends"
        onPress={() => {
          close();
          setAddOpen(true);
        }}
      />
      <MenuItem icon="share" label="Share Profile" onPress={shareOwn} />
      <MenuSeparator />
      <MenuItem
        icon="settings"
        label="Settings"
        onPress={() => {
          close();
          // A PLAIN push, unlike the settings rows: the menu closes on the
          // first tap (no double push), and from the Feed tab this lands on
          // the You stack (/you/settings), where singular would pull an
          // already open Settings forward over a deeper page (Privacy).
          router.push(settingsHref(mount));
        }}
      />
    </>
  ) : !profile ? null : profile.state === 'ok' ? (
    <>
      <MenuItem icon="share" label="Share Profile" onPress={() => shareTheirs(profile.name, profile.username)} />
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
            askUnfollow(profile);
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
      <MenuItem icon="share" label="Share Profile" onPress={() => shareTheirs(profile.name, profile.username)} />
      <MenuSeparator />
      {profile.isFollowing ? (
        <MenuItem
          icon="user"
          label="Unfollow"
          onPress={() => {
            close();
            askUnfollow(profile);
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
    // No Share Profile here (you blocked them): only Unblock.
    <>
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

  const barAvatar = ok && profile.imageUrl ? <Avatar imageUrl={profile.imageUrl} name={profile.name} size={26} /> : undefined;

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
        <ProfileIdentity name={profile.name} username={profile.username} imageUrl={null} />
        <NoticeBox
          text={`You blocked ${firstName(profile.name)}.`}
          action={<Button size="sm" variant="secondary" title="Unblock" loading={busy} onPress={unblock} />}
        />
      </View>
    );
  } else if (profile.state === 'shell') {
    // Private (their tier doesn't admit you): the blocked layout + Follow and
    // one plain sentence (ruled 2026-11-12; the shell never says the tier).
    body = (
      <View style={{ paddingHorizontal: GUTTER, paddingTop: 4 }}>
        <ProfileIdentity name={profile.name} username={profile.username} imageUrl={null} />
        <NoticeBox
          text={`${firstName(profile.name)}’s profile is private.`}
          action={
            <FollowButton isFollowing={profile.isFollowing} followsYou={profile.followsYou} busy={busy} onPress={() => onFollowPress(profile)} />
          }
        />
      </View>
    );
  } else {
    body = (
      <FeedList
        // The cover and plain layouts are different scroll setups (full-bleed
        // vs under a bar): a fresh list when the cover comes or goes.
        key={hero ? 'cover' : 'plain'}
        userId={userId}
        scrollHandle={scrollHandle}
        fullBleed={hero}
        contentTopPad={hero ? 0 : LIST_TOP_PAD}
        refreshOffset={hero ? BAR_H : undefined}
        refreshTint={hero ? '#fff' : undefined}
        inert={editing}
        bottomInset={editing ? kbH + editBarH + (kbH > 0 ? 0 : insets.bottom) + 24 : undefined}
        onRefresh={() => profileQ.refetch()}
        onScrollY={onScrollY}
        header={
          <ProfileHeader
            profile={profile}
            own={own}
            followBusy={busy}
            onFollowPress={() => onFollowPress(profile)}
            onNameBottom={onNameBottom}
            edit={edit}
            pulled={pulled}
            onPeople={openPeople}
            onTile={openList}
            onStatus={openStatus}
            onPalate={openPalate}
          />
        }
        empty={
          own ? (
            <EmptyPosts title="No posts yet" body="Your impressions and moments will show up here." />
          ) : (
            // The same line as Only Me's hidden posts (postsHiddenLine), so
            // the empty state doesn't tell the two apart.
            <EmptyPosts title="No posts found" />
          )
        }
        // Step 4 (Q3): their Check-Ins Visible To hides the posts from you.
        // The line REPLACES the list (whatever its cache holds), never only
        // its empty slot; your own profile never carries it.
        postsHidden={profile.checkinsAudience ? <EmptyPosts title={postsHiddenLine(profile.name, profile.checkinsAudience)} /> : undefined}
      />
    );
  }

  return (
    // A SCREEN-LOCAL provider for the tile sheet: a root provider's gorhom
    // host gets zero height across the Stack boundary (the line-up's note).
    <BottomSheetModalProvider>
      <View
        style={{ flex: 1, paddingTop: hero ? 0 : insets.top }}
        // While you edit, a tap outside the fields, the edit bar and Back shakes the bar (it is still open).
        {...editTouchHandlers(() => {
          if (editingRef.current) setShake((n) => n + 1);
        })}
      >
        <Stack.Screen options={{ statusBarStyle }} />
        <StatusBar style={statusBarStyle} />
        {hero ? null : (
          <View style={{ paddingHorizontal: GUTTER }}>
            <VBar
              back={!root}
              backCapture={markNoShake}
              title={ok ? profile.name : ''}
              titleShown={ok && titled}
              titleLeading={barAvatar}
              right={showMenuButton ? (
                // Inert and dimmed while you edit, like the tiles (a tap there shakes the edit bar).
                <View
                  style={{ opacity: editing ? 0.35 : 1 }}
                  pointerEvents={editing ? 'none' : 'auto'}
                  accessibilityElementsHidden={editing}
                  importantForAccessibility={editing ? 'no-hide-descendants' : 'auto'}
                >
                  <AnchorButton onOpen={setMenu} accessibilityLabel="Profile Options" />
                </View>
              ) : null}
            />
          </View>
        )}
        {body}
        {hero ? (
          <ProfileHeroBar
            title={profile.name}
            leading={barAvatar}
            collapsed={titled}
            back={!root}
            onBack={() => router.back()}
            onMenu={showMenuButton ? setMenu : undefined}
            menuInert={editing}
          />
        ) : null}
        {editing ? <EditBar busy={saving} onCancel={cancelEdit} onDone={doneEdit} onHeight={setEditBarH} shake={shake} line={editLine} doneDisabled={usernameBlocked} /> : null}
        <AnchoredMenu anchor={menu} onClose={close} onClosed={onMenuClosed} right={16} minWidth={220}>
          {menuItems}
        </AnchoredMenu>
        {own ? <AddFriendsSheet open={addOpen} onClose={() => setAddOpen(false)} meId={userId} /> : null}
        {own && ok ? (
          <TileCoverSheet
            tile={tileSheet}
            shown={tileSheet ? profile.tiles[tileSheet]?.imageUrl ?? null : null}
            pinned={tileSheet ? profile.tiles[tileSheet]?.pinned === true : false}
            onClose={() => setTileSheet(null)}
            onUse={pinTilePhoto}
            onUpload={uploadTileCover}
          />
        ) : null}
      </View>
    </BottomSheetModalProvider>
  );
}

// The cover bar (04·R5i·b `.ir-floathead`): glass back + glass ⋯ over the
// photo; once collapsed, a solid theme.bg fill with the shared BarTitle (26pt
// photo + name), both off ONE useBarTitleProgress value, like the moment's
// HeroTopBar. Height = heroBarHeight (lib/layout.ts).
function ProfileHeroBar({
  title, leading, collapsed, back, onBack, onMenu, menuInert,
}: {
  title: string;
  leading?: React.ReactNode;
  collapsed: boolean;
  back: boolean;
  onBack: () => void;
  onMenu?: (anchor: MenuAnchor) => void;
  // While you edit: dimmed + inert (a tap there shakes the edit bar).
  menuInert?: boolean;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const phone = usePhoneTokens();
  const anim = useBarTitleProgress(collapsed);
  const controlSize = phone.size('heroAction');
  const iconSize = phone.size('heroActionIcon');
  const iconColor = collapsed ? theme.ink : '#fff';
  const circle = {
    width: controlSize,
    height: controlSize,
    borderRadius: controlSize / 2,
    backgroundColor: collapsed ? undefined : GLASS_FILL,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 8 }}>
      <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: anim, backgroundColor: theme.bg }} />
      <View style={{ paddingTop: insets.top, paddingHorizontal: 14, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', height: controlSize }}>
          {back ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back"
              onPress={onBack}
              onStartShouldSetResponderCapture={markNoShake}
              hitSlop={8}
              style={({ pressed }) => ({ ...circle, opacity: pressed ? 0.5 : 1 })}
            >
              <Icon name="back" size={iconSize} color={iconColor} />
            </Pressable>
          ) : null}
          {/* Without a back circle (your own profile, the tab root) the photo
              lines up with the screen gutter like every avatar below it:
              GUTTER − the bar's 14 padding. */}
          <BarTitle title={title} leading={leading} progress={anim} inset={back ? 10 : GUTTER - 14} hidden={!collapsed} />
          {onMenu ? (
            <View
              style={[circle, menuInert ? { opacity: 0.35 } : null]}
              pointerEvents={menuInert ? 'none' : 'auto'}
              accessibilityElementsHidden={menuInert}
              importantForAccessibility={menuInert ? 'no-hide-descendants' : 'auto'}
            >
              <AnchorButton onOpen={onMenu} accessibilityLabel="Profile Options" size={controlSize}>
                <Icon name="more" size={iconSize} color={iconColor} />
              </AnchorButton>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const LIST_TOP_PAD = 4;

// The Q3 line (ruled 2026-11-11): what to do when something helps, else
// the SAME line as a profile with no posts ("No posts found"), so Only Me
// isn't named (the missing Impressions tile still shows posts are hidden).
// No pronouns (we don't know anyone's). Verre Users can only hide posts from
// someone signed out (the web), never from the app, so it falls there too.
function postsHiddenLine(name: string, audience: CheckinVisibility): string {
  const first = firstName(name);
  if (audience === 'public-followers') return `Follow ${first} to see posts`;
  if (audience === 'public-mutual') return `Become friends with ${first} to see posts`;
  return 'No posts found';
}
