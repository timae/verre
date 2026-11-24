import { useState } from 'react';
import { AnchoredMenu, AnchorButton, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { VText } from '@/components/ui/VText';
import { useTheme } from '@/theme';

// The ⓘ that explains something in a few lines (an info popover, never a
// "bubble": bubbles are sparkling). A small ink-soft (i) opening the house
// anchored panel with the text. NV's explanation in the bottle picker, a
// moment's Who Can See This Moment (ruled 2026-11-24: too long under the row).
export function InfoTip({ text, accessibilityLabel, minWidth = 200 }: { text: string; accessibilityLabel: string; minWidth?: number }) {
  const { theme } = useTheme();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  return (
    <>
      <AnchorButton icon="info" iconColor={theme.inkSoft} accessibilityLabel={accessibilityLabel} onOpen={setAnchor} />
      <AnchoredMenu anchor={anchor} onClose={() => setAnchor(null)} right={16} minWidth={minWidth}>
        <VText variant="small" style={{ color: theme.ink, paddingHorizontal: 10, paddingVertical: 6 }}>{text}</VText>
      </AnchoredMenu>
    </>
  );
}
