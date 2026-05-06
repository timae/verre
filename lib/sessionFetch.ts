// Client-side helpers for the Phase 2 anon-token model.
//
// Anonymous users get a per-session token from /api/session POST or
// /api/session/join POST. The token is persisted in localStorage (shared
// across tabs and survives browser restart) and sent on every state-changing
// request via the x-vr-anon-token header. The server resolves identity from
// auth() first, then this header — never from a body field.
//
// Logged-in users don't need a token (the auth cookie is their trust anchor),
// so getAnonToken returns null for them and sessionFetch sends no extra header.

import { normalizeCode, joinPath } from '@/lib/sessionCode'

// Defensive: callers should pass canonical codes (post-normalizeCode), but
// fall back to upper-case if normalize rejects so a malformed code at least
// produces stable keys instead of mismatched ones.
const canonical = (code: string) => normalizeCode(code) ?? code.toUpperCase()
const TOKEN_KEY = (code: string) => `vr_anon_${canonical(code)}`
const NAME_KEY  = (code: string) => `vr_name_${canonical(code)}`

export function setAnonToken(code: string, token: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(TOKEN_KEY(code), token)
}

export function getAnonToken(code: string): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(TOKEN_KEY(code))
}

export function clearAnonToken(code: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(TOKEN_KEY(code))
}

// Fetch a session-context endpoint, attaching the anon token header when one
// is stored locally for this session code.
//
// On responses carrying X-Vr-Auth: invalid, drop the stored token and
// display name and bounce the user to the join page. The header is set by
// the server only when the rejection was about identity itself (no token,
// expired token, kicked, not a participant). Permission-denied 403s
// ("only the host can do X", "pro required for blind tasting") do not
// carry the header — those are surfaced to the caller as a normal failed
// response so the UI can show an error without booting the user out.
export async function sessionFetch(code: string, url: string, init?: RequestInit): Promise<Response> {
  const C = canonical(code)
  const headers = new Headers(init?.headers)
  const token = getAnonToken(code)
  if (token) headers.set('x-vr-anon-token', token)
  const res = await fetch(url, { ...init, headers })
  // Auth-invalid means the server can't tie the caller to a participant in
  // this session (no auth, expired cookie, deleted account, kicked, anon
  // token lapsed). Always clear local cache and bounce to /join. The shell
  // gates session-scoped GETs on `visitResolved`, so we no longer need to
  // tolerate a "join race" 401 during initial load.
  if (res.headers.get('X-Vr-Auth') === 'invalid') {
    clearAnonToken(code)
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(NAME_KEY(code))
      localStorage.removeItem(`vr_id_${C}`)
    }
    if (typeof window !== 'undefined') window.location.href = joinPath(C)
  }
  return res
}
