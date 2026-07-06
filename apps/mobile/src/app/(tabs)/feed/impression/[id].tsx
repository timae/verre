import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { CenteredMessage } from '@/components/ui/ConnectionState';
import { VBar } from '@/components/VBar';

// Full impression detail page reached from a feed card's glass panel
// (proposal 08 §3). CHECKPOINT-2 build: photo hero + rating below + swipe
// between the moment's impressions + tap-hero-to-fullscreen. This is the
// checkpoint-1 placeholder so the feed→detail navigation resolves and the
// list is judgeable on-device first.
export default function FeedImpression() {
  const { id, index } = useLocalSearchParams<{ id: string; index?: string }>();
  return (
    <View style={{ flex: 1 }}>
      <VBar title="Impression" />
      <CenteredMessage title="Impression detail" body={`Coming next (post ${id}, wine ${index ?? 0}).`} />
    </View>
  );
}
