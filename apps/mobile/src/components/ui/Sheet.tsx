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
// To sit above the tab bar we HIDE the pill bar while a sheet is open
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
  stackBehavior = 'replace',
  layer = 0,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  snapPoints?: (string | number)[];
  enableDynamicSizing?: boolean;
  // Cap for dynamic-sized sheets (e.g. a long People roster) so they don't
  // grow past the screen.
  maxDynamicContentSize?: number;
  // 'replace' (default): opening one sheet as another closes dismisses the
  // outgoing one (People "Add" → Invite). Pass 'push' for a sheet that opens
  // ON TOP of a still-open parent and returns to it on close (the moments
  // filter sheet's role/host/people pickers).
  stackBehavior?: 'push' | 'replace' | 'switch';
  // Stacking depth for nested (stackBehavior='push') sheets. The shell z-hoists
  // container=100/backdrop=99 (see below) — identical for every sheet, so a
  // pushed child's backdrop (99) would paint UNDER the parent's container
  // (100) and the parent sheet sits un-dimmed beside the front sheet. Each
  // layer lifts the pair above the previous layer's container.
  layer?: number;
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
      // zIndex on the BACKDROP itself: gorhom renders it as a SIBLING BEFORE
      // the sheet's hosting container (plain absoluteFill, no zIndex), so the
      // containerStyle hoist below does not reach it — without this the
      // screen's zIndexed overlays (hero bar, sticky tab/rail overlays,
      // reconnecting bar) paint OVER the dim layer. 99 keeps it just under
      // the sheet (100).
      <BottomSheetBackdrop
        {...props}
        style={[props.style, { zIndex: 99 + layer * 4 }]}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    [layer],
  );

  return (
    <BottomSheetModal
      ref={ref}
      // onDismiss is the single funnel for every close path (button, backdrop,
      // swipe) — release the counter and the presented guard here.
      onDismiss={() => { presented.current = false; markClosed(); onClose(); }}
      // See the prop doc — 'replace' default, 'push' for nested pickers.
      stackBehavior={stackBehavior}
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
      containerStyle={{ zIndex: 100 + layer * 4 }}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: theme.surface }}
      handleIndicatorStyle={{ backgroundColor: theme.rule }}
    >
      {children}
    </BottomSheetModal>
  );
}
