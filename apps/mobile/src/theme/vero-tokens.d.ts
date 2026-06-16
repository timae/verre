export interface TypeStyle {
  size: number;
  lineHeight: number;
  weight: '400' | '500' | '600';
  tracking: number;
  trackingPx: number;
  uppercase?: boolean;
}

export const type: {
  fontFamily: string;
  fontFeature: string;
  display: TypeStyle;
  title: TypeStyle;
  heading: TypeStyle;
  subhead: TypeStyle;
  bodyLg: TypeStyle;
  body: TypeStyle;
  small: TypeStyle;
  caption: TypeStyle;
  label: TypeStyle;
};

export const space: {
  '3xs': number; '2xs': number; xs: number; sm: number; md: number;
  lg: number; xl: number; '2xl': number; '3xl': number; '4xl': number;
};

export const radius: { xs: number; sm: number; md: number; lg: number; xl: number; pill: number };

export const motion: {
  dur1: number; dur2: number; dur3: number;
  ease: [number, number, number, number];
  easeIn: [number, number, number, number];
  easeOut: [number, number, number, number];
};

export const control: { h: number; hSm: number; hLg: number };

export interface ThemeColors {
  name: string;
  scheme: 'light' | 'dark';
  default?: 'light' | 'dark';
  bg: string; surface: string; surfaceSunk: string;
  ink: string; inkSoft: string; inkFaint: string;
  accent: string; accentInk: string; accentTint: string; accentLine: string;
  positive: string; positiveInk: string;
  caution: string; cautionInk: string;
  critical: string; criticalInk: string;
  rule: string; ruleSoft: string;
  scrim: string; press: string;
}

export const themes: {
  apricot: ThemeColors;
  charcoal: ThemeColors;
  cobalt: ThemeColors;
  aubergine: ThemeColors;
  clay: ThemeColors;
  mauve: ThemeColors;
};

export const defaults: { light: keyof typeof themes; dark: keyof typeof themes };

export const elevation: {
  sm: { ios: { shadowOpacity: number; shadowRadius: number; shadowOffsetY: number }; android: { elevation: number } };
  md: { ios: { shadowOpacity: number; shadowRadius: number; shadowOffsetY: number }; android: { elevation: number } };
  lg: { ios: { shadowOpacity: number; shadowRadius: number; shadowOffsetY: number }; android: { elevation: number } };
  menu: { ios: { shadowOpacity: number; shadowRadius: number; shadowOffsetY: number }; android: { elevation: number } };
};

declare const _default: {
  type: typeof type; space: typeof space; radius: typeof radius; motion: typeof motion;
  control: typeof control; themes: typeof themes; defaults: typeof defaults; elevation: typeof elevation;
};
export default _default;
