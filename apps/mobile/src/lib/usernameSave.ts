import type { QueryClient } from '@tanstack/react-query';
import { applyOwnProfileChange } from '@/lib/api/profile';
import { USERNAME_KEY, UsernameError, putUsername, type UsernameState } from '@/lib/api/username';
import { errorText, sentence } from '@/lib/errorCopy';
import { viewerCacheEpoch } from '@/lib/query';
import { RESERVED_TEXT, TAKEN_TEXT, changeAgainText } from '@/lib/usernameCopy';

// THE username change, for Edit Profile and the profile's in-place edit: the
// PUT, then the caches that show it. A refusal comes back as the line to
// show: `field` = about the name typed (taken, reserved, a broken rule; it
// blocks a save until the text changes), `locked` = none left after all (the
// refusal is the authority, so the cached state locks NOW whatever the re-read
// does; the caller drops its draft), `other` = it didn't get through.
// 🔒 `null` = the viewer changed while it ran: show nothing, a refusal for one
// account must not lock the next. The caller refetches Better Auth's session
// on success (its copy carries the username).
export type UsernameSaveOutcome = { ok: true } | { ok: false; kind: 'field' | 'locked' | 'other'; message: string };

export async function saveUsername(
  queryClient: QueryClient,
  userId: string,
  username: string,
  { epoch, current, locale }: { epoch: number; current: string | null; locale: string },
): Promise<UsernameSaveOutcome | null> {
  try {
    const state = await putUsername(username);
    if (viewerCacheEpoch() !== epoch) return null;
    queryClient.setQueryData<UsernameState>(USERNAME_KEY, state);
    await applyOwnProfileChange(queryClient, userId, { username: state.username }, epoch);
    return { ok: true };
  } catch (e) {
    if (viewerCacheEpoch() !== epoch) return null;
    if (!(e instanceof UsernameError) || e.code == null) return { ok: false, kind: 'other', message: `Couldn’t save your username. ${errorText(e)}` };
    if (e.code === 'taken') return { ok: false, kind: 'field', message: TAKEN_TEXT };
    if (e.code === 'reserved') return { ok: false, kind: 'field', message: RESERVED_TEXT };
    if (e.code === 'invalid') return { ok: false, kind: 'field', message: sentence(e.message) };
    const nextChangeAt = e.nextChangeAt;
    queryClient.setQueryData<UsernameState>(USERNAME_KEY, (s) => ({ ...(s ?? { username: current, previous: null }), changesLeft: 0, nextChangeAt }));
    void queryClient.refetchQueries({ queryKey: USERNAME_KEY, exact: true });
    return { ok: false, kind: 'locked', message: changeAgainText(nextChangeAt, locale) };
  }
}
