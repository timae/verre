import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Platform, View } from 'react-native';
import { SetGroup, SetNav, SetPage, SetSection } from '@/components/moments/settingsParts';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { MY_ACCOUNT_KEY, getMyAccount } from '@/lib/api/me';
import { ApiError } from '@/lib/api/sessions';
import { DEVICES_KEY, deleteAccount, getDevices, signOutDevice, signOutOtherDevices, type Device } from '@/lib/api/settings';
import { authClient } from '@/lib/authClient';
import { errorText, sentence } from '@/lib/errorCopy';
import { DATE_LOCALE } from '@/lib/locale';
import { viewerCacheEpoch } from '@/lib/query';
import { confirmSignOut } from '@/lib/signOutConfirm';
import { settingsHref, useSessionTab } from '@/lib/sessionStack';
import { useTheme } from '@/theme';

// The password re-auth uses iOS's secure Alert.prompt (plan T2). Android has
// none, so the three password-gated actions render disabled there ("Soon",
// apps/mobile/CLAUDE.md § Deferred Android work).
const CAN_PROMPT = Platform.OS === 'ios';

// 🔒 The password goes straight from the prompt into the request body: never
// logged, never kept in state. An empty one counts as Cancel: sending it would
// only spend one of the shared password budget's attempts (rl:account).
function promptPassword(title: string, message: string, confirm: string): Promise<string | null> {
  return new Promise((resolve) => {
    Alert.prompt(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
        { text: confirm, style: 'destructive', onPress: (pw?: string) => resolve(pw || null) },
      ],
      'secure-text',
    );
  });
}

