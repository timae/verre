import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { OptionSheet } from '@/components/moments/momentForm';
import { ChoiceRow, SetPage, SetTitle, ToggleRow } from '@/components/moments/settingsParts';
import {
  BLOCKS_KEY, MUTES_KEY, VISIBILITY_KEY, getBlocks, getMutes, getVisibility, patchVisibility,
  type CheckinVisibility, type ListedPerson, type ProfileVisibility, type VisibilityChanges, type VisibilitySettings,
} from '@/lib/api/settings';
import { ApiError } from '@/lib/api/sessions';
import { errorText } from '@/lib/errorCopy';
import { viewerCacheEpoch } from '@/lib/query';
import { settingsHref, useSessionTab } from '@/lib/sessionStack';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { broader, canonical, extendedApplies, extendedOn, sameTier } from '@/lib/postAudience';

// Ruling P1: the server's four tiers, Friends = mutual follows.
const TIERS: ReadonlyArray<{ code: ProfileVisibility; label: string }> = [
  { code: 'public-internet', label: 'Everyone' },
  { code: 'public-users', label: 'Verre Users' },
  { code: 'public-followers', label: 'Followers' },
  { code: 'public-mutual', label: 'Friends' },
];
// Posts (Check-Ins Visible To on the wire; step 4, ruling Q2; "posts" in
// all copy, ruled 2026-11-11). "Same as Account" is a switch (the
// server's null); off shows these choices. The stricter of account and posts
// always wins, so a choice BROADER than the account is greyed with a why, and
// the SAME tier is greyed as "Same as account visibility" unless the extended
// circle is on (then it means "without friends of friends"). Only Me never is.
const POST_CHOICES: ReadonlyArray<{ code: CheckinVisibility; label: string }> = [
  { code: 'public-users', label: 'Verre Users' },
  { code: 'public-followers', label: 'Followers' },
  { code: 'public-mutual', label: 'Friends' },
  { code: 'only-me', label: 'Only Me' },
];
// The extended circle follows the tier (ruled 2026-11-11): followers of your
// followers, or friends of your friends. ⚠️ The server's rule for Friends still
// admits followers of followers until the FoF change lands. The audience rules
// (canonical, sameAudience, …) live in lib/postAudience.ts.
const extendedLabel = (p: ProfileVisibility) => (p === 'public-mutual' ? 'Friends of Friends' : 'Followers of Followers');
const extendedHelper = (p: ProfileVisibility) =>
  p === 'public-mutual' ? 'Also people your friends are friends with' : 'Also people who follow your followers';
const SAVE_KEY = ['me', 'visibility', 'save'] as const;
const sameSettings = (a: VisibilitySettings, b: VisibilitySettings) =>
  (Object.keys(a) as (keyof VisibilitySettings)[]).every((k) => a[k] === b[k]);

