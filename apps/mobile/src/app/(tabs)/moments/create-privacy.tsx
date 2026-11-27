import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { MomentPrivacyRows } from '@/components/moments/MomentPrivacyRows';
import { SetPage } from '@/components/moments/settingsParts';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { getVisibility, VISIBILITY_KEY } from '@/lib/api/settings';
import { getCreatePrivacy, setCreatePrivacy, subscribeCreatePrivacy } from '@/lib/createPrivacy';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';

// Create Moment → Privacy (Moment Defaults D4, plan § 3): THIS moment's
// privacy before it exists, both sections of Moment Privacy, on local state
// (lib/createPrivacy.ts, keyed by the create screen) — nothing is saved here;
// the create's POST carries the six values. Mounted beside each create
// (Moments, Feed, You), so Back is the create screen.
export default function CreatePrivacy() {
  const { key: raw } = useLocalSearchParams<{ key?: string }>();
  const key = typeof raw === 'string' ? raw : '';
  const values = useSyncExternalStore(subscribeCreatePrivacy, () => getCreatePrivacy(key), () => getCreatePrivacy(key));
  const vis = useQuery({ queryKey: VISIBILITY_KEY, queryFn: getVisibility, staleTime: 60_000 });
  return (
    <BottomSheetModalProvider>
      <SetPage title="Moment Privacy" gap={32} bottomPad={TAB_BAR_CLEARANCE + 100}>
        {values ? (
          <MomentPrivacyRows values={values} onChange={(field, value) => setCreatePrivacy(key, field, value)} account={vis.data} />
        ) : (
          // A page whose create screen is gone (a restored state).
          <CenteredMessage title="This isn’t available any more" />
        )}
      </SetPage>
    </BottomSheetModalProvider>
  );
}
