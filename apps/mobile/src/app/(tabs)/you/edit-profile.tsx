import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BIO_MAX, normalizeBio, validateDisplayName } from '@verre/core';
import { NotesField, pickPhotoOrRemove } from '@/components/moments/momentForm';
import { GlassButton, SettingsFooter, SettingsScreenFallback } from '@/components/moments/settingsParts';
import { SHEET_RISE } from '@/components/profile/coverGeometry';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { VBar } from '@/components/VBar';
import {
  applyOwnProfileChange, patchProfile, removeAvatar, removeCover, uploadAvatar, uploadCover,
} from '@/lib/api/profile';
import { profileKey, profileQueryOptions, type FullProfile, type Profile } from '@/lib/api/users';
import { authClient } from '@/lib/authClient';
import { errorText, sentence } from '@/lib/errorCopy';
import { viewerCacheEpoch } from '@/lib/query';
import { FOOT_CLEARANCE, GUTTER, HERO_RATIO } from '@/lib/layout';
import { useTheme } from '@/theme';

// Edit Profile (04 `setProfile`, ruling D1): your own profile's ⋯ → Edit
// Profile. The cover and the photo with their edit buttons, Display Name,
// Profile Text, Discard | Save. The way to add a FIRST cover (a coverless
// profile has no hero to long-press); long-press stays the quick path.
//
// Everything is a DRAFT until Save: a picked image is held as a fitted data
// URL, a removal as a flag; Discard drops them (nothing uploaded, nothing
// reclaimed). Save runs photo → cover → text and stops at the first failure:
// finished steps stay saved and leave the draft, and the footer names what
// didn't save. Pushed stack-relative (lib/sessionStack.ts profileEditHref);
// the pill hides here (the sticky footer replaces it).
export default function EditProfile() {
  const meId = authClient.useSession().data?.user.id;
  const userId = meId != null ? Number(meId) : null;
  const q = useQuery({ ...profileQueryOptions(userId ?? 0), enabled: userId != null });
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
function EditProfileForm({ userId, profile }: { userId: number; profile: FullProfile }) {
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
  const [avatar, setAvatar] = useState<ImageDraft>({ kind: 'keep' });
  const [cover, setCover] = useState<ImageDraft>({ kind: 'keep' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badName, setBadName] = useState(false);

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
        return failed(body.name !== undefined && body.bio !== undefined ? 'name and profile text' : body.name !== undefined ? 'name' : 'profile text', e);
      }
    }
    if (!sameViewer()) return;
    router.back();
  };

  return (
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
              {/* The photo below overlaps the bottom AVATAR_OVERLAP of this
                  area, so the prompt is centred in the band ABOVE it, icon and
                  caption side by side (one line, robust to larger text). */}
              <View
                style={{
                  height: Math.max(0, coverH - AVATAR_OVERLAP),
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  paddingHorizontal: GUTTER,
                }}
              >
                <Icon name="cam" size={22} color={theme.inkSoft} />
                <VText variant="small" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold', flexShrink: 1 }}>Add a cover photo</VText>
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
            label="Display Name"
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
          <NotesField label="Profile Text" placeholder="Add a profile text" value={bio} onChange={setBio} maxLength={BIO_MAX} />
        </View>
      </ScrollView>
      <SettingsFooter saving={saving} error={error} onDiscard={() => router.back()} onSave={onSave} bottomInset={insets.bottom} />
    </View>
  );
}
