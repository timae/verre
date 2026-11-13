import { useLocalSearchParams } from 'expo-router';
import { normalizePublicUserId } from '@verre/core';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { DiscoveriesScreen } from '@/components/profile/lists/DiscoveriesScreen';

// Someone's Impressions opened from INSIDE an opened post (a profile on the
// post's stack), pushed on the post's own stack. Its own wrapper because the
// owning post already holds `id` in this route tree; the person is `personId`.
export default function PostStackImpressions() {
  const { personId } = useLocalSearchParams<{ personId: string }>();
  const userId = normalizePublicUserId(personId);
  if (!userId) return <CenteredMessage title="These impressions aren’t available" />;
  return <DiscoveriesScreen userId={userId} initial="impressions" />;
}
