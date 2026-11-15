import { useLocalSearchParams } from 'expo-router';
import { normalizePublicUserId } from '@verre/core';
import { PalateScreen } from '@/components/profile/ComingLater';
import { CenteredMessage } from '@/components/ui/ConnectionState';

// Someone's (or your) Palate, a placeholder for now (components/profile/
// ComingLater.tsx), pushed from the profile's status line (lib/sessionStack.ts
// feedHref 'palate'). You mirrors it at /(tabs)/you/palate/[id]; on an opened
// post's stack it is feed/[id]/palate/[personId].tsx.
export default function Palate() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const userId = normalizePublicUserId(id);
  if (!userId) return <CenteredMessage title="This palate isn’t available" />;
  return <PalateScreen userId={userId} />;
}
