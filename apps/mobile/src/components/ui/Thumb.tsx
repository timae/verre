import { Image, View } from 'react-native';
import { Icon } from '@/components/ui/Icon';
import { radius as radii, useTheme } from '@/theme';

// Square cover/wine thumbnail with the glass-glyph placeholder fallback.
// Extracted from 3 copies (moments-home `Thumb`, recents `Thumb46`, the line-up
// `LuRow` thumb). The placeholder glyph scales to the box (~42%, matching the
// original). For the line-up's hidden-from-guests eye-off badge, wrap this in a
// relative View and overlay the badge at the call site.
export function Thumb({
  uri, size, radius = radii.sm,
}: {
  uri?: string | null;
  size: number;
  radius?: number;
}) {
  const { theme } = useTheme();
  if (uri) return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: radius }} />;
  return (
    <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: theme.surfaceSunk, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="glass" size={Math.round(size * 0.42)} color={theme.inkFaint} />
    </View>
  );
}
