import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { JoinClient } from '@/components/session/JoinClient'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const C = code.toUpperCase()
  const session = await auth()

  // Fetch session meta for the welcome screen
  let sessionMeta: { host: string; name: string } | null = null
  try {
    const raw = await redis.get(k.meta(C))
    if (raw) sessionMeta = JSON.parse(raw)
  } catch {}

  // If logged-in user has already joined this session, skip the invite page.
  // Check both: Redis users set (live participants) and Postgres sessionMember
  // (durable history that persists across Redis TTL expirations).
  if (session?.user?.id && sessionMeta) {
    let alreadyJoined = false
    try {
      if (session.user.name) {
        // Match either the bare name or a disambiguated `${name} <emoji>` form.
        const members = await redis.sMembers(k.users(C))
        alreadyJoined = members.some(n => n === session.user!.name || n.startsWith(`${session.user!.name} `))
      }
    } catch {}
    if (!alreadyJoined) {
      try {
        const member = await prisma.sessionMember.findUnique({
          where: { userId_sessionCode: { userId: Number(session.user.id), sessionCode: C } },
        })
        if (member) alreadyJoined = true
      } catch {}
    }
    if (alreadyJoined) redirect(`/session/${C}`)
  }

  return (
    <JoinClient
      code={C}
      sessionMeta={sessionMeta}
      defaultName={session?.user?.name || ''}
      isLoggedIn={!!session?.user}
    />
  )
}
