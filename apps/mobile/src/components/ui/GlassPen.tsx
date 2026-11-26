import { Pressable, View } from 'react-native';
import { Icon } from '@/components/ui/Icon';
import { GLASS_FILL } from '@/lib/layout';

// The small glass pen in a photo's top-right corner (28pt, the over-photo
// GLASS_FILL, a white `edit` glyph): "this photo can be changed". Extracted
// from PhotoTiles (Edit Profile's tiles) when Had It Too's 72pt photo became
// its second user. Without `onPress` it is a plain mark (the tile itself takes
// the touch: PhotoTiles, Had It Too's empty tile); with it, a button of its
// own (hit area grown to 44pt). `disabled` dims either and makes the button
// inert. Edit Profile's bigger round `GlassButton` (settingsParts.tsx, 34pt)
// stays the cover's.
export function GlassPen({ onPress, disabled, accessibilityLabel = 'Change Photo', inset = 8 }: {
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  // Distance from the photo's top and right edges.
  inset?: number;
}) {
  const style = {
    position: 'absolute' as const, top: inset, right: inset, width: 28, height: 28, borderRadius: 14,
    backgroundColor: GLASS_FILL, alignItems: 'center' as const, justifyContent: 'center' as const,
  };
  const glyph = <Icon name="edit" size={14} color="#fff" />;
  if (!onPress) return <View pointerEvents="none" style={[style, disabled ? { opacity: 0.4 } : null]}>{glyph}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [style, { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
    >
      {glyph}
    </Pressable>
  );
}
