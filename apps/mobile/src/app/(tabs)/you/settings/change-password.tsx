import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SetPage, SettingsFooter } from '@/components/moments/settingsParts';
import { TextField } from '@/components/ui/TextField';
import { DEVICES_KEY } from '@/lib/api/settings';
import { authClient } from '@/lib/authClient';
import { SIGNED_OUT_TEXT } from '@/lib/errorCopy';
import { FOOT_CLEARANCE } from '@/lib/layout';
import { viewerCacheEpoch } from '@/lib/query';

// Better Auth's defaults for a NEW password (the server sets no other
// length). The current one gets no cap: a web password can be longer.
const MIN = 8;
const MAX = 128;
const LENGTH_RULE = `Use ${MIN} to ${MAX} characters.`;

// Settings → Account → Change Password: Current / New / Confirm New, Discard
// | Save. Through Better Auth's /change-password: it keeps THIS device signed
// in and signs out every other one, web and native (the server's hooks), and
// charges the shared password budget. The pill is hidden here (sticky footer).
export default function ChangePassword() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
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
    if (!current) return setError('Enter your current password.');
    if (next.length < MIN || next.length > MAX) return setError(LENGTH_RULE);
    if (next !== confirm) return setError('The new passwords don’t match.');
    const epoch = viewerCacheEpoch();
    setSaving(true);
    let res: Awaited<ReturnType<typeof authClient.changePassword>>;
    try {
      res = await authClient.changePassword({ currentPassword: current, newPassword: next });
    } catch {
      // 🔒 A transport failure or the client's 12 s abort REJECTS (it never
      // becomes `{ error }`), and the change may have landed meanwhile.
      setSaving(false);
      return setError('We couldn’t confirm the change. If your current password stops working, use the new one.');
    }
    setSaving(false);
    if (res.error) {
      const { code, status, message } = res.error;
      if (code === 'INVALID_PASSWORD') return setError('Your current password isn’t right.');
      if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') return setError(LENGTH_RULE);
      if (status === 429) return setError(message?.startsWith('Too many attempts') ? message : 'Too many attempts. Try again later.');
      if (status === 401) return setError(SIGNED_OUT_TEXT);
      return setError('Check your connection and try again.');
    }
    if (viewerCacheEpoch() === epoch) void queryClient.refetchQueries({ queryKey: DEVICES_KEY, exact: true });
    Alert.alert('Password Changed', 'Your other devices are signed out.');
    if (mounted.current) router.back();
  };

  return (
    <SetPage
      title="Change Password"
      bottomPad={insets.bottom + FOOT_CLEARANCE}
      footer={<SettingsFooter saving={saving} error={error} onDiscard={() => router.back()} onSave={() => void onSave()} bottomInset={insets.bottom} />}
    >
      <View style={{ gap: 14 }}>
        <TextField label="Current Password" value={current} onChangeText={setCurrent} secureTextEntry autoComplete="current-password" textContentType="password" />
        <TextField label="New Password" value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" textContentType="newPassword" maxLength={MAX} />
        <TextField label="Confirm New Password" value={confirm} onChangeText={setConfirm} secureTextEntry autoComplete="new-password" textContentType="newPassword" maxLength={MAX} />
      </View>
    </SetPage>
  );
}
