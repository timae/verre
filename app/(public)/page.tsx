import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { LobbyClient } from '@/components/session/LobbyClient'

export default async function LobbyPage() {
  const session = await auth()
  if (session?.user) redirect('/me')
  return <LobbyClient user={null} />
}
