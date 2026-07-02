import { useCallback, useEffect, useRef } from 'react';
import { BottomSheetBackdrop, BottomSheetModal, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { popSheet, pushSheet } from '@/lib/sheetVisibility';
import { useTheme } from '@/theme';

// Shared @gorhom/bottom-sheet shell for the app's bottom sheets (Invite, People,
// create-category). Pure-JS sheet (no native overlay capturing taps — the
// @expo/ui community sheet's Host did). Driven by an `open` prop so call sites
// keep their existing open/onClose interface; the ref present/dismiss is wired
// internally. Themed background + handle + a tap-to-dismiss backdrop.
//
// Above the tab bar: the sheet renders IN-SCREEN (gorhom v5 hosts it in its own
// BottomSheetHostingContainer inside the per-screen BottomSheetModalProvider).
// To sit above the OS tab bar we HIDE the NativeTabs bar while a sheet is open
// (lib/sheetVisibility.ts → (tabs)/_layout.tsx `hidden`), rather than a
// react-native-screens FullWindowOverlay — the overlay re-hosts the sheet in a
// full-window native context whose height competes with the in-screen host
// (bottom gap + collapsed dynamic panes) and traps in-sheet popups (share, row
// menus) behind it. See sheetVisibility.ts for the full rationale.
//
// ⚠️ Present/dismiss is GUARDED: calling `.dismiss()` on a BottomSheetModal that
// has never been presented poisons it into MODAL_STATUS.DISMISSING permanently
// (handleDismiss flips a still-INITIAL modal straight to DISMISSING). A later
// `.present()` then silently no-ops — handlePortalRender bails while DISMISSING,
// so the inner sheet never mounts and onDismiss fires immediately. The naive
// `open ? present() : dismiss()` effect triggers this on the very first render
// (open=false → dismiss() on a pristine modal). So we only dismiss once we've
// actually presented.
export function Sheet({
  open,
  onClose,
  children,
  snapPoints,
  enableDynamicSizing = true,
  maxDynamicContentSize,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  snapPoints?: (string | number)[];
  enableDynamicSizing?: boolean;
  // Cap for dynamic-sized sheets (e.g. a long People roster) so they don't
  // grow past the screen.
  maxDynamicContentSize?: number;
}) {
  const { theme } = useTheme();
  const ref = useRef<BottomSheetModal>(null);
  const presented = useRef(false);
  // Whether THIS instance currently holds a +1 on the tab-bar-hide counter, so
  // we push/pop exactly once regardless of close path (button, swipe, unmount)
  // and never double-count.
  const contributing = useRef(false);

  const markOpen = useCallback(() => {
    if (contributing.current) return;
    contributing.current = true;
    pushSheet();
  }, []);
  const markClosed = useCallback(() => {
    if (!contributing.current) return;
    contributing.current = false;
    popSheet();
  }, []);

  useEffect(() => {
    if (open) {
      presented.current = true;
      markOpen();
      ref.current?.present();
    } else if (presented.current) {
      ref.current?.dismiss();
    }
  }, [open, markOpen]);

  // Unmount while open (e.g. navigating away mid-sheet) must release the
  // counter — otherwise the bar stays hidden. Idempotent via `contributing`.
  useEffect(() => markClosed, [markClosed]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
    ),
    [],
  );

  return (
    <BottomSheetModal
      ref={ref}
      // onDismiss is the single funnel for every close path (button, backdrop,
      // swipe) — release the counter and the presented guard here.
      onDismiss={() => { presented.current = false; markClosed(); onClose(); }}
      // Replace (not the default 'switch') so when one sheet opens as another
      // closes (People "Add" → Invite), the outgoing sheet is dismissed rather
      // than minimized-and-parked behind the new one.
      stackBehavior="replace"
      enablePanDownToClose
      // Keyboard: gorhom's default 'interactive' slides the WHOLE sheet up to
      // keep the focused input above the keyboard — but our sheet inputs (the
      // Invite browse search) sit near the top of a tall snap, so the shift just
      // looks like the sheet jumped. 'extend' keeps the sheet anchored and lets
      // the keyboard slide under it; 'restore' returns to the resting snap on
      // blur. Shell-wide default so every sheet input behaves the same.
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
      enableDynamicSizing={enableDynamicSizing}
      maxDynamicContentSize={maxDynamicContentSize}
      snapPoints={snapPoints}
      // Explicit stacking: the portal'd modal container has NO zIndex, and
      // under Fabric's view flattening the screen's zIndexed absolute
      // overlays (hero bar 8, sticky tab/rail overlays 7, reconnecting bar
      // 50) can end up siblings of it and paint OVER the backdrop. Hoist the
      // whole modal layer above anything a screen uses.
      containerStyle={{ zIndex: 100 }}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: theme.surface }}
      handleIndicatorStyle={{ backgroundColor: theme.rule }}
    >
      {children}
    </BottomSheetModal>
  );
}
