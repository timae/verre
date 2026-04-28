import { auth } from '@/auth'
import { LobbyClient } from '@/components/session/LobbyClient'

export default async function LobbyPage() {
  const session = await auth()
  return <LobbyClient user={session?.user ?? null} />
}
