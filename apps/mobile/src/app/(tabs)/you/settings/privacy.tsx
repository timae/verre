import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { FieldGroup, OptionSheet, SelectField } from '@/components/moments/momentForm';
import { SetGroup, SetNav, SetPage, SetSection, SetSwitch } from '@/components/moments/settingsParts';
import {
  BLOCKS_KEY, MUTES_KEY, VISIBILITY_KEY, getBlocks, getMutes, getVisibility, patchVisibility,
  type ListedPerson, type ProfileVisibility, type VisibilitySettings,
} from '@/lib/api/settings';
import { ApiError } from '@/lib/api/sessions';
import { errorText } from '@/lib/errorCopy';
import { viewerCacheEpoch } from '@/lib/query';
import { settingsHref, useSessionTab } from '@/lib/sessionStack';

// Ruling P1: the server's four tiers, Friends = mutual follows.
const TIERS: ReadonlyArray<{ code: ProfileVisibility; label: string }> = [
  { code: 'public-internet', label: 'Everyone' },
  { code: 'public-users', label: 'Verre Users' },
  { code: 'public-followers', label: 'Followers' },
  { code: 'public-mutual', label: 'Friends' },
];
const fofApplies = (v: ProfileVisibility) => v === 'public-followers' || v === 'public-mutual';
const SAVE_KEY = ['me', 'visibility', 'save'] as const;

