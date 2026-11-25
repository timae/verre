import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { HostPrivacyRows } from '@/components/moments/MomentPrivacyRows';
import { SetPage, failedReads } from '@/components/moments/settingsParts';
import { TAB_BAR_CLEARANCE } from '@/lib/layout';
import { MOMENT_DEFAULTS_SECTIONS, MOMENTS_AREA_TITLE } from '@/lib/momentVisibilityCopy';
import { useMomentDefaults } from '@/lib/useMomentDefaults';

// Settings → Moments & Check-Ins (the design's "Tasting" row; Simon's split,
// 2026-11-25): your Moment Defaults for moments you CREATE, right on this page
// for now (Simon: no page one level deeper while they are the only content;
// the tasting defaults, a check-in's category and what you rate, join later).
// Laid out like a moment's Moment Privacy, saved on change with the "Apply to
// Existing Moments?" alert (lib/useMomentDefaults.ts). Your own join default
// and your posts' Hide from Feed are in Settings → Privacy.
export default function MomentsAndCheckins() {
  const { q, shown, saving, save } = useMomentDefaults();
  return (
    <BottomSheetModalProvider>
      <SetPage title={MOMENTS_AREA_TITLE} gap={32} bottomPad={TAB_BAR_CLEARANCE + 100} offline={failedReads(q)}>
        {shown ? (
          <HostPrivacyRows title={MOMENT_DEFAULTS_SECTIONS.host} values={shown} onChange={(field, value) => void save(field, value as never)} busy={saving} />
        ) : null}
      </SetPage>
    </BottomSheetModalProvider>
  );
}
