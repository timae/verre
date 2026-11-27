import { apiFetch } from '../apiFetch';
import { throwApiError } from './sessions';
import type { Audience } from '../momentVisibilityCopy';

// Your Moment Defaults (docs/dev/proposals/moment-defaults.md): the page under
// Settings → Privacy, the Create Moment Privacy row's starting values, and the
// check-in switch's preset. COPIED by the server when you create or join a
// moment or check in; changing one changes nothing that exists (only the
// alert's "All N …" does, through the apply).
export type MomentDefaults = {
  visibility: Audience;
  includeGuestCircles: boolean;
  showPlace: boolean;
  showDetails: boolean;
  onlyInside: boolean;
  momentHiddenFromFeed: boolean;
  checkinHiddenFromFeed: boolean;
};
export type MomentDefaultField = keyof MomentDefaults;
// What differs among your moments / check-ins for that field (counts by
// direction, D2), or null when nothing does.
export type DefaultsPreview = { field: MomentDefaultField; value: Audience | boolean; count: number; wider: number; narrower: number };

export const MOMENT_DEFAULTS_KEY = ['moment-defaults'] as const;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function getMomentDefaults(): Promise<MomentDefaults> {
  const res = await apiFetch('/api/me/moment-defaults');
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// ONE field per save (the page saves on change).
export async function patchMomentDefault<F extends MomentDefaultField>(field: F, value: MomentDefaults[F]): Promise<{ defaults: MomentDefaults; existing: DefaultsPreview | null }> {
  const res = await apiFetch('/api/me/moment-defaults', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ [field]: value }) });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// The STORED default applied to whatever differs now (not bound to the
// preview: ruled). A 429 means the widening part was refused AFTER the
// narrowing part applied: the caller refreshes either way.
export async function applyMomentDefault(field: MomentDefaultField): Promise<{ changed: number }> {
  const res = await apiFetch('/api/me/moment-defaults/apply', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ field }), timeoutMs: 60_000 });
  if (!res.ok) await throwApiError(res);
  return res.json();
}
