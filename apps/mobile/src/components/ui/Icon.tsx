import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/theme';

// Vero icon set — paths vendored from the design's SVG defs
// (.local/design/Vero - Screens.html / Components.html). 24×24 viewBox,
// stroke icons at the design's per-icon stroke widths, currentColor → color.
type Seg =
  | { d: string; sw?: number; fill?: boolean; cap?: boolean; join?: boolean }
  | { cx: number; cy: number; r: number; sw?: number; fill?: boolean };

const ICONS: Record<string, Seg[]> = {
  glass: [
    { d: 'M7 3h10l-1 7a4 4 0 0 1-8 0L7 3Z', sw: 1.5, join: true },
    { d: 'M12 14v6M9 20h6', sw: 1.5, cap: true },
  ],
  clock: [
    { cx: 12, cy: 12, r: 8.5, sw: 1.5 },
    { d: 'M12 7.5V12l3 2', sw: 1.5, cap: true, join: true },
  ],
  pin: [
    { d: 'M12 21s6.5-5.4 6.5-10.5A6.5 6.5 0 0 0 5.5 10.5C5.5 15.6 12 21 12 21Z', sw: 1.5, join: true },
    { cx: 12, cy: 10.5, r: 2.4, sw: 1.5 },
  ],
  link: [
    { d: 'M9.5 14.5l5-5M8 11l-2 2a3 3 0 0 0 4.2 4.2l2-2M16 13l2-2a3 3 0 0 0-4.2-4.2l-2 2', sw: 1.5, cap: true, join: true },
  ],
  eyeoff: [
    { d: 'M4 4l16 16', sw: 1.5, cap: true },
    { d: 'M9.5 5.6A10.4 10.4 0 0 1 12 5.5C18.5 5.5 22 12 22 12a14 14 0 0 1-3 3.7M6.3 7.3A14 14 0 0 0 2 12s3.5 6.5 10 6.5a10 10 0 0 0 3.3-.5', sw: 1.5, cap: true, join: true },
  ],
  // open eye — reveal control (design i-eye def). Pairs with eyeoff (hide).
  eye: [
    { d: 'M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z', sw: 1.5, join: true },
    { cx: 12, cy: 12, r: 2.6, sw: 1.5 },
  ],
  plus: [{ d: 'M12 5v14M5 12h14', sw: 1.6, cap: true }],
  starf: [{ d: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z', fill: true }],
  'chevron-right': [{ d: 'M9.5 6l6 6-6 6', sw: 1.6, cap: true, join: true }],
  'chevron-down': [{ d: 'M6 9.5l6 6 6-6', sw: 1.6, cap: true, join: true }],
  check: [{ d: 'M5 12.5l4.5 4.5L19 7', sw: 1.8, cap: true, join: true }],
  back: [{ d: 'M15 5l-7 7 7 7', sw: 1.7, cap: true, join: true }],
  heart: [
    { d: 'M12 20s-7-4.6-7-9.5A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7-2.5C19 10.4 12 20 12 20Z', sw: 1.6, join: true },
  ],
  'heart-fill': [
    { d: 'M12 20s-7-4.6-7-9.5A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7-2.5C19 10.4 12 20 12 20Z', fill: true },
  ],
  more: [
    { cx: 5, cy: 12, r: 1.6, fill: true },
    { cx: 12, cy: 12, r: 1.6, fill: true },
    { cx: 19, cy: 12, r: 1.6, fill: true },
  ],
  undo: [{ d: 'M9 7H5V3M5 7a8 8 0 1 1-2 5', sw: 1.6, cap: true, join: true }],
  cam: [
    { d: 'M4 8.5h3L8.4 6.4h7.2L17 8.5h3v11H4z', sw: 1.5, join: true },
    { cx: 12, cy: 13.5, r: 3.3, sw: 1.5 },
  ],
  x: [{ d: 'M6 6l12 12M18 6L6 18', sw: 1.7, cap: true }],
  share: [
    { cx: 6.5, cy: 12, r: 2.4, sw: 1.6 },
    { cx: 17.5, cy: 6.5, r: 2.4, sw: 1.6 },
    { cx: 17.5, cy: 17.5, r: 2.4, sw: 1.6 },
    { d: 'M8.7 10.9l6.6-3.3M8.7 13.1l6.6 3.3', sw: 1.6, cap: true },
  ],
  copy: [
    { d: 'M8 8h11v11H8z', sw: 1.6, join: true },
    { d: 'M16 5.5H6.5A1.5 1.5 0 0 0 5 7v9.5', sw: 1.6, cap: true, join: true },
  ],
  search: [
    { cx: 11, cy: 11, r: 6, sw: 1.6 },
    { d: 'M15.5 15.5L20 20', sw: 1.6, cap: true },
  ],
  user: [
    { cx: 12, cy: 8.5, r: 3.5, sw: 1.5 },
    { d: 'M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6', sw: 1.5, cap: true },
  ],
  edit: [{ d: 'M5 19h3l9-9-3-3-9 9v3ZM14 6l3 3', sw: 1.6, cap: true, join: true }],
  trash: [{ d: 'M5 7h14M10 7V5.5h4V7M6.5 7l.9 12.5h9.2L17.5 7', sw: 1.5, cap: true, join: true }],
  sparkles: [
    { d: 'M13.5 2.5 Q14.1 10.4 19 11 Q14.1 11.6 13.5 19.5 Q12.9 11.6 8 11 Q12.9 10.4 13.5 2.5 Z', sw: 1.3, join: true },
    { d: 'M5.6 2.6 Q5.88 5.72 8.2 6 Q5.88 6.28 5.6 9.4 Q5.32 6.28 3 6 Q5.32 5.72 5.6 2.6 Z', fill: true },
    { d: 'M7 15.9 Q7.24 18.26 9 18.5 Q7.24 18.74 7 21.1 Q6.76 18.74 5 18.5 Q6.76 18.26 7 15.9 Z', fill: true },
  ],
  settings: [
    { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', sw: 1.4, join: true },
    { cx: 12, cy: 12, r: 3, sw: 1.4 },
  ],
  // accordion / picker disclosure (design i-chevron-down def)
  chevrondown: [
    { d: 'M6 9.5l6 6 6-6', sw: 1.7, cap: true, join: true },
  ],
  // high/low sort toggle — compare "Show all" sheet (design i-sort def)
  sort: [
    { d: 'M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3', sw: 1.6, cap: true, join: true },
  ],
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, color }: { name: IconName; size?: number; color?: string }) {
  const { theme } = useTheme();
  const c = color ?? theme.ink;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {ICONS[name].map((s, i) =>
        'cx' in s ? (
          s.fill ? (
            <Circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill={c} />
          ) : (
            <Circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill="none" stroke={c} strokeWidth={s.sw ?? 1.5} />
          )
        ) : (
          <Path
            key={i}
            d={s.d}
            fill={s.fill ? c : 'none'}
            stroke={s.fill ? undefined : c}
            strokeWidth={s.fill ? undefined : (s.sw ?? 1.5)}
            strokeLinecap={s.cap ? 'round' : undefined}
            strokeLinejoin={s.join ? 'round' : undefined}
          />
        ),
      )}
    </Svg>
  );
}
