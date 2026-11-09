import { View } from 'react-native';
import { ProfileScreen } from '@/components/profile/ProfileScreen';
import { authClient } from '@/lib/authClient';

// The You tab's root: your own profile (handoff 04·R5c, step 1). Sign out,
// About and the dev gallery moved to ⋯ → Settings.
export default function You() {
  const meId = authClient.useSession().data?.user.id;
  if (meId == null) return <View style={{ flex: 1 }} />;
  return <ProfileScreen userId={Number(meId)} root />;
}
