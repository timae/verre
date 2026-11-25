import { apiFetch } from '../apiFetch';
import { lookInHeaders, lookInPath } from '../lookInLinks';
import { throwApiError } from './sessions';

// Moment Visibility (step-2 plan § 4.2): the five routes the app calls. Wire
// types MIRROR lib/momentLookIn.ts + lib/momentSettings.ts: keep in sync by
// hand. Everything is dark behind the server's MOMENT_LOOKIN_ENABLED; while it
// is off every one of these answers 404.
//
// 🔒 No note and no rating photo ever reaches a look-in (R15).
// 🔒 A look-in link's token travels ONLY as the `X-Verre-Link` header, never a
// query string, a route param or a cache key (lib/lookInLinks.ts holds it).
// Errors: ApiError (lib/api/sessions.ts): 404 'not-found' (the look-in's one
// refusal: the screen picks the words by how it was opened), 429
// 'rate-limited', 401 'http' with status 401 (signed out).

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export type {
  LookIn, LookInAroma, LookInAromaRating, LookInBlindBottle, LookInBottle, LookInDetails, LookInLightRating, LookInMember,
  LookInMoment, LookInOpenBottle, LookInPerson,
} from '../lookInWire';
import type { LookIn, LookInDetails, LookInMember } from '../lookInWire';

async function lookInGet<T>(path: string, link?: string | null, signal?: AbortSignal): Promise<T | LookInMember> {
  const res = await apiFetch(path, { headers: lookInHeaders(link), signal });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// GET /api/moments/:publicId — the first read.
export function getLookIn(momentId: string, link?: string | null, signal?: AbortSignal): Promise<LookIn | LookInMember> {
  return lookInGet<LookIn>(lookInPath(momentId), link, signal);
}

// GET /api/moments/:publicId?bottles=<key>,… — the details read: the open
// Compare cards' aromas (1 to 30 keys; the scheduler sends at most 10,
// lib/lookInDetails.ts).
export function getLookInDetails(momentId: string, keys: string[], link?: string | null, signal?: AbortSignal): Promise<LookInDetails | LookInMember> {
  return lookInGet<LookInDetails>(lookInPath(momentId, keys), link, signal);
}

// GET /api/me/sessions/by-moment/:publicId — the one route of the feature that
// answers a code, and only to the moment's own members (a look-in that answered
// `{ member: true }`). Anything else: the look-in's 404.
export async function getMomentMembership(momentId: string): Promise<{ id: number; code: string }> {
  const res = await apiFetch(`/api/me/sessions/by-moment/${encodeURIComponent(momentId)}`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// ── The setting (host and cohosts write; every participant reads) ─────────

export type MomentAudience = 'members' | 'friends' | 'followers' | 'verre';
export type MomentVisibilityView = {
  visibility: MomentAudience;
  includeGuestCircles: boolean;
  showPlace: boolean;
  showDetails: boolean;
  frozen: boolean; // no signed-in host: can only be narrowed
  canEdit: boolean; // host or cohost, signed in
  // Host and cohosts only. `url` / `since` only while the link is active.
  link?: { available: boolean; active: boolean; url: string | null; since: string | null };
  // Your own choices here (step 3): `onlyInside` = Incognito (R11);
  // `hiddenFromFeed` = Hide from Feed for your post of it (R12; signed in, and
  // only with the server's HIDE_FROM_FEED_ENABLED: absent = no switch). null =
  // the moment has no record. On EVERY answer of this shape.
  // `sessionId`: the moment's id, signed in only (the key your posts of it
  // carry in the feed; Codex recheck 2026-11-25).
  me: { onlyInside: boolean; hiddenFromFeed?: boolean; sessionId?: number } | null;
};
export type MomentChoice = 'onlyInside' | 'hiddenFromFeed';
export type MomentVisibilityPatch = Partial<Pick<MomentVisibilityView, 'visibility' | 'includeGuestCircles' | 'showPlace' | 'showDetails'>>;
export const momentVisibilityKey = (code: string) => ['moment-visibility', code] as const;

// 404 = the feature is off (never "moment gone": the moment's own polls say
// that), step-2 plan T10.
export async function getMomentVisibility(code: string): Promise<MomentVisibilityView> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/visibility`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function updateMomentVisibility(code: string, patch: MomentVisibilityPatch): Promise<MomentVisibilityView> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/visibility`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch) });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// One of your own choices (PATCH /api/session/:code/me/privacy): anyone in
// the moment. The answer echoes the field only: merged into the page's `me`,
// never a replacement of its copy.
export async function updateMyMomentPrivacy(code: string, field: MomentChoice, on: boolean): Promise<boolean> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/me/privacy`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ [field]: on }) });
  if (!res.ok) await throwApiError(res);
  return ((await res.json()) as Record<string, unknown>)[field] === true;
}

export async function lookInLinkAction(code: string, action: 'share' | 'off' | 'reset'): Promise<MomentVisibilityView> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/look-in-link`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action }) });
  if (!res.ok) await throwApiError(res);
  return res.json();
}
