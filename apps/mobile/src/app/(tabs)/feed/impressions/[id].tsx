import { useLocalSearchParams } from 'expo-router';
import { normalizePublicUserId } from '@verre/core';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { DiscoveriesScreen } from '@/components/profile/lists/DiscoveriesScreen';

// Someone's (or your) Impressions (lists plan), pushed from the profile's tile
// (lib/sessionStack.ts feedHref 'impressions'). You mirrors it at
// /(tabs)/you/impressions/[id]; on an opened post's stack it is
// feed/[id]/impressions/[personId].tsx.
export default function ImpressionsList() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // A PUBLIC id; an old integer link or anything else is not a person.
  const userId = normalizePublicUserId(id);
  if (!userId) return <CenteredMessage title="These impressions aren’t available" />;
  return <DiscoveriesScreen userId={userId} initial="impressions" />;
}
