import { BottomSheetView } from '@gorhom/bottom-sheet';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Keyboard } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PersonPreview } from '@/components/people/PersonPreview';
import { Sheet } from '@/components/ui/Sheet';
import type { SessionMetaView } from '@/lib/api/sessions';
import { blockLook, opensPreview } from '@/lib/blockLook';
import { viewerCacheEpoch } from '@/lib/query';
import type { RelOp } from '@/lib/relationship';
import { usePushGuard } from '@/lib/usePushGuard';

// A person tapped inside a moment (ruled 2026-11-15): the scan card
// (`PersonPreview`) in a small sheet, pushed over whatever sheet the tap came
// from (People, Compare's Show All, Aroma Details) or on its own (Brought By).
// ONE per screen (the line-up, an impression, the moment settings hub),
// mounted beside the screen's other sheets (the screen-level
// sheet anatomy: a sheet mounted inside a conditionally mounted sheet was
// stranded on close, apps/mobile/CLAUDE.md § Compare aromas). Surfaces ask
// `canOpen(identityId)` to decide whether a person is tappable at all: 🔒
// the block look decides (`opensPreview`), so someone who blocked you taps
// exactly like a guest. 🔒 And only someone ON THE ROSTER (`meta.participants`):
// the block lists are scoped to it (lib/sessionState.ts), so a bringer or
// rater no longer in the moment (kicked, left) who blocked you would read as
// 'normal' and open a "gone" card where a guest stays inert (Codex
// 2026-11-15). `from: 'friends'` = a row of /api/me/friends (the invite
// sheet), which the server scrubs of block pairs both ways, so it needs no
// roster. The card is keyed on the PUBLIC id, never a name.
type PreviewFrom = 'moment' | 'friends';
type PersonPreviewApi = {
  canOpen: (identityId: string | null | undefined, from?: PreviewFrom) => boolean;
  open: (identityId: string, from?: PreviewFrom) => void;
};
const PreviewContext = createContext<PersonPreviewApi | null>(null);

// null outside a provider: nothing there is tappable.
export function usePersonPreview(): PersonPreviewApi | null {
  return useContext(PreviewContext);
}

// ⚠️ gorhom draws a sheet's content at its BottomSheetModalProvider's portal
// host, OUTSIDE this provider, so `usePersonPreview()` inside a <Sheet>'s
// children reads null (Codex 2026-11-15: every Aroma Details photo was inert).
// Read it where the <Sheet> is rendered and wrap the sheet's content in this.
export function PersonPreviewBridge({ value, children }: { value: PersonPreviewApi | null; children: React.ReactNode }) {
  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

// `meta` null (not loaded, or the moment is gone / you were removed) closes
// the sheet and makes nobody tappable.
export function PersonPreviewProvider({ code, meta, myIdentityId, children }: {
  code: string;
  meta: SessionMetaView | null;
  myIdentityId: string;
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const guard = usePushGuard();
  const [person, setPerson] = useState<{ id: string; seq: number } | null>(null);
  const [isOpen, setOpen] = useState(false);
  const blocksOut = meta?.viewerBlocksOut;
  const blocksIn = meta?.viewerBlocksIn;
  const participants = meta?.participants;
  const live = meta != null;
  const roster = useMemo(() => new Set((participants ?? []).map((p) => p.id)), [participants]);
  const canOpen = useCallback(
    (id: string | null | undefined, from: PreviewFrom = 'moment') =>
      live && !!id && myIdentityId.startsWith('u:') && (from === 'friends' || roster.has(id)) &&
      opensPreview(blockLook(id, myIdentityId, blocksOut, blocksIn)),
    [live, myIdentityId, roster, blocksOut, blocksIn],
  );
  const open = useCallback((id: string, from: PreviewFrom = 'moment') => {
    if (!canOpen(id, from)) return;
    // A row tapped while its sheet's search has the keyboard up (the lists
    // persist taps): the small bottom sheet would present UNDER the keyboard,
    // only its backdrop showing (review 2026-11-15).
    Keyboard.dismiss();
    setPerson((p) => ({ id: id.slice(2), seq: (p?.seq ?? 0) + 1 }));
    setOpen(true);
  }, [canOpen]);
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);
  const api = useMemo(() => ({ canOpen, open }), [canOpen, open]);

  // View Profile: only the card closes; the sheet it came from (People, Show
  // All, Aroma Details, Invite) stays open behind the profile, so Back lands
  // on it (ruled 2026-11-15, like a likes list). It doesn't hide the tab bar
  // on the profile: a sheet does that only while its screen is focused
  // (ui/Sheet.tsx).
  const leaveTo = (push: () => void) =>
    guard(() => {
      setOpen(false);
      push();
    });
  // "· Blocked" comes from the moment's poll (`viewerBlocksOut`) and "Friend"
  // from ['my-friends'], which leaves out block pairs (so an unblocked mutual
  // follow is a friend again): refresh what the write changed, not only the
  // header. Cancel first: an invalidate JOINS a first load still in flight,
  // whose pre-write answer would stand (Codex 2026-11-15).
  const onRelated = (op: RelOp) => {
    const keys = [...(op === 'unblock' ? [['session-state', code]] : []), ['my-friends']];
    const epoch = viewerCacheEpoch();
    void Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey }))).then(() => {
      if (viewerCacheEpoch() !== epoch) return;
      keys.forEach((queryKey) => void queryClient.invalidateQueries({ queryKey }));
    });
  };

  return (
    <PreviewContext.Provider value={api}>
      {children}
      {live ? (
        // Layer 2: above every layer-1 sheet a tap can come from.
        <Sheet open={isOpen} onClose={() => setOpen(false)} stackBehavior="push" layer={2}>
          <BottomSheetView style={{ width: '100%', paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 16 }}>
            {person ? <PersonPreview key={person.seq} id={person.id} leaveTo={leaveTo} goneText="This profile isn’t available." onRelated={onRelated} /> : null}
          </BottomSheetView>
        </Sheet>
      ) : null}
    </PreviewContext.Provider>
  );
}
