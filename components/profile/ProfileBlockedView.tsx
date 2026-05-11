import { Avatar } from './Avatar'
import { UnblockButton } from '@/components/social/UnblockButton'

interface Props {
  userId: number
  userName: string
  myId: number | null
}

// Blocker-side stripped view. The viewer blocked this profile, so we
// show the name (so they recognise who they blocked) and an unblock
// button — nothing else. No avatar (dummy initial-letter only), no
// XP, no badges, no check-ins, no follow button, no follower count.
//
// The blocked-side equivalent of this view doesn't exist: the gate
// collapses to 'gone' (404) for the blocked side, so they never reach
// any render. Keeps the asymmetry honest.
export function ProfileBlockedView({ userId, userName, myId }: Props) {
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Avatar name={userName} imageUrl={null} size={56} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.1, marginBottom: 4 }}>{userName}</h1>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>blocked</div>
        </div>
        {myId !== null && <UnblockButton userId={userId} />}
      </div>
    </div>
  )
}
