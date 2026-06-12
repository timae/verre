/* VENDORED COPY — design source of truth lives in the design workspace:
   .local/design/vero-tokens.js (mirrors vero-tokens.css). Keep this file a
   verbatim copy below this header; update by re-vendoring, never by editing
   values here. */
/* ───────────────────────────────────────────────────────────────
   VERO — TOKENS as plain data (web + React Native single source)

   Numbers are UNITLESS (React-Native style): fontSize: 16, not "1rem".
   Web: 1 unit = 1px (rem * 16). RN: consume the numbers directly.
   `letterSpacing` is given in BOTH em (web) and an approximate px at the
   token's own size (RN has no em; px ≈ em * fontSize).

   Mirrors vero-tokens.css exactly — keep the two in sync.
   ─────────────────────────────────────────────────────────────── */

export const type = {
  fontFamily: 'Instrument Sans',
  // OpenType feature for the clean footless "1". Web: font-feature-settings:'cv05' 1.
  // RN: pass via fontVariant/font feature settings where supported, else ship a build with cv05 default-on.
  fontFeature: 'cv05',
  // size / lineHeight (multiplier) / weight / letterSpacing(em) / letterSpacingPx(approx at size)
  display: { size: 40, lineHeight: 1.05, weight: '600', tracking: -0.03,  trackingPx: -1.2 },
  title:   { size: 30, lineHeight: 1.10, weight: '600', tracking: -0.025, trackingPx: -0.75 },
  heading: { size: 23, lineHeight: 1.18, weight: '600', tracking: -0.02,  trackingPx: -0.46 },
  subhead: { size: 18, lineHeight: 1.30, weight: '600', tracking: -0.015, trackingPx: -0.27 },
  bodyLg:  { size: 17, lineHeight: 1.55, weight: '400', tracking: -0.005, trackingPx: -0.085 },
  body:    { size: 15, lineHeight: 1.55, weight: '400', tracking: -0.004, trackingPx: -0.06 },
  small:   { size: 13, lineHeight: 1.50, weight: '400', tracking: 0,      trackingPx: 0 },
  caption: { size: 12, lineHeight: 1.40, weight: '500', tracking: 0,      trackingPx: 0 },
  label:   { size: 11, lineHeight: 1.00, weight: '600', tracking: 0.14,   trackingPx: 1.54, uppercase: true },
};

// 4px base grid
export const space = { '3xs': 2, '2xs': 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, '2xl': 48, '3xl': 64, '4xl': 96 };

export const radius = { xs: 4, sm: 8, md: 12, lg: 16, xl: 22, pill: 999 };

export const motion = {
  // durations in ms
  dur1: 120, dur2: 200, dur3: 320,
  // easings — web cubic-bezier control points. RN (Reanimated): Easing.bezier(...).
  ease:    [0.2, 0.7, 0.3, 1],   // standard
  easeIn:  [0.4, 0, 1, 1],       // exit / accelerate
  easeOut: [0, 0, 0.2, 1],       // entrance / decelerate
};

export const control = { h: 44, hSm: 36, hLg: 52 }; // min touch target = 44

/* ── Per-theme COLOR tokens. Shadows are described abstractly because RN's
   shadow model differs (iOS shadow* props vs Android elevation); see `elevation`. ── */
function theme(c) { return c; }

