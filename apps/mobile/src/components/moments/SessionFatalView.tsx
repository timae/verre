// Terminal session-screen states (gone / removed / banned / invalid / too many
// codes / network)
// — moved verbatim out of the line-up when Compare (02d) became the second
// screen that needs identical handling for the shared /state poll's fatal
// errors. Still a hand-rolled flex-center block: <CenteredMessage> has no
// button slot yet, so the pending migration noted in apps/mobile/CLAUDE.md
// stays open (extend CenteredMessage with a footer slot, then adopt it here).

import { View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { VText } from '@/components/ui/VText';
import { usePhoneTokens } from '@/lib/layout';
import { type ApiError } from '@/lib/api/sessions';

export function SessionFatalView({
  fatal, removedKind, sessionLabel, onRetry, onBack, copy,
}: {
  fatal: ApiError;
  removedKind: 'banned' | 'kicked' | null;
  sessionLabel: string | null;
  onRetry: () => void;
  onBack: () => void;
  /** A look-in's own words for its refusal (Moment Visibility § 4.4); the moment passes none. */
  copy?: { title: string; body: string };
}) {
  const phone = usePhoneTokens();
  let title = 'Something went wrong';
  let body = 'Try again in a moment.';
  if (fatal.kind === 'not-found') {
    // One neutral text whether or not this screen ever showed the moment
    // (Simon, 2026-11-10). App users are signed in, so every moment they open
    // is reopenable whatever its age: "ended" never applies to them.
    title = "This moment isn't available";
    body = 'It may have been deleted.';
  } else if (fatal.kind === 'removed') {
    if (removedKind === 'banned') {
      title = 'You have been banned from this moment';
      body = `The host${sessionLabel ? ` of ${sessionLabel}` : ''} banned you. Your ratings and notes from this moment have been removed.`;
    } else {
      title = 'You were removed';
      body = 'The host removed you from this moment. You can rejoin with the code.';
    }
  } else if (fatal.kind === 'rate-limited') {
    // Too many wrong codes from this account or network: a non-member can't
    // open moments for a while (the server's entrance gate). Its own copy
    // carries the wait; Try Again re-runs the visit.
    title = "Can't open this moment right now";
    body = fatal.message && fatal.message !== 'rate-limited' ? fatal.message : 'Too many codes tried. Try again later.';
  } else if (fatal.kind === 'invalid') {
    body = "We couldn't verify you in this moment. Try joining again with the code.";
    title = 'Not part of this moment';
  }
  if (copy) { title = copy.title; body = copy.body; }
  const retryable = fatal.kind === 'http' || fatal.kind === 'rate-limited';
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 }}>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('subhead'), textAlign: 'center' }}>{title}</VText>
      <VText color="inkSoft" style={{ textAlign: 'center', ...phone.text('small'), maxWidth: 280 }}>{body}</VText>
      {retryable ? <Button title="Try Again" onPress={onRetry} style={{ marginTop: 10 }} /> : null}
      {/* Plain "Back": this view is mounted on Moments, Feed, You and an
          opened post's stack, so it can't name where back lands. */}
      <Button title="Back" variant="secondary" onPress={onBack} style={{ marginTop: retryable ? 0 : 10 }} />
    </View>
  );
}
