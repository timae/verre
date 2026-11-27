import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Alert } from 'react-native';
import { applyMomentDefault, getMomentDefaults, MOMENT_DEFAULTS_KEY, patchMomentDefault, type DefaultsPreview, type MomentDefaultField, type MomentDefaults } from '@/lib/api/momentDefaults';
import { ApiError } from '@/lib/api/sessions';
import { errorText } from '@/lib/errorCopy';
import { useMeId } from '@/lib/meId';
import { applyDefaultAlert } from '@/lib/momentVisibilityCopy';
import { afterDefaultsApply } from '@/lib/postPrivacyActions';
import { viewerCacheEpoch } from '@/lib/query';

// Your Moment Defaults as an editor (docs/dev/proposals/moment-defaults.md;
// plan § 3): Settings → Privacy (your own join defaults, the check-ins' Hide
// from Feed) and Settings → Moments → Moment Defaults (moments you create)
// both edit through this, saved on change, ONE save at a time per screen (the
// Moment Privacy page's ref). 🔒 COPIED, never live: a save changes nothing
// that exists. When something you already have differs (`existing` on the
// answer), the native alert (D3): "All N …" applies THAT setting (the server
// applies the stored default to what differs now: ruled, no binding), "New …
// Only" keeps the existing ones, Cancel undoes the change. Success is silent; a failure (a 429 included: its
// narrowing part applied) is the house error alert; EVERY apply answer
// refreshes the feeds, the moments' Moment Privacy copies and the opened posts
// (afterDefaultsApply). Concurrent changes elsewhere are not handled (ruled).
export function useMomentDefaults() {
  const queryClient = useQueryClient();
  const meId = useMeId();
  const q = useQuery({ queryKey: MOMENT_DEFAULTS_KEY, queryFn: getMomentDefaults });
  // What the screen shows while a save is in flight; null = the query's copy.
  const [view, setView] = useState<MomentDefaults | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);

  const apply = async (field: MomentDefaultField) => {
    const epoch = viewerCacheEpoch();
    try {
      await applyMomentDefault(field);
    } catch (e) {
      if (viewerCacheEpoch() === epoch) Alert.alert('Something went wrong', errorText(e));
    } finally {
      // After EVERY answer, a 429 included (review r4 P3), even when you have
      // left the page meanwhile: an opened post re-reads on its own.
      if (viewerCacheEpoch() === epoch) afterDefaultsApply(queryClient, field, meId);
    }
  };
  // Three buttons (Simon, 2026-11-25: "i miss exiting it", and Cancel undoes
  // the change): "All N …" applies the new default to what differs, "New …
  // Only" keeps it for new ones, Cancel puts the setting back (a second save
  // of the value it had, with no alert of its own). A centred iOS alert never
  // closes on a backdrop tap, so Cancel is the way out.
  const ask = <F extends MomentDefaultField>(p: DefaultsPreview, field: F, before: MomentDefaults[F]) => {
    const a = applyDefaultAlert(p);
    Alert.alert(a.title, a.message, [
      { text: a.all, onPress: () => void apply(p.field) },
      { text: a.keep },
      { text: 'Cancel', style: 'cancel', onPress: () => void save(field, before, false) },
    ]);
  };
  const save = async <F extends MomentDefaultField>(field: F, value: MomentDefaults[F], askAfter = true) => {
    // 🔒 Synchronous: a second tap in the same frame can't start a second save.
    if (busy.current) return;
    const cur = queryClient.getQueryData<MomentDefaults>(MOMENT_DEFAULTS_KEY);
    if (!cur || cur[field] === value) return;
    busy.current = true;
    setSaving(true);
    const epoch = viewerCacheEpoch();
    try {
      // A read in flight may carry the value from before this save.
      await queryClient.cancelQueries({ queryKey: MOMENT_DEFAULTS_KEY, exact: true });
      if (viewerCacheEpoch() !== epoch) return;
      setView({ ...cur, [field]: value });
      const r = await patchMomentDefault(field, value);
      if (viewerCacheEpoch() !== epoch) return;
      await queryClient.cancelQueries({ queryKey: MOMENT_DEFAULTS_KEY, exact: true });
      if (viewerCacheEpoch() !== epoch) return;
      queryClient.setQueryData(MOMENT_DEFAULTS_KEY, r.defaults);
      setView(null);
      if (r.existing && askAfter) ask(r.existing, field, cur[field]);
    } catch (e) {
      if (viewerCacheEpoch() !== epoch) return;
      setView(null);
      // A refusal changed nothing; no answer (a timeout, a 5xx) may have saved.
      if (!(e instanceof ApiError && e.status >= 400 && e.status < 500)) void queryClient.invalidateQueries({ queryKey: MOMENT_DEFAULTS_KEY, exact: true });
      Alert.alert('Something went wrong', errorText(e));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  return { q, shown: view ?? q.data, saving, save };
}
