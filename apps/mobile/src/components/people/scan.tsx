import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRootNavigationState, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, View } from 'react-native';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Thumb } from '@/components/ui/Thumb';
import { VText } from '@/components/ui/VText';
import { ApiError, getMomentPreview, momentPreviewKey, type MomentPreview } from '@/lib/api/sessions';
import { profileQueryOptions } from '@/lib/api/users';
import { authClient } from '@/lib/authClient';
import { WEB_BASE } from '@/lib/config';
import { firstName } from '@/lib/initials';
import { joinByCode, joinErrorText } from '@/lib/joinByCode';
import { sessionWhen } from '@/lib/momentFormat';
import { relate, usePersonBusy } from '@/lib/relationship';
import { parseVerreCode, type VerreCode } from '@/lib/scanCode';
import { feedHref, sessionHref, useSessionTab, type SessionMount } from '@/lib/sessionStack';
import { useTheme } from '@/theme';

// Scanning a Verre code (D8): the iPhone's own scanner (VisionKit through
// expo-camera) and what a scanned code shows before anything happens. Shared
// by Add Friends (its result pane) and Moments home (Scan in the join block,
// the result in a sheet; ruled 2026-11-12).

// One app-wide scanner event (expo-camera: `onModernBarcodeScanned`) and
// several live screens that can scan: only the scanner whose Scan tap is the
// LATEST may take a result (`scanOwner`), and only while armed.
let scanOwner = 0;
let scanSeq = 0;
// When the scanner was last told to close. dismissScanner resolves when the
// dismiss STARTS, and expo-camera stops whatever scanner is current when the
// old dismissal completes, so a relaunch waits until that is surely over.
let lastDismiss = 0;
const DISMISS_SETTLE_MS = 700;

// `active`: subscribed while true (a sheet: while open). A swipe-down cancel
// sends no event, so the armed flag (not a per-tap listener) is what a tap
// sets. A Verre code: the success haptic, the scanner closes, `onCode`. Any
// other code (ruled 2026-11-12): the error haptic and an alert you tap away,
// OVER the live scanner, which stays open (RN alerts present in their own
// window). expo-camera reports a code continuously while it is in view, so
// nothing is taken while the alert is up, and that code is ignored for the
// rest of this scan: point at another one.
export function useVerreScanner(active: boolean, onCode: (code: VerreCode) => void): { scan: () => Promise<void>; launching: boolean } {
  const [id] = useState(() => ++scanSeq);
  const armed = useRef(false);
  const alertUp = useRef(false);
  const ignored = useRef(new Set<string>());
  const activeRef = useRef(active);
  const onCodeRef = useRef(onCode);
  useEffect(() => {
    onCodeRef.current = onCode;
    activeRef.current = active;
  });
  useEffect(() => {
    if (!active) return;
    const sub = CameraView.onModernBarcodeScanned((e) => {
      if (!armed.current || scanOwner !== id || alertUp.current || ignored.current.has(e.data)) return;
      const code = parseVerreCode(e.data, WEB_BASE);
      if (!code) {
        ignored.current.add(e.data);
        alertUp.current = true;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('Not a Verre Code', 'This QR code doesn’t lead to a Verre profile or moment.', [
          { text: 'OK', onPress: () => { alertUp.current = false; } },
        ]);
        return;
      }
      armed.current = false;
      lastDismiss = Date.now();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      void CameraView.dismissScanner();
      onCodeRef.current(code);
    });
    return () => {
      sub.remove();
      armed.current = false;
    };
  }, [active, id]);

  const [, requestCamera] = useCameraPermissions({ get: false });
  const [launching, setLaunching] = useState(false);
  const busy = useRef(false);
  const scan = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLaunching(true);
    try {
      const perm = await requestCamera();
      if (!perm.granted) {
        Alert.alert('Camera Access Needed', 'Allow Verre to use the camera in Settings to scan codes.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ]);
        return;
      }
      const settle = lastDismiss + DISMISS_SETTLE_MS - Date.now();
      if (settle > 0) await new Promise((r) => setTimeout(r, settle));
      // The sheet may have closed during the prompt or the wait: its listener
      // is gone, so nothing would take a code or close the scanner (review).
      if (!activeRef.current) return;
      scanOwner = id;
      armed.current = true;
      alertUp.current = false;
      ignored.current = new Set();
      try {
        await CameraView.launchScanner({ barcodeTypes: ['qr'], isHighlightingEnabled: true });
      } catch {
        // Permission is granted here, so this is the hardware: VisionKit's
        // DataScannerViewController isn't supported on every iPhone.
        armed.current = false;
        Alert.alert('Scanning isn’t available on this iPhone.');
      }
    } finally {
      busy.current = false;
      setLaunching(false);
    }
  }, [id, requestCamera]);
  return { scan, launching };
}

