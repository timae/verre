import { redirect } from 'next/navigation'
import { auth } from '@/auth'

// Legacy route. /me/profile no longer exists as its own surface — the
// public profile at /u/<id> is the unified view, with a settings button
// for the owner. This page is kept as a redirect so old bookmarks,
// cached PWA paths, and shared links don't 404.
export default async function MeProfileLegacyRedirect() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  redirect(`/u/${session.user.id}`)
}
