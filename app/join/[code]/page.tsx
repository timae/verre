import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { JoinClient } from '@/components/session/JoinClient'
import { redis, k } from '@/lib/redis'

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

  // If logged-in user has already joined this session, skip the invite page
  if (session?.user?.name && sessionMeta) {
    try {
      const isMember = await redis.sIsMember(k.users(C), session.user.name)
      if (isMember) redirect(`/session/${C}`)
    } catch {}
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
