// fetch wrapper for authenticated /api/me/* endpoints.
//
// On 401 (token revoked, user deleted, session expired): redirect to /login
// so the user lands on a usable page instead of seeing a crash from a
// query function trying to parse `{ error: 'auth required' }` as the
// expected payload shape.
//
// On other non-OK responses: throws so React Query surfaces an error state.
export async function authedFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new Error('unauthorized')
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}
