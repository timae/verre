import { auth } from '@/auth'
import { MeDashboard } from '@/components/me/MeDashboard'
import { clientSession } from '@/lib/clientSession'

export default async function MePage() {
  const user = clientSession(await auth())?.user
  if (!user) return null
  return <MeDashboard user={user} />
}
