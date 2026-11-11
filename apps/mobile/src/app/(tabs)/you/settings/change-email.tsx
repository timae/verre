import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SetPage, SettingsFooter } from '@/components/moments/settingsParts';
import { TextField } from '@/components/ui/TextField';
import { MY_ACCOUNT_KEY, getMyAccount } from '@/lib/api/me';
import { ApiError } from '@/lib/api/sessions';
import { changeEmail } from '@/lib/api/settings';
import { SIGNED_OUT_TEXT, errorText } from '@/lib/errorCopy';
import { FOOT_CLEARANCE } from '@/lib/layout';
import { viewerCacheEpoch } from '@/lib/query';

// Settings → Account → Email (ruled 2026-11-11: the web can change it, so the
// app can, with no confirmation mail as there is no email pipeline yet). 🔒
// From the app it re-confirms the current password, checked by the server
// (app/api/me/account PATCH): the email is the sign-in name. The pill is
// hidden here (sticky footer), like Change Password.
export default function ChangeEmail() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const account = useQuery({ queryKey: MY_ACCOUNT_KEY, queryFn: getMyAccount });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A save that lands after you left must not pop whatever is under you now.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onSave = async () => {
    setError(null);
    const next = email.trim().toLowerCase();
    // A friendly pre-check; the server applies Better Auth's own rule.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) return setError('Enter a valid email address.');
    if (next === account.data?.email) return setError('That’s already your email.');
    if (!password) return setError('Enter your current password.');
    const epoch = viewerCacheEpoch();
    setSaving(true);
    try {
      await changeEmail(next, password);
    } catch (e) {
      setSaving(false);
      if (viewerCacheEpoch() !== epoch) return;
      // The 400s share a status, so their copy keys on the route's own text
      // (app/api/me/account PATCH); anything else falls back to errorText.
      const msg = e instanceof ApiError ? e.message : '';
      if (e instanceof ApiError && e.status === 401) return setError(SIGNED_OUT_TEXT);
      if (msg === 'current password incorrect') return setError('Your current password isn’t right.');
      if (e instanceof ApiError && e.status === 409) return setError('That email is already in use.');
      if (msg === 'invalid email') return setError('Enter a valid email address.');
      return setError(errorText(e));
    }
    setSaving(false);
    if (viewerCacheEpoch() !== epoch) return;
    void queryClient.refetchQueries({ queryKey: MY_ACCOUNT_KEY, exact: true });
    Alert.alert('Email Changed', `You now sign in with ${next}.`);
    if (mounted.current) router.back();
  };

  return (
    <SetPage
      title="Change Email"
      bottomPad={insets.bottom + FOOT_CLEARANCE}
      footer={<SettingsFooter saving={saving} error={error} onDiscard={() => router.back()} onSave={() => void onSave()} bottomInset={insets.bottom} />}
    >
      <View style={{ gap: 14 }}>
        <TextField
          label="New Email"
          placeholder={account.data?.email ?? ''}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
        />
        <TextField label="Current Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" />
      </View>
    </SetPage>
  );
}
