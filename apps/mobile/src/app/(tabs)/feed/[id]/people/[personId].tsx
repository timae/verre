import { useLocalSearchParams } from 'expo-router';
import { normalizePublicUserId } from '@verre/core';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { PeopleScreen } from '@/components/people/PeopleScreen';
import { peopleTab } from '@/lib/api/people';

// Someone's People opened from INSIDE an opened post (a profile on the post's
// stack), pushed on the post's own stack. Its own wrapper because the owning
// post already holds `id` in this route tree; the person is `personId`.
export default function PostStackPeople() {
  const { personId, tab, known } = useLocalSearchParams<{ personId: string; tab?: string; known?: string }>();
  // A PUBLIC id (case-insensitive, canonical uppercase); an old integer link
  // or anything else is not a person.
  const userId = normalizePublicUserId(personId);
  if (!userId) return <CenteredMessage title="These people aren’t available" />;
  return <PeopleScreen userId={userId} initialTab={peopleTab(tab)} initialKnown={known === '1'} />;
}
