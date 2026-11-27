import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SetGroup, SetNav } from '@/components/moments/settingsParts';
import { VBar } from '@/components/VBar';
import { VText } from '@/components/ui/VText';
import { APP_BUILD } from '@/lib/clientVersion';
import { useMeId } from '@/lib/meId';
import { GUTTER } from '@/lib/layout';
import { legalHref, useSessionTab } from '@/lib/sessionStack';
import { space } from '@/theme';

// About hub — version + the legal surfaces. Deliberately a hub rather than a
// single screen: Terms and Privacy land here when they exist, and Attributions
// is one row among them rather than a top-level Settings entry.
//
// 🔒 LIVES AT THE ROOT, OUTSIDE THE AUTH GUARD (app/_layout.tsx), not under
// (tabs)/you — the attributions it leads to are a LICENCE OBLIGATION and must
// be readable by a signed-out user on first launch. Reached from the auth
// screens when signed out; signed in, Settings opens its MIRROR on the You
// stack (`(tabs)/you/about`, lib/sessionStack.ts legalHref) and an opened post
// its own (`[id]/about`). No tab-bar clearance here: the pill is hidden on
// every mount (app/(tabs)/_layout.tsx).
export default function About() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // The root route, or its mirror on the You stack or an opened post's stack
  // (lib/sessionStack.ts legalHref): Attributions follows where this hub is mounted.
  const mount = useSessionTab();
  const signedIn = useMeId() != null;
  const version = Constants.expoConfig?.version ?? '—';
  // Which code this is (app.config.ts `extra.commit`): a tap copies it.
  const commit = (Constants.expoConfig?.extra as { commit?: string | null } | undefined)?.commit ?? null;
  const build = [`Verre ${version}`, APP_BUILD ? `Build ${APP_BUILD}` : null, commit].filter(Boolean).join(' · ');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

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
        <SetNav icon="info" label="Attributions" onPress={() => router.push(legalHref(mount, 'attributions'), { dangerouslySingular: true })} />
      </SetGroup>
      {/* The Dev Gallery (moved from Settings, 2026-11-26). Testing phase
          (Simon, 2026-07-16): visible in release builds too; re-gate on
          __DEV__ before a public launch. Only on the You stack's About (the
          mirror Settings opens): the gallery is pushed on that same stack (its
          tab bar shows while theme-testing) and Back returns here. Never at
          the root (signed out) or from an opened post. */}
      {signedIn && mount.tab === 'you' && mount.post == null ? (
        <SetGroup>
          <SetNav icon="grid" label="Dev Gallery" onPress={() => router.push('/you/dev-gallery', { dangerouslySingular: true })} />
        </SetGroup>
      ) : null}

      <Pressable
        onPress={() => {
          void Clipboard.setStringAsync(build);
          setCopied(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${build}. Copy`}
        style={{ alignSelf: 'center', marginTop: space.xs, paddingVertical: space.xs }}
      >
        <VText variant="caption" color="inkFaint" style={{ textAlign: 'center' }}>
          {copied ? 'Copied' : build}
        </VText>
      </Pressable>
      <View style={{ height: space.lg }} />
    </ScrollView>
  );
}
