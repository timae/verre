import { forwardRef, useEffect, useState } from 'react';
import { View, type TextInputInstance, type TextInputProps } from 'react-native';
import { USERNAME_MAX, checkUsername } from '@verre/core';
import { checkUsernameAvailable } from '@/lib/api/username';
import { sentence } from '@/lib/errorCopy';
import { RESERVED_TEXT, TAKEN_TEXT, typedUsername } from '@/lib/usernameCopy';
import { TextField } from './TextField';
import { VText } from './VText';

// THE username input (sign-up, the choose-your-username screen, Edit
// Profile): the `@` in front of what you type, lowercase as you type, and one
// line of feedback under it. About half a second after the last keystroke it
// names the rule a name breaks (the validator's own message) and, with
// `availability`, asks the server whether the name is free ("Available" /
// taken). Sign-up has no account yet, so it passes no `availability`: a taken
// name shows there after the submit, through `error`.
//
// 🔒 Never `textContentType="username"` / `autoComplete="username"`: the EMAIL
// is the login for password managers (usernames § 13).
export { RESERVED_TEXT, TAKEN_TEXT };
const PAUSE_MS = 500;

// `pending` = a changed name whose answer isn't in yet (the pause after a
// keystroke; also, without `availability`, a valid name for good): the
// profile's edit bar says "Checking availability…" through it and `checking`
// (device pass 2026-11-14: falling back to "Editing Profile" on every
// keystroke confused). `idle` = nothing to say (empty, your own name, or a
// check that failed: advisory only).
export type UsernameCheckState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'invalid'; message: string }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'taken'; message: string };

// The feedback for `value`. A name that turns valid clears its message at
// once; a broken rule waits for the pause. `current` (your own name) is never
// checked.
export function useUsernameCheck(value: string, { availability = false, current = null }: { availability?: boolean; current?: string | null } = {}): UsernameCheckState {
  const [settled, setSettled] = useState<{ value: string; state: UsernameCheckState }>({ value: '', state: { kind: 'idle' } });
  useEffect(() => {
    if (value === '' || value === current) return;
    const local = checkUsername(value);
    const ask = local.ok && availability;
    const ac = new AbortController();
    const t = setTimeout(() => {
      if (!local.ok) {
        setSettled({ value, state: { kind: 'invalid', message: local.reason === 'reserved' ? RESERVED_TEXT : sentence(local.message) } });
        return;
      }
      if (!ask) return;
      setSettled({ value, state: { kind: 'checking' } });
      checkUsernameAvailable(local.username, ac.signal).then(
        (r) => {
          if (ac.signal.aborted) return;
          setSettled({ value, state: r.available ? { kind: 'available' } : { kind: 'taken', message: r.reason === 'reserved' ? RESERVED_TEXT : TAKEN_TEXT } });
        },
        // Advisory only: a failed check says nothing (the save's answer decides).
        () => { if (!ac.signal.aborted) setSettled({ value, state: { kind: 'idle' } }); },
      );
    }, PAUSE_MS);
    return () => {
      clearTimeout(t);
      ac.abort();
      // Typing on drops the answer: coming back to the same text within the
      // pause must not show it again before it is re-checked.
      setSettled((s) => (s.state.kind === 'idle' ? s : { value: '', state: { kind: 'idle' } }));
    };
  }, [value, availability, current]);
  // Only the answer for the text now in the field counts.
  if (value === '' || value === current) return { kind: 'idle' };
  return settled.value === value ? settled.state : { kind: 'pending' };
}

type Props = Omit<TextInputProps, 'value' | 'onChangeText' | 'onChange'> & {
  label?: string;
  // What was typed, without the `@` (lib/usernameCopy `typedUsername`).
  value: string;
  onChange: (value: string) => void;
  // Ask the server whether the name is free (signed-in screens only).
  availability?: boolean;
  // Your own current name: unchanged, so nothing to check.
  current?: string | null;
  // A message from the submit (taken, the server's refusal): shown until the text changes.
  error?: string | null;
  // A quiet line under the field when there is no feedback (changes left).
  hint?: string | null;
};

export const UsernameField = forwardRef<TextInputInstance, Props>(function UsernameField(
  { label = 'Username', value, onChange, availability, current, error, hint, ...rest },
  ref,
) {
  const check = useUsernameCheck(value, { availability, current });
  const bad = error ?? (check.kind === 'invalid' || check.kind === 'taken' ? check.message : undefined);
  return (
    <View style={{ gap: 7 }}>
      <TextField
        ref={ref}
        label={label}
        value={value ? `@${value}` : ''}
        onChangeText={(t) => onChange(typedUsername(t).slice(0, USERNAME_MAX))}
        placeholder="@username"
        error={bad ?? undefined}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        accessibilityLabel={label}
        {...rest}
      />
      {bad ? null : check.kind === 'available' ? (
        <VText variant="caption" color="positive" accessibilityLiveRegion="polite">Available</VText>
      ) : hint ? (
        <VText variant="caption" color="inkSoft">{hint}</VText>
      ) : null}
    </View>
  );
});
