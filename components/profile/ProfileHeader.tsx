'use client'
import { useRouter } from 'next/navigation'
import { getLevel } from '@/lib/badges'
import { formatNumber } from '@/lib/formatNumber'
import { ProfileSettingsButton } from './ProfileSettingsButton'
import { FollowButton } from '@/components/social/FollowButton'
import { ProfileActionsMenu } from './ProfileActionsMenu'
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
  // full (non-shell) view since the actions menu is hidden on the shell.
  viewerMutes?: boolean
  // Optional. Passed by callers in a client-cached context (e.g.
  // UserProfileModal) so a follow-toggle invalidates the cached
  // profile payload; the gate may flip when the viewer becomes a
  // follower or stops being one.
  //
  // SSR /u/[id] usage omits it; we fall back to router.refresh() so
  // an unfollow (or a follow that turned a non-mutual back into a
  // shell) re-runs resolveProfileViewer and re-renders with the new
  // gate without the user navigating away.
  //
  // The FollowButton's onToggle is (following: boolean) => void;
  // we ignore the param because the invalidation doesn't branch on
  // direction.
  onFollowToggle?: () => void
  // Mute toggle invalidates the feed cache so the muted user's content
  // disappears (or reappears) without a page reload.
  onMuteToggle?: () => void
  // Block toggle invalidates user-profile, feed, profile-people,
  // session-meta caches — block affects every viewer surface.
  onBlockToggle?: () => void
}

export function ProfileHeader({ userId, userName, userXp, userImageUrl, myId, isFollowing, viewerMutes, onFollowToggle, onMuteToggle, onBlockToggle }: Props) {
  const router = useRouter()
  const level = getLevel(userXp)
  const nextXP = level.nextXP
  const progress = nextXP ? ((userXp - level.minXP) / (nextXP - level.minXP)) * 100 : 100
  const isOwner = myId === userId

  // SSR /u/[id] callers omit these — fall back to router.refresh() so
  // the server gate re-evaluates (follow/unfollow flips shell↔ok; block
  // flips ok→blocked-by-me; mute changes the feed-filter side-effect).
  // Client-cached callers (UserProfileModal) pass their own invalidation.
  const handleFollowToggle = onFollowToggle ?? (() => router.refresh())
  const handleMuteToggle = onMuteToggle ?? (() => router.refresh())
  const handleBlockToggle = onBlockToggle ?? (() => router.refresh())

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 14 }}>
        {isOwner
          ? <EditableAvatar userId={userId} name={userName} imageUrl={userImageUrl ?? null} size={56} />
          : <ZoomableAvatar name={userName} imageUrl={userImageUrl} size={56} />
        }
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.1, marginBottom: 4 }}>{userName}</h1>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{level.icon} {level.name} · {formatNumber(userXp)} XP</div>
          <div style={{ height: 3, background: 'var(--bg3)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, progress)}%`, background: 'var(--accent)', borderRadius: 2 }} />
          </div>
        </div>
        {isOwner ? (
          <ProfileSettingsButton />
        ) : myId ? (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <FollowButton userId={userId} initialFollowing={isFollowing} onToggle={handleFollowToggle} />
            <ProfileActionsMenu
              userId={userId}
              viewerMutes={!!viewerMutes}
              onMuteToggle={handleMuteToggle}
              onBlockToggle={handleBlockToggle}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
