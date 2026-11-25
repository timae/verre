import { useState } from 'react';
import { AnchorButton, AnchoredMenu, MenuItem, type MenuAnchor } from '@/components/ui/AnchoredMenu';
import { useTheme } from '@/theme';

// The feed cards' ⋯ menu (Simon, 2026-07-17), owner-only today (the list
// screen passes onEdit only for the viewer's own posts, so the trigger simply
// doesn't render otherwise). Crave/Share/etc. join here when their deferred
// passes land (08-feed §6/§7). `deleteLabel` forks the destructive row's copy:
// standalone = "Delete" (the post goes), session = "Delete Rating" (the
// active impression's rating resets; the post only goes if that emptied it).
export function FeedCardMenu({
  onEdit,
  onDelete,
  deleteLabel = 'Delete',
  deleteAccessibilityLabel = 'Delete Post',
  privacy,
}: {
  onEdit: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  deleteAccessibilityLabel?: string;
  // Your post's own switches (Moment Visibility step 3, R2 / R5 / R11 / R12):
  // "Hide from Feed" on a moment post or a check-in (never Incognito: R13), a
  // check while on, acting at once (lib/postPrivacyActions.ts
  // usePostPrivacyRow).
  privacy?: { field: string; label: string; on: boolean; onToggle: () => void }[];
}) {
  const { theme } = useTheme();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  return (
    <>
      <AnchorButton onOpen={setAnchor} accessibilityLabel="Post Options" iconColor={theme.inkSoft} />
      <AnchoredMenu anchor={anchor} onClose={() => setAnchor(null)} right={16} minWidth={privacy?.length ? 220 : 180}>
        {(privacy ?? []).map((row) => (
          <MenuItem
            key={row.field}
            icon="eyeoff"
            label={row.label}
            checked={row.on}
            onPress={() => {
              setAnchor(null);
              row.onToggle();
            }}
          />
        ))}
        <MenuItem
          icon="edit"
          label="Edit"
          accessibilityLabel="Edit Post"
          onPress={() => {
            setAnchor(null);
            onEdit();
          }}
        />
        {onDelete ? (
          <MenuItem
            icon="trash"
            label={deleteLabel}
            tone="danger"
            accessibilityLabel={deleteAccessibilityLabel}
            onPress={() => {
              setAnchor(null);
              onDelete();
            }}
          />
        ) : null}
      </AnchoredMenu>
    </>
  );
}
