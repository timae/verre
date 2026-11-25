import { apiFetch } from '../apiFetch';

// Typed fetchers for the session surfaces. Wire types mirror the server
// builders (lib/sessionState.ts, lib/session.ts wineToWire) — keep in sync.

export type SessionRole = 'host' | 'cohost' | 'provider' | null;

// Carousel-card chip, computed server-side. null ⟺ not pinned. 'now' = live +
// started, 'soon' = pinned but not yet started, 'visited' = recently opened.
// Hand-mirrored from CarouselLabel in app/api/me/sessions/route.ts (web↔native
// wire-type convention) — keep in sync. See docs/dev/moments-home.md.
export type CarouselLabel = 'now' | 'soon' | 'visited' | null;

export type MySessionRow = {
  id: number;
  code: string;
  host_name: string;
  name: string | null;
  created_at: string;
  joined_at: string;
  wines_rated: number;
  avg_score: number | null;
  date_from: string | null;
  date_to: string | null;
  address: string | null;
  wine_count: number;
  ttl_seconds: number;
  lifespan: string | null;
  taster_count: number | null;
  // Session category ('wine' in v1; NULL on rows predating the column — treat
  // as 'wine', the only thing they could be). Widens with future category sets.
  category: string | null;
  // Everyone who was part of the moment (minus the viewer + block pairs;
  // live identities ∪ durable members). Names are presentation-only.
  people: { id: string; name: string }[];
  role: SessionRole;
  // Server-computed Moments-home routing — full model in docs/dev/moments-home.md.
  // `status` drives the LISTS (Upcoming = `=== 'upcoming'`, Recent = the rest);
  // `pinned` drives the CAROUSEL, independent of status (the two overlap);
  // `carouselLabel` is the strip card's chip (null ⟺ !pinned). All three are
  // server-authoritative — the client renders them verbatim, never recomputes.
  status: 'live' | 'upcoming' | 'past';
  pinned: boolean;
  carouselLabel: CarouselLabel;
  cover_photo_url: string | null;
};

export const isUpcomingSession = (r: MySessionRow) => r.status === 'upcoming';
// Carousel membership — the `pinned` signal, NOT `status` (an upcoming moment
// can be pinned). Use this for the highlight strip.
export const isPinnedSession = (r: MySessionRow) => r.pinned;

// The catalogue wine a bottle is linked to (lib/catalogEntries.ts
// CatalogEntry, merges followed). 🔒 Label identity: `null` on a blind row,
// which the server replaces wholesale.
export type CatalogEntryWire = {
  productId: string;
  vintageId: string | null;
  producerId: string;
  producer: string;
  name: string;
  year: number | null;
  category: string;
  colour: string | null;
  sparkling: boolean;
  style: string | null;
  abv: number | null;
  grapes: string[];
  region: string | null;
  country: string | null;
  description: string | null;
  vinification: string | null;
};

// One bottle of the line-up (lib/session.ts wineToWire, the catalogue model
// change): its own fields (name / producer / vintage are its snapshot of the
// entry; About, Process and the purchase link are the bottle's own), the kind
// as `colour` + `sparkling` (the axes read `sparkling`), the abv, and `entry`.
// A blind row: `entry` null, `abv` null, no name; colour and sparkling stay.
export type WireWine = {
  id: string;
  name: string;
  producer: string;
  vintage: string;
  grape: string;
  image: string;
  imageUrl: string;
  description?: string;
  region?: string;
  country?: string;
  vinification?: string;
  purchaseUrl?: string;
  revealedAt?: string | null;
  colour: string | null;
  sparkling: boolean;
  abv: number | null;
  entry: CatalogEntryWire | null;
  isMine: boolean;
  addedByDisplayName: string | null;
  // The adder's PUBLIC id (opaque string), null for an anonymous adder.
  addedByUserId: string | null;
  _blind?: boolean;
  // The signed-in viewer's save (lib/cravings.ts savedFlags): on a row hidden
  // for them only their save of THAT bottle, never whether they crave the wine.
  saved?: boolean;
};

export type SessionParticipant = { id: string; displayName: string; imageUrl: string | null };

