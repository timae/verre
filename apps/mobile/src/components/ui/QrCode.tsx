import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import qrcode from 'qrcode-generator';
import { useTheme } from '@/theme';
import { contrastRatio } from '@/lib/contrast';

// Scan-safe minimum: QR readers want strong field/module contrast. Themed
// fg/bg (modules in theme.ink on theme.surface) is used when it clears this;
// otherwise we fall back to fixed dark-on-white. Floor is 3.0 — empirically
// Clay (the lowest theme at ~3.44 ink/surface) scans reliably in its own
// colors even at minimum screen brightness, so all six current themes render
// themed; the guard remains for any future palette that drops below 3.0.
const MIN_CONTRAST = 3;
const FALLBACK_FG = '#15120e'; // design's QR module color
const FALLBACK_BG = '#ffffff';

// On-device, on-demand QR. Encodes `value` each render (byte mode, EC level M,
// auto version), draws the module matrix as react-native-svg <Rect>s. No native
// module beyond the already-present react-native-svg; no prebuilt assets.
// `forceThemed` bypasses the scan-safe contrast clamp — DEV/testing only (the
// dev gallery uses it to eyeball whether a low-contrast theme like Clay scans).
export function QrCode({
  value,
  size,
  quietZone = 2,
  forceThemed = false,
}: {
  value: string;
  size: number;
  quietZone?: number;
  forceThemed?: boolean;
}) {
  const { theme } = useTheme();

  const themed = forceThemed || contrastRatio(theme.ink, theme.surface) >= MIN_CONTRAST;
  const fg = themed ? theme.ink : FALLBACK_FG;
  const bg = themed ? theme.surface : FALLBACK_BG;

  const cells = useMemo(() => {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(value, 'Byte');
      qr.make();
      const count = qr.getModuleCount();
      const dark: { r: number; c: number }[] = [];
      for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) dark.push({ r, c });
      return { count, dark };
    } catch {
      // qrcode-generator throws if `value` exceeds capacity — render an empty
      // field rather than crash the tree (can't happen for a join URL, but
      // WEB_BASE is operator-set; defensive).
      return { count: 0, dark: [] as { r: number; c: number }[] };
    }
  }, [value]);

  const total = cells.count + quietZone * 2;

  return (
    <View style={{ width: size, height: size, backgroundColor: bg }}>
      <Svg width={size} height={size} viewBox={`0 0 ${total} ${total}`}>
        <Rect x={0} y={0} width={total} height={total} fill={bg} />
        {cells.dark.map(({ r, c }) => (
          <Rect key={`${r}-${c}`} x={c + quietZone} y={r + quietZone} width={1.02} height={1.02} fill={fg} />
        ))}
      </Svg>
    </View>
  );
}
