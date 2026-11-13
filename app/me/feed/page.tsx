import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { FeedClient } from '@/components/social/FeedClient'
import { clientSession } from '@/lib/clientSession'

export default async function FeedPage() {
  const me = clientSession(await auth())?.user
  if (!me) redirect('/login')
  return <FeedClient myId={me.id} />
}