export type SessionMetaView = {
  code: string;
  host: string;
  name: string;
  createdAt: number;
  // Every user id in meta is PUBLIC: hostUserId a public id, the identity
  // lists (hostIdentityId, coHostIds, providerIds) `u:<publicId>` / `a:<uuid>`.
  hostUserId: string | null;
  hostIdentityId?: string;
  blind?: boolean;
  blindForEveryone?: boolean;
  // "Show who brought each impression". Default ON: absent or true → shown;
  // false → the host turned it off (server nulls addedBy* off the wire).
  showProvenance?: boolean;
  lifespan?: string;
  coHostIds?: string[];
  providerIds?: string[];
  address?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  timezone?: string;
  description?: string;
  link?: string;
  hideLineup?: boolean;
  hideLineupMinutesBefore?: number;
  // From the server SessionMeta (lib/session.ts) through metaToWire's
  // allow-list (lib/sessionState.ts): present whenever the host set a cover. Used by the 02f
  // Moment-details settings sheet to preview/replace/remove the cover.
  coverPhotoUrl?: string;
  participants: SessionParticipant[];
  ttlSeconds: number;
  viewerBlocksOut: string[];
  viewerBlocksIn: string[];
  banCount: number;
};

// `aromas` (PR A, aroma-layer.md §4): {a: nodeId, m: modifierId|null} pairs
// against the @verre/core taxonomy. The node may sit at ANY tier (leaf
// "strawberry", subfamily "fruity.berry", family "fruity" — any-tier ruling
// 2026-07-08); resolve via core's getAromaNode. Optional on the wire —
// ratings written before the column shipped simply lack the key. `p` =
// pronounced flag (the note that led the impression), present only when true.
export type RatingMeta = {
  score: number;
  flavors: Record<string, number>;
  aromas?: { a: string; m: string | null; p?: boolean }[];
  // A look-in's light rating (Moment Visibility, lib/lookInCompare.ts): it has
  // aromas, which arrive with the details read. Never on a moment's own rating.
  hasAromas?: true;
  notes: string;
  at: number;
};
export type RatingsView = Record<string, { displayName: string; ratings: Record<string, RatingMeta> }>;

export type SessionState = {
  meta: SessionMetaView | null;
  wines: WireWine[] | null;
  ratings: RatingsView | null;
};

export type ApiErrorKind =
  | 'not-found' // 404 — session gone, go home
  | 'removed' // X-Vr-Auth: removed — kicked/banned by the host
  | 'invalid' // X-Vr-Auth: invalid — identity didn't resolve, rejoin
  | 'banned' // join refused (403 { error: 'banned' })
  | 'rate-limited' // 429 — body carries a human wait message
  | 'http'; // anything else

export class ApiError extends Error {
  kind: ApiErrorKind;
  status: number;
  constructor(kind: ApiErrorKind, status: number, message?: string) {
    super(message ?? kind);
    this.kind = kind;
    this.status = status;
  }
}

async function bodyError(res: Response): Promise<string | undefined> {
  try {
    const j = await res.json();
    return typeof j?.error === 'string' ? j.error : undefined;
  } catch {
    return undefined;
  }
}

export async function throwApiError(res: Response): Promise<never> {
  const vrAuth = res.headers.get('X-Vr-Auth');
  if (vrAuth === 'removed') throw new ApiError('removed', res.status);
  if (vrAuth === 'invalid') throw new ApiError('invalid', res.status);
  const msg = await bodyError(res);
  if (res.status === 404) throw new ApiError('not-found', 404, msg);
  if (res.status === 429) throw new ApiError('rate-limited', 429, msg);
  if (res.status === 403 && msg === 'banned') throw new ApiError('banned', 403, msg);
  throw new ApiError('http', res.status, msg);
}

// Home screen (index.tsx) — the UNFILTERED recent page + carousel. No params =
// the server's 50 most-recently-active rows, activity-sorted for the carousel.
// `upcomingTotal`/`recentTotal` are the TRUE full-history bucket counts (from
// response headers), so the home nav rows gate on real totals — not the capped
// 50-row page (a user whose only upcoming moment is older than their 50 most
// recent would otherwise see no Upcoming row and couldn't reach the list).
export type MySessionsResult = {
  rows: MySessionRow[];
  upcomingTotal: number;
  recentTotal: number;
};

