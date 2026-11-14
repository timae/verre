import { useLocalSearchParams } from 'expo-router';
import { normalizePublicUserId } from '@verre/core';
import { PalateScreen } from '@/components/profile/ComingLater';
import { CenteredMessage } from '@/components/ui/ConnectionState';

// Someone's Palate opened from INSIDE an opened post, on the post's own stack
// (the owning post holds `id` in this route tree; the person is `personId`).
export default function PostStackPalate() {
  const { personId } = useLocalSearchParams<{ personId: string }>();
  const userId = normalizePublicUserId(personId);
  if (!userId) return <CenteredMessage title="This palate isn’t available" />;
  return <PalateScreen userId={userId} />;
}
