import { useLocalSearchParams } from 'expo-router';
import { normalizePublicUserId } from '@verre/core';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { DiscoveriesScreen } from '@/components/profile/lists/DiscoveriesScreen';

// Someone's (or your) Cravings (lists plan), pushed from the profile's tile
// (lib/sessionStack.ts feedHref 'cravings'). You mirrors it at
// /(tabs)/you/cravings/[id]; on an opened post's stack it is
// feed/[id]/cravings/[personId].tsx.
export default function CravingsList() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // A PUBLIC id; an old integer link or anything else is not a person.
  const userId = normalizePublicUserId(id);
  if (!userId) return <CenteredMessage title="These cravings aren’t available" />;
  return <DiscoveriesScreen userId={userId} initial="cravings" />;
}
