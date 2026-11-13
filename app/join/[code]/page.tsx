import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/auth'
import { JoinClient } from '@/components/session/JoinClient'
import { RemovedView } from '@/components/session/RemovedView'
import { openSessionCharged } from '@/lib/sessionRoute'
import { getClientIp, formatWait } from '@/lib/rateLimit'
import { prisma } from '@/lib/prisma'
import { normalizeCode, formatCode } from '@verre/core'
import { sessionPath } from '@/lib/sessionCode'

export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>
  searchParams: Promise<{ removed?: string }>
}) {
  const { code } = await params
  const { removed } = await searchParams
  // Invalid code (malformed Crockford or wrong length) → render the styled
  // "session not found" panel rather than Next's default 404 page. Pass the
  // raw input through to the client for display.
  const C = normalizeCode(code)
  const session = await auth()

  // Fetch session meta for the welcome screen — only if the code is valid.
  let sessionMeta: { host: string; name: string } | null = null
  let rateLimited: { wait: string } | null = null
  if (C) {
    // Opened like every session route, through the entrance gate (leak-fixes
    // F2): a wrong code pays the wrong-code budget; once it is spent a caller
    // who isn't a member gets the "too many codes" panel for EVERY code. A
    // guest is unknown here (their token lives in the browser): JoinClient
    // sends one holding this moment's token + name to the moment, where the
    // API decides with the token. A cold Postgres-backed moment is rebuilt;
    // 'restoring' gets one short retry, then the error page — never "not
    // found" for a live moment (JoinClient renders a missing meta as an ended
    // session).
    const userId = session?.user?.id ? Number(session.user.id) : null
    const who = { userId, ip: getClientIp({ headers: await headers() }), identity: async () => userId !== null ? `u:${userId}` : null }
    let opened = await openSessionCharged(C, who)
    if (opened.status === 'restoring') {
      await new Promise(r => setTimeout(r, 300))
      opened = await openSessionCharged(C, who)
    }
    if (opened.status === 'restoring') throw new Error('This moment is being restored. Try again in a moment.')
    // Only what the page shows: JoinClient is a client component, so the whole
    // meta would be serialized into the HTML for anyone with the code, signed
    // out and unlimited (host user id, co-host / provider ids, …; review
    // 2026-11-12).
    if (opened.status === 'live') sessionMeta = { host: opened.meta.host, name: opened.meta.name }
    if (opened.status === 'limited') rateLimited = { wait: formatWait(opened.retryAfter) }
  }

  // Removed-bounce path. The session-fetch helper redirects here with
  // ?removed=1 after a 401+X-Vr-Auth: removed. Skip the regular join flow
  // and render the kicked/banned screen — RemovedView pings the server
  // to figure out which. The `isLoggedIn` prop drives the final
  // destination: logged-in → /me (their dashboard); anon → / (the
  // lobby). The Keep/Delete prompts live in RemovedView, not here.
  // On a spent budget the page can't read the moment (a guest's token is in
  // the browser): the code-only label, the same for any code, and RemovedView's
  // own removed-state call (which carries the token) decides.
  if (removed === '1' && C && (sessionMeta || rateLimited)) {
    const label = sessionMeta?.name || `Session ${formatCode(C)}`
    return <RemovedView code={C} sessionLabel={label} isLoggedIn={!!session?.user} />
  }

  // If a logged-in user has already joined this session, skip the invite
  // page. Authoritative source is Postgres sessionMember (id-keyed). The
  // earlier Redis-users-set check was display-name based and incorrectly
  // matched two distinct users sharing a display name, silently bouncing
  // the second one into the session without going through the join flow.
  //
  // EXCEPTION — a KICKED member (kick-keep leaves the row with
  // removed_state='kicked') must NOT be blind-redirected: they'd land on
  // /visit, get bounced with ?removed=1, and the RemovedView only offers
  // Keep/Delete — so the join POST (the sole path that clears removed_state +
  // the Redis kicked marker) would never run and the moment would stay
  // durably hidden from their Moments home. Fall through to <JoinClient> so
  // clicking the invite link genuinely re-joins them and clears the flag —
  // the documented "rejoin by code/link" contract (docs/dev/kick-ban.md).
  //
  // redirect() THROWS (NEXT_REDIRECT), so it runs after the lookup, never inside
  // a try whose catch would swallow it: a failed lookup only falls through to the
  // join screen.
  if (session?.user?.id && C && sessionMeta) {
    const member = await prisma.sessionMember.findUnique({
      where: { userId_sessionCode: { userId: Number(session.user.id), sessionCode: C } },
    }).catch(() => null)
    if (member && member.removedState !== 'kicked') redirect(sessionPath(C))
  }

  return (
    <JoinClient
      code={C ?? code.toUpperCase()}
      sessionMeta={sessionMeta}
      rateLimited={rateLimited}
      defaultName={session?.user?.name || ''}
      isLoggedIn={!!session?.user}
    />
  )
}