export async function getMySessions(): Promise<MySessionsResult> {
  const res = await apiFetch('/api/me/sessions');
  if (!res.ok) await throwApiError(res);
  const rows = (await res.json()) as MySessionRow[];
  // Fall back to the page-derived count if a header is absent (older server) —
  // never worse than the pre-header behavior.
  const upNum = Number(res.headers.get('X-Upcoming-Total'));
  const reNum = Number(res.headers.get('X-Recent-Total'));
  const pageUpcoming = rows.filter((r) => r.status === 'upcoming').length;
  const upcomingTotal = Number.isFinite(upNum) && res.headers.get('X-Upcoming-Total') !== null ? upNum : pageUpcoming;
  const recentTotal = Number.isFinite(reNum) && res.headers.get('X-Recent-Total') !== null ? reNum : rows.length - pageUpcoming;
  return { rows, upcomingTotal, recentTotal };
}

// The ONE definition of the home my-sessions query — consumed by the Moments
// tab AND useEnterableMoment (feed). Both observers must attach with the same
// key/staleTime for the shared cache to work, so the definition lives here.
// Sub-key invalidations still match: invalidateQueries({queryKey:
// ['my-sessions']}) is a prefix match.
export function mySessionsQueryOptions() {
  return { queryKey: ['my-sessions'] as const, queryFn: getMySessions, staleTime: 15_000 };
}

// Server-side filtered + paginated moments (recents.tsx). The server owns
// search/facets/order (moments-server-filtering.md Part B); the client passes
// the query + filter params and pages on the opaque cursor. `tense` picks the
// list: 'upcoming' (future-start, soonest-first) vs 'past' (everything else,
// newest-first); OMITTED = both, newest first (your Moments list, lists plan
// D10: pass `limit` then, since a request with no param at all is the legacy
// 50-row carousel read). Roles/hosts/people are comma-joined multi-selects.
export type MomentQuery = {
  tense?: 'upcoming' | 'past';
  q?: string;
  roles?: string[];
  hosts?: string[];
  people?: string[];
  category?: string; // 'wine' | undefined (any)
  from?: string | null; // YYYY-MM-DD inclusive
  to?: string | null;
  cursor?: string | null;
  limit?: number;
};

export type MomentPage = { rows: MySessionRow[]; nextCursor: string | null };

export async function getMomentsPage(query: MomentQuery): Promise<MomentPage> {
  const p = new URLSearchParams();
  if (query.tense) p.set('tense', query.tense);
  if (query.q?.trim()) p.set('q', query.q.trim());
  if (query.roles?.length) p.set('roles', query.roles.join(','));
  if (query.hosts?.length) p.set('hosts', query.hosts.join(','));
  if (query.people?.length) p.set('people', query.people.join(','));
  if (query.category && query.category !== 'any') p.set('category', query.category);
  if (query.from) p.set('from', query.from);
  if (query.to) p.set('to', query.to);
  if (query.cursor) p.set('cursor', query.cursor);
  if (query.limit) p.set('limit', String(query.limit));
  const res = await apiFetch(`/api/me/sessions?${p.toString()}`);
  if (!res.ok) await throwApiError(res);
  const rows = (await res.json()) as MySessionRow[];
  return { rows, nextCursor: res.headers.get('X-Next-Cursor') };
}

export async function getSessionState(code: string): Promise<SessionState> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/state`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// Registers a logged-in visitor in the session's identities map — MUST run
// (and succeed) before the first /state poll, which 401s for non-participants.
export async function postVisit(code: string): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/visit`, { method: 'POST' });
  if (!res.ok) await throwApiError(res);
}

