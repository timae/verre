import { normalizePublicUserId } from '@verre/core';

// Look-in links (Moment Visibility step-2 plan § 4.3, T5). A shared link is a
// web page whose "Open in Verre" button hands `io.verre.app://l/<id>.<token>`
// to the app (R12). It is caught BEFORE routing (app/+native-intent.tsx), so
// 🔒 the token never enters navigation state, a route param, a query key, a
// cache, a log line or an error report: it lives here, in memory only.
//
// Two things with different lifetimes (review r1):
//   - the PENDING open: the link that just arrived (or "a bad link"), one at a
//     time, the latest wins; consumed ONCE by the opener (usePendingLookIn),
//     dropped after 15 minutes;
//   - the TOKENS of open look-ins, one per OPENING (Codex r1): the opener mints
//     a random handle for each look-in it opens by link; the route carries
//     `via=link&h=<handle>` (the handle names nothing outside this process) and
//     the screen sends the handle's token as `X-Verre-Link`. Consuming or
//     expiring the pending open never drops a token; a handle's token lives
//     until sign-out. Two openings of one moment are two handles, so a later
//     dead link never changes an earlier screen's credential.
// Sign-out clears both (app/_layout.tsx, beside clearViewerCache). A bad link
// recorded while signed out is dropped when the opener starts (no alert after
// a sign-in minutes later); a GOOD one survives sign-in, within its 15 minutes
// (R13).
//
// Pure apart from the module state; the clock and the handle source are
// injectable for the units (scripts/tests/look-in-units.ts § 2–3).

export const PENDING_TTL_MS = 15 * 60 * 1000;

export type LinkMatch = { kind: 'link'; momentId: string; token: string } | { kind: 'bad' };

