// Global "tap anywhere to leave the keyboard" (Simon's ruling 2026-07-03,
// app-wide): the root layout mounts onStartShouldSetResponderCapture=
// {dismissKeyboardOnOutsideTouch} on a View around the navigator. Any touch
// that starts OUTSIDE a text input dismisses the keyboard WITHOUT consuming
// the touch (the handler always returns false, so the button/card under the
// finger still fires — one tap acts AND exits the keyboard).
//
// The registry protects touches that must NOT bounce the keyboard: the
// inputs themselves (cursor moves, field-to-field focus hops) and their
// companion controls (the password eye, a search field's clear ✕). Every
// text input goes through a registering component (TextField, NotesField,
// the score/position numerals) — if you add a raw TextInput, call
// useRegisterInput(ref) or typing surfaces will lose the keyboard on tap.
//
// RN Modals (AnchoredMenu, DateField's picker) are separate touch roots the
// capture never sees — fine, they host no text inputs.
//
// 🔒 The ONE exception: the in-place EDIT BAR (ui/InPlaceEdit.tsx `EditBar`,
// your profile's and a moment's), docked KEYBOARD_GAP above the keyboard.
// Simon, 2026-11-25: tapping "Add Fields" closed the keyboard and the bar
// dropped out of sight; "lock the keyboard in place when somebody navigates
// this bar". So a touch inside the docked bar's band keeps the keyboard: the
// band ends at the keyboard's top minus the gap and begins one measured ROW
// height above that (the bar publishes it, `setDockedEditBar`), the touch and
// the keyboard frame compared in the SAME coordinate space. Cancel and Done
// close the keyboard themselves (Done when its save starts). iOS only: Fabric
// puts `screenY` on the touch at runtime but the installed
// GestureResponderEvent type omits it, so it is read through a narrow runtime
// check; Android's responder payload has only root-relative `pageY`, and no
// verified way to put the keyboard frame in those coordinates exists yet, so
// Android keeps the plain dismissal (as does any touch whose coordinate can't
// be read). Timing is unchanged for every other touch.

import { useEffect, type RefObject } from 'react';
import { findNodeHandle, Keyboard, Platform, type GestureResponderEvent } from 'react-native';

const inputTags = new Set<number>();

/** Register a mounted input (or companion control) as keyboard-safe. `enabled`
 *  re-runs registration when the node mounts conditionally (e.g. the eye). */
export function useRegisterInput(ref: RefObject<unknown>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const tag = findNodeHandle(ref.current as never);
    if (tag == null) return;
    inputTags.add(tag);
    return () => {
      inputTags.delete(tag);
    };
  }, [ref, enabled]);
}

/** Is this touch target a registered input (or companion control)? */
export function isRegisteredInput(target: unknown): boolean {
  return typeof target === 'number' && inputTags.has(target);
}

// The docked edit bar's measured row height (null = no bar mounted). A token
// so an old bar unmounting after a new one mounted can't clear the new one.
let dockedBar: { token: number; rowH: number; gap: number } | null = null;
let dockedSeq = 0;
export function dockEditBar(): number {
  return ++dockedSeq;
}
export function setDockedEditBar(token: number, bar: { rowH: number; gap: number } | null) {
  if (bar) dockedBar = { token, ...bar };
  else if (dockedBar?.token === token) dockedBar = null;
}

// A finite screen-space Y on the touch (iOS Fabric), else null.
function touchScreenY(n: unknown): number | null {
  const y = (n as { screenY?: unknown } | null)?.screenY;
  return typeof y === 'number' && Number.isFinite(y) ? y : null;
}
function inDockedBarBand(e: GestureResponderEvent): boolean {
  if (!dockedBar || Platform.OS !== 'ios') return false;
  const kb = Keyboard.metrics();
  const y = touchScreenY(e.nativeEvent);
  if (!kb || y === null || !Number.isFinite(kb.screenY)) return false;
  const bottom = kb.screenY - dockedBar.gap;
  return y <= bottom && y >= bottom - dockedBar.rowH;
}

/** Root capture handler — dismisses on outside touches, never claims the
 *  responder. */
export function dismissKeyboardOnOutsideTouch(e: GestureResponderEvent): boolean {
  if (Keyboard.isVisible()) {
    const target = e.nativeEvent.target;
    if ((typeof target !== 'number' || !inputTags.has(target)) && !inDockedBarBand(e)) Keyboard.dismiss();
  }
  return false;
}
