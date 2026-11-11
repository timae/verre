import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { ThemeSwipePicker } from '@/components/settings/ThemeSwipePicker';
import { VText } from '@/components/ui/VText';
import { VBar } from '@/components/VBar';
import { useForwardStatusBarStyle } from '@/lib/forwardedStatusBar';
import { themes, useTheme, type ThemeKey } from '@/theme';

// Settings → Appearance (ruling Q-D): the design's swipe-to-theme, not a list.
// Back = no change; Use commits and pops; Use When Phone Is in Light / Dark
// Mode commits and stays (so you can set the other one too). The page paints its
// own full-bleed background (the stack's contentStyle is the APP's theme) and
// sets the status bar per previewed theme through both channels: the screen
// option, and the forward for a mount on an opened post's stack
// (apps/mobile/CLAUDE.md § The opened post's own stack, Status bar), plus
// expo-status-bar for Android. The pill is hidden here.
export default function Appearance() {
  const router = useRouter();
  const { themeKey, setChoice, setSystemTheme } = useTheme();
  const [preview, setPreview] = useState<ThemeKey>(themeKey);
  const statusBarStyle = themes[preview].scheme === 'dark' ? 'light' : 'dark';
  useForwardStatusBarStyle(statusBarStyle);
  const onPreview = useCallback((k: ThemeKey) => setPreview(k), []);
  return (
    <>
      <Stack.Screen options={{ statusBarStyle }} />
      <StatusBar style={statusBarStyle} />
      <ThemeSwipePicker
        header={
          <>
            <VBar title="Appearance" />
            <VText variant="small" color="inkSoft" style={{ textAlign: 'center', marginTop: 34 }}>Swipe to try the themes.</VText>
          </>
        }
        onPreview={onPreview}
        onUse={(k) => {
          setChoice(k);
          router.back();
        }}
        // Stays on the page: you set the light AND the dark one (ruled).
        onUseInSystem={setSystemTheme}
      />
    </>
  );
}
