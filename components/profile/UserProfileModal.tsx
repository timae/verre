'use client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Modal } from '@/components/ui/Modal'
import { ProfileHeader } from './ProfileHeader'
import { ProfileTabs } from './ProfileTabs'
import { ProfileShell } from './ProfileShell'
import { ProfileBlockedView } from './ProfileBlockedView'
import type { LoadedProfile } from '@/lib/profileLoad'

interface Props {
  userId: number
  myId: number | null
  onClose: () => void
}

// /api/users/[id] returns three shapes:
//   - blocked-by-me: `{id, name, blocked: true}` — viewer blocked target
//   - tier-gated:    `{id, name, gated: true, isFollowing}` — viewer can't see content per tier
//   - full payload:  LoadedProfile + `viewerMutes`
// Discriminate before reading content fields, otherwise `data.level.icon`
// etc. throw. (Blocked-side viewers — author blocked viewer — see 404
// from the server, so the modal never opens for them; no client branch
// needed for that direction.)
type ProfileResponse =
  | (LoadedProfile & { viewerMutes?: boolean })
  | { id: number; name: string; gated: true; isFollowing: boolean }
  | { id: number; name: string; blocked: true }

function isBlocked(p: ProfileResponse): p is { id: number; name: string; blocked: true } {
  return (p as { blocked?: boolean }).blocked === true
}

function isGated(p: ProfileResponse): p is { id: number; name: string; gated: true; isFollowing: boolean } {
  return (p as { gated?: boolean }).gated === true
}

// In-tasting profile viewer. Shows the same header + tabs that /u/[id]
// renders, fetched client-side via /api/users/<id> so the user stays
// in their session context. Render code is shared with the route
// (ProfileHeader + ProfileTabs); only the data-fetch path differs.
export function UserProfileModal({ userId, myId, onClose }: Props) {
  const qc = useQueryClient()
  // Same cache key as ProfilePreviewInline — they hit the same
  // endpoint and the modal's payload is a superset of the preview's.
  // Second open after a preview is instant from cache.
  const { data, isError } = useQuery<ProfileResponse>({
    queryKey: ['user-profile', userId],
    queryFn: () => fetch(`/api/users/${userId}`).then(r => {
      if (!r.ok) throw new Error(`status ${r.status}`)
      return r.json()
    }),
    staleTime: 30_000,
  })

  // A follow-toggle inside the modal may flip the gate (shell → full or
  // vice-versa). Invalidate so the modal — and any other surface sharing
  // this query key (ProfilePreviewInline) — refetches.
  function onFollowToggle() {
    qc.invalidateQueries({ queryKey: ['user-profile', userId] })
  }

  // A mute-toggle changes whether this user's content surfaces in the
  // viewer's feed. Invalidate both the profile payload (so viewerMutes
  // is fresh on next render) and any feed query so the muted user's
  // posts disappear (or reappear).
  function onMuteToggle() {
    qc.invalidateQueries({ queryKey: ['user-profile', userId] })
    qc.invalidateQueries({ queryKey: ['feed'] })
  }

  // A block toggle reshapes every viewer surface: profile (gate flips
  // to blocked-by-me or back), feed (block-pair authors filtered),
  // followers/following lists (block-pair rows + count drop), session
  // meta (viewerBlocksOut/In). Invalidate the lot.
  function onBlockToggle() {
    qc.invalidateQueries({ queryKey: ['user-profile', userId] })
    qc.invalidateQueries({ queryKey: ['feed'] })
    qc.invalidateQueries({ queryKey: ['profile-people'] })
    qc.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'session-meta' })
  }

  return (
    <Modal onClose={onClose} maxWidth={860} maxHeight="90vh">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
          {data?.name ?? 'Profile'}
        </div>
        <button className="btn-s" onClick={onClose} style={{ fontSize: 9 }}>close</button>
      </div>

      {isError && (
        <div style={{ fontSize: 12, color: 'var(--danger)', padding: '12px 0' }}>
          Couldn&apos;t load profile.
        </div>
      )}

      {!isError && !data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 0' }}>
          <div style={{ height: 80, background: 'var(--bg3)', borderRadius: 12 }} />
          <div style={{ height: 200, background: 'var(--bg3)', borderRadius: 12 }} />
        </div>
      )}

      {data && isBlocked(data) && (
        <ProfileBlockedView
          userId={data.id}
          userName={data.name}
          myId={myId}
        />
      )}

      {data && !isBlocked(data) && isGated(data) && (
        <ProfileShell
          userId={data.id}
          userName={data.name}
          myId={myId}
          isFollowing={data.isFollowing}
          onFollowToggle={onFollowToggle}
        />
      )}

      {data && !isBlocked(data) && !isGated(data) && (
        <>
          <ProfileHeader
            userId={data.id}
            userName={data.name}
            userXp={data.xp}
            userImageUrl={data.imageUrl}
            myId={myId}
            isFollowing={data.isFollowing}
            viewerMutes={data.viewerMutes}
            onFollowToggle={onFollowToggle}
            onMuteToggle={onMuteToggle}
            onBlockToggle={onBlockToggle}
          />
          <ProfileTabs
            profileUserId={data.id}
            profileUserName={data.name}
            profileUserXp={data.xp}
            profileUserImageUrl={data.imageUrl}
            myId={myId}
            viewerFollowsProfile={data.isFollowing}
            stats={{
              ratings: data.stats.ratings,
              checkins: data.stats.checkins,
              badges: data.stats.badges,
              followers: data.stats.followers,
            }}
            flavor={data.flavor}
            initialCheckins={data.recentCheckins.map(c => ({
              ...c,
              flavors: c.flavors as Record<string, number>,
            }))}
            initialSessionPosts={data.recentSessionPosts}
            // Modal overlay sits on top of an unrelated page (e.g.
            // /session/[code]/wines). Don't rewrite the underlying
            // URL with ?tab=... when switching tabs inside the modal.
            syncToUrl={false}
          />
        </>
      )}
    </Modal>
  )
}
