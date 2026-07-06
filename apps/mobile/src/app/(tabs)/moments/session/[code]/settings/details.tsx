import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullscreenImage } from '@/components/ui/FullscreenImage';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { DateField, NotesField, nextFullHour, pickPhoto } from '@/components/moments/momentForm';
import { GlassButton, SettingsFooter, SettingsScreenFallback } from '@/components/moments/settingsParts';
import {
  ApiError,
  updateMomentSettings,
  type MomentSettingsBody,
  type SessionMetaView,
} from '@/lib/api/sessions';
import { useSettingsSession } from '@/lib/useSettingsSession';
import { FOOT_CLEARANCE, GUTTER } from '@/lib/layout';
import { radius, useTheme } from '@/theme';

// 02f·2 Moment details — a pushed full-screen edit form (NOT a sheet), so the
// Discard/Save bar sticks to the bottom via the proven create.tsx .vfoot
// pattern. Fields mirror create + the settings PATCH; saves the minimal diff
// vs the loaded meta, then returns to the Settings hub.
export default function MomentDetails() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = String(raw ?? '');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { meta, isError, isFetching, refetch } = useSettingsSession(code);

  return meta ? (
    <DetailsForm
      code={code}
      meta={meta}
      onSaved={() => {
        queryClient.invalidateQueries({ queryKey: ['session-state', code] });
        queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
        router.back();
      }}
      onDiscard={() => router.back()}
    />
  ) : (
    <SettingsScreenFallback title="Moment Details" isError={isError} retrying={isFetching} onRetry={refetch} />
  );
}

