import { useLocalSearchParams } from 'expo-router';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { PeopleScreen } from '@/components/people/PeopleScreen';
import { peopleTab } from '@/lib/api/people';

// Someone's People (handoff 04·11): Friends / Followers / Following, pushed
// from their profile's counts or in-common row (lib/sessionStack.ts feedHref
// 'people'). You mirrors it at /(tabs)/you/people/[id]; on an opened post's
// stack it is feed/[id]/people/[personId].tsx. `tab` + `known` seed the
// screen (presentation only).
export default function People() {
  const { id, tab, known } = useLocalSearchParams<{ id: string; tab?: string; known?: string }>();
  const userId = Number(id);
  if (!Number.isInteger(userId) || userId < 1) return <CenteredMessage title="These people aren’t available" />;
  return <PeopleScreen userId={userId} initialTab={peopleTab(tab)} initialKnown={known === '1'} />;
}
