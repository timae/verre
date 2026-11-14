import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { checkUsername } from '@verre/core';
import { Button } from '@/components/ui/Button';
import { RESERVED_TEXT, TAKEN_TEXT, UsernameField } from '@/components/ui/UsernameField';
import { VText } from '@/components/ui/VText';
import { MY_ACCOUNT_KEY } from '@/lib/api/me';
import { USERNAME_KEY, UsernameError, putUsername } from '@/lib/api/username';
import { authClient } from '@/lib/authClient';
import { errorText, sentence } from '@/lib/errorCopy';
import { confirmSignOut } from '@/lib/signOutConfirm';
import { space } from '@/theme';

// The blocking "choose your username" screen (usernames § 10): an account
// from before usernames picks one at its next launch. The root layout mounts
// it as the ONLY open route group while the server says `username: null`
// (lib/bootGate.ts `needsUsername`); a chosen name closes that guard onto the
// Moments tab. No suggested names (ruled). Sign Out is the way off the screen
// for someone on the wrong account.
export default function ChooseUsername() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { data: session, error: sessionError, refetch } = authClient.useSession();
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The name is stored but this screen is still up: the session re-read that
  // lifts the guard failed (`refetch` never rejects). Continue re-reads it.
  const [saved, setSaved] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const handle = checkUsername(username);

  const submit = async () => {
    if (busy || !handle.ok) return;
    setError(null);
    setBusy(true);
    try {
      await putUsername(handle.username);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: MY_ACCOUNT_KEY });
      void queryClient.invalidateQueries({ queryKey: USERNAME_KEY });
      // The session carries the name fresh: this is what lifts the guard.
      await refetch();
    } catch (e) {
      if (e instanceof UsernameError && e.code === 'taken') setFieldError(TAKEN_TEXT);
      else if (e instanceof UsernameError && e.code === 'reserved') setFieldError(RESERVED_TEXT);
      else if (e instanceof UsernameError && e.code === 'invalid') setFieldError(sentence(e.message));
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg, paddingHorizontal: space.lg, gap: space.md }}
        keyboardShouldPersistTaps="handled"
      >
        <VText variant="subhead" accessibilityRole="header">Choose Your Username</VText>
        <VText variant="small" color="inkSoft" style={{ marginBottom: space.xs }}>
          This is how people find you on Verre. You can change it later.
        </VText>
        <UsernameField
          value={username}
          onChange={(v) => { setUsername(v); setFieldError(null); setError(null); setSaved(false); }}
          availability
          error={fieldError}
          autoFocus
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        {error ? (
          <VText variant="small" color="critical">{error}</VText>
        ) : saved && !busy && sessionError ? (
          <VText variant="small" color="critical">Your username is saved. Check your connection, then tap Continue.</VText>
        ) : null}
        <Button title="Continue" loadingTitle="Saving…" block loading={busy} disabled={!handle.ok || signingOut} onPress={submit} style={{ marginTop: space['2xs'] }} />
        <View style={{ alignItems: 'center', marginTop: space.md }}>
          <Button title="Sign Out" variant="tertiary" disabled={busy || signingOut} onPress={() => confirmSignOut(session?.user?.email, setSigningOut)} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
