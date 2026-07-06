import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { authClient } from '@/lib/authClient';
import { space } from '@/theme';

// 01·4 Sign in. "Forgot?" lands with the (deferred) password-reset flow —
// /reset-password is a disabledPaths 404 server-side today.
export default function SignIn() {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  const submit = async () => {
    setError(null);
    if (!email.trim() || !password) { setError('Email and password are required'); return; }
    setBusy(true);
    const res = await authClient.signIn.email({ email: email.trim(), password });
    setBusy(false);
    if (res.error) setError(res.error.message ?? 'Could not sign you in');
    // On success the root layout's session guard switches to the tabs.
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg, paddingHorizontal: space.lg, gap: space.md }}
        keyboardShouldPersistTaps="handled"
      >
        <VText variant="subhead">Welcome Back</VText>
        <VText variant="small" color="inkSoft" style={{ marginBottom: space.xs }}>Sign in to pick up where you left off.</VText>
        <TextField label="Email" value={email} onChangeText={setEmail} autoComplete="email" textContentType="username" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => passwordRef.current?.focus()} />
        <TextField ref={passwordRef} label="Password" value={password} onChangeText={setPassword} autoComplete="password" textContentType="password" secureTextEntry returnKeyType="go" onSubmitEditing={submit} />
        {error ? <VText variant="small" color="critical">{error}</VText> : null}
        <Button title="Sign In" loadingTitle="Signing in…" block loading={busy} onPress={submit} style={{ marginTop: space['2xs'] }} />
        <Pressable onPress={() => router.replace('/sign-up')} style={{ alignItems: 'center', marginTop: space.md }}>
          <VText variant="small" color="inkSoft">
            New to Verre? <VText variant="small" color="accent">Create an account</VText>
          </VText>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
