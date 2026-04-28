import { auth } from '@/auth'
import { MeDashboard } from '@/components/me/MeDashboard'

export default async function MePage() {
  const session = await auth()
  if (!session?.user) return null
  return <MeDashboard user={session.user} />
}