export const themes = {
  apricot: theme({
    name: 'Apricot mist', scheme: 'light', default: 'light',
    bg: '#f6ecde', surface: '#fcf5ea', surfaceSunk: '#f0d6bb',
    ink: '#2a1f24', inkSoft: '#8c6f6a', inkFaint: '#b6a097',
    accent: '#d68b56', accentInk: '#2a1f24',
    accentTint: 'rgba(214,139,86,0.14)', accentLine: 'rgba(214,139,86,0.42)',
    positive: '#6f8c5a', positiveInk: '#ffffff',
    caution: '#c2913a', cautionInk: '#2a1f24',
    critical: '#b8455a', criticalInk: '#ffffff',
    rule: 'rgba(42,31,36,0.10)', ruleSoft: 'rgba(42,31,36,0.06)',
    scrim: 'rgba(42,31,36,0.38)', press: '#000',
  }),
  charcoal: theme({
    name: 'Charcoal', scheme: 'dark', default: 'dark',
    bg: '#1a1815', surface: '#2c2925', surfaceSunk: '#221f1c',
    ink: '#efe5cb', inkSoft: '#8a857a', inkFaint: '#5c574e',
    accent: '#d4b266', accentInk: '#1a1815',
    accentTint: 'rgba(212,178,102,0.16)', accentLine: 'rgba(212,178,102,0.42)',
    positive: '#6e8a52', positiveInk: '#efe5cb',
    caution: '#d2a64a', cautionInk: '#1a1815',
    critical: '#c95f6e', criticalInk: '#efe5cb',
    rule: 'rgba(239,229,203,0.13)', ruleSoft: 'rgba(239,229,203,0.07)',
    scrim: 'rgba(0,0,0,0.55)', press: '#fff',
  }),
  cobalt: theme({
    name: 'Cobalt night', scheme: 'dark',
    bg: '#122142', surface: '#1f3057', surfaceSunk: '#17264a',
    ink: '#f0eccc', inkSoft: '#8298b5', inkFaint: '#4f6286',
    accent: '#e8c062', accentInk: '#122142',
    accentTint: 'rgba(232,192,98,0.16)', accentLine: 'rgba(232,192,98,0.42)',
    positive: '#7f9a5e', positiveInk: '#f0eccc',
    caution: '#d8b24f', cautionInk: '#122142',
    critical: '#d06a78', criticalInk: '#f0eccc',
    rule: 'rgba(240,236,204,0.13)', ruleSoft: 'rgba(240,236,204,0.07)',
    scrim: 'rgba(4,8,20,0.58)', press: '#fff',
  }),
  aubergine: theme({
    name: 'Aubergine', scheme: 'dark',
    bg: '#2b1530', surface: '#3d2342', surfaceSunk: '#321b38',
    ink: '#f3e6cd', inkSoft: '#a08a96', inkFaint: '#6a5560',
    accent: '#e8a565', accentInk: '#2b1530',
    accentTint: 'rgba(232,165,101,0.16)', accentLine: 'rgba(232,165,101,0.42)',
    positive: '#8a9a64', positiveInk: '#f3e6cd',
    caution: '#d2a64a', cautionInk: '#2b1530',
    critical: '#d06a78', criticalInk: '#f3e6cd',
    rule: 'rgba(243,230,205,0.13)', ruleSoft: 'rgba(243,230,205,0.07)',
    scrim: 'rgba(14,4,16,0.58)', press: '#fff',
  }),
  clay: theme({
    name: 'Clay', scheme: 'dark',
    bg: '#b35a45', surface: '#c06b54', surfaceSunk: '#a8503c',
    ink: '#faf2dd', inkSoft: '#eccdbd', inkFaint: '#cf9c89',
    accent: '#f6cd7e', accentInk: '#5a2418',
    accentTint: 'rgba(246,205,126,0.18)', accentLine: 'rgba(246,205,126,0.46)',
    positive: '#a9b27a', positiveInk: '#faf2dd',
    caution: '#f0c266', cautionInk: '#5a2418',
    critical: '#7a2820', criticalInk: '#faf2dd',
    rule: 'rgba(250,242,221,0.20)', ruleSoft: 'rgba(250,242,221,0.10)',
    scrim: 'rgba(40,12,6,0.50)', press: '#fff',
  }),
  mauve: theme({
    name: 'Mauve', scheme: 'light',
    bg: '#c8a8a3', surface: '#d8bdb8', surfaceSunk: '#bd9b95',
    ink: '#2a1c20', inkSoft: '#6c4e54', inkFaint: '#9a7d80',
    accent: '#5e2a32', accentInk: '#faf2dd',
    accentTint: 'rgba(94,42,50,0.14)', accentLine: 'rgba(94,42,50,0.42)',
    positive: '#5f7d4c', positiveInk: '#ffffff',
    caution: '#a8792f', cautionInk: '#2a1c20',
    critical: '#9c3346', criticalInk: '#ffffff',
    rule: 'rgba(42,28,32,0.14)', ruleSoft: 'rgba(42,28,32,0.08)',
    scrim: 'rgba(42,28,32,0.42)', press: '#000',
  }),
};

export const defaults = { light: 'apricot', dark: 'charcoal' };

/* Elevation — abstract levels (web maps to box-shadow; RN maps to iOS shadow*
   props + Android elevation). Use these instead of raw shadow strings.
   opacity/radius/offsetY are iOS shadow hints; elevation is the Android value. */
export const elevation = {
  sm: { ios: { shadowOpacity: 0.10, shadowRadius: 3,  shadowOffsetY: 1 },  android: { elevation: 1 } },
  md: { ios: { shadowOpacity: 0.14, shadowRadius: 12, shadowOffsetY: 4 },  android: { elevation: 4 } },
  lg: { ios: { shadowOpacity: 0.22, shadowRadius: 28, shadowOffsetY: 12 }, android: { elevation: 12 } },
};

export default { type, space, radius, motion, control, themes, defaults, elevation };
