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
// Two auth-rejection signals from the server:
//
//   X-Vr-Auth: invalid → the caller has no valid identity for this session
//     (no token, expired cookie, deleted account, never joined). Clear
//     local state and bounce to /join — they need to re-enter their name.
//
//   X-Vr-Auth: removed → the caller WAS a participant but got kicked or
//     banned. PRESERVE local state so the /join page can re-identify them
//     via the preserved anon token / id and render "You were removed"
//     with the right next step (Keep/Delete data for kick, or "you were
//     banned" for ban). The token doesn't grant access anymore — the
//     server's participantOrBanned check rejects it — but it keeps the
//     identification anchor for the bounce screen.
//
// Permission-denied 403s ("only the host can do X", "pro required") don't
// carry either header — those surface as normal failed responses so the
// UI shows an error without booting the user out.
export async function sessionFetch(code: string, url: string, init?: RequestInit): Promise<Response> {
  const C = canonical(code)
  const headers = new Headers(init?.headers)
  const token = getAnonToken(code)
  if (token) headers.set('x-vr-anon-token', token)
  const res = await fetch(url, { ...init, headers })
  const authHeader = res.headers.get('X-Vr-Auth')
  if (authHeader === 'invalid') {
    clearAnonToken(code)
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(NAME_KEY(code))
      localStorage.removeItem(`vr_id_${C}`)
    }
    if (typeof window !== 'undefined') window.location.href = joinPath(C)
  } else if (authHeader === 'removed') {
    // Keep local state so /join can identify the removed user. The
    // ?removed=1 hint tells the page to look up the bans / identities
    // state and render the appropriate copy.
    if (typeof window !== 'undefined') window.location.href = joinPath(C) + '?removed=1'
  }
  return res
}