// Split out so all draft state is seeded ONCE from meta (the form mounts only
// after meta resolves) and never re-seeded by a background poll mid-edit.
function DetailsForm({
  code, meta, onSaved, onDiscard,
}: {
  code: string;
  meta: SessionMetaView;
  onSaved: () => void;
  onDiscard: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(meta.name ?? '');
  const [dateFrom, setDateFrom] = useState<Date | null>(meta.dateFrom ? new Date(meta.dateFrom) : null);
  const [dateTo, setDateTo] = useState<Date | null>(meta.dateTo ? new Date(meta.dateTo) : null);
  const [address, setAddress] = useState(meta.address ?? '');
  const [description, setDescription] = useState(meta.description ?? '');
  const [link, setLink] = useState(meta.link ?? '');
  // Cover: `coverUrl` is what the slot shows (server URL, or a freshly picked
  // local preview uri, or null when removed); `coverData` is the base64 to
  // upload, set only on a fresh pick. Only sent to the PATCH if changed.
  const [coverUrl, setCoverUrl] = useState<string | null>(meta.coverPhotoUrl ?? null);
  const [coverData, setCoverData] = useState<string | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [coverFullscreen, setCoverFullscreen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which required fields failed the last save (red border), cleared per-field
  // as the user edits.
  const [badFields, setBadFields] = useState({ name: false, start: false });

  const onPickCover = async () => {
    setCoverError(null);
    const picked = await pickPhoto();
    if (!picked) return;
    if ('failed' in picked) {
      setCoverError("Couldn't use that photo — try another.");
      return;
    }
    setCoverData(picked.dataUrl);
    setCoverUrl(picked.previewUri);
  };
  const onRemoveCover = () => {
    setCoverData(null);
    setCoverUrl(null);
  };

  const onSave = async () => {
    setError(null);
    // Name + start date are required and can't be CLEARED (Simon, 2026-07-06 —
    // the same absolute invariant as create). Collect ALL misses, flag each
    // field (red border), one summary. Applies to old dateless moments too:
    // they must gain a start date before their next save goes through.
    const bad = { name: !name.trim(), start: !dateFrom };
    setBadFields(bad);
    const missCount = Number(bad.name) + Number(bad.start);
    if (missCount > 0) {
      setError(
        missCount > 1 ? 'Please fill in the highlighted fields.'
        : bad.name ? 'Please name your moment.'
        : 'Please set a start date.',
      );
      return;
    }
    if (!dateFrom) return; // unreachable (missCount caught it) — narrows for TS below
    if (dateTo && dateTo < dateFrom) {
      setError('The end time can’t be before the start time.');
      return;
    }
    setSaving(true);
    // Minimal diff vs the loaded meta — send only changed fields. dateFrom is
    // guaranteed set here (required + narrowed above), so it's never null; dateTo
    // sends null to clear. Timezone rides along whenever either date is present.
    const body: MomentSettingsBody = {};
    if (name.trim() !== (meta.name ?? '')) body.name = name.trim();
    const fromIso = dateFrom.toISOString();
    const toIso = dateTo ? dateTo.toISOString() : null;
    if (fromIso !== (meta.dateFrom ?? null)) body.dateFrom = fromIso;
    if (toIso !== (meta.dateTo ?? null)) body.dateTo = toIso;
    if ((body.dateFrom !== undefined || body.dateTo !== undefined) && (dateFrom || dateTo)) {
      body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    if (address.trim() !== (meta.address ?? '')) body.address = address.trim();
    if (description.trim() !== (meta.description ?? '')) body.description = description.trim();
    if (link.trim() !== (meta.link ?? '')) body.link = link.trim();
    if (coverData) body.coverPhoto = coverData;
    else if (!coverUrl && meta.coverPhotoUrl) body.coverPhoto = null; // removed

    if (Object.keys(body).length === 0) { onDiscard(); return; }
    try {
      await updateMomentSettings(code, body);
      onSaved();
    } catch (e) {
      setSaving(false);
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      setError(msg && msg !== 'http' ? msg : "Couldn't save changes. Check your connection and try again.");
    }
  };

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <VBar title="Moment Details" />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: insets.bottom + FOOT_CLEARANCE }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {/* .set-photo — cover with glass edit/remove buttons; no cover yet =>
            the dashed add affordance (same as create's empty CoverPicker). */}
        {coverUrl ? (
          <View style={{ position: 'relative', marginBottom: 18 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Open cover photo fullscreen" onPress={() => setCoverFullscreen(true)}>
              <Image source={{ uri: coverUrl }} alt="" style={{ width: '100%', height: 130, borderRadius: radius.md }} resizeMode="cover" />
            </Pressable>
            <GlassButton label="Change Photo" icon="edit" right={52} onPress={onPickCover} />
            <GlassButton label="Remove Photo" icon="trash" right={10} onPress={onRemoveCover} />
            <FullscreenImage uri={coverUrl} visible={coverFullscreen} label="Cover Photo" onClose={() => setCoverFullscreen(false)} />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={onPickCover}
            style={({ pressed }) => ({
              height: 104,
              borderRadius: radius.md,
              borderWidth: 1.5,
              borderStyle: 'dashed',
              borderColor: theme.rule,
              backgroundColor: theme.surfaceSunk,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 18,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name="cam" size={24} color={theme.inkSoft} />
            <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold', marginTop: 4 }}>Add a cover photo</VText>
          </Pressable>
        )}
        {coverError ? (
          <VText variant="small" style={{ marginTop: -10, marginBottom: 10, color: theme.critical }}>{coverError}</VText>
        ) : null}

        <View style={{ marginBottom: 14 }}>
          <TextField label="Moment Name" placeholder="Friday natural wines" value={name} onChangeText={(t) => { setName(t); if (badFields.name && t.trim()) { setBadFields((b) => ({ ...b, name: false })); if (!badFields.start) setError(null); } }} invalid={badFields.name} autoCorrect={false} />
        </View>
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 14 }}>
          <DateField label="From" value={dateFrom} placeholder="Tap to set" error={badFields.start} onChange={(d) => { setDateFrom(d); if (d && badFields.start) { setBadFields((b) => ({ ...b, start: false })); if (!badFields.name) setError(null); } }} defaultValue={() => nextFullHour()} maximumDate={dateTo ?? undefined} />
          <DateField label="To" value={dateTo} onChange={setDateTo} defaultValue={() => new Date((dateFrom ?? nextFullHour()).getTime() + 6 * 3600_000)} minimumDate={dateFrom ?? undefined} />
        </View>
        <View style={{ marginBottom: 14 }}>
          <TextField label="Address" placeholder="Where's it happening?" value={address} onChangeText={setAddress} />
        </View>
        <View style={{ marginBottom: 14 }}>
          <NotesField label="Description" placeholder="Notes for your guests…" value={description} onChange={setDescription} />
        </View>
        <View style={{ marginBottom: 14 }}>
          <TextField label="Event Link" placeholder="Menu, event page…" value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        </View>
      </ScrollView>

      <SettingsFooter saving={saving} error={error} onDiscard={onDiscard} onSave={onSave} bottomInset={insets.bottom} />
    </View>
  );
}
