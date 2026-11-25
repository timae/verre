// Your own Privacy settings opened from a moment's Moment Privacy ("Outside
// This Moment", Moment Visibility step 3, R15): the You tab's page on THIS
// stack, so Back returns to the moment (device pass 2026-11-25: the jump to
// the You tab came back elsewhere). Mirrored on every session mount.
import { PrivacySettings } from '@/app/(tabs)/you/settings/privacy';
import { ACCOUNT_PRIVACY_TITLE } from '@/lib/momentVisibilityCopy';

export default function MyPrivacyInMoment() {
  return <PrivacySettings inMoment title={ACCOUNT_PRIVACY_TITLE} />;
}
