import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme, type TextStyle } from 'react-native';
import { defaults, themes, type, type ThemeColors, type TypeStyle } from './vero-tokens';

export { control, elevation, motion, radius, space, themes, type as typeScale } from './vero-tokens';
export { springs } from './motion';
export type { ThemeColors } from './vero-tokens';

export type ThemeKey = keyof typeof themes;
export type ThemeChoice = ThemeKey | 'system';
// The pair Match System follows: the phone's light / dark appearance picks
// one of them (ruled 2026-11-11; the defaults until you choose).
export type SystemThemes = { light: ThemeKey; dark: ThemeKey };

const STORAGE_KEY = 'verre.theme';
const SYSTEM_KEY = 'verre.theme.system';

// A stored pair, kept only where each slot is a theme of that kind.
function parseSystemThemes(raw: string | null): SystemThemes {
  const out: SystemThemes = { light: defaults.light, dark: defaults.dark };
  try {
    const v = raw ? JSON.parse(raw) : null;
    for (const s of ['light', 'dark'] as const) {
      if (typeof v?.[s] === 'string' && Object.prototype.hasOwnProperty.call(themes, v[s]) && themes[v[s] as ThemeKey].scheme === s) out[s] = v[s] as ThemeKey;
    }
  } catch {}
  return out;
}

const FONT_BY_WEIGHT: Record<TypeStyle['weight'], string> = {
  '400': 'InstrumentSans_400Regular',
  '500': 'InstrumentSans_500Medium',
  '600': 'InstrumentSans_600SemiBold',
};

export type TextVariant = 'display' | 'title' | 'heading' | 'subhead' | 'bodyLg' | 'body' | 'small' | 'caption' | 'label';

export function textStyle(variant: TextVariant): TextStyle {
  const t = type[variant];
  return {
    fontFamily: FONT_BY_WEIGHT[t.weight],
    fontSize: t.size,
    lineHeight: Math.round(t.size * t.lineHeight),
    letterSpacing: t.trackingPx,
    ...(t.uppercase ? { textTransform: 'uppercase' as const } : null),
    // NOTE: the cv05 numeral feature (vero-tokens fontFeature) is not expressible
    // via RN fontVariant — revisit with a cv05-default font build if numerals matter.
  };
}

interface ThemeContextValue {
  theme: ThemeColors;
  themeKey: ThemeKey;
  choice: ThemeChoice;
  setChoice: (c: ThemeChoice) => void;
  systemThemes: SystemThemes;
  // Match System, with `key` as the theme for its own kind (light or dark).
  setSystemTheme: (key: ThemeKey) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [choice, setChoiceState] = useState<ThemeChoice>('system');
  const [systemThemes, setSystemThemes] = useState<SystemThemes>({ light: defaults.light, dark: defaults.dark });

  useEffect(() => {
    AsyncStorage.multiGet([STORAGE_KEY, SYSTEM_KEY]).then(([[, v], [, pair]]) => {
      if (v && (v === 'system' || Object.prototype.hasOwnProperty.call(themes, v))) setChoiceState(v as ThemeChoice);
      setSystemThemes(parseSystemThemes(pair));
    }).catch(() => {});
  }, []);

  const setChoice = (c: ThemeChoice) => {
    setChoiceState(c);
    AsyncStorage.setItem(STORAGE_KEY, c).catch(() => {});
  };
  const setSystemTheme = (key: ThemeKey) => {
    const next = { ...systemThemes, [themes[key].scheme]: key };
    setSystemThemes(next);
    setChoiceState('system');
    AsyncStorage.multiSet([[SYSTEM_KEY, JSON.stringify(next)], [STORAGE_KEY, 'system']]).catch(() => {});
  };

  const themeKey: ThemeKey = choice === 'system' ? systemThemes[systemScheme === 'dark' ? 'dark' : 'light'] : choice;
  // The setters close over systemThemes only, which is a dependency.
  const value = useMemo(
    () => ({ theme: themes[themeKey], themeKey, choice, setChoice, systemThemes, setSystemTheme }),
    [themeKey, choice, systemThemes],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// Re-themes a SUBTREE with `themeKey` (the Appearance picker's live preview,
// built reusable for onboarding). Overrides BOTH `theme` and `themeKey`
// (components branch on `themeKey`, e.g. NonPhotoHero, RailPicker,
// RingsPicker) and passes the app's real `choice` / `setChoice` /
// `systemThemes` / `setSystemTheme` through unchanged: "is this current?"
// checks read the real choice, and the app's theme is untouched until the
// caller commits.
export function ThemePreviewProvider({ themeKey, children }: { themeKey: ThemeKey; children: ReactNode }) {
  const outer = useTheme();
  const value = useMemo(() => ({ ...outer, theme: themes[themeKey], themeKey }), [outer, themeKey]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
