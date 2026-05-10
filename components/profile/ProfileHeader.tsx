import { getLevel } from '@/lib/badges'
import { ProfileSettingsButton } from './ProfileSettingsButton'
import { FollowButton } from '@/components/social/FollowButton'
import { EditableAvatar } from './EditableAvatar'
import { ZoomableAvatar } from './ZoomableAvatar'

interface Props {
  userId: number
  userName: string
  userXp: number
  userImageUrl?: string | null
  myId: number | null
  isFollowing: boolean
}

export function ProfileHeader({ userId, userName, userXp, userImageUrl, myId, isFollowing }: Props) {
  const level = getLevel(userXp)
  const nextXP = level.nextXP
  const progress = nextXP ? ((userXp - level.minXP) / (nextXP - level.minXP)) * 100 : 100
  const isOwner = myId === userId

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 14 }}>
        {isOwner
          ? <EditableAvatar name={userName} imageUrl={userImageUrl ?? null} size={56} />
          : <ZoomableAvatar name={userName} imageUrl={userImageUrl} size={56} />
        }
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