// Privacy (handoff 04·4 `setPrivacy`): Profile Visible To (+ Friends of
// Friends for the two strict tiers), Check-Ins Visible To ("Soon", step 4),
// the two locked profile switches (step 4), then Blocked and Muted, each a
// row opening its own page (ruling Q-B).
export default function Privacy() {
  const router = useRouter();
  const mount = useSessionTab();
  const queryClient = useQueryClient();
  const vis = useQuery({ queryKey: VISIBILITY_KEY, queryFn: getVisibility });
  const blocks = useQuery({ queryKey: BLOCKS_KEY, queryFn: getBlocks });
  const mutes = useQuery({ queryKey: MUTES_KEY, queryFn: getMutes });
  const [sheet, setSheet] = useState(false);
  // 🔒 One PATCH at a time, APP-WIDE: two in flight are separate transactions
  // that can commit in either order, so the server could end on the older,
  // broader value, and Privacy can be mounted twice (on the You stack and on
  // an opened post's, in another tab). The mutation scope queues saves in tap
  // order, and every mounted editor's select + switch are disabled while one
  // is pending. networkMode 'always': offline fails at once instead of
  // pausing with the controls locked.
  const patch = useMutation({ mutationKey: SAVE_KEY, scope: { id: 'me-visibility' }, networkMode: 'always', mutationFn: patchVisibility });
  const saving = useIsMutating({ mutationKey: SAVE_KEY }) > 0;

  // Optimistic, with an alert on failure. 🔒 Always BOTH fields: the PATCH
  // replaces them, and a missing fofEnabled would turn it off.
  const save = async (next: VisibilitySettings) => {
    const cur = vis.data;
    if (!cur || saving || (cur.visibility === next.visibility && cur.fofEnabled === next.fofEnabled)) return;
    const epoch = viewerCacheEpoch();
    const sent = patch.mutateAsync(next);
    await queryClient.cancelQueries({ queryKey: VISIBILITY_KEY, exact: true });
    if (viewerCacheEpoch() === epoch) queryClient.setQueryData<VisibilitySettings>(VISIBILITY_KEY, next);
    const failure = await sent.then(() => null, (e: unknown) => ({ e }));
    // Signed out meanwhile: nothing of this viewer's may be written.
    if (viewerCacheEpoch() !== epoch) return;
    // 🔒 A read that started before the PATCH landed (a focus refetch) can
    // carry the OLD value, and a save made from it would send it back: drop
    // it, show what the server now holds, then re-read.
    await queryClient.cancelQueries({ queryKey: VISIBILITY_KEY, exact: true });
    if (viewerCacheEpoch() !== epoch) return;
    if (!failure) {
      queryClient.setQueryData<VisibilitySettings>(VISIBILITY_KEY, next);
      return void queryClient.invalidateQueries({ queryKey: VISIBILITY_KEY, exact: true });
    }
    // A refusal (a 4xx) changed nothing: back to the old value. 🔒 Any other
    // failure (no answer, a timeout, a 5xx) may have COMMITTED, so the old
    // value is unconfirmed: drop it, and every mounted editor stays on its
    // loading / retry state until the server's own value reads back.
    const refused = failure.e instanceof ApiError && failure.e.status >= 400 && failure.e.status < 500;
    if (refused) {
      queryClient.setQueryData<VisibilitySettings>(VISIBILITY_KEY, cur);
      void queryClient.invalidateQueries({ queryKey: VISIBILITY_KEY, exact: true });
    } else {
      void queryClient.resetQueries({ queryKey: VISIBILITY_KEY, exact: true });
    }
    Alert.alert('Something went wrong', errorText(failure.e));
  };

  const v = vis.data;
  const tier = v ? TIERS.find((t) => t.code === v.visibility)?.label ?? '' : '';
  return (
    // BottomSheetModalProvider in-screen: the OptionSheet needs a sized host
    // across the Stack boundary (no root provider, see app/_layout.tsx).
    <BottomSheetModalProvider>
    <SetPage title="Privacy">
      <SetSection label="Visibility">
        <FieldGroup label="Profile Visible To">
          <SelectField
            value={tier}
            placeholder={vis.isError ? 'Couldn’t load' : ''}
            accessibilityLabel={`Profile Visible To${tier ? `: ${tier}` : vis.isError ? ': Couldn’t load' : ''}`}
            disabled={(!v && !vis.isError) || saving}
            onPress={() => (v ? setSheet(true) : void vis.refetch())}
          />
        </FieldGroup>
        {v && fofApplies(v.visibility) ? (
          <View style={{ marginBottom: 14 }}>
            <SetGroup flush>
              <SetSwitch
                label="Friends of Friends"
                subtitle="Also people one step away, through someone you trust"
                value={v.fofEnabled}
                disabled={saving}
                onChange={(on) => void save({ visibility: v.visibility, fofEnabled: on })}
              />
            </SetGroup>
          </View>
        ) : null}
        <FieldGroup label="Check-Ins Visible To">
          <SelectField value="" placeholder="Soon" accessibilityLabel="Check-Ins Visible To, Soon" disabled onPress={() => {}} />
        </FieldGroup>
      </SetSection>
      <SetSection label="On My Profile">
        <SetGroup flush>
          <SetSwitch label="Show Cravings" subtitle="Others can see what you want to try" value soon />
          <SetSwitch label="Show My Locations" subtitle="Places on check-ins and moments" value soon />
        </SetGroup>
      </SetSection>
      <SetGroup flush>
        <ListRow icon="block" label="Blocked" q={blocks} onPress={() => router.push(settingsHref(mount, 'blocked'))} />
        <ListRow icon="eyeoff" label="Muted" q={mutes} onPress={() => router.push(settingsHref(mount, 'muted'))} />
      </SetGroup>
      <OptionSheet
        open={sheet}
        title="Profile Visible To"
        options={TIERS}
        selected={v?.visibility ?? null}
        onClose={() => setSheet(false)}
        onSelect={(code) => {
          setSheet(false);
          // The stored FoF rides along even while its switch is hidden.
          if (v) void save({ visibility: code, fofEnabled: v.fofEnabled });
        }}
      />
    </SetPage>
    </BottomSheetModalProvider>
  );
}

// Blocked / Muted: the count + chevron once loaded and non-empty; "No one"
// (inert) only after a SUCCESSFUL empty fetch; no value and inert while
// loading. On an error the row stays tappable (the page shows the error +
// retry): for a mutual block it is the only unblock path.
function ListRow({ icon, label, q, onPress }: {
  icon: 'block' | 'eyeoff';
  label: string;
  q: { data?: ListedPerson[]; isError: boolean };
  onPress: () => void;
}) {
  if (q.data && q.data.length === 0) return <SetNav icon={icon} label={label} value="No one" trailing="none" />;
  if (q.data) return <SetNav icon={icon} label={label} value={String(q.data.length)} onPress={onPress} />;
  return <SetNav icon={icon} label={label} trailing={q.isError ? undefined : 'none'} onPress={q.isError ? onPress : undefined} />;
}
