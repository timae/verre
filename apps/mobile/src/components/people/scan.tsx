import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, View } from 'react-native';
import { PersonPreview, PreviewMessage, PreviewSpinner } from '@/components/people/PersonPreview';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Thumb } from '@/components/ui/Thumb';
import { UsernameLine } from '@/components/ui/UsernameLine';
import { VText } from '@/components/ui/VText';
import { ApiError, getMomentPreview, momentPreviewKey, type MomentPreview } from '@/lib/api/sessions';
import { getProfileByUsername } from '@/lib/api/users';
import { authClient } from '@/lib/authClient';
import { WEB_BASE } from '@/lib/config';
import { joinByCode, joinErrorText } from '@/lib/joinByCode';
import { sessionWhen } from '@/lib/momentFormat';
import { parseVerreCode, type VerreCode } from '@/lib/scanCode';
import { feedHref, sessionHref, useSessionTab } from '@/lib/sessionStack';
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
// (`PersonPreview`, the card a person tapped inside a moment shows too), your
// own code, an unavailable one (an old integer QR included: `profile-legacy`,
// no request), or a moment's preview (ruled 2026-11-12: cover, name, the host
// (tappable), when, where; Join, or Open Moment when you're in it).
// `leaveTo` closes the host sheet, then pushes (a profile, the moment), on
// the caller's own stack (Moments has its own profile mount since 2026-11-15).
export function ScanResult({ result, meId, leaveTo }: { result: VerreCode; meId: string | null; leaveTo: (push: () => void) => void }) {
  const router = useRouter();
  const mount = useSessionTab();
  const queryClient = useQueryClient();
  const sessionName = authClient.useSession().data?.user.name;
  // A shared `/@name` link is resolved to its person first (usernames § 5),
  // then everything runs on the public id like a scanned QR. Never cached by
  // name (a name can change hands). Its answer seeds the id's header
  // (PersonPreview `seed`).
  const byName = result.kind === 'profile-username' ? result.username : null;
  const namedQ = useQuery({
    queryKey: ['profile-by-username', byName],
    queryFn: () => getProfileByUsername(byName!),
    enabled: byName != null,
    gcTime: 0,
  });
  const named = namedQ.data && namedQ.data.state !== 'gone' ? namedQ.data : null;
  const scannedId = result.kind === 'profile' ? result.id : named?.id ?? null;
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
  const openProfile = (id: string) => go(() => router.push(feedHref(mount, 'profile', { id })));
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
    if (previewQ.isPending) return <PreviewSpinner />;
    if (error instanceof ApiError && error.kind === 'not-found') return <PreviewMessage text="This code isn’t available." />;
    if (error instanceof ApiError && (error.kind === 'banned' || error.kind === 'rate-limited')) return <PreviewMessage text={joinErrorText(error)} />;
    if (error || !data) {
      return (
        <View style={{ gap: 14 }}>
          <PreviewMessage text="Couldn’t load this moment." />
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
  // An old QR (`/u/<digits>`, from before public ids): recognised, never looked up.
  if (result.kind === 'profile-legacy') return <PreviewMessage text="This code isn’t available." />;
  if (result.kind === 'profile-username') {
    if (namedQ.isPending) return <PreviewSpinner />;
    if (namedQ.isError || !namedQ.data) {
      return (
        <View style={{ gap: 14 }}>
          <PreviewMessage text="Couldn’t load this profile." />
          <Button title="Try Again" variant="secondary" block onPress={() => void namedQ.refetch()} />
        </View>
      );
    }
    // Renamed away, held or deleted: the link no longer names anyone.
    if (namedQ.data.state === 'gone') return <PreviewMessage text="This code isn’t available." />;
  }
  if (scannedId == null) return <PreviewMessage text="This code isn’t available." />;
  if (scannedId === meId) return <PreviewMessage text="This is your code." />;
  return <PersonPreview id={scannedId} leaveTo={go} goneText="This code isn’t available." seed={named} seedAt={namedQ.dataUpdatedAt} />;
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
              {/* From the preview itself (the one username a moment route sends). */}
              <UsernameLine username={preview.hostUsername} />
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
