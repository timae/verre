import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from '../apiFetch';
import { dropUnmountedFeedCaches, refetchFeedCaches } from '../feedCache';
import { viewerCacheEpoch } from '../query';
import { getMyAccount, type MyAccount } from './me';
import { throwApiError } from './sessions';
import { profileKey, type FullProfile, type Profile, type ProfileTile } from './users';

// Own-profile writes (the You profile, step 2) + the cache merges after them.
// Wire shapes MIRROR app/api/me/profile/route.ts, app/api/me/profile/photos,
// app/api/me/avatar and app/api/me/cover — keep in sync by hand.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export type TileKey = 'impressions' | 'moments' | 'cravings';
export type TilePhoto = { imageUrl: string | null; pinned: boolean };
export type ProfilePatch = {
  name?: string;
  bio?: string | null;
  // url = pin that photo (must be in the tile's pickable pool), null = back to
  // the automatic latest.
  tiles?: Partial<Record<TileKey, string | null>>;
};
// Only the fields that changed come back; the client merges them.
export type ProfilePatchResult = { name?: string; bio?: string | null; tiles?: Partial<Record<TileKey, TilePhoto>> };

export async function patchProfile(body: ProfilePatch): Promise<ProfilePatchResult> {
  const res = await apiFetch('/api/me/profile', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// The profile photo + the profile cover: device photos only (ruling D2), sent
// as a fitted data URL. Replacing reclaims the previous upload server-side.
export async function uploadAvatar(dataUrl: string): Promise<string> {
  const res = await apiFetch('/api/me/avatar', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ imageData: dataUrl }) });
  if (!res.ok) await throwApiError(res);
  return (await res.json()).imageUrl as string;
}
export async function removeAvatar(): Promise<void> {
  const res = await apiFetch('/api/me/avatar', { method: 'DELETE' });
  if (!res.ok) await throwApiError(res);
}
export async function uploadCover(dataUrl: string): Promise<string> {
  const res = await apiFetch('/api/me/cover', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ imageData: dataUrl }) });
  if (!res.ok) await throwApiError(res);
  return (await res.json()).coverPhotoUrl as string;
}
export async function removeCover(): Promise<void> {
  const res = await apiFetch('/api/me/cover', { method: 'DELETE' });
  if (!res.ok) await throwApiError(res);
}

// The tile cover picker: the latest ≤ 60 pickable photos of one tile, the
// current pin first while it is still pickable (`pin`, else null).
export async function getTilePhotos(pool: TileKey): Promise<{ photos: string[]; pin: string | null }> {
  const res = await apiFetch(`/api/me/profile/photos?pool=${pool}`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// What a write changed, merged into your own `['user-profile', me]` entry.
export type OwnProfileChange = Partial<Pick<FullProfile, 'name' | 'bio' | 'imageUrl' | 'coverPhotoUrl'>> & {
  tiles?: Partial<Record<TileKey, TilePhoto>>;
};

// After a successful own-profile write: a typed MERGE into the `ok` entry (the
// in-flight read cancelled first, so a pre-write response can't land over
// it), then an in-place refetch. A rename also refreshes the own-account
// query (create / join read your name from it: Better Auth's session copy
// stays stale after a rename that isn't BA's own). A name or photo change
// touches every post you authored: the mounted feeds refetch IN PLACE and
// the unmounted ones are dropped (never invalidate a feed cache,
// lib/feedCache.ts). 🔒 `epoch` = the viewer epoch captured BEFORE the write
// was sent (lib/query.tsx): if the viewer changed while it was in flight (a
// sign-out + another account), nothing of the previous viewer's lands in the
// new viewer's caches. Checked again after every await here.
export async function applyOwnProfileChange(queryClient: QueryClient, userId: number, change: OwnProfileChange, epoch: number): Promise<void> {
  if (viewerCacheEpoch() !== epoch) return;
  const key = profileKey(userId);
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  if (viewerCacheEpoch() !== epoch) return;
  queryClient.setQueryData<Profile>(key, (p) => {
    if (!p || p.state !== 'ok') return p;
    const { tiles, ...rest } = change;
    const next: FullProfile = { ...p, ...rest };
    if (tiles) {
      next.tiles = { ...p.tiles };
      for (const [k, t] of Object.entries(tiles) as [TileKey, TilePhoto][]) {
        next.tiles[k] = { ...p.tiles[k], imageUrl: t.imageUrl, pinned: t.pinned } satisfies ProfileTile;
      }
    }
    return next;
  });
  if (change.name !== undefined) {
    queryClient.setQueryData<MyAccount>(['my-account'], (a) => (a ? { ...a, name: change.name ?? a.name } : a));
  }
  const jobs: Promise<unknown>[] = [queryClient.refetchQueries({ queryKey: key, exact: true })];
  if (change.name !== undefined) jobs.push(queryClient.refetchQueries({ queryKey: ['my-account'], exact: true }));
  if (change.name !== undefined || change.imageUrl !== undefined) {
    dropUnmountedFeedCaches(queryClient);
    jobs.push(refetchFeedCaches(queryClient));
  }
  await Promise.allSettled(jobs);
}

// Your own display name, fresh from the users row (GET /api/me/account), for
// the two places the app SENDS it (moment create, join). Better Auth serves
// `useSession().data.user.name` from its session copy, which a rename through
// our routes never refreshes. Falls back to that copy only when offline.
export async function freshOwnName(queryClient: QueryClient, fallback: string | null | undefined): Promise<string | null> {
  const acct = await queryClient
    .fetchQuery({ queryKey: ['my-account'], queryFn: getMyAccount, staleTime: 0 })
    .catch(() => null);
  return acct?.name ?? fallback ?? null;
}
