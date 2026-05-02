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
// On responses carrying X-Vr-Auth: invalid, drop the stored token and
// display name and bounce the user to the join page. The header is set by
// the server only when the rejection was about identity itself (no token,
// expired token, kicked, not a participant). Permission-denied 403s
// ("only the host can do X", "pro required for blind tasting") do not
// carry the header — those are surfaced to the caller as a normal failed
// response so the UI can show an error without booting the user out.
export async function sessionFetch(code: string, url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const token = getAnonToken(code)
  if (token) headers.set('x-vr-anon-token', token)
  const res = await fetch(url, { ...init, headers })
  // Only act on X-Vr-Auth=invalid when WE sent a token. If we didn't send
  // one, the 401 belongs to a logged-in user whose participant registration
  // hasn't landed yet — surface to the caller so they can retry, don't
  // bounce them out.
  if (token && res.headers.get('X-Vr-Auth') === 'invalid') {
    clearAnonToken(code)
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(NAME_KEY(code))
      localStorage.removeItem(`vr_id_${code.toUpperCase()}`)
    }
    if (typeof window !== 'undefined') window.location.href = `/join/${code.toUpperCase()}`
  }
  return res
}
