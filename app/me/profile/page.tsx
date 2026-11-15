import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { clientSession } from '@/lib/clientSession'
import { profilePath } from '@verre/core'

// Legacy route. /me/profile no longer exists as its own surface — the
// public profile at /u/<id> is the unified view, with a settings button
// for the owner. This page is kept as a redirect so old bookmarks,
// cached PWA paths, and shared links don't 404.
export default async function MeProfileLegacyRedirect() {
  const me = clientSession(await auth())?.user
  if (!me) redirect('/login')
  redirect(profilePath(me.id))
}
