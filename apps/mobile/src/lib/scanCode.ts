import { normalizeCode, normalizePublicUserId, usernameFromPath } from '@verre/core';

// What an in-app scan (Add Friends → Scan) may open: a profile QR
// (`${WEB_BASE}/u/<id>`, your Add Friends card) or a moment's invite QR
// (`${WEB_BASE}/join/<code>`: the web's is hyphenated, the app's raw, legacy
// codes 4 characters). Anything else, including either path on another
// origin, is not a Verre code: the scanner ignores it and keeps running.
//
// Pure and platform-neutral. Deliberately NOT `new URL()`: React Native's URL
// is a regex shim with no validation or normalisation, so it would behave
// differently on the phone than in a unit test. One anchored match instead:
// scheme + host[:port] (no user info: an `@` makes the origin differ), then
// the path; the query and fragment are ignored. The origin compares exactly
// (case-insensitive: hosts are).
//
// A profile QR carries the PUBLIC id (12 characters, letter first; case-
// insensitive, canonical uppercase out). An OLD profile QR (`/u/<digits>`,
// from before public ids) stays a RECOGNISED Verre code, `profile-legacy`:
// the result says "This code isn’t available." and nothing is requested (old
// links break on purpose, public-user-ids § 2).
//
// A shared profile LINK is `/@<username>` (or `/%40<username>`): the FORMAT
// only (a reserved name an operator assigned opens too), canonical lowercase
// out; the caller resolves it (`GET /api/users/by-username/<name>`). A
// malformed name is not a Verre code.
export type VerreCode =
  | { kind: 'profile'; id: string }
  | { kind: 'profile-legacy' }
  | { kind: 'profile-username'; username: string }
  | { kind: 'moment'; code: string };

const URL_RE = /^(https?:\/\/[^/?#\s]+)(\/[^?#\s]*)?(?:[?#]\S*)?$/i;

function originOf(url: string): string | null {
  const m = URL_RE.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

export function parseVerreCode(data: string, webBase: string): VerreCode | null {
  const m = URL_RE.exec(data.trim());
  const base = originOf(webBase);
  if (!m || !base || m[1].toLowerCase() !== base) return null;
  const path = m[2] ?? '/';
  const u = /^\/u\/([A-Za-z0-9]+)\/?$/.exec(path);
  if (u) {
    const id = normalizePublicUserId(u[1]);
    if (id) return { kind: 'profile', id };
    return /^[1-9]\d{0,9}$/.test(u[1]) ? { kind: 'profile-legacy' } : null;
  }
  const at = /^\/(?:@|%40)([^/]+)\/?$/.exec(path);
  if (at) {
    const username = usernameFromPath(at[1]);
    return username ? { kind: 'profile-username', username } : null;
  }
  const j = /^\/join\/([A-Za-z0-9-]+)\/?$/.exec(path);
  if (j) {
    const code = normalizeCode(j[1]);
    return code ? { kind: 'moment', code } : null;
  }
  return null;
}
