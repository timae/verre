'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
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

export function ProfilePreviewInline({ userId, isSelf, viewerLoggedIn, myId }: Props) {
  const [openProfile, setOpenProfile] = useState(false)
  const [openSettings, setOpenSettings] = useState(false)

  // Plain fetch (not authedFetch) — /api/users/<id> is anon-readable
  // and an anon viewer in a session must not be redirected to /login
  // if the call ever 401s. Shared cache key with UserProfileModal.
  const { data, isError } = useQuery<LoadedProfile>({
    queryKey: ['user-profile', userId],
    queryFn: () => fetch(`/api/users/${userId}`).then(r => {
      if (!r.ok) throw new Error(`status ${r.status}`)
      return r.json()
    }),
    staleTime: 30_000,
  })

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

        {data && (
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 12 }}>
            {/* aspect-ratio:1 + alignSelf:stretch makes the circle's
                height span name-row → visit-profile-row, and width
                follows that height so it stays a circle. */}
            <Avatar
              name={data.name}
              imageUrl={data.imageUrl}
              style={{
                alignSelf: 'stretch',
                aspectRatio: '1 / 1',
                fontSize: 'clamp(20px, 4vw, 32px)',
              }}
            />
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
                  <FollowButton userId={data.id} initialFollowing={data.isFollowing} />
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