// "11 Nov" ("Nov 11" in the US), with the year when it isn't this one.
function shortDate(iso: string): string {
  const d = new Date(iso);
  const year = d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' as const };
  return d.toLocaleDateString(DATE_LOCALE, { day: 'numeric', month: 'short', ...year });
}
// The web panel's scale (lastSeenLabel in the repo root's
// components/me/AccountSettings.tsx): every row, web or app, is stored on
// 5-minute buckets (the root's lib/lastSeen.ts), so
// under 10 minutes is "recently", then 5-minute steps, hours, days, the date.
function lastActive(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(secs)) return 'Last active a while ago';
  if (secs < 600) return 'Active recently';
  if (secs < 3600) return `Last active ${Math.floor(secs / 300) * 5} min ago`;
  const ago = (n: number, unit: string) => `Last active ${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (secs < 86_400) return ago(Math.floor(secs / 3600), 'hour');
  if (secs < 604_800) return ago(Math.floor(secs / 86_400), 'day');
  return `Last active ${shortDate(iso)}`;
}
const deviceIcon = (label: string) => (/MacBook|Windows|Linux|Chromebook/.test(label) ? 'laptop' : 'phone');
// "Signed in 11 Nov": two logins from the same kind of device stay tellable
// apart (the web panel shows it for the same reason).
const signedIn = (iso: string) => `Signed in ${shortDate(iso)}`;

// One signed-in device: icon, label, "Active now" (this one) or when it was
// last active, the country when known, then when it signed in (the web
// panel's facts). Your own row: Sign Out (the plain logout); the others:
// Disconnect (the web panel's word, ruled 2026-11-11).
function DeviceRow({ d, busyId, onSignOut }: { d: Device; busyId?: string | null; onSignOut?: () => void }) {
  const { theme } = useTheme();
  const label = d.deviceLabel ?? 'Unknown device';
  const where = d.geoLabel ? ` · ${d.geoLabel}` : '';
  return (
    <SetNav
      leading={<Icon name={deviceIcon(label)} size={19} color={theme.inkSoft} />}
      label={label}
      subtitle={`${d.isCurrent ? 'Active now' : lastActive(d.lastSeenAt)}${where}\n${signedIn(d.createdAt)}`}
      trailing={!onSignOut ? 'none' : (
        <Button
          title={d.isCurrent ? 'Sign Out' : 'Disconnect'}
          variant="tertiary"
          critical={d.isCurrent}
          size="sm"
          loading={busyId === d.id}
          // Your own row needs no password prompt (a logout), so iOS-only
          // Alert.prompt doesn't gate it.
          disabled={(!d.isCurrent && !CAN_PROMPT) || (busyId != null && busyId !== d.id)}
          accessibilityLabel={`${d.isCurrent ? 'Sign Out' : 'Disconnect'} ${label}`}
          onPress={onSignOut}
        />
      )}
    />
  );
}

// Account (handoff 04·4 `setAccount`, ruling Q-C): email (→ Change Email),
// Change Password, signed-in devices (This Device, Disconnect per device,
// Disconnect All Other Devices), Delete Account. Connected sign-ins are left out
// (no social sign-in yet).
export default function Account() {
  const router = useRouter();
  const mount = useSessionTab();
  const queryClient = useQueryClient();
  const account = useQuery({ queryKey: MY_ACCOUNT_KEY, queryFn: getMyAccount });
  const devices = useQuery({ queryKey: DEVICES_KEY, queryFn: getDevices });
  const [busy, setBusy] = useState<string | null>(null); // a device id, 'others' or 'delete'

  const refetchDevices = (epoch: number) => {
    if (viewerCacheEpoch() === epoch) void queryClient.refetchQueries({ queryKey: DEVICES_KEY, exact: true });
  };
  // A device revoke's failure copy. 404 = that device is already gone.
  const revokeFailed = (e: unknown, epoch: number) => {
    if (viewerCacheEpoch() !== epoch) return;
    if (e instanceof ApiError && e.kind === 'not-found') return refetchDevices(epoch);
    Alert.alert('Couldn’t Disconnect', e instanceof ApiError && e.status === 403 ? 'That password isn’t right.' : errorText(e));
  };

  const disconnectOne = async (d: Device) => {
    const label = d.deviceLabel ?? 'Unknown device';
    const epoch = viewerCacheEpoch();
    const pw = await promptPassword(`Disconnect ${label}?`, 'Enter your Verre password to disconnect this device.', 'Disconnect');
    if (pw == null || viewerCacheEpoch() !== epoch) return;
    setBusy(d.id);
    try {
      await signOutDevice(d.id, pw);
      refetchDevices(epoch);
    } catch (e) {
      revokeFailed(e, epoch);
    } finally {
      setBusy(null);
    }
  };
  const disconnectOthers = async () => {
    const epoch = viewerCacheEpoch();
    const pw = await promptPassword('Disconnect All Other Devices?', 'Enter your Verre password. Every other phone and browser signed in to your account will be disconnected.', 'Disconnect');
    if (pw == null || viewerCacheEpoch() !== epoch) return;
    setBusy('others');
    try {
      await signOutOtherDevices(pw);
      refetchDevices(epoch);
    } catch (e) {
      revokeFailed(e, epoch);
    } finally {
      setBusy(null);
    }
  };

  // Delete Account (plan T4). After the password check the server signs this
  // phone out BEFORE the step that can still fail, so every failure past it
  // ends signed out (and there is no in-place retry): the phone signs itself
  // out too, with copy for what is known. A timeout or network error means
  // the outcome is unknown (the server keeps going).
  const confirmDelete = () => {
    Alert.alert(
      'Delete your account?',
      'This is permanent. Your profile, posts, bookmarks and badges are deleted. Your ratings in moments with other tasters stay, shown as [deleted]. Moments you host where no one else has rated are deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void runDelete() },
      ],
    );
  };
  const runDelete = async () => {
    const epoch = viewerCacheEpoch();
    const pw = await promptPassword('Enter Your Password', 'Enter your Verre password to delete your account.', 'Delete Account');
    if (pw == null || viewerCacheEpoch() !== epoch) return;
    setBusy('delete');
    let outcome;
    try {
      outcome = await deleteAccount(pw);
    } catch {
      setBusy(null); // a 426: the update screen has taken over
      return;
    }
    // 🔒 The viewer changed while it ran (the server revokes this phone's
    // sessions before its last step, so a heartbeat can sign it out, and
    // someone else can sign in): this result is no longer this phone's. Its
    // sign-out would revoke THEIR session; its alert would be about another
    // account.
    if (viewerCacheEpoch() !== epoch) return setBusy(null);
    if (outcome.kind === 'refused') {
      setBusy(null);
      const copy = outcome.status === 400 ? 'That password isn’t right.' : outcome.message ? sentence(outcome.message) : 'Too many attempts. Try again later.';
      return Alert.alert('Delete Account', copy);
    }
    void authClient.signOut();
    if (outcome.kind === 'deleted') return;
    if (outcome.kind === 'failed') {
      return Alert.alert(
        'Delete Account',
        outcome.tooManyMoments
          ? 'You host too many empty moments to delete your account in one go. Sign in, delete some of them, then try again.'
          : 'Your account wasn’t deleted. Sign in again to try again.',
      );
    }
    Alert.alert('Delete Account', 'We couldn’t confirm whether your account was deleted. Sign in again to check.');
  };

  // Two groups (ruled 2026-11-11, the mock lists one): This Device, then
  // Other Devices: Disconnect All Other Devices, an accent action row like
  // the per-device Disconnect buttons, in its own card touching the list's
  // (only with a current device to keep: the route refuses otherwise), then
  // the list in the server's order (most recently active first). Your own row's Sign Out is the hub's (the same confirm,
  // no password: a logout; ruled 2026-11-11, replacing T3's no-button row).
  const list = devices.data;
  const current = list?.find((d) => d.isCurrent);
  const others = list?.filter((d) => !d.isCurrent) ?? [];
  return (
    <SetPage title="Account">
      <SetGroup flush>
        <SetNav icon="user" label="Email" value={account.data?.email ?? ''} onPress={() => router.push(settingsHref(mount, 'change-email'))} />
        <SetNav icon="eyeoff" label="Change Password" onPress={() => router.push(settingsHref(mount, 'change-password'))} />
      </SetGroup>
      {!list || current ? (
        <SetSection label="This Device">
          {current ? (
            <SetGroup flush>
              <DeviceRow d={current} busyId={busy} onSignOut={() => confirmSignOut(account.data?.email, (b) => setBusy(b ? current.id : null))} />
            </SetGroup>
          ) : devices.isError ? (
            <SetGroup flush>
              <SetNav label="Couldn’t load your devices" subtitle="Tap to try again." onPress={() => void devices.refetch()} />
            </SetGroup>
          ) : (
            <View style={{ paddingVertical: 12, alignItems: 'center' }}><ActivityIndicator /></View>
          )}
        </SetSection>
      ) : null}
      {others.length > 0 ? (
        <SetSection label="Other Devices">
          {/* Two cards, each fully rounded, touching (ruled): the action reads
              as its own button, joined to the list. One child, so the
              section's gap doesn't fall between them; the list overlaps by
              1 pt so the two borders draw as ONE line. */}
          <View>
            {current ? (
              <SetGroup flush>
                <SetNav
                  icon="logout"
                  label="Disconnect All Other Devices"
                  action
                  accent
                  disabled={!CAN_PROMPT || busy != null}
                  soon={!CAN_PROMPT}
                  busy={busy === 'others'}
                  onPress={() => void disconnectOthers()}
                />
              </SetGroup>
            ) : null}
            <View style={{ marginTop: current ? -1 : 0 }}>
              <SetGroup flush>
                {others.map((d) => (
                  <DeviceRow key={d.id} d={d} busyId={busy} onSignOut={() => void disconnectOne(d)} />
                ))}
              </SetGroup>
            </View>
          </View>
        </SetSection>
      ) : null}
      <SetGroup flush>
        <SetNav
          icon="trash"
          label="Delete Account"
          action
          critical
          disabled={!CAN_PROMPT || busy != null}
          soon={!CAN_PROMPT}
          busy={busy === 'delete'}
          onPress={confirmDelete}
        />
      </SetGroup>
    </SetPage>
  );
}
