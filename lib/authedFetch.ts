import { webApiFetch } from '@/lib/sessionFetch'

// fetch wrapper for authenticated /api/me/* endpoints.
//
// On 401 (token revoked, user deleted, session expired): redirect to /login
// so the user lands on a usable page instead of seeing a crash from a
// query function trying to parse `{ error: 'auth required' }` as the
// expected payload shape.
//
// On other non-OK responses: throws so React Query surfaces an error state.
//
// Sends the web wire generation (webApiFetch, public-user-ids § 6): a signed-in
// call to a moment path without it is bounced by the proxy, which here would
// read as a 401 and send the user to /login.
export async function authedFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await webApiFetch(url, init)
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new Error('unauthorized')
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}
