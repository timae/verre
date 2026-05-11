import { Avatar } from './Avatar'
import { FollowButton } from '@/components/social/FollowButton'

interface Props {
  userId: number
  userName: string
  myId: number | null
  isFollowing: boolean
  // Optional — passed by the in-modal renderer (UserProfileModal) so a
  // follow toggle invalidates the cached profile payload and the gate
  // re-resolves. SSR /u/[id] usage doesn't need it (page is server-
  // rendered; the next navigation refetches). FollowButton's onToggle
  // signature accepts a (following: boolean) param; callers here ignore
  // it because the invalidation logic doesn't branch on direction —
  // both follow and unfollow refetch the same cache key.
  onFollowToggle?: () => void
}

// Tier-gated profile view. Display name is always public for any user
// that exists; everything else (avatar, level/XP, badges, check-ins,
// social graph) is gated by the owner's tier — render the dummy
// initial-letter avatar instead of the real imageUrl.
//
// Logged-in viewers see a follow button so they can request access.
// Logged-out viewers see only name + dummy avatar; they can sign in
// and try the follow path from there.
export function ProfileShell({ userId, userName, myId, isFollowing, onFollowToggle }: Props) {
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Avatar name={userName} imageUrl={null} size={56} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.1, marginBottom: 4 }}>{userName}</h1>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>private profile</div>
        </div>
        {myId ? <FollowButton userId={userId} initialFollowing={isFollowing} onToggle={onFollowToggle} /> : null}
      </div>
    </div>
  )
}
