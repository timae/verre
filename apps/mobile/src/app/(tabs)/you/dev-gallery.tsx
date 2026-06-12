import { Redirect } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlavourWheel, type WheelAxis } from '@/components/scoring/FlavourWheel';
import { StarScore } from '@/components/scoring/StarScore';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { space, themes, useTheme, type ThemeChoice } from '@/theme';

// Dev-only widget gallery + theme switcher: the Simulator verification surface
// for the read-only scoring widgets and the NativeTabs/theming spike. Not a
// user surface — the wheel ships to users when its screen lands (next
// milestone), with the design-resolved flavour palette.
const SAMPLE: WheelAxis[] = [
  { label: 'Red fruit', color: '#C0563E', value: 4 },
  { label: 'Citrus', color: '#D9A227', value: 2 },
  { label: 'Floral', color: '#B070A8', value: 1 },
  { label: 'Earth', color: '#7A5A3A', value: 3 },
  { label: 'Spice', color: '#9A6FA0', value: 2 },
  { label: 'Oak', color: '#A8865C', value: 5 },
  { label: 'Body', color: '#6E5A8A', value: 3 },
  { label: 'Acidity', color: '#5E9B8A', value: 4 },
];

export default function DevGallery() {
  const insets = useSafeAreaInsets();
  const { theme, choice, setChoice } = useTheme();
  if (!__DEV__) return <Redirect href="/moments" />;

  return (
    <>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.bg }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + space.xl, gap: space.lg }}
      >
        <View style={{ gap: space.xs }}>
          <VText variant="heading">Theme</VText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
            {(['system', ...Object.keys(themes)] as ThemeChoice[]).map((c) => (
              <Button key={c} title={c} size="sm" variant={choice === c ? 'primary' : 'secondary'} onPress={() => setChoice(c)} />
            ))}
          </View>
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">Star + value</VText>
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <StarScore value={4.25} />
            <StarScore value={5} />
            <StarScore value={0.75} size={18} />
          </View>
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">Flavour wheel</VText>
          <View style={{ alignItems: 'center' }}>
            <FlavourWheel axes={SAMPLE} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <FlavourWheel axes={SAMPLE} size={72} labels={false} />
            <VText variant="small" color="inkSoft">mini (feed-card scale)</VText>
          </View>
        </View>
      </ScrollView>
    </>
  );
}