// 04·12d — what a scanned Verre code is, before anything happens: a person
// (View Profile + Follow / Follow Back), private, blocked, your own code, an
// unavailable one, or a moment's preview (ruled 2026-11-12: cover, name, the
// host (tappable), when, where; Join, or Open Moment when you're in it).
// `leaveTo` closes the host sheet, then pushes (a profile, the moment).
export function ScanResult({ result, meId, leaveTo }: { result: VerreCode; meId: number; leaveTo: (push: () => void) => void }) {
  const router = useRouter();
  const mount = useSessionTab();
  const rootState = useRootNavigationState();
  const queryClient = useQueryClient();
  const sessionName = authClient.useSession().data?.user.name;
  const personId = result.kind === 'profile' && result.id !== meId ? result.id : null;
  const profileQ = useQuery({ ...profileQueryOptions(personId ?? 0), enabled: personId != null });
  const momentCode = result.kind === 'moment' ? result.code : null;
  const previewQ = useQuery({
    queryKey: momentPreviewKey(momentCode ?? ''),
    queryFn: () => getMomentPreview(momentCode!),
    enabled: momentCode != null,
    // Never a cached answer: `joined` changes with a join.
    gcTime: 0,
    // A missing moment, a ban or the code-guessing limit won't change on a retry.
    retry: (n, e) => !(e instanceof ApiError && e.kind !== 'http') && n < 1,
  });
  const busy = usePersonBusy(personId);
  const [joining, setJoining] = useState(false);
  // Once you've left (a push, or the view is gone), a join that finishes later
  // must not push the moment over wherever you are (review 2026-11-12).
  const left = useRef(false);
  useEffect(() => () => {
    left.current = true;
  }, []);

  const go = (push: () => void) => {
    left.current = true;
    leaveTo(push);
  };
  // Profiles have no Moments mount, so from Moments home they open on the Feed
  // tab, and never on its OUTER stack above an open post (that presents over
  // the contained post: the 2026-11-10 hang class): onto the post's own stack
  // instead (review 2026-11-12; router-sim t15).
  const profileMount = (): SessionMount => {
    if (mount.tab !== 'moments') return mount;
    const post = openFeedPost(rootState);
    return post ? { tab: 'feed', post } : mount;
  };
  const openProfile = (id: number) => go(() => router.push(feedHref(profileMount(), 'profile', { id: String(id) })));
  const openMoment = (code: string) => go(() => router.push(sessionHref(mount, '', { code })));
  const join = async (code: string) => {
    if (joining) return;
    setJoining(true);
    try {
      const joined = await joinByCode(queryClient, code, sessionName);
      if (!left.current) openMoment(joined.code);
    } catch (e) {
      if (!left.current) Alert.alert('Couldn’t Join', joinErrorText(e));
    } finally {
      setJoining(false);
    }
  };

  if (result.kind === 'moment') {
    const { data, error } = previewQ;
    if (previewQ.isPending) return <Spinner />;
    if (error instanceof ApiError && error.kind === 'not-found') return <Message text="This code isn’t available." />;
    if (error instanceof ApiError && (error.kind === 'banned' || error.kind === 'rate-limited')) return <Message text={joinErrorText(error)} />;
    if (error || !data) {
      return (
        <View style={{ gap: 14 }}>
          <Message text="Couldn’t load this moment." />
          <Button title="Try Again" variant="secondary" block onPress={() => void previewQ.refetch()} />
        </View>
      );
    }
    return (
      <View style={{ gap: 14 }}>
        <MomentCard preview={data} onHost={data.hostUserId != null && !joining ? () => openProfile(data.hostUserId!) : undefined} />
        {data.joined ? (
          <Button title="Open Moment" block onPress={() => openMoment(data.code)} />
        ) : (
          <Button title="Join" loadingTitle="Joining…" loading={joining} block onPress={() => void join(data.code)} />
        )}
      </View>
    );
  }
  if (result.id === meId) return <Message text="This is your code." />;
  if (profileQ.isPending) return <Spinner />;
  const profile = profileQ.data;
  if (profileQ.isError || !profile) {
    return (
      <View style={{ gap: 14 }}>
        <Message text="Couldn’t load this profile." />
        <Button title="Try Again" variant="secondary" block onPress={() => void profileQ.refetch()} />
      </View>
    );
  }
  if (profile.state === 'gone') return <Message text="This code isn’t available." />;
  const viewBtn = <Button title="View Profile" variant="secondary" style={{ flex: 1 }} onPress={() => openProfile(profile.id)} />;
  if (profile.state === 'blocked') {
    return (
      <View style={{ gap: 14 }}>
        <Person name={profile.name} imageUrl={null} line={`You blocked ${firstName(profile.name)}.`} />
        <View style={{ flexDirection: 'row' }}>{viewBtn}</View>
      </View>
    );
  }
  const followsYou = profile.followsYou;
  const line = profile.state === 'ok' && profile.inCommon && profile.inCommon.count > 0
    ? `${profile.inCommon.count} ${profile.inCommon.count === 1 ? 'friend' : 'friends'} in common`
    : null;
  return (
    <View style={{ gap: 14 }}>
      <Person name={profile.name} imageUrl={profile.state === 'ok' ? profile.imageUrl : null} line={line} />
      {/* .yo-ffoot — View Profile + their follow button. */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {viewBtn}
        {profile.isFollowing ? (
          <Button title={followsYou ? 'Friends' : 'Following'} icon="check" variant="secondary" style={{ flex: 1 }} disabled />
        ) : (
          <Button title={followsYou ? 'Follow Back' : 'Follow'} loading={busy} style={{ flex: 1 }} onPress={() => void relate(queryClient, profile.id, 'follow')} />
        )}
      </View>
    </View>
  );
}

// The post open on the Feed tab's outer stack (its top route is the `[id]`
// modal), if any, from the root navigation state. `(tabs)` is found at any
// depth: the container's state wraps the root layout in a `__root` route
// (router-sim t15, the real expo-router 58 reducer).
type NavState = { index?: number; routes?: readonly NavNode[] };
type NavNode = { name?: string; params?: object; state?: NavState };
function findChild(s: NavState | undefined, name: string): NavState | undefined {
  for (const r of s?.routes ?? []) {
    if (r.name === name) return r.state;
    const deeper = findChild(r.state, name);
    if (deeper) return deeper;
  }
  return undefined;
}
function openFeedPost(root: NavState | undefined): string | null {
  const feed = findChild(root, '(tabs)')?.routes?.find((r) => r.name === 'feed')?.state;
  const routes = feed?.routes ?? [];
  const top = routes[feed?.index ?? routes.length - 1];
  const id = top?.name === '[id]' ? (top.params as { id?: unknown } | undefined)?.id : undefined;
  return typeof id === 'string' && id !== '' ? id : null;
}

function Person({ name, imageUrl, line }: { name: string; imageUrl: string | null; line: string | null }) {
  return (
    // .yo-cam-person — the photo, the name, one line.
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <Avatar imageUrl={imageUrl} name={name} size={56} initialsSize={20} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} numberOfLines={1}>{name}</VText>
        {line ? <VText variant="small" color="inkSoft">{line}</VText> : null}
      </View>
    </View>
  );
}

