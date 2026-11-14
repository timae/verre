import { notFound } from 'next/navigation'
import { usernameFromPath } from '@verre/core'
import { ProfilePageView } from '@/components/profile/ProfilePageView'
import { userForUsername } from '@/lib/username'

// `/@<username>` (next.config.ts rewrites it here; an `@folder` would be a
// parallel-routes slot). A thin entry over the same view as `/u/<publicId>`.
// 🔒 The FORMAT only, never the reserved list (that is a rule for writes: an
// account the operator gave a reserved name opens like any other). Malformed,
// unknown, renamed away, held → 404; no redirect from an old name, ever
// (after the hold someone else may own it).
export default async function ProfileByUsernamePage({ params }: { params: Promise<{ username: string }> }) {
  const username = usernameFromPath((await params).username)
  if (username === null) notFound()
  return <ProfilePageView resolve={() => userForUsername(username)} />
}
