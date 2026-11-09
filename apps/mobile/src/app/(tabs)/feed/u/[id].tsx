import { useLocalSearchParams } from 'expo-router';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { ProfileScreen } from '@/components/profile/ProfileScreen';

// Someone's profile (handoff 04·5), pushed on the Feed stack from a post's
// author; You mirrors it at /(tabs)/you/u/[id]. Your own id renders the own
// variant with a back button.
export default function UserProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const userId = Number(id);
  if (!Number.isInteger(userId) || userId < 1) return <CenteredMessage title="This profile isn’t available" />;
  return <ProfileScreen userId={userId} />;
}
