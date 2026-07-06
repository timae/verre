import { validateDisplayName } from '@verre/core';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { authClient } from '@/lib/authClient';
import { space } from '@/theme';

// 01·2 Sign up. Social buttons + legal line land with the social milestone.
export default function SignUp() {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const submit = async () => {
    setError(null);
    let cleanName: string;
    try {
      cleanName = validateDisplayName(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid name');
      return;
    }
    if (!email.trim()) { setError('Email is required'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError("Passwords don't match"); return; }
    setBusy(true);
    // Server uses autoSignIn: false (enumeration posture) — sign-up then
    // sign-in as a deliberate second step (proposal 01).
    const signUpRes = await authClient.signUp.email({ email: email.trim(), password, name: cleanName });
    if (signUpRes.error) {
      setBusy(false);
      setError(signUpRes.error.message ?? 'Could not create your account');
      return;
    }
    const signInRes = await authClient.signIn.email({ email: email.trim(), password });
    setBusy(false);
    if (signInRes.error) setError(signInRes.error.message ?? 'Could not sign you in');
    // On success the root layout's session guard switches to the tabs.
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg, paddingHorizontal: space.lg, gap: space.md }}
        keyboardShouldPersistTaps="handled"
      >
        <VText variant="subhead" style={{ marginBottom: space.xs }}>Create Your Account</VText>
        <TextField label="Name" value={name} onChangeText={setName} autoComplete="name" textContentType="name" autoCapitalize="words" returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => emailRef.current?.focus()} />
        <TextField ref={emailRef} label="Email" value={email} onChangeText={setEmail} autoComplete="email" textContentType="username" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => passwordRef.current?.focus()} />
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
