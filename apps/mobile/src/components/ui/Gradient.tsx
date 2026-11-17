import { View, type ViewProps } from 'react-native';

// The app's linear gradient (photo scrims, fades, colour bands), drawn by
// React Native itself: `backgroundImage: linear-gradient(...)` is a
// CAGradientLayer on iOS, drawn by the GPU: no CPU painting, even when React
// Native re-creates the layer on a layout change; border radius clips it like
// a background. It replaced expo-linear-gradient (removed 2026-11-17), which
// painted in software on the main thread (twice per paint, again on every size
// or prop change); with a scrim on every post photo, slide and tile, that
// stalled each navigation into or out of a screen of posts (0.1.5 You-tab lag,
// Instruments). `colors` run top to bottom (`direction="right"`: left to
// right), optional `locations` 0..1, other View props passed through
// (pointerEvents included).
export function Gradient({
  colors,
  locations,
  direction = 'down',
  style,
  ...rest
}: ViewProps & { colors: readonly string[]; locations?: readonly number[]; direction?: 'down' | 'right' }) {
  const stops = colors.map((c, i) => (locations ? `${c} ${+(locations[i] * 100).toFixed(3)}%` : c)).join(', ');
  return <View {...rest} style={[style, { backgroundImage: `linear-gradient(to ${direction === 'right' ? 'right' : 'bottom'}, ${stops})` }]} />;
}