// Privacy (handoff 04·4 `setPrivacy`, laid out per the 2026-11-11 design
// screenshot): Account Visibility (Visible To + the extended circle for the
// two strict tiers), Post Visibility (Same as Account; off: Visible To), On
// My Profile (Show Cravings, Show Moments, Show My Locations), then Blocked
// and Muted, each a row opening its own page (ruling Q-B).
export default function Privacy() {
  const router = useRouter();
  const mount = useSessionTab();
  const queryClient = useQueryClient();
  const vis = useQuery({ queryKey: VISIBILITY_KEY, queryFn: getVisibility });
  const blocks = useQuery({ queryKey: BLOCKS_KEY, queryFn: getBlocks });
  const mutes = useQuery({ queryKey: MUTES_KEY, queryFn: getMutes });
  const [sheet, setSheet] = useState<'profile' | 'posts' | null>(null);
  // Turning Same as Account off opens the choices; nothing is saved
  // until one is picked, and closing the sheet leaves the switch on.
  const [choosing, setChoosing] = useState(false);
  const picked = useRef(false);
  // 🔒 One PATCH at a time, APP-WIDE: Privacy can be mounted twice (on the
  // You stack and on an opened post's, in another tab). The mutation scope
  // queues saves in tap order, and every mounted editor's controls are
  // disabled while one is pending. networkMode 'always': offline fails at once
  // instead of pausing with the controls locked. The server's compare-and-set
  // (`expected`) refuses a save made from a stale read (409).
  const patch = useMutation({
    mutationKey: SAVE_KEY,
    scope: { id: 'me-visibility' },
    networkMode: 'always',
    mutationFn: ({ expected, changes }: { expected: VisibilitySettings; changes: VisibilityChanges }) => patchVisibility(expected, changes),
  });
  const saving = useIsMutating({ mutationKey: SAVE_KEY }) > 0;

  // Optimistic, with an alert on failure. `changes` = only the field this
  // save changes; `expected` = the cache at TAP time (never this render's
  // closure, which can be a save behind).
  const save = async (changes: VisibilityChanges) => {
    // 🔒 Synchronous: query-core marks a mutation pending before its first
    // await, so a second tap in the same frame is dropped here (the render-time
    // `saving` can't see it yet).
    if (queryClient.isMutating({ mutationKey: SAVE_KEY }) > 0) return;
    const expected = queryClient.getQueryData<VisibilitySettings>(VISIBILITY_KEY);
    if (!expected) return;
    // From what the page SHOWS (canonical), not the raw stored row: a stored
    // value that displays as Same as Account must stay that way when another
    // field changes (review 2026-11-11). The raw `expected` stays the
    // compare-and-set base and the diff below.
    const next = canonical({ ...canonical(expected), ...changes }, 'visibility' in changes || 'fofEnabled' in changes);
    if (sameSettings(expected, next)) return;
    // A collapse (or clamp) of the posts choice rides in the same PATCH, and
    // a tier change carries the stored FoF too (unchanged, so harmless here:
    // a server from before the compare-and-set, still serving mid-deploy,
    // stores a missing fofEnabled as false).
    const sentChanges: VisibilityChanges = {
      ...('visibility' in changes ? { fofEnabled: expected.fofEnabled } : null),
      ...changes,
      ...(next.checkinVisibility !== expected.checkinVisibility ? { checkinVisibility: next.checkinVisibility } : null),
    };
    const epoch = viewerCacheEpoch();
    const sent = patch.mutateAsync({ expected, changes: sentChanges });
    await queryClient.cancelQueries({ queryKey: VISIBILITY_KEY, exact: true });
    if (viewerCacheEpoch() === epoch) queryClient.setQueryData<VisibilitySettings>(VISIBILITY_KEY, next);
    const outcome = await sent.then((r) => ({ r }), (e: unknown) => ({ e }));
    // Signed out meanwhile: nothing of this viewer's may be written.
    if (viewerCacheEpoch() !== epoch) return;
    // 🔒 A read that started before the PATCH landed (a focus refetch) can
    // carry the OLD value: drop it, show what the server now holds, re-read.
    await queryClient.cancelQueries({ queryKey: VISIBILITY_KEY, exact: true });
    if (viewerCacheEpoch() !== epoch) return;
    if ('r' in outcome) {
      // 200 → what is saved now; 409 → nothing was written, the settings had
      // changed since this page read them (another device, the web): show the
      // server's and say so.
      queryClient.setQueryData<VisibilitySettings>(VISIBILITY_KEY, outcome.r.current ?? next);
      void queryClient.invalidateQueries({ queryKey: VISIBILITY_KEY, exact: true });
      if (!outcome.r.ok) Alert.alert('Settings Changed', 'Your privacy settings changed while saving. This is what’s saved now.');
      return;
    }
    // A refusal (a 4xx) changed nothing: back to the old value. 🔒 Any other
    // failure (no answer, a timeout, a 5xx) may have COMMITTED, so the old
    // value is unconfirmed: drop it, and every mounted editor stays on its
    // loading / retry state until the server's own value reads back.
    const refused = outcome.e instanceof ApiError && outcome.e.status >= 400 && outcome.e.status < 500;
    if (refused) {
      queryClient.setQueryData<VisibilitySettings>(VISIBILITY_KEY, expected);
      void queryClient.invalidateQueries({ queryKey: VISIBILITY_KEY, exact: true });
    } else {
      void queryClient.resetQueries({ queryKey: VISIBILITY_KEY, exact: true });
    }
    Alert.alert('Something went wrong', errorText(outcome.e));
  };

  const v = vis.data ? canonical(vis.data) : undefined;
  const tier = v ? TIERS.find((t) => t.code === v.visibility)?.label ?? '' : '';
  const posts = v?.checkinVisibility ?? null;
  const postsLabel = posts ? POST_CHOICES.find((c) => c.code === posts)?.label ?? '' : '';
  // The same tier as the account with the extended circle on: say what it means.
  const postsHelper = v && posts && sameTier(posts, v.visibility) ? `Without ${extendedLabel(v.visibility).toLowerCase()}` : undefined;
  const postOptions = POST_CHOICES.map((c) => {
    if (!v) return c;
    if (broader(c.code, v.visibility)) return { ...c, disabled: true, hint: 'Change your account visibility first' };
    if (!sameTier(c.code, v.visibility)) return c;
    return extendedOn(v)
      ? { ...c, hint: `Without ${extendedLabel(v.visibility).toLowerCase()}` }
      : { ...c, disabled: true, hint: 'Same as account visibility' };
  });
  return (
    // BottomSheetModalProvider in-screen: the OptionSheet needs a sized host
    // across the Stack boundary (no root provider, see app/_layout.tsx).
    <BottomSheetModalProvider>
    <SetPage title="Privacy" gap={32} bottomPad={TAB_BAR_CLEARANCE + 100}>
      {/* The settings type (ruled 2026-11-11 on device, from the design): a
          SetTitle per topic, rows `body` regular, helpers `small`, no cards. */}
      <View>
        <SetTitle>Account Visibility</SetTitle>
        <ChoiceRow
          flush
          dropdown
          label="Visible To"
          value={v ? tier : vis.isError ? 'Couldn’t load' : ''}
          accessibilityLabel={`Account Visible To: ${v ? tier : vis.isError ? 'Couldn’t load' : 'Loading'}`}
          disabled={!v && !vis.isError}
          busy={saving}
          onPress={() => (v ? setSheet('profile') : void vis.refetch())}
        />
        {v && extendedApplies(v.visibility) ? (
          <ToggleRow
            title={`Include ${extendedLabel(v.visibility)}`}
            subtitle={extendedHelper(v.visibility)}
            value={v.fofEnabled}
            busy={saving}
            onChange={(on) => void save({ fofEnabled: on })}
          />
        ) : null}
      </View>
      {v ? (
        <View>
          <SetTitle>Post Visibility</SetTitle>
          <ToggleRow
            flush
            title="Same as Account"
            subtitle="Turn off to share posts with fewer people"
            value={posts === null && !choosing}
            busy={saving}
            onChange={(on) => {
              if (on) return void save({ checkinVisibility: null });
              picked.current = false;
              setChoosing(true);
              setSheet('posts');
            }}
          />
          {posts ? (
            <ChoiceRow
              dropdown
              label="Visible To"
              value={postsLabel}
              helper={postsHelper}
              accessibilityLabel={`Posts Visible To: ${postsLabel}${postsHelper ? `, ${postsHelper}` : ''}`}
              busy={saving}
              onPress={() => setSheet('posts')}
            />
          ) : null}
        </View>
      ) : null}
      {/* Only once loaded: a placeholder value would show a switch you turned off as on. */}
      {v ? (
        <View>
          <SetTitle>On My Profile</SetTitle>
          <ToggleRow flush title="Show Cravings" subtitle="Others can see what you crave" value={v.showCravings} busy={saving} onChange={(on) => void save({ showCravings: on })} />
          <ToggleRow title="Show Moments" subtitle="Others can see the moments you joined" value={v.showMoments} busy={saving} onChange={(on) => void save({ showMoments: on })} />
          <ToggleRow title="Show My Locations" subtitle="Places on your posts" value={v.showLocations} busy={saving} onChange={(on) => void save({ showLocations: on })} />
        </View>
      ) : null}
      <View>
        <SetTitle>People</SetTitle>
        <ListRow flush icon="block" label="Blocked" q={blocks} onPress={() => router.push(settingsHref(mount, 'blocked'), { dangerouslySingular: true })} />
        <ListRow icon="eyeoff" label="Muted" q={mutes} onPress={() => router.push(settingsHref(mount, 'muted'), { dangerouslySingular: true })} />
      </View>
      <OptionSheet
        open={sheet === 'profile'}
        title="Account Visible To"
        options={TIERS}
        selected={v?.visibility ?? null}
        onClose={() => setSheet(null)}
        onSelect={(code) => {
          setSheet(null);
          void save({ visibility: code });
        }}
      />
      <OptionSheet
        open={sheet === 'posts'}
        title="Posts Visible To"
        options={postOptions}
        selected={posts}
        onClose={() => {
          setSheet(null);
          if (!picked.current) setChoosing(false);
        }}
        onSelect={(code) => {
          picked.current = true;
          setSheet(null);
          // The switch stays off until the save lands (no flicker back on).
          void save({ checkinVisibility: code }).finally(() => setChoosing(false));
        }}
      />
    </SetPage>
    </BottomSheetModalProvider>
  );
}

// Blocked / Muted: the count, or "No one" once a fetch succeeded empty, both
// with the chevron (both open their list, which says "No one blocked." when
// empty). No value and inert while loading; on an error the row stays
// tappable (the page shows the error + retry): for a mutual block it is the
// only unblock path.
function ListRow({ icon, label, q, onPress, flush }: {
  icon: 'block' | 'eyeoff';
  label: string;
  q: { data?: ListedPerson[]; isError: boolean };
  onPress: () => void;
  flush?: boolean;
}) {
  if (q.data) return <ChoiceRow flush={flush} icon={icon} label={label} value={q.data.length === 0 ? 'No one' : String(q.data.length)} onPress={onPress} />;
  return <ChoiceRow flush={flush} icon={icon} label={label} value="" onPress={q.isError ? onPress : undefined} />;
}
