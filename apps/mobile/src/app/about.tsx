import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SetGroup, SetNav } from '@/components/moments/settingsParts';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { GUTTER } from '@/lib/layout';
import { space } from '@/theme';

// About hub — version + the legal surfaces. Deliberately a hub rather than a
// single screen: Terms and Privacy land here when they exist, and Attributions
// is one row among them rather than a top-level Settings entry.
//
// 🔒 LIVES AT THE ROOT, OUTSIDE THE AUTH GUARD (app/_layout.tsx), not under
// (tabs)/you — the attributions it leads to are a LICENCE OBLIGATION and must
// be readable by a signed-out user on first launch. Reached from You → About
// when signed in, and from the auth screens when signed out. No tab-bar
// clearance here: the pill does not render outside (tabs).
export default function About() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const version = Constants.expoConfig?.version ?? '—';

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: insets.top + space.md,
        paddingHorizontal: GUTTER,
        paddingBottom: insets.bottom + space.xl,
      }}
    >
      <VBar title="About" />

      <SetGroup>
        <SetNav icon="info" label="Attributions" onPress={() => router.push('/attributions')} />
      </SetGroup>

      <VText variant="caption" color="inkFaint" style={{ textAlign: 'center', marginTop: space.xs }}>
        Verre {version}
      </VText>
      <View style={{ height: space.lg }} />
    </ScrollView>
  );
}