// Distinguishes kicked (can rejoin by code) from banned (cannot) after a
// removed bounce — same endpoint the web RemovedView uses.
export async function getRemovedState(code: string): Promise<'banned' | 'kicked' | 'none'> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/removed-state`);
  if (!res.ok) return 'none';
  const j = await res.json().catch(() => null);
  return j?.state === 'banned' || j?.state === 'kicked' ? j.state : 'none';
}

export type RateBody = {
  wineId: string;
  score: number; // 0..5 in 0.25 steps; 0 = not rated
  // 0..5 integer intensities. Structure-wheel zero rule (§5): once ANY axis is
  // rated, the rest persist as explicit 0 ("perceived none"); if EVERY axis is
  // None the whole map is empty ({}). So a non-empty map carries zeros — do NOT
  // assume "zeros omitted" (the pre-structure-wheel contract). The server's
  // validateFlavors enforces this drop-all-or-keep-all shape.
  flavors: Record<string, number>;
  // Aroma selections. PRESENT-REPLACES / OMITTED-PRESERVES on the server:
  // leave the field off to keep whatever is stored; send [] to clear.
  aromas?: { a: string; m: string | null; p?: boolean }[];
  notes: string;
};

// Upserts the caller's rating. Server side-effects (no client work):
// Postgres archival, the feed_item on first engagement, and the
// engagement-deletion cascade when score+flavors+aromas+notes are all
// empty — so "clear my rating" is just an empty rate POST (an OMITTED
// aromas field preserves stored aromas, which then keep the row alive).
export async function rateWine(code: string, body: RateBody): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/rate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
}

// Save / unsave a bottle of the moment (signed-in participant) → the new
// state. A refusal carries the server's sentence (409 "This bottle isn't in
// the catalogue yet", 429 "Too many saves. Try again in …").
export async function setBookmark(code: string, wineId: string, on: boolean): Promise<{ saved: boolean }> {
  const res = await apiFetch(
    `/api/session/${encodeURIComponent(code)}/wines/${encodeURIComponent(wineId)}/bookmark`,
    { method: on ? 'POST' : 'DELETE' },
  );
  if (!res.ok) await throwApiError(res);
  const j = (await res.json().catch(() => null)) as { saved?: boolean } | null;
  return { saved: typeof j?.saved === 'boolean' ? j.saved : on };
}

export type CreateMomentBody = {
  hostDisplayName: string;
  sessionName: string; // required (Simon, 2026-07-06) — server rejects an empty name
  category?: 'wine'; // v1 allow-list — widens with future category sets
  coverPhoto?: string; // base64 data URL; server runs the hardened image pipeline
  dateFrom: string; // required — a moment always has a start date; server rejects absence
  dateTo?: string;
  timezone?: string;
  hideLineup?: boolean;
  hideLineupMinutesBefore?: number;
  address?: string;
  description?: string;
  link?: string;
  blind?: boolean; // pro-gated server-side
  // Moment Defaults (D4, ruled 2026-11-25): the six values the Privacy row
  // showed, all sent (a field absent = your default at the time of the create,
  // the server's rule for a client that sends none).
  privacy?: { visibility: 'members' | 'friends' | 'followers' | 'verre'; includeGuestCircles: boolean; showPlace: boolean; showDetails: boolean; onlyInside: boolean; hiddenFromFeed: boolean };
  // No lifespan: every logged-in create is 'unlimited' server-side (a body
  // lifespan is ignored; root CLAUDE.md § Freemium split).
};

export async function createMoment(body: CreateMomentBody): Promise<{ code: string }> {
  const res = await apiFetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// 02b·add add-impression, on the catalogue (ADR-0009). Host / cohost /
// provider. Every bottle is a catalogue wine: `productId` + `vintageId` picks
// one, `create` adds one with the bottle (lib/catalogChoice.ts linkBody).
// `id` is the client's (lib/clientId.ts), minted once per add screen: a retry
// of the same id answers `{ id, alreadyAdded: true }`, someone else's id is a
// 409. The photo is its own call after the add (putWineImage). `position`
// (1-indexed) is honoured for hosts only.
export type AddWineBody = {
  id: string;
  productId?: string;
  vintageId?: string | null;
  create?: Record<string, unknown>;
  description?: string;
  vinification?: string; // design "Process"
  purchaseUrl?: string;
  position?: number;
};

// An edit: a link (`productId` / `vintageId` or `create`) re-links, the three
// own fields change only what is sent (an empty string clears). The photo has
// its own call.
export type UpdateWineBody = Omit<AddWineBody, 'id' | 'position'>;

export async function addWine(code: string, body: AddWineBody): Promise<{ id: string; alreadyAdded?: boolean }> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/wines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function updateWine(code: string, wineId: string, body: UpdateWineBody): Promise<void> {
  const res = await apiFetch(
    `/api/session/${encodeURIComponent(code)}/wines/${encodeURIComponent(wineId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) await throwApiError(res);
}

