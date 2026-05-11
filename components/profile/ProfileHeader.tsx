import { getLevel } from '@/lib/badges'
import { ProfileSettingsButton } from './ProfileSettingsButton'
import { FollowButton } from '@/components/social/FollowButton'
import { MuteButton } from '@/components/social/MuteButton'
import { EditableAvatar } from './EditableAvatar'
import { ZoomableAvatar } from './ZoomableAvatar'

interface Props {
  userId: number
  userName: string
  userXp: number
  userImageUrl?: string | null
  myId: number | null
  isFollowing: boolean
  // Whether the viewer has muted this profile. Only meaningful on the
  // full (non-shell) view since the mute button is hidden on the shell.
  viewerMutes?: boolean
  // Optional. Passed by callers in a client-cached context (e.g.
  // UserProfileModal) so a follow-toggle invalidates the cached
  // profile payload; the gate may flip when the viewer becomes a
  // follower or stops being one. SSR /u/[id] usage doesn't need it
  // — the page is server-rendered and the next nav refetches.
  // The FollowButton's onToggle is (following: boolean) => void;
  // we ignore the param because the invalidation doesn't branch on
  // direction.
  onFollowToggle?: () => void
  // Same shape, but for the mute toggle. The feed query cache should
  // invalidate when mute state changes so the muted user's content
  // disappears (or reappears) from the feed without a page reload.
  onMuteToggle?: () => void
}

export function ProfileHeader({ userId, userName, userXp, userImageUrl, myId, isFollowing, viewerMutes, onFollowToggle, onMuteToggle }: Props) {
  const level = getLevel(userXp)
  const nextXP = level.nextXP
  const progress = nextXP ? ((userXp - level.minXP) / (nextXP - level.minXP)) * 100 : 100
  const isOwner = myId === userId

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 14 }}>
        {isOwner
          ? <EditableAvatar userId={userId} name={userName} imageUrl={userImageUrl ?? null} size={56} />
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
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <MuteButton userId={userId} initialMuted={!!viewerMutes} onToggle={onMuteToggle} />
            <FollowButton userId={userId} initialFollowing={isFollowing} onToggle={onFollowToggle} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
