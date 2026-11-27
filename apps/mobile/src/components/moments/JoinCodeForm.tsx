import { BottomSheetView } from '@gorhom/bottom-sheet';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { normalizeCode, formatCodeInput, validateCodeInput } from '@verre/core';
import { ScanResult, useVerreScanner } from '@/components/people/scan';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { VText } from '@/components/ui/VText';
import { GUTTER } from '@/lib/layout';
import { joinByCode, joinErrorText, notThisMomentText } from '@/lib/joinByCode';
import { ApiError, getMomentPreview } from '@/lib/api/sessions';
import { authClient } from '@/lib/authClient';
import { type VerreCode } from '@/lib/scanCode';
import { usePushGuard } from '@/lib/usePushGuard';
import { meIdOf } from '@/lib/meId';

// The join form (.sh-joinblock): the code field, Scan while it is empty, Join
// once it holds a code. Moved from the Moments home (app/(tabs)/moments/
// index.tsx, its `JoinBlock`) for a look-in's "Join with Code" (Moment
// Visibility step-2 plan § 4.4, R6). The caller decides where a join lands.
export function JoinCodeForm({ onJoined, resultLayer, scannedJoins, title, only }: {
  /** Where a successful join lands (the Moments home pushes the moment; a look-in replaces itself). */
  onJoined: (code: string) => void;
  /** A scanned moment opened from the scan result goes through `onJoined` too (a look-in). */
  scannedJoins?: boolean;
  /** Inside another sheet (a look-in's Join sheet): the scan result's sheet stacks above it. */
  resultLayer?: number;
  /** The sheet's title (default "Join a Moment"; a look-in: "Join <its name>"). */
  title?: string;
  /** A look-in: only THIS moment's code joins (asked of the preview first, which answers yes or no). */
  only?: { momentId: string; name: string };
}) {
  const queryClient = useQueryClient();
  const { data: auth } = authClient.useSession();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const code = normalizeCode(input);
  // A letter codes never use says so at once (device pass 2026-11-24: Join
  // just stayed grey); a code still being typed says nothing.
  const checked = validateCodeInput(input);
  const charHint = !checked.ok && checked.error === 'invalid-char' ? 'Codes don’t use the letters I, L, O or U.' : null;
  const insets = useSafeAreaInsets();
  const guard = usePushGuard();
  const meId = meIdOf(auth);

  // Scan (ruled 2026-11-12): the button while the field is empty; the
  // result is the same as Add Friends' (components/people/scan.tsx) in a
  // sheet. `scanned` is kept through the close animation; `scanSeq` gives
  // every scan a fresh result view.
  const [scanned, setScanned] = useState<VerreCode | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [scanSeq, setScanSeq] = useState(0);
  const { scan, launching } = useVerreScanner(true, (c) => {
    setScanned(c);
    setScanSeq((n) => n + 1);
    setSheetOpen(true);
  });
  const leaveTo = (push: () => void) =>
    guard(() => {
      setSheetOpen(false);
      push();
    });
  // Join keeps Scan's width, so the field doesn't jump on the first key.
  const [scanW, setScanW] = useState(0);

  const join = async () => {
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (only) {
        // An unknown code reads the same as another moment's.
        const same = await getMomentPreview(code, only.momentId).then(
          (p) => p.sameMoment === true,
          (e: unknown) => { if (e instanceof ApiError && e.kind === 'not-found') return false; throw e; },
        );
        if (!same) { setError(notThisMomentText(only.name)); return; }
      }
      // lib/joinByCode.ts (shared with Add Friends' scan): your name fresh
      // from the users row, then ['my-sessions'] invalidated.
      const joined = await joinByCode(queryClient, code, auth?.user.name);
      setInput('');
      onJoined(joined.code);
    } catch (e) {
      setError(joinErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    // .sh-joinblock: gap 10, margin-top 6
    <View style={{ paddingHorizontal: GUTTER, gap: 10, marginTop: 6 }}>
      {/* .sh-sheettitle */}
      <VText variant="subhead" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
        {title ?? 'Join a Moment'}
      </VText>
      <VText variant="small" color="inkSoft" style={{ marginTop: -4 }}>Enter the code your host shared.</VText>
      {/* .gs-codewrap: row, gap 8, stretch */}
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          {/* .gs-c: 15/600, 0.14em tracking, uppercase via formatCodeInput.
              Codes are alphanumeric (Crockford), so we want letters AND digits
              reachable. Android 'visible-password' shows a full QWERTY WITH the
              number row (and kills autocorrect/suggestions). iOS has no
              letters-plus-number-row keyboard type — 'ascii-capable' is the
              closest (letters; digits one tap away via the 123 key). */}
          <TextField
            surface="code"
            value={input}
            onChangeText={(t) => { setInput(formatCodeInput(t)); setError(null); }}
            // The example goes through the same formatter as the typed value, so
            // placeholder and input share separator and spacing (only the colour
            // differs). The handoff's "8H4K – Q2NP" did not match what typing produces.
            placeholder={formatCodeInput('8H4KQ2NP')}
            keyboardType={Platform.OS === 'android' ? 'visible-password' : 'ascii-capable'}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            returnKeyType="go"
            onSubmitEditing={join}
            style={{ fontFamily: 'InstrumentSans_600SemiBold', fontSize: 15, lineHeight: 18, letterSpacing: 2.1 }}
          />
        </View>
        {input === '' ? (
          <View onLayout={(e) => setScanW(e.nativeEvent.layout.width)}>
            {/* Filled, like Add Friends' (ruled 2026-11-12: the outlined
                secondary read as the old disabled Join). */}
            <Button title="Scan" icon="qr" iconSize={20} accessibilityLabel="Scan a QR Code" disabled={launching} onPress={() => void scan()} style={{ paddingHorizontal: 20 }} />
          </View>
        ) : (
          // Filled like Scan as soon as the code is complete (ruled 2026-11-15);
          // outlined and disabled while it isn't.
          <Button title="Join" loadingTitle="Joining…" variant={code ? 'primary' : 'secondary'} loading={busy} disabled={!code} onPress={join} style={{ paddingHorizontal: 20, minWidth: scanW || undefined }} />
        )}
      </View>
      {error || charHint ? <VText variant="caption" color="critical">{error ?? charHint}</VText> : null}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} {...(resultLayer != null ? { stackBehavior: 'push' as const, layer: resultLayer } : {})}>
        <BottomSheetView style={{ width: '100%', paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 16 }}>
          {scanned && meId != null ? <ScanResult key={scanSeq} result={scanned} meId={meId} leaveTo={leaveTo} onOpenMoment={scannedJoins ? onJoined : undefined} onlyMoment={only} /> : null}
        </BottomSheetView>
      </Sheet>
    </View>
  );
}
