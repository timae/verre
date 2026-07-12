import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme, type TextStyle } from 'react-native';
import { defaults, themes, type, type ThemeColors, type TypeStyle } from './vero-tokens';

export { control, elevation, motion, radius, space, themes, type as typeScale } from './vero-tokens';
export { springs } from './motion';
export type { ThemeColors } from './vero-tokens';

export type ThemeKey = keyof typeof themes;
export type ThemeChoice = ThemeKey | 'system';

const STORAGE_KEY = 'verre.theme';

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
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [choice, setChoiceState] = useState<ThemeChoice>('system');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((v) => {
      if (v && (v === 'system' || v in themes)) setChoiceState(v as ThemeChoice);
    });
  }, []);

  const setChoice = (c: ThemeChoice) => {
    setChoiceState(c);
    AsyncStorage.setItem(STORAGE_KEY, c).catch(() => {});
  };

  const themeKey: ThemeKey = choice === 'system' ? defaults[systemScheme === 'dark' ? 'dark' : 'light'] : choice;
  const value = useMemo(() => ({ theme: themes[themeKey], themeKey, choice, setChoice }), [themeKey, choice]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
