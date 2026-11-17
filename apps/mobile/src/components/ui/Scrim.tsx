import { View, type ViewProps } from 'react-native';

// A top-to-bottom fade (the photo scrims), drawn by React Native itself:
// `backgroundImage: linear-gradient(...)` is a CAGradientLayer on iOS, drawn
// by the GPU: no CPU painting, even when React Native re-creates the layer on
// a layout change. expo-linear-gradient paints its layer in software on the
// main thread (twice per paint, again on every size or prop change); with a
// scrim on every post photo, slide and tile, that stalled each navigation into
// or out of a screen of posts (0.1.5 You-tab lag, Instruments). Same contract
// as its vertical default: `colors` top to bottom, optional `locations` 0..1,
// other View props passed through (pointerEvents included).
export function Scrim({ colors, locations, style, ...rest }: ViewProps & { colors: readonly string[]; locations?: readonly number[] }) {
  const stops = colors.map((c, i) => (locations ? `${c} ${+(locations[i] * 100).toFixed(3)}%` : c)).join(', ');
  return <View {...rest} style={[style, { backgroundImage: `linear-gradient(to bottom, ${stops})` }]} />;
}
