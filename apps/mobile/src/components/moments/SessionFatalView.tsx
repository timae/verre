// Terminal session-screen states (gone / removed / banned / invalid / network)
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
  fatal, removedKind, sessionLabel, onRetry, onBack,
}: {
  fatal: ApiError;
  removedKind: 'banned' | 'kicked' | null;
  sessionLabel: string | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  const phone = usePhoneTokens();
  let title = 'Something went wrong';
  let body = 'Try again in a moment.';
  if (fatal.kind === 'not-found') {
    title = 'This moment has ended';
    body = 'The session is no longer live.';
  } else if (fatal.kind === 'removed') {
    if (removedKind === 'banned') {
      title = 'You have been banned from this session';
      body = `The host${sessionLabel ? ` of ${sessionLabel}` : ''} banned you. Your ratings and notes from this session have been removed.`;
    } else {
      title = 'You were removed';
      body = 'The host removed you from this moment. You can rejoin with the code.';
    }
  } else if (fatal.kind === 'invalid') {
    body = "We couldn't verify you in this moment. Try joining again with the code.";
    title = 'Not part of this moment';
  }
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 }}>
      <VText style={{ fontFamily: 'InstrumentSans_600SemiBold', ...phone.text('subhead'), textAlign: 'center' }}>{title}</VText>
      <VText color="inkSoft" style={{ textAlign: 'center', ...phone.text('small'), maxWidth: 280 }}>{body}</VText>
      {fatal.kind === 'http' ? <Button title="Try Again" onPress={onRetry} style={{ marginTop: 10 }} /> : null}
      <Button title="Back to Moments" variant="secondary" onPress={onBack} style={{ marginTop: fatal.kind === 'http' ? 0 : 10 }} />
    </View>
  );
}
