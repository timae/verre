import { useLocalSearchParams } from 'expo-router';
import { normalizePublicUserId } from '@verre/core';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { ProfileScreen } from '@/components/profile/ProfileScreen';

// Someone's profile (handoff 04·5), pushed on the Feed stack from a post's
// author; You mirrors it at /(tabs)/you/u/[id]. Your own id renders the own
// variant with a back button.
export default function UserProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // A PUBLIC id (case-insensitive, canonical uppercase); an old integer link
  // or anything else is not a person.
  const userId = normalizePublicUserId(id);
  if (!userId) return <CenteredMessage title="This profile isn’t available" />;
  return <ProfileScreen userId={userId} />;
}
