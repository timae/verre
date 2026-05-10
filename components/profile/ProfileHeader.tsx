import { getLevel } from '@/lib/badges'
import { ProfileSettingsButton } from './ProfileSettingsButton'
import { FollowButton } from '@/components/social/FollowButton'

// Canonical profile header — avatar circle, name, level + XP, progress
// bar, and a context-dependent right-side action: settings for owner,
// follow for any other logged-in viewer, nothing for anon viewers.
//
// Used by /u/[id] and any other surface that needs to render a profile
// (e.g. an in-tasting profile-preview modal). Visual changes here flow
// to every consumer — no JSX duplication.

interface Props {
  userId: number
  userName: string
  userXp: number
  myId: number | null
  isFollowing: boolean
}

export function ProfileHeader({ userId, userName, userXp, myId, isFollowing }: Props) {
  const level = getLevel(userXp)
  const nextXP = level.nextXP
  const progress = nextXP ? ((userXp - level.minXP) / (nextXP - level.minXP)) * 100 : 100
  const isOwner = myId === userId

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 14 }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(200,150,60,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700, color: 'var(--accent)', flexShrink: 0 }}>
          {userName[0].toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.1, marginBottom: 4 }}>{userName}</h1>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{level.icon} {level.name} · {userXp.toLocaleString()} XP</div>
          <div style={{ height: 3, background: 'var(--bg3)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, progress)}%`, background: 'var(--accent)', borderRadius: 2 }} />
          </div>
        </div>
        {isOwner ? (
          <ProfileSettingsButton />
        ) : myId ? (
          <FollowButton userId={userId} initialFollowing={isFollowing} />
        ) : null}
      </div>
    </div>
  )
}
