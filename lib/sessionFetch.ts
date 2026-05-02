// Client-side helpers for the Phase 2 anon-token model.
//
// Anonymous users get a per-session token from /api/session POST or
// /api/session/join POST. The token is persisted in sessionStorage and sent
// on every state-changing request via the x-vr-anon-token header. The server
// resolves identity from auth() first, then this header — never from a body
// field.
//
// Logged-in users don't need a token (the auth cookie is their trust anchor),
// so getAnonToken returns null for them and sessionFetch sends no extra header.

const TOKEN_KEY = (code: string) => `vr_anon_${code.toUpperCase()}`

export function setAnonToken(code: string, token: string): void {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.setItem(TOKEN_KEY(code), token)
}

export function getAnonToken(code: string): string | null {
  if (typeof sessionStorage === 'undefined') return null
  return sessionStorage.getItem(TOKEN_KEY(code))
}

export function clearAnonToken(code: string): void {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.removeItem(TOKEN_KEY(code))
}

// Fetch a session-context endpoint, attaching the anon token header when one
// is stored locally for this session code.
export async function sessionFetch(code: string, url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const token = getAnonToken(code)
  if (token) headers.set('x-vr-anon-token', token)
  return fetch(url, { ...init, headers })
}