// A bottle's photo, its own call (README: PUT / DELETE …/wines/:id/image):
// a data URL under MAX_WINE_IMAGE_BYTES replaces it, DELETE removes it.
export async function putWineImage(code: string, wineId: string, image: string): Promise<void> {
  const res = await apiFetch(
    `/api/session/${encodeURIComponent(code)}/wines/${encodeURIComponent(wineId)}/image`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) },
  );
  if (!res.ok) await throwApiError(res);
}
export async function deleteWineImage(code: string, wineId: string): Promise<void> {
  const res = await apiFetch(
    `/api/session/${encodeURIComponent(code)}/wines/${encodeURIComponent(wineId)}/image`,
    { method: 'DELETE' },
  );
  if (!res.ok) await throwApiError(res);
}

// Reassign "Brought by" (host/cohost only) — an OWNERSHIP-ONLY request, sent
// SEPARATELY from field/image edits (the server rejects a mix). The reassign is
// idempotent, so on a transient failure we RETRY ONCE: the retry either
// completes the change or repairs a Redis/PG split from the first attempt.
// One retry, then surface an honest failure — never background-retry.
export async function reassignBroughtBy(code: string, wineId: string, identityId: string): Promise<WireWine> {
  const send = () => apiFetch(
    `/api/session/${encodeURIComponent(code)}/wines/${encodeURIComponent(wineId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ broughtByIdentityId: identityId }),
    },
  );
  let res = await send();
  // Retry once on a server-side failure (5xx) — a 4xx (bad target, not host,
  // provenance hidden) is deterministic and won't change on retry, so don't.
  if (!res.ok && res.status >= 500) res = await send();
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function deleteWine(code: string, wineId: string): Promise<void> {
  const res = await apiFetch(
    `/api/session/${encodeURIComponent(code)}/wines/${encodeURIComponent(wineId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) await throwApiError(res);
}

// Blind reveal/hide (host/cohost-gated server-side; providers can't reveal).
// On a blind session a wine is hidden from guests until revealed; revealing
// stamps wines[].revealedAt (the host always sees the real value, even while
// blindForEveryone masks the wine from them). The four endpoints map 1:1 to
// the web WineListScreen controls; all take no body (server reads only the
// session + caller). After any of them, invalidate ['session-state', code]
// so the 5s poll surfaces the new revealedAt.
export async function revealWine(code: string, wineId: string): Promise<void> {
  const res = await apiFetch(
    `/api/session/${encodeURIComponent(code)}/wines/${encodeURIComponent(wineId)}/reveal`,
    { method: 'POST' },
  );
  if (!res.ok) await throwApiError(res);
}

export async function hideWine(code: string, wineId: string): Promise<void> {
  const res = await apiFetch(
    `/api/session/${encodeURIComponent(code)}/wines/${encodeURIComponent(wineId)}/reveal`,
    { method: 'DELETE' },
  );
  if (!res.ok) await throwApiError(res);
}

// Host/cohost-only; the server validates a FULL permutation of the current
// list (length + id-set match) and rejects anything else.
export async function reorderWines(code: string, orderedIds: string[]): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/wines/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  });
  if (!res.ok) await throwApiError(res);
}

export async function revealAllWines(code: string): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/wines/reveal-all`, { method: 'POST' });
  if (!res.ok) await throwApiError(res);
}

export async function hideAllWines(code: string): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/wines/hide-all`, { method: 'POST' });
  if (!res.ok) await throwApiError(res);
}

// 02f settings edit. Host-only PATCH; every field is optional — send only
// what changed. The server (app/api/session/[code]/settings) shares the detail
// validators with create via lib/sessionFields.ts, pro-gates blind + showProvenance,
// and runs the hardened image pipeline on coverPhoto. coverPhoto: null removes
// the cover (reclaims the prior S3 bytes); a data URL replaces it. Mobile never
// sends lifespan (vestigial server-side: every logged-in moment is 'unlimited').
export type MomentSettingsBody = {
  // name is required — an empty/whitespace value is rejected server-side
  // (lib/sessionFields.ts) and the client guards block it before send.
  name?: string;
  address?: string;
  // dateFrom is required and can't be CLEARED — the server rejects null/empty
  // (Simon, 2026-07-06). Typed non-null (never sent as null): callers guard on
  // a set start date before building the diff. (dateTo stays nullable — clearing
  // the end date is allowed.)
  dateFrom?: string;
  dateTo?: string | null;
  timezone?: string;
  description?: string;
  link?: string;
  hideLineup?: boolean;
  hideLineupMinutesBefore?: number;
  blind?: boolean; // pro-gated server-side
  blindForEveryone?: boolean;
  showProvenance?: boolean; // "Show who brought each impression" — pro-gated server-side
  coverPhoto?: string | null; // data URL = replace; null = remove
};

