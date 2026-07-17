import { useState } from 'react';
import { AnchorButton, AnchoredMenu, MenuItem, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { useTheme } from '@/theme';

// The feed cards' ⋯ menu (Simon, 2026-07-17) — owner-only today (the list
// screen passes onEdit only for the viewer's own posts, so the trigger simply
// doesn't render otherwise). One item for now; Crave/Share/etc. join here
// when their deferred passes land (08-feed §6/§7).
export function FeedCardMenu({ onEdit }: { onEdit: () => void }) {
  const { theme } = useTheme();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  return (
    <>
      <AnchorButton onOpen={setAnchor} accessibilityLabel="Post Options" iconColor={theme.inkSoft} />
      <AnchoredMenu anchor={anchor} onClose={() => setAnchor(null)} right={16} minWidth={180}>
        <MenuItem
          icon="edit"
          label="Edit"
          accessibilityLabel="Edit Post"
          onPress={() => {
            setAnchor(null);
            onEdit();
          }}
        />
      </AnchoredMenu>
    </>
  );
}