// The RAW URL as expo-router hands it to redirectSystemPath (on both paths:
// warm `link/linking.js`, cold `getLinkingConfig.js`): normalise, then match
// `l/<12 public-id chars>.<32 hex>`. null = not a look-in link at all (pass it
// through unchanged: the cold home-screen launch `io.verre.app:///`, any other
// path). A path under `l/` that doesn't match is a bad link. 🔒 A URL is a
// look-in link when EITHER reading puts it under `l/` (review r1 + recheck):
// ours (any scheme with or without slashes, our custom scheme's `l` host, an
// https host for registered app links one day, R12, percent-encoding) and the
// router's own (routerPathOf); otherwise the token could reach navigation
// state through +not-found.
const LINK = /^l\/([0-9a-z]{12})\.([0-9a-f]{32})$/;
const lookInPathOf = (raw: string): string => {
  let rest = raw.replace(/[?#].*$/, '');
  try { rest = decodeURIComponent(rest); } catch { /* keep it as sent */ }
  rest = rest.toLowerCase();
  const scheme = /^[a-z][a-z0-9+.-]*:/.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    // `//authority/path`: our scheme's look-in links put `l` in the host slot.
    if (rest.startsWith('//')) {
      rest = rest.slice(2);
      if (!/^\/*l(\/|$)/.test(rest)) rest = rest.replace(/^[^/]*/, '');
    }
  }
  return rest.replace(/^\/+/, '');
};
// The path the way expo-router itself routes it (fork/extractPathFromURL.js
// `fromDeepLink`: the WHATWG URL's host + pathname, which strips userinfo,
// ports, tabs and spaces and resolves dot segments), so a spelling only the
// router would read as `l/…` is caught too (build review recheck).
const routerPathOf = (raw: string): string => {
  let p: string;
  try { const u = new URL(raw); p = u.host + u.pathname; } catch { p = raw.startsWith('/') ? raw : raw.replace(/^[^:]+:\/\//, ''); }
  p = p.replace(/[?#].*$/, '');
  try { p = decodeURIComponent(p); } catch { /* keep it as sent */ }
  return p.toLowerCase().replace(/^\/+/, '');
};
// An https link (registered app links one day, R12): its resolved pathname,
// the host dropped.
const httpPathOf = (raw: string): string => {
  if (!/^\s*https?:/i.test(raw)) return '';
  try { return decodeURIComponent(new URL(raw).pathname).toLowerCase().replace(/^\/+/, ''); } catch { return ''; }
};
export function matchLookInUrl(raw: string): LinkMatch | null {
  const paths = [lookInPathOf(raw), routerPathOf(raw), httpPathOf(raw)].filter((p) => p === 'l' || p.startsWith('l/'));
  if (paths.length === 0) return null;
  for (const path of paths) {
    const m = LINK.exec(path);
    const momentId = m ? normalizePublicUserId(m[1]) : null;
    if (m && momentId) return { kind: 'link', momentId, token: m[2] };
  }
  return { kind: 'bad' };
}

type Pending = { at: number; signedIn: boolean } & ({ kind: 'link'; momentId: string; token: string } | { kind: 'bad' });

let now: () => number = () => Date.now();
let mint: () => string = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
let pending: Pending | null = null;
let active = false; // the opener is mounted (signed in, past the username screen)
const tokens = new Map<string, string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function subscribeLookInLinks(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// From +native-intent: the latest link wins.
export function recordLookInLink(match: LinkMatch): void {
  pending = { ...match, at: now(), signedIn: active };
  emit();
}

// The opener: present while signed in. Starting drops a bad link recorded
// while signed out.
export function setLookInOpenerActive(on: boolean): void {
  active = on;
  if (on && pending?.kind === 'bad' && !pending.signedIn) pending = null;
  if (on) emit();
}

export function hasPendingLookIn(): boolean {
  if (pending && now() - pending.at > PENDING_TTL_MS) pending = null;
  return pending !== null;
}

// ONE consume. A good link mints its opening's handle here.
export type Opening = { kind: 'link'; momentId: string; handle: string } | { kind: 'bad' };
export function consumePendingLookIn(): Opening | null {
  if (!hasPendingLookIn()) return null;
  const p = pending!;
  pending = null;
  if (p.kind === 'bad') return { kind: 'bad' };
  const handle = mint();
  tokens.set(handle, p.token);
  return { kind: 'link', momentId: p.momentId, handle };
}

// A screen opened with `via=link`: its credential, or null ("This link doesn't
// work", never a fallback to the audience).
export function lookInLinkToken(handle: string | null | undefined): string | null {
  return handle ? tokens.get(handle) ?? null : null;
}

// How a look-in screen asks (useLookIn, the units pin it): `via` present in any
// form = opened by LINK, whatever else (an array, an unknown value, a missing
// or unknown handle: "This link doesn't work", T6: never an audience read); the
// query key names the opening, never the token.
export type LookInRequestPlan = { viaLink: boolean; token: string | null; badLink: boolean; key: readonly ['look-in', string, string] };
export function lookInRequestPlan(momentId: string, via: unknown, h: unknown): LookInRequestPlan {
  const viaLink = via !== undefined && via !== null && via !== '';
  const handle = viaLink && via === 'link' && typeof h === 'string' && h !== '' ? h : null;
  const token = handle ? lookInLinkToken(handle) : null;
  return {
    viaLink,
    token,
    badLink: viaLink && token === null,
    key: ['look-in', momentId, viaLink ? `link:${handle ?? '-'}` : 'audience'],
  };
}
// The wire: the path never holds a token; the token is only ever this header.
export const lookInPath = (momentId: string, bottles?: string[]) =>
  `/api/moments/${encodeURIComponent(momentId)}${bottles ? `?bottles=${bottles.join(',')}` : ''}`;
export const lookInHeaders = (token?: string | null): Record<string, string> => (token ? { 'X-Verre-Link': token } : {});

// The opener's peek (a bad link alerts at once, whatever the wait rule says).
export function pendingLookInKind(): 'link' | 'bad' | null {
  return hasPendingLookIn() ? pending!.kind : null;
}

export function clearLookInLinks(): void {
  pending = null;
  tokens.clear();
  emit();
}

// Units only.
export function __setLookInLinksTestHooks(h: { now?: () => number; mint?: () => string }): void {
  if (h.now) now = h.now;
  if (h.mint) mint = h.mint;
  pending = null;
  active = false;
  tokens.clear();
}

// app/+native-intent.tsx's `redirectSystemPath` (here so the units can reach
// it): a look-in link is recorded and taken OUT of routing; warm → null (no
// navigation), cold → the Moments home as the first route. Every other URL
// passes through unchanged. Never throws (an error there can crash the app).
export function redirectLookInPath({ path, initial }: { path: string; initial: boolean }): string | null {
  let match: LinkMatch | null = null;
  try { match = matchLookInUrl(path); } catch { return path; }
  if (!match) return path;
  recordLookInLink(match);
  return initial ? '/moments' : null;
}
