import { notFound } from 'next/navigation'
import { ProfilePageView } from '@/components/profile/ProfilePageView'
import { parsePublicIdParam, userIdForPublicId } from '@/lib/publicIds'

// `/u/<publicId>`. A thin entry: it only parses its own format; the shared
// view charges the limiter, THEN resolves (components/profile/ProfilePageView).
export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // Format only; `/u/<int>` (an old link) or anything else is a 404, no redirect.
  const publicId = parsePublicIdParam(id)
  if (publicId === null) notFound()
  return (
    <ProfilePageView
      resolve={async () => {
        const userId = await userIdForPublicId(publicId)
        return userId === null ? null : { id: userId, publicId }
      }}
    />
  )
}
