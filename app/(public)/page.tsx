import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { LobbyClient } from '@/components/session/LobbyClient'
import { normalizeCode, joinPath } from '@/lib/sessionCode'

export default async function LobbyPage({
  searchParams,
}: {
  searchParams: Promise<{ join?: string }>
}) {
  const { join } = await searchParams

  // Legacy invite URLs: /?join=CODE → /join/CODE. Normalize so dirty
  // input (lowercase, hyphenated, padded with spaces) lands on the
  // canonical form. Invalid codes fall through to the lobby.
  if (join) {
    const c = normalizeCode(join)
    if (c) redirect(joinPath(c))
  }

  const session = await auth()
  if (session?.user) redirect('/me')

  return <LobbyClient user={null} />
}
