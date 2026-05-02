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

const TOKEN_KEY = (code: string) => `vr_anon_${code.toUpperCase()}`
const NAME_KEY  = (code: string) => `vr_name_${code.toUpperCase()}`

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
// On 401/403 responses where a token was sent, we drop the stored token and
// display name and bounce the user to the join page. This handles three
// cases uniformly: (1) the session expired in Redis after 48h, (2) a future
// "host kicks user" feature revoked the token, (3) the token got corrupted.
// Logged-in users hitting 403 (e.g. lacking host permission) are untouched
// because no token was sent on their request.
export async function sessionFetch(code: string, url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const token = getAnonToken(code)
  if (token) headers.set('x-vr-anon-token', token)
  const res = await fetch(url, { ...init, headers })
  if (token && (res.status === 401 || res.status === 403)) {
    clearAnonToken(code)
    if (typeof localStorage !== 'undefined') localStorage.removeItem(NAME_KEY(code))
    if (typeof window !== 'undefined') window.location.href = `/join/${code.toUpperCase()}`
  }
  return res
}
