import { useLocalSearchParams } from 'expo-router';
import { normalizePublicUserId } from '@verre/core';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { ProfileScreen } from '@/components/profile/ProfileScreen';

// Someone's profile opened from INSIDE an opened post (its author, or a
// profile reached from there), pushed on the post's own stack. Its own wrapper
// because the owning post already holds `id` in this route tree; the person
// is `personId`. The outer profile is feed/u/[id].tsx.
export default function PostStackProfile() {
  const { personId } = useLocalSearchParams<{ personId: string }>();
  // A PUBLIC id (case-insensitive, canonical uppercase); an old integer link
  // or anything else is not a person.
  const userId = normalizePublicUserId(personId);
  if (!userId) return <CenteredMessage title="This profile isn’t available" />;
  return <ProfileScreen userId={userId} />;
}
