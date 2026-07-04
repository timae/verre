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

import { useEffect, type RefObject } from 'react';
import { findNodeHandle, Keyboard, type GestureResponderEvent } from 'react-native';

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

/** Root capture handler — dismisses on outside touches, never claims the
 *  responder. */
export function dismissKeyboardOnOutsideTouch(e: GestureResponderEvent): boolean {
  if (Keyboard.isVisible()) {
    const target = e.nativeEvent.target;
    if (typeof target !== 'number' || !inputTags.has(target)) Keyboard.dismiss();
  }
  return false;
}
