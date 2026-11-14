import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BIO_MAX, checkUsername, normalizeBio, validateDisplayName } from '@verre/core';
import { NotesField, pickPhotoOrRemove } from '@/components/moments/momentForm';
import { GlassButton, SetTitle, SettingsFooter, SettingsScreenFallback } from '@/components/moments/settingsParts';
import { TileCoverSheet } from '@/components/profile/TileCoverSheet';
import { PhotoTiles } from '@/components/profile/PhotoTiles';
import { compactCount } from '@/components/profile/ProfileHeader';
import { SHEET_RISE } from '@/components/profile/coverGeometry';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { RESERVED_TEXT, TAKEN_TEXT, UsernameField } from '@/components/ui/UsernameField';
import { VText } from '@/components/ui/VText';
import { VBar } from '@/components/VBar';
import {
  applyOwnProfileChange, patchProfile, removeAvatar, removeCover, uploadAvatar, uploadCover, uploadTilePhoto, type TileKey, type TilePhoto,
} from '@/lib/api/profile';
import { USERNAME_KEY, UsernameError, getUsernameState, putUsername, type UsernameState } from '@/lib/api/username';
import { profileKey, profileQueryOptions, type FullProfile, type Profile } from '@/lib/api/users';
import { authClient } from '@/lib/authClient';
import { errorText, sentence } from '@/lib/errorCopy';
import { viewerCacheEpoch } from '@/lib/query';
import { FOOT_CLEARANCE, GUTTER, HERO_RATIO } from '@/lib/layout';
import { DATE_LOCALE } from '@/lib/locale';
import { changeAgainText, usernameQuotaLine } from '@/lib/usernameCopy';
import { useTheme } from '@/theme';
import { useMeId } from '@/lib/meId';

// Edit Profile (04 `setProfile`, ruling D1): your own profile's ⋯ → Edit
// Profile. The cover and the photo with their edit buttons, Name, Username,
// Bio, Discard | Save. The way to add a FIRST cover (a coverless
// profile has no hero to long-press); long-press stays the quick path.
//
// Everything is a DRAFT until Save: a picked image is held as a fitted data
// URL, a removal as a flag; Discard drops them (nothing uploaded, nothing
// reclaimed). Save runs username → photo → cover → text and stops at the first failure:
// finished steps stay saved and leave the draft, and the footer names what
// didn't save. Pushed stack-relative (lib/sessionStack.ts profileEditHref);
// the pill hides here (the sticky footer replaces it).
//
// Username (usernames, ruled 2026-11-14): the ONLY place to change it (the
// profile's long-press edits name and bio). Live "Available" / taken under the
// field; the limit (5 changes per 90 days) stays quiet until the last two,
// and with none left the field is read-only and names the date. Its own
// request (`PUT /api/me/username`), saved FIRST: the one step someone else
// can refuse (taken), before anything is uploaded.
//
// Profile Tiles (the lists step): the tiles as on your profile (`PhotoTiles`),
// a pen on each, one TAP opening the tile's cover sheet (the long-press on the
// profile's tile; ruled 2026-11-13, replacing settings rows). That sheet
// saves on its own "Use Photo", like there: a tile change is not part of this
// page's draft. Not in the mock (its setProfile page has no tiles).
export default function EditProfile() {
  const userId = useMeId();
  const q = useQuery({ ...profileQueryOptions(userId ?? ''), enabled: userId != null });
  const profile = q.data;
  if (userId != null && profile?.state === 'ok') return <EditProfileForm userId={userId} profile={profile} />;
  return <SettingsScreenFallback title="Edit Profile" isError={q.isError || profile?.state === 'gone'} retrying={q.isFetching} onRetry={() => q.refetch()} />;
}

// How far the photo rises into the cover (`.yo-epav { margin-top: -58px }`)
// plus its 4pt bg ring.
const AVATAR_OVERLAP = 58;

type ImageDraft = { kind: 'keep' } | { kind: 'new'; dataUrl: string; preview: string } | { kind: 'remove' };

