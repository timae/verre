import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
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
        // left 57%: the dessert sits right of the frame's midline — biasing
        // the crop window right pulls the ITEM to the screen's centre
        // (device screenshot 2026-07-04; ~2.5pt per % on this asset).
        contentPosition={{ top: '40%', left: '57%' }}
        accessibilityIgnoresInvertColors
        alt=""
      />
      {/* .welcome .scrim — the design's 4-stop gradient. */}
      <LinearGradient
        pointerEvents="none"
        colors={[...WELCOME_SCRIM]}
        locations={[...WELCOME_SCRIM_STOPS]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      {/* Foreground scrolls OVER the fixed photo+scrim (PR #65 review #4):
          flexGrow:1 + space-between keeps the wordmark top / CTAs bottom when
          content fits, and lets it scroll instead of clipping when scaled text
          on a short device would overflow. The image + scrim stay absolute
          behind it (transparent scroll bg). */}
      <ScrollView
        style={{ flex: 1 }}
        // ── Vertical distribution (Simon, 2026-07-26) ──────────────────────
        // The bottom group sits low on purpose: the tail padding is
        // `insets.bottom` MINUS 10, i.e. it deliberately eats 10pt into the
        // safe-area inset to close the gap to the screen edge (Simon's call,
        // after several passes at trimming the padding above it).
        //
        // ⚠️ `Math.max(0, …)` is load-bearing: on a device with NO bottom inset
        // (older non-notched phones, where insets.bottom is 0) the subtraction
        // would go negative and pull content off-screen. The clamp makes the
        // trim a no-op there and only spends inset that actually exists.
        //
        // 10pt is a deliberate encroachment, not a mistake: the home-indicator
        // inset is generous, and the attributions link is a low-frequency text
        // target rather than a primary control. If a device check ever shows
        // the link fouling the indicator, raise this back toward 0 — don't
        // "fix" it by deleting the clamp.
        //
        // Slack is absorbed by the explicit flexible spacer below the wordmark
        // rather than by `justifyContent: 'space-between'`. Same result with two
        // children, but the spacer is a named thing to tune.
        //
        // flexGrow stays so the content SCROLLS instead of clipping when large
        // Dynamic Type on a short device overflows.
        contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + 18, paddingBottom: Math.max(0, insets.bottom - 10) }}
        // Indicator left ON: in the exact overflow case this fix targets
        // (large Dynamic Type on a short device) it's the only cue that the
        // CTAs are reachable by scrolling (PR #65 review). alwaysBounce off so
        // the common fits-on-screen case doesn't rubber-band.
        alwaysBounceVertical={false}
      >
        {/* .w-top — wordmark + h1. */}
        <View style={{ paddingHorizontal: 24, alignItems: 'center' }}>
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
        {/* The flexible spacer that replaces space-between. It absorbs ALL the
            slack, so the group below sits as low as its padding floor allows.
            `minHeight` preserves the old marginTop:24 breathing room from the
            h1 for the short-viewport case, where there is no slack to absorb
            and the spacer collapses to nothing. */}
        <View style={{ flex: 1, minHeight: 24 }} />
        {/* .content — bottom copy + buttons. */}
        <View style={{ paddingHorizontal: 22 }}>
          <VText variant="small" style={{ textAlign: 'center', color: 'rgba(255,255,255,0.92)', fontFamily: 'InstrumentSans_600SemiBold', marginBottom: 22, lineHeight: Math.round(phone.text('small').fontSize * 1.5) }}>
            Wine, coffee, the dish you can&apos;t stop thinking about — capture it, score it, remember why.
          </VText>
          <View style={{ gap: 10 }}>
            <Button title="Get Started" bar block variant="onlight" onPress={() => router.push('/sign-up')} />
            <Button title="Sign In" bar block variant="ghostlight" onPress={() => router.push('/sign-in')} />
          </View>
          {/* 🔒 The signed-out entry point to the legal surfaces. The catalog
              attributions are a LICENCE OBLIGATION and must be readable before
              an account exists — this is the only pre-auth screen that can
              carry the link. Deliberately quiet (no button weight) so the two
              CTAs keep the hero's emphasis. ⚠️ This is an addition to a
              pixel-spec'd brand-custom screen; placement/treatment is open to
              Simon's call. */}
          <Pressable
            accessibilityRole="link"
            onPress={() => router.push('/about')}
            hitSlop={10}
            style={({ pressed }) => ({ alignItems: 'center', marginTop: 14, paddingVertical: 2, opacity: pressed ? 0.5 : 1 })}
          >
            <VText variant="caption" style={{ color: 'rgba(255,255,255,0.72)' }}>About &amp; attributions</VText>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
