import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { JoinClient } from '@/components/session/JoinClient'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { normalizeCode, sessionPath } from '@/lib/sessionCode'

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
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

  // If a logged-in user has already joined this session, skip the invite
  // page. Authoritative source is Postgres sessionMember (id-keyed). The
  // earlier Redis-users-set check was display-name based and incorrectly
  // matched two distinct users sharing a display name, silently bouncing
  // the second one into the session without going through the join flow.
  if (session?.user?.id && C && sessionMeta) {
    try {
      const member = await prisma.sessionMember.findUnique({
        where: { userId_sessionCode: { userId: Number(session.user.id), sessionCode: C } },
      })
      if (member) redirect(sessionPath(C))
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
