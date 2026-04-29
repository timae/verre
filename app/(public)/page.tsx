import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { LobbyClient } from '@/components/session/LobbyClient'

export default async function LobbyPage({
  searchParams,
}: {
  searchParams: Promise<{ join?: string }>
}) {
  const { join } = await searchParams

  // Legacy invite URLs: /?join=CODE → /join/CODE
  if (join) redirect(`/join/${join.toUpperCase()}`)

  const session = await auth()
  if (session?.user) redirect('/me')

  return <LobbyClient user={null} />
}
