import type { QueryClient } from '@tanstack/react-query';
import { freshOwnName } from '@/lib/api/profile';
import { ApiError, joinMoment } from '@/lib/api/sessions';

// Join a moment by its code: the Moments home join block and an in-app scan
// of a moment's QR (Add Friends → Scan). Its own module, not lib/api/sessions:
// lib/api/profile.ts imports that one, so freshOwnName from there would cycle.
// Sends your name fresh from the users row, not Better Auth's session copy
// (stale after a rename; lib/api/profile.ts freshOwnName). The caller pushes
// the moment (`code` = the server's canonical form).
export async function joinByCode(queryClient: QueryClient, code: string, fallbackName: string | null | undefined): Promise<{ code: string }> {
  const joined = await joinMoment(code, (await freshOwnName(queryClient, fallbackName)) ?? '');
  queryClient.invalidateQueries({ queryKey: ['my-sessions'] });
  return joined;
}

// The join's failure copy (the join block's line, the scan result's alert).
export function joinErrorText(e: unknown): string {
  if (e instanceof ApiError && e.kind === 'not-found') return 'No moment found for that code.';
  if (e instanceof ApiError && e.kind === 'banned') return "You can't join this moment.";
  if (e instanceof ApiError && e.kind === 'rate-limited') return e.message || 'Too many attempts. Try again soon.';
  return 'Something went wrong. Try again.';
}
