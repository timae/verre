import { useLocalSearchParams } from 'expo-router';
import { normalizePublicUserId } from '@verre/core';
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
  // A PUBLIC id (case-insensitive, canonical uppercase); an old integer link
  // or anything else is not a person.
  const userId = normalizePublicUserId(id);
  if (!userId) return <CenteredMessage title="These people aren’t available" />;
  return <PeopleScreen userId={userId} initialTab={peopleTab(tab)} initialKnown={known === '1'} />;
}
