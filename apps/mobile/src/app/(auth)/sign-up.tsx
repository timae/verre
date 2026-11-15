import { checkUsername, validateDisplayName } from '@verre/core';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, type TextInputInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { RESERVED_TEXT, TAKEN_TEXT, UsernameField } from '@/components/ui/UsernameField';
import { VText } from '@/components/ui/VText';
import { authClient } from '@/lib/authClient';
import { sentence } from '@/lib/errorCopy';
import { space } from '@/theme';

// 01·2 Sign up. Social buttons + legal line land with the social milestone.
// ONE step (usernames § 9): `/sign-up/email` creates the account WITH its
// username and returns the session, so there is no follow-up sign-in (it would
// add a second device row). A taken email and a taken username are answered
// honestly and can show together.
// 🔒 Password AutoFill: the EMAIL is the login (`textContentType="username"`);
// the Username field never claims that role (UsernameField).
const EMAIL_TAKEN_TEXT = 'This email is already registered.';
export default function SignUp() {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Per-field answers from the submit; each clears when its field changes.
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usernameRef = useRef<TextInputInstance>(null);
  const emailRef = useRef<TextInputInstance>(null);
  const passwordRef = useRef<TextInputInstance>(null);
  const confirmRef = useRef<TextInputInstance>(null);

  const submit = async () => {
    setError(null);
    let cleanName: string;
    try {
      cleanName = validateDisplayName(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid name');
      return;
    }
    const handle = checkUsername(username);
    if (!handle.ok) { setUsernameError(handle.reason === 'reserved' ? RESERVED_TEXT : sentence(handle.message)); return; }
    if (!email.trim()) { setError('Email is required'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError("Passwords don't match"); return; }
    setBusy(true);
    const res = await authClient.signUp.email({ email: email.trim(), password, name: cleanName, username: handle.username });
    setBusy(false);
    if (!res.error) return; // Signed in by this call: the root layout's guard switches to the tabs.
    const code = res.error.code;
    const nameTaken = code === 'USERNAME_TAKEN' || code === 'EMAIL_AND_USERNAME_TAKEN';
    const emailTaken = code === 'EMAIL_TAKEN' || code === 'EMAIL_AND_USERNAME_TAKEN';
    if (nameTaken) setUsernameError(TAKEN_TEXT);
    if (emailTaken) setEmailError(EMAIL_TAKEN_TEXT);
    if (nameTaken || emailTaken) return;
    if (code === 'INVALID_USERNAME') { setUsernameError(sentence(res.error.message ?? 'username is invalid')); return; }
    setError(res.error.message ?? 'Could not create your account');
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg, paddingHorizontal: space.lg, gap: space.md }}
        keyboardShouldPersistTaps="handled"
      >
        <VText variant="subhead" style={{ marginBottom: space.xs }}>Create Your Account</VText>
        <TextField label="Name" value={name} onChangeText={setName} autoComplete="name" textContentType="name" autoCapitalize="words" returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => usernameRef.current?.focus()} />
        <UsernameField ref={usernameRef} value={username} onChange={(v) => { setUsername(v); setUsernameError(null); }} error={usernameError} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => emailRef.current?.focus()} />
        <TextField ref={emailRef} label="Email" value={email} onChangeText={(v) => { setEmail(v); setEmailError(null); }} error={emailError ?? undefined} autoComplete="email" textContentType="username" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => passwordRef.current?.focus()} />
        <TextField ref={passwordRef} label="Password" value={password} onChangeText={setPassword} autoComplete="new-password" textContentType="newPassword" secureTextEntry returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => confirmRef.current?.focus()} />
        <TextField ref={confirmRef} label="Confirm Password" value={confirm} onChangeText={setConfirm} autoComplete="new-password" textContentType="newPassword" secureTextEntry returnKeyType="go" onSubmitEditing={submit} />
        {error ? <VText variant="small" color="critical">{error}</VText> : null}
        <Button title="Create Account" loadingTitle="Creating account…" block loading={busy} onPress={submit} style={{ marginTop: space['2xs'] }} />
        <Pressable onPress={() => router.replace('/sign-in')} style={{ alignItems: 'center', marginTop: space.md }}>
          <VText variant="small" color="inkSoft">
            Already have an account? <VText variant="small" color="accent">Sign in</VText>
          </VText>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
