import { Redirect } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { resolveAxes, perRatingAxes } from '@verre/core';
import { FlavourWheel, type WheelAxis } from '@/components/scoring/FlavourWheel';
import { FlavourInput } from '@/components/scoring/FlavourInput';
import { StarScore } from '@/components/scoring/StarScore';
import { QrCode } from '@/components/ui/QrCode';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { contrastRatio } from '@/lib/contrast';
import { useFlavourColors } from '@/theme/flavourColors';
import { radius, space, themes, useTheme, type ThemeChoice } from '@/theme';

// Dev-only widget gallery + theme switcher: the Simulator verification surface
// for the scoring widgets and the NativeTabs/theming spike. Not a user surface.
//
// Structure-wheel data: the axes are the real registry set (resolveAxes) with
// colour resolved from the ACTIVE THEME (useFlavourColors) — switch themes above
// to see the wheel + input retint. A sparkling style is used here so Bubbles
// shows; the values are a demo profile.
const SAMPLE_STYLE = 'spark';
const SAMPLE_LEVELS: Record<string, number> = {
  sweet: 2,
  acid: 4,
  body: 3,
  finish: 4,
  aroma: 3,
  flavour: 5,
  tannin: 2,
  bubbles: 4,
};

export default function DevGallery() {
  const insets = useSafeAreaInsets();
  const { theme, choice, setChoice } = useTheme();
  const axisColor = useFlavourColors();
  const [levels, setLevels] = useState<Record<string, number>>(SAMPLE_LEVELS);
  if (!__DEV__) return <Redirect href="/moments" />;

  // Wheel reads the SAME resolved axes + theme colours the input writes.
  const sample: WheelAxis[] = perRatingAxes(levels, resolveAxes('wine', SAMPLE_STYLE)).map((a) => ({
    label: a.l,
    color: axisColor(a.k),
    value: levels[a.k] ?? 0,
  }));

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
          <VText variant="heading">Flavour input</VText>
          <VText variant="small" color="inkSoft">Fill-track — tap/drag; wheel below updates live.</VText>
          <FlavourInput style={SAMPLE_STYLE} value={levels} onChange={setLevels} />
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">Flavour wheel</VText>
          <View style={{ alignItems: 'center' }}>
            <FlavourWheel axes={sample} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <FlavourWheel axes={sample} size={72} labels={false} />
            <VText variant="small" color="inkSoft">mini (feed-card scale)</VText>
          </View>
        </View>

        <View style={{ gap: space.xs }}>
          <VText variant="heading">QR code</VText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
            <View style={{ gap: 4 }}>
              <View style={{ padding: 12, borderRadius: radius.md, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule }}>
                <QrCode value="https://verre.app/join/7F3K-9QX2" size={156} />
              </View>
              <VText variant="caption" color="inkSoft">
                {contrastRatio(theme.ink, theme.surface) >= 3 ? 'auto: themed' : 'auto: fallback (white)'}
              </VText>
            </View>
            <View style={{ gap: 4 }}>
              <View style={{ padding: 12, borderRadius: radius.md, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.rule }}>
                <QrCode value="https://verre.app/join/7F3K-9QX2" size={156} forceThemed />
              </View>
              <VText variant="caption" color="inkSoft">forced: theme colors</VText>
            </View>
          </View>
          <VText variant="small" color="inkSoft">
            {`ink/surface contrast ${contrastRatio(theme.ink, theme.surface).toFixed(2)} (clamp at 3.0)`}
          </VText>
          <VText variant="caption" color="inkFaint">
            Left = the real component (clamps to white below 3.0; all current themes pass). Right = forced theme colors, no clamp. Scan each with the Camera app.
          </VText>
        </View>
      </ScrollView>
    </>
  );
}