// Resolves with the saved meta as the server echoes it (`metaToWire`: no
// per-viewer fields, no participants), or null when the body didn't parse.
// The in-place moment edit merges its detail fields into the poll's cache.
export type MomentSettingsEcho = Omit<SessionMetaView, 'participants' | 'ttlSeconds' | 'viewerBlocksOut' | 'viewerBlocksIn' | 'banCount'>;
export async function updateMomentSettings(code: string, body: MomentSettingsBody): Promise<MomentSettingsEcho | null> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError(res);
  const json = (await res.json().catch(() => null)) as { meta?: MomentSettingsEcho } | null;
  return json?.meta ?? null;
}

// Soft-deletes the moment (host/cohost-gated server-side). Bounces every
// participant on their next poll (the session 404s). Irreversible from the UI.
export async function deleteMoment(code: string): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}`, { method: 'DELETE' });
  if (!res.ok) await throwApiError(res);
}

// Hide / un-hide a moment from the home highlight carousel (personal view
// pref; it stays in "All moments"). Re-engaging (visit/rate) auto-un-hides.
export async function setMomentHidden(code: string, hidden: boolean): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/carousel-hidden`, {
    method: hidden ? 'POST' : 'DELETE',
  });
  if (!res.ok) await throwApiError(res);
}

// GET /api/session/:code/preview — a scanned moment before you join (Add
// Friends → Scan). `joined` = you're already in it (Open, no join). 404 = no
// such moment, 403 'banned' = `ApiError` kind 'banned'.
export type MomentPreview = {
  code: string;
  name: string | null;
  host: string | null;
  hostUserId: string | null;
  // The host's `@name`, only beside `hostUserId` (null: a guest host, a block
  // pair, not chosen yet). The one username a moment route sends.
  hostUsername: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  address: string | null;
  coverPhotoUrl: string | null;
  joined: boolean;
  // Only when asked with `moment` (a look-in's Join): whether the code is that moment's.
  sameMoment?: boolean;
};
export const momentPreviewKey = (code: string, moment?: string) => ['moment-preview', code, moment ?? null] as const;
export async function getMomentPreview(code: string, moment?: string): Promise<MomentPreview> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/preview${moment ? `?moment=${encodeURIComponent(moment)}` : ''}`);
  if (!res.ok) await throwApiError(res);
  return res.json();
}

export async function joinMoment(code: string, displayName: string): Promise<{ code: string }> {
  const res = await apiFetch('/api/session/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, displayName }),
  });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// People-management actions (host/cohost). The server is the authority on the
// tier gates (cohost role = strict-host only; banning a cohost = strict-host;
// provider ⊥ cohost) — the People UI mirrors them only to avoid offering dead
// actions, and surfaces the server's 403 message if a race slips through.

// Set a participant's role. 'taster' clears cohost/provider. The wire role
// values are snake_case to match the backend (PATCH /api/session/:code).
export type WireRole = 'taster' | 'co_host' | 'provider';
export async function setParticipantRole(code: string, targetId: string, role: WireRole): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-role', targetId, role }),
  });
  if (!res.ok) await throwApiError(res);
}

// Kick (can rejoin) or ban (cannot) a participant. Ban deletes their data;
// deleteAddedWines additionally removes wines they added (default false).
export async function removeParticipant(
  code: string,
  identityId: string,
  mode: 'kick' | 'ban',
  deleteAddedWines = false,
): Promise<void> {
  const res = await apiFetch(`/api/session/${encodeURIComponent(code)}/bans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityId, mode, deleteAddedWines }),
  });
  if (!res.ok) await throwApiError(res);
}
