import { ApiError } from './api/sessions';

// A 401: this phone's session is gone (revoked elsewhere, or expired); the
// next session check lands it on sign-in.
export const SIGNED_OUT_TEXT = 'You’re signed out. Sign in again.';

// A failed write's alert copy: the server's own message for a 4xx (validation,
// "Try again in …"), else the connection line.
export function errorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 401) return SIGNED_OUT_TEXT;
  const msg = e instanceof ApiError && e.status > 0 && e.status < 500 ? e.message : null;
  return msg && msg !== 'http' ? sentence(msg) : 'Check your connection and try again.';
}

// The shared validators speak lower case ("name must be at least 2
// characters"); an alert body reads as a sentence.
export function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const c = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
}
