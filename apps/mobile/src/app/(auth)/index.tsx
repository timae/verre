import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens, WELCOME_SCRIM, WELCOME_SCRIM_STOPS } from '@/lib/layout';
import welcomeHero from '../../../assets/images/welcome-hero.jpg';

// 01·1 Launch — prototype .welcome, now with the real hero asset (Simon's
// dessert photo == the design's P.dessert): full-bleed cover photo
// (object-position centre-40%), the design's 4-stop scrim, wordmark + h1
// pinned top, copy + buttons bottom. All white-over-photo colors here are
// SANCTIONED literals (same carve-out as GLASS_FILL/HERO_SCRIM — they sit on
// the photo, not on a themed surface; the design specs them theme-independent:
// btn-onlight #fff/#1a1512, btn-ghostlight white 50% ring). Copy is final.
export default function Launch() {
  const insets = useSafeAreaInsets();
  const phone = usePhoneTokens();
  // Light glyphs over the photo, ONLY while this screen is focused: the
  // pushed sign-up/in screens mount no StatusBar of their own, so this one
  // must unmount on push to fall back to the root layout's themed bar.
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  return (
    <View style={{ flex: 1 }}>
      {focused ? <StatusBar style="light" /> : null}
      {/* .welcome .hero — cover, focal point at centre 40% per the design's
          object-position (expo-image's contentPosition maps to it directly). */}
      <Image
        source={welcomeHero}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        contentFit="cover"
        contentPosition={{ top: '40%', left: '50%' }}
        accessibilityIgnoresInvertColors
      />
      {/* .welcome .scrim — the design's 4-stop gradient. */}
      <LinearGradient
        pointerEvents="none"
        colors={[...WELCOME_SCRIM]}
        locations={[...WELCOME_SCRIM_STOPS]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      {/* .w-top — wordmark + h1, pinned below the status area. */}
      <View style={{ position: 'absolute', top: insets.top + 18, left: 0, right: 0, paddingHorizontal: 24, alignItems: 'center' }}>
        <VText variant="heading" style={{ color: '#fff' }}>
          verre<VText variant="heading" color="accent">.</VText>
        </VText>
        <VText
          variant="title"
          style={{ textAlign: 'center', color: '#fff', marginTop: 16, lineHeight: Math.round(phone.text('title').fontSize * 1.12) }}
        >
          Everything you taste{'\n'}In one place
        </VText>
      </View>
      {/* .content — bottom copy + buttons. */}
      <View style={{ flex: 1, justifyContent: 'flex-end', paddingHorizontal: 22, paddingBottom: insets.bottom + 26 }}>
        <VText variant="small" style={{ textAlign: 'center', color: 'rgba(255,255,255,0.84)', marginBottom: 22, lineHeight: Math.round(phone.text('small').fontSize * 1.5) }}>
          Wine, coffee, the dish you can&apos;t stop thinking about — capture it, score it, remember why.
        </VText>
        <View style={{ gap: 10 }}>
          <Button title="Get started" bar block variant="onlight" onPress={() => router.push('/sign-up')} />
          <Button title="Sign in" bar block variant="ghostlight" onPress={() => router.push('/sign-in')} />
        </View>
      </View>
    </View>
  );
}
