import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { JoinClient } from '@/components/session/JoinClient'
import { RemovedView } from '@/components/session/RemovedView'
import { redis, k } from '@/lib/redis'
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
  if (C) {
    try {
      const raw = await redis.get(k.meta(C))
      if (raw) sessionMeta = JSON.parse(raw)
    } catch {}
  }

  // Removed-bounce path. The session-fetch helper redirects here with
  // ?removed=1 after a 401+X-Vr-Auth: removed. Skip the regular join flow
  // and render the kicked/banned screen — RemovedView pings the server
  // to figure out which. The `isLoggedIn` prop drives the final
  // destination: logged-in → /me (their dashboard); anon → / (the
  // lobby). The Keep/Delete prompts live in RemovedView, not here.
  if (removed === '1' && C && sessionMeta) {
    const label = sessionMeta.name || `Session ${formatCode(C)}`
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
  if (session?.user?.id && C && sessionMeta) {
    try {
      const member = await prisma.sessionMember.findUnique({
        where: { userId_sessionCode: { userId: Number(session.user.id), sessionCode: C } },
      })
      if (member && member.removedState !== 'kicked') redirect(sessionPath(C))
    } catch {}
  }

  return (
    <JoinClient
      code={C ?? code.toUpperCase()}
      sessionMeta={sessionMeta}
      defaultName={session?.user?.name || ''}
      isLoggedIn={!!session?.user}
    />
  )
}
