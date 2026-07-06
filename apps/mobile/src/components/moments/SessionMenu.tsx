// Session ⋯ menu (.sess-menu) + its anchor button + the Blind-for-all toggle
// mutation — shared by the line-up (02b) and Compare (02d) session screens.
// The menu is the brand .ir-menu anchored dropdown (native-chrome exception,
// Simon 2026-06-12), never a native action sheet.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { AnchoredMenu, MenuItem } from '@/components/ui/AnchoredMenu';
import { Icon } from '@/components/ui/Icon';
import { GUTTER, usePhoneTokens } from '@/lib/layout';
import { ApiError, updateMomentSettings, type SessionState } from '@/lib/api/sessions';
import { useTheme } from '@/theme';

export function SessionMenuButton({ onOpen }: { onOpen: (anchorBottomY: number) => void }) {
  const { theme } = useTheme();
  const phone = usePhoneTokens();
  const ref = useRef<View>(null);
  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Session menu"
        hitSlop={8}
        onPress={() => ref.current?.measureInWindow((_x, y, _w, h) => onOpen(y + h))}
        style={({ pressed }) => ({ width: phone.size('compactAction'), height: phone.size('compactAction'), alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
      >
        <Icon name="more" size={phone.size('compactActionIcon')} color={theme.ink} />
      </Pressable>
    </View>
  );
}

// Blind-for-all inline toggle (⋯ menu). Optimistically flip the cached meta
// so the row responds immediately, PATCH, then let the 5s poll reconcile;
// roll back + alert on failure. blindForEveryone is NOT pro-gated server-side
// (it composes on an already-blind session — root freemium note), so any
// host/cohost on a blind session may flip it. The menu only renders the
// toggle when meta.blind is true.
export function useBlindForEveryoneToggle(code: string, myIdentityId: string) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const toggle = useCallback(async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    const stateKey = ['session-state', code, myIdentityId];
    const prev = queryClient.getQueryData<SessionState>(stateKey);
    if (prev?.meta) {
      queryClient.setQueryData<SessionState>(stateKey, { ...prev, meta: { ...prev.meta, blindForEveryone: next } });
    }
    try {
      await updateMomentSettings(code, { blindForEveryone: next });
      queryClient.invalidateQueries({ queryKey: ['session-state', code] });
    } catch (e) {
      if (prev) queryClient.setQueryData<SessionState>(stateKey, prev); // roll back
      const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
      Alert.alert('Could not update', msg || 'Check your connection and try again.');
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, code, myIdentityId]);
  return { busy, toggle };
}

// .sess-menu: People + Share invite + Settings. Anchored dropdown (the 02e
// .ir-menu pattern). Blind-for-all MOVED to the line-up's eye menu (ADR-0007,
// Simon 2026-07-04) — reveal-scope controls live together, and this menu is
// now identical for blind and non-blind sessions.
export function SessionMenu({
  anchorTop, onClose, onPeople, onShare, onSettings,
}: {
  anchorTop: number | null;
  onClose: () => void;
  onPeople: () => void;
  onShare: () => void;
  onSettings: () => void;
}) {
  return (
    // anchorTop is the ⋯ button's bottom edge; pass it as both top+bottom (the
    // menu sits at the top of the screen and never flips). right=GUTTER/minWidth
    // 200 keep the line-up menu's prior metrics.
    <AnchoredMenu
      anchor={anchorTop !== null ? { top: anchorTop, bottom: anchorTop } : null}
      onClose={onClose}
      right={GUTTER}
      minWidth={200}
    >
      <MenuItem icon="user" label="People" onPress={onPeople} />
      <MenuItem icon="share" label="Share Invite" onPress={onShare} />
      <MenuItem icon="settings" label="Settings" onPress={onSettings} />
    </AnchoredMenu>
  );
}
