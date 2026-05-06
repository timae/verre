import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { FeedClient } from '@/components/social/FeedClient'

export default async function FeedPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  return <FeedClient myId={Number(session.user.id)} />
}