// Seeded ONCE (the form mounts after the profile resolves); a background
// refetch never re-seeds mid-edit.
function EditProfileForm({ userId, profile }: { userId: string; profile: FullProfile }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  // The cover as the profile shows it above its card line (HERO_RATIO of
  // the screen height, the photo cropped as there: its box runs SHEET_RISE
  // further, hidden here as under the profile's card).
  const { height: windowH } = useWindowDimensions();
  const coverH = Math.round(windowH * HERO_RATIO);
  const [name, setName] = useState(profile.name);
  const [bio, setBio] = useState(profile.bio ?? '');
  const [username, setUsername] = useState(profile.username ?? '');
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const { refetch: refetchSession } = authClient.useSession();
  const usernameQ = useQuery({ queryKey: USERNAME_KEY, queryFn: getUsernameState });
  const quota = usernameQ.data ? usernameQuotaLine(usernameQ.data, DATE_LOCALE) : { locked: false, text: null };
  // A read-only field can't hold a changed draft (the limit can turn out
  // spent after you typed: a slow read, a 409): back to the current name, or
  // every Save would re-send the refused change and stop there.
  const locked = quota.locked;
  useEffect(() => {
    if (!locked) return;
    setUsername(profile.username ?? '');
    setUsernameError(null);
  }, [locked, profile.username]);
  const [avatar, setAvatar] = useState<ImageDraft>({ kind: 'keep' });
  const [cover, setCover] = useState<ImageDraft>({ kind: 'keep' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badName, setBadName] = useState(false);

  // A tile's cover (the profile's R5g2 sheet): throws to keep the sheet open.
  const [tileSheet, setTileSheet] = useState<TileKey | null>(null);
  const saveTile = useCallback(
    async (tile: TileKey, run: () => Promise<Partial<Record<TileKey, TilePhoto>> | undefined>) => {
      const epoch = viewerCacheEpoch();
      try {
        const tiles = await run();
        if (tiles) await applyOwnProfileChange(queryClient, userId, { tiles }, epoch);
        setTileSheet(null);
      } catch (e) {
        Alert.alert('Couldn’t Save', errorText(e));
        throw e;
      }
    },
    [queryClient, userId],
  );

  const shown = (d: ImageDraft, current: string | null) => (d.kind === 'new' ? d.preview : d.kind === 'remove' ? null : current);
  const avatarUrl = shown(avatar, profile.imageUrl);
  const coverUrl = shown(cover, profile.coverPhotoUrl);

  const pick = async (kind: 'avatar' | 'cover') => {
    setError(null);
    const has = kind === 'avatar' ? !!avatarUrl : !!coverUrl;
    const r = await pickPhotoOrRemove(has ? (kind === 'avatar' ? 'Remove Photo' : 'Remove Cover') : null);
    if (!r) return;
    if (r !== 'remove' && 'failed' in r) {
      setError('Couldn’t use that photo. Try another.');
      return;
    }
    const next: ImageDraft = r === 'remove' ? { kind: 'remove' } : { kind: 'new', dataUrl: r.dataUrl, preview: r.previewUri };
    // Removing an image that was never saved just drops the pick.
    const settled = r === 'remove' && !(kind === 'avatar' ? profile.imageUrl : profile.coverPhotoUrl) ? { kind: 'keep' as const } : next;
    (kind === 'avatar' ? setAvatar : setCover)(settled);
  };

  const onSave = async () => {
    setError(null);
    // The name is validated (and sent) only when it CHANGED: an untouched
    // grandfathered name must not block a photo, cover or bio save.
    let nextName: string | null = null;
    let nextBio: string | null;
    if (name !== profile.name) {
      try {
        nextName = validateDisplayName(name);
      } catch (e) {
        setBadName(true);
        setError(sentence((e as Error).message));
        return;
      }
    }
    try {
      nextBio = normalizeBio(bio);
    } catch (e) {
      setError(sentence((e as Error).message));
      return;
    }
    // Like the name: checked (and sent) only when it CHANGED.
    let nextUsername: string | null = null;
    if (!locked && username !== (profile.username ?? '')) {
      const handle = checkUsername(username);
      if (!handle.ok) {
        setUsernameError(handle.reason === 'reserved' ? RESERVED_TEXT : sentence(handle.message));
        return;
      }
      nextUsername = handle.username;
    }
    setSaving(true);
    // 🔒 The viewer the save started for. A sign-out (and another account's
    // sign-in) while the steps run must stop the rest: the next request would
    // carry the NEW account's cookie (lib/query.tsx viewer epoch).
    const epoch = viewerCacheEpoch();
    const sameViewer = () => viewerCacheEpoch() === epoch;
    const failed = (what: string, e: unknown) => {
      setSaving(false);
      setError(`Couldn’t save your ${what}. ${errorText(e)}`);
    };
    const curUsername = (() => {
      const p = queryClient.getQueryData<Profile>(profileKey(userId));
      return p?.state === 'ok' ? p.username : profile.username;
    })();
    if (nextUsername != null && nextUsername !== curUsername) {
      try {
        const state = await putUsername(nextUsername);
        if (!sameViewer()) return;
        queryClient.setQueryData<UsernameState>(USERNAME_KEY, state);
        await applyOwnProfileChange(queryClient, userId, { username: state.username }, epoch);
        // Better Auth's session carries the name too (fresh on every answer).
        void refetchSession();
      } catch (e) {
        // 🔒 A refusal for the viewer the save started for only: after a
        // sign-out (and another sign-in) it must not lock the next account.
        if (!sameViewer()) return;
        setSaving(false);
        if (e instanceof UsernameError && e.code === 'taken') setUsernameError(TAKEN_TEXT);
        else if (e instanceof UsernameError && e.code === 'reserved') setUsernameError(RESERVED_TEXT);
        else if (e instanceof UsernameError && e.code === 'invalid') setUsernameError(sentence(e.message));
        else if (e instanceof UsernameError && e.code === 'quota') {
          // None left after all: the refusal is the authority, so the field
          // locks NOW (the effect then drops the draft; the rest of the page
          // can still be saved) whether or not the re-read below succeeds.
          const nextChangeAt = e.nextChangeAt;
          queryClient.setQueryData<UsernameState>(USERNAME_KEY, (s) => ({
            ...(s ?? { username: profile.username, previous: null }),
            changesLeft: 0,
            nextChangeAt,
          }));
          setUsername(profile.username ?? '');
          void usernameQ.refetch();
        } else setError(`Couldn’t save your username. ${errorText(e)}`);
        return;
      }
    }
    if (!sameViewer()) return;
    if (avatar.kind !== 'keep') {
      try {
        const imageUrl = avatar.kind === 'new' ? await uploadAvatar(avatar.dataUrl) : (await removeAvatar(), null);
        await applyOwnProfileChange(queryClient, userId, { imageUrl }, epoch);
        setAvatar({ kind: 'keep' });
      } catch (e) {
        return failed('photo', e);
      }
    }
    if (!sameViewer()) return;
    if (cover.kind !== 'keep') {
      try {
        const coverPhotoUrl = cover.kind === 'new' ? await uploadCover(cover.dataUrl) : (await removeCover(), null);
        await applyOwnProfileChange(queryClient, userId, { coverPhotoUrl }, epoch);
        setCover({ kind: 'keep' });
      } catch (e) {
        return failed('cover', e);
      }
    }
    if (!sameViewer()) return;
    // The minimal text diff against the CURRENT profile (the caches above may
    // have refreshed it).
    const cur = queryClient.getQueryData<Profile>(profileKey(userId));
    const base = cur?.state === 'ok' ? cur : profile;
    const body: { name?: string; bio?: string | null } = {};
    if (nextName != null && nextName !== base.name) body.name = nextName;
    if (nextBio !== (base.bio ?? null)) body.bio = nextBio;
    if (Object.keys(body).length > 0) {
      try {
        const r = await patchProfile(body);
        await applyOwnProfileChange(queryClient, userId, {
          ...(r.name !== undefined ? { name: r.name } : {}),
          ...(r.bio !== undefined ? { bio: r.bio } : {}),
        }, epoch);
      } catch (e) {
        return failed(body.name !== undefined && body.bio !== undefined ? 'name and bio' : body.name !== undefined ? 'name' : 'bio', e);
      }
    }
    if (!sameViewer()) return;
    router.back();
  };

  return (
    // A SCREEN-LOCAL provider for the tile cover sheet (no root provider).
    <BottomSheetModalProvider>
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Edit Profile" />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom + FOOT_CLEARANCE }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {/* .yo-epcover — full-bleed, the profile's cover height (ruled
            2026-11-11; the mock's is 3:2), the edit button bottom-right. No
            cover yet: the same footprint on the sunk fill with the add
            affordance (flagged: the mock always shows a cover). */}
        <View style={{ marginHorizontal: -GUTTER, height: coverH, overflow: 'hidden' }}>
          {coverUrl ? (
            <>
              <Image source={{ uri: coverUrl }} style={{ width: '100%', height: coverH + SHEET_RISE }} contentFit="cover" />
              <GlassButton label="Change Cover" icon="edit" right={12} bottom={12} onPress={() => pick('cover')} />
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add a Cover Photo"
              onPress={() => pick('cover')}
              style={({ pressed }) => ({ flex: 1, backgroundColor: theme.surfaceSunk, opacity: pressed ? 0.7 : 1 })}
            >
              {/* The glyph above the caption, centred MIDWAY between the box
                  top and the photo's top (ruled 2026-11-13 on device: centred
                  in the whole box it sat low, the photo covering the bottom
                  AVATAR_OVERLAP of it; the 11-12 "centre it better" had
                  moved it there). */}
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: GUTTER, paddingBottom: AVATAR_OVERLAP }}>
                <Icon name="cam" size={24} color={theme.inkSoft} />
                <VText variant="small" numberOfLines={2} style={{ fontFamily: 'InstrumentSans_600SemiBold', textAlign: 'center' }}>Add a cover photo</VText>
              </View>
            </Pressable>
          )}
        </View>
        {/* .yo-epav — the 96pt photo centred over the cover's edge, a 4pt bg
            ring, its edit button bottom-right. */}
        <View style={{ alignSelf: 'center', marginTop: -AVATAR_OVERLAP, marginBottom: 18 }}>
          <View style={{ padding: 4, borderRadius: 52, backgroundColor: theme.bg }}>
            <Avatar imageUrl={avatarUrl} name={name.trim() || profile.name} size={96} tint />
          </View>
          <GlassButton label="Change Photo" icon="edit" right={12} bottom={12} onPress={() => pick('avatar')} />
        </View>

        <View style={{ marginBottom: 14 }}>
          <TextField
            label="Name"
            value={name}
            onChangeText={(t) => {
              setName(t);
              if (badName) {
                setBadName(false);
                setError(null);
              }
            }}
            invalid={badName}
            autoCorrect={false}
            maxLength={64}
          />
        </View>
        <View style={{ marginBottom: 14 }}>
          <UsernameField
            value={username}
            onChange={(v) => {
              setUsername(v);
              setUsernameError(null);
            }}
            availability
            current={profile.username}
            error={usernameError}
            hint={quota.text}
            editable={!locked}
          />
        </View>
        <View style={{ marginBottom: 14 }}>
          <NotesField label="Bio" placeholder="Add a bio" value={bio} onChange={setBio} maxLength={BIO_MAX} />
        </View>
        {TILE_ROWS.some(([k]) => profile.tiles[k]) ? (
          <View style={{ marginTop: 18 }}>
            <SetTitle>Profile Tiles</SetTitle>
            {/* The tiles as on your profile, a pen on each, one TAP opens the
                tile's cover sheet (ruled 2026-11-13). */}
            <PhotoTiles
              tiles={TILE_ROWS.flatMap(([k, label]) => {
                const t = profile.tiles[k];
                return t ? [{
                  label,
                  count: compactCount(t.count),
                  imageUrl: t.imageUrl,
                  editable: true,
                  onPress: () => setTileSheet(k),
                  accessibilityLabel: `${compactCount(t.count)} ${label}, ${t.pinned ? 'chosen' : 'automatic'} cover`,
                  accessibilityHint: 'Double-tap to choose its cover.',
                }] : [];
              })}
            />
          </View>
        ) : null}
      </ScrollView>
      <SettingsFooter saving={saving} error={error} onDiscard={() => router.back()} onSave={onSave} bottomInset={insets.bottom} />
      <TileCoverSheet
        tile={tileSheet}
        shown={tileSheet ? profile.tiles[tileSheet]?.imageUrl ?? null : null}
        onClose={() => setTileSheet(null)}
        onUse={(tile, url) => saveTile(tile, async () => (await patchProfile({ tiles: { [tile]: url } })).tiles)}
        onUpload={(tile, dataUrl) => saveTile(tile, () => uploadTilePhoto(tile, dataUrl))}
      />
    </View>
    </BottomSheetModalProvider>
  );
}

const TILE_ROWS: ReadonlyArray<readonly [TileKey, string]> = [['impressions', 'Impressions'], ['moments', 'Moments'], ['cravings', 'Cravings']];
