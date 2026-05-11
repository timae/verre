'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FollowButton } from '@/components/social/FollowButton'
import { UserProfileModal } from './UserProfileModal'
import { AccountSettingsModal } from '@/components/me/AccountSettingsModal'
import { Avatar } from './Avatar'
import type { LoadedProfile } from '@/lib/profileLoad'

interface Props {
  userId: number
  isSelf: boolean
  viewerLoggedIn: boolean
  myId: number | null
}

// /api/users/[id] returns three shapes:
//   - blocked-by-me: `{id, name, blocked: true}` — viewer blocked target
//   - tier-gated:    `{id, name, gated: true, isFollowing}`
//   - full payload:  LoadedProfile + `viewerMutes`
// Discriminate before reading content fields, otherwise `data.level.icon`
// / `data.xp.toLocaleString()` throw. The full payload also includes
// `viewerMutes` (handled in the modal, not surfaced here — the inline
// preview doesn't render a mute button).
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

export function ProfilePreviewInline({ userId, isSelf, viewerLoggedIn, myId }: Props) {
  const qc = useQueryClient()
  const [openProfile, setOpenProfile] = useState(false)
  const [openSettings, setOpenSettings] = useState(false)

  // Plain fetch (not authedFetch) — /api/users/<id> is anon-readable
  // and an anon viewer in a session must not be redirected to /login
  // if the call ever 401s. Shared cache key with UserProfileModal.
  const { data, isError } = useQuery<ProfileResponse>({
    queryKey: ['user-profile', userId],
    queryFn: () => fetch(`/api/users/${userId}`).then(r => {
      if (!r.ok) throw new Error(`status ${r.status}`)
      return r.json()
    }),
    staleTime: 30_000,
  })

  // A follow-toggle on this user can flip their gate (`public-followers`
  // becomes visible; `public-mutual` becomes visible if the reverse edge
  // already exists). Invalidate so the preview AND the modal (shared
  // query key) refetch the gate state before any further interaction.
  function onFollowToggle() {
    qc.invalidateQueries({ queryKey: ['user-profile', userId] })
  }

  return (
    <>
      <div style={{
        marginLeft: 16, marginTop: 4, marginBottom: 4,
        padding: 12,
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {isError && (
          <div style={{ fontSize: 11, color: '#e07070' }}>Couldn&apos;t load profile.</div>
        )}

        {!isError && !data && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--bg3)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ height: 11, background: 'var(--bg3)', borderRadius: 3, width: '50%' }} />
              <div style={{ height: 9,  background: 'var(--bg3)', borderRadius: 3, width: '40%' }} />
            </div>
          </div>
        )}

        {data && isBlocked(data) && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <Avatar name={data.name} imageUrl={null} size={96} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {data.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>blocked</div>
              <button className="btn-s" onClick={() => setOpenProfile(true)} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                visit profile
              </button>
            </div>
          </div>
        )}

        {data && !isBlocked(data) && isGated(data) && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <Avatar name={data.name} imageUrl={null} size={96} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 13, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {data.name}
                </div>
                {viewerLoggedIn && !isSelf ? (
                  <FollowButton userId={data.id} initialFollowing={data.isFollowing} onToggle={onFollowToggle} />
                ) : null}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>private profile</div>
              <button className="btn-s" onClick={() => setOpenProfile(true)} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                visit profile
              </button>
            </div>
          </div>
        )}

        {data && !isBlocked(data) && !isGated(data) && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            {/* Fixed size — earlier "stretch to right-column height"
                burst out of the panel when an image rendered. 96px
                matches the natural height of name+level+button. */}
            <Avatar name={data.name} imageUrl={data.imageUrl} size={96} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 13, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {data.name}
                </div>
                {isSelf ? (
                  <button className="btn-s" onClick={() => setOpenSettings(true)} style={{ flexShrink: 0 }}>
                    settings
                  </button>
                ) : viewerLoggedIn ? (
                  <FollowButton userId={data.id} initialFollowing={data.isFollowing} onToggle={onFollowToggle} />
                ) : null}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
                {data.level.icon} {data.level.name} · {data.xp.toLocaleString()} XP
              </div>
              <button className="btn-s" onClick={() => setOpenProfile(true)} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                visit profile
              </button>
            </div>
          </div>
        )}
      </div>

      {openProfile && <UserProfileModal userId={userId} myId={myId} onClose={() => setOpenProfile(false)} />}
      {openSettings && <AccountSettingsModal onClose={() => setOpenSettings(false)} />}
    </>
  )
}
