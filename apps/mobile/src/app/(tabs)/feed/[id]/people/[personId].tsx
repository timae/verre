import { useLocalSearchParams } from 'expo-router';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { PeopleScreen } from '@/components/people/PeopleScreen';
import { peopleTab } from '@/lib/api/people';

// Someone's People opened from INSIDE an opened post (a profile on the post's
// stack), pushed on the post's own stack. Its own wrapper because the owning
// post already holds `id` in this route tree; the person is `personId`.
export default function PostStackPeople() {
  const { personId, tab, known } = useLocalSearchParams<{ personId: string; tab?: string; known?: string }>();
  const userId = Number(personId);
  if (!Number.isInteger(userId) || userId < 1) return <CenteredMessage title="These people aren’t available" />;
  return <PeopleScreen userId={userId} initialTab={peopleTab(tab)} initialKnown={known === '1'} />;
}
