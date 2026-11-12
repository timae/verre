import { normalizeCode } from '@verre/core';

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
export type VerreCode = { kind: 'profile'; id: number } | { kind: 'moment'; code: string };

const URL_RE = /^(https?:\/\/[^/?#\s]+)(\/[^?#\s]*)?(?:[?#]\S*)?$/i;
const PG_INT4_MAX = 2147483647;

function originOf(url: string): string | null {
  const m = URL_RE.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

export function parseVerreCode(data: string, webBase: string): VerreCode | null {
  const m = URL_RE.exec(data.trim());
  const base = originOf(webBase);
  if (!m || !base || m[1].toLowerCase() !== base) return null;
  const path = m[2] ?? '/';
  // `/u/<id>`: the server's parsePathId rule (no leading zeros, int4).
  const u = /^\/u\/([1-9][0-9]*)\/?$/.exec(path);
  if (u) {
    const id = Number(u[1]);
    return Number.isSafeInteger(id) && id <= PG_INT4_MAX ? { kind: 'profile', id } : null;
  }
  const j = /^\/join\/([A-Za-z0-9-]+)\/?$/.exec(path);
  if (j) {
    const code = normalizeCode(j[1]);
    return code ? { kind: 'moment', code } : null;
  }
  return null;
}
