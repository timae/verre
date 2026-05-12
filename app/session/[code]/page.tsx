import { redirect } from 'next/navigation'
import { normalizeCode, sessionPath } from '@/lib/sessionCode'

// The session root redirects to the Rate tab — the new default
// landing per the step-7 wine-rate-split design. Direct links to
// /session/<C> still resolve cleanly; the user lands on Rate and
// taps "Wines" in the bottom nav (or the in-page "manage wines"
// button for hosts) to reach the management surface.
//
// Query parameters are preserved on the redirect because LobbyClient
// and JoinClient pass bootstrap params (`?name=...&id=...&host=1`)
// that the SessionShell reads on first render to seed local identity
// state. Dropping them would force an anon user back to /join.
export default async function SessionRootPage({
  params, searchParams,
}: {
  params: Promise<{ code: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { code } = await params
  const sp = await searchParams
  const c = normalizeCode(code)
  // normalizeCode returns null on a malformed code — fall through to
  // the original input so the rate route can surface its own 404 /
  // invalid-session response instead of redirecting to an empty path.
  const target = sessionPath(c || code, 'rate')
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) { for (const vv of v) qs.append(k, vv) }
    else if (typeof v === 'string') qs.set(k, v)
  }
  const query = qs.toString()
  redirect(query ? `${target}?${query}` : target)
}