// A scanned moment before you join: cover, name, the host (tappable: their
// profile), when, where. The lines are the line-up's about block (icon +
// small text).
function MomentCard({ preview, onHost }: { preview: MomentPreview; onHost?: () => void }) {
  const { theme } = useTheme();
  const when = sessionWhen(preview.dateFrom, preview.dateTo);
  const line = (icon: 'clock' | 'pin', text: string) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon name={icon} size={16} color={theme.inkSoft} />
      <VText variant="small" style={{ flexShrink: 1 }}>{text}</VText>
    </View>
  );
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Thumb uri={preview.coverPhotoUrl} size={56} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <VText variant="body" style={{ fontFamily: 'InstrumentSans_600SemiBold' }} numberOfLines={2}>{preview.name || 'Untitled moment'}</VText>
          {preview.host ? (
            <Pressable
              accessibilityRole={onHost ? 'button' : 'text'}
              disabled={!onHost}
              onPress={onHost}
              hitSlop={6}
              style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.5 : 1 })}
            >
              <VText variant="small" color="inkSoft" numberOfLines={1}>
                Hosted by <VText variant="small" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>{preview.host}</VText>
              </VText>
            </Pressable>
          ) : null}
        </View>
      </View>
      {when || preview.address ? (
        <View style={{ gap: 4 }}>
          {when ? line('clock', when) : null}
          {preview.address ? line('pin', preview.address) : null}
        </View>
      ) : null}
    </View>
  );
}

function Spinner() {
  return (
    <View style={{ height: 96, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator />
    </View>
  );
}

function Message({ text }: { text: string }) {
  return <VText variant="body" color="inkSoft" style={{ paddingVertical: 8 }}>{text}</VText>;
}
