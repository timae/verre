'use client'
import { useQuery } from '@tanstack/react-query'
import { FollowButton } from '@/components/social/FollowButton'
import Link from 'next/link'

interface UserPayload {
  id: number
  name: string
  xp: number
  level: { icon: string; name: string }
  isFollowing: boolean
}

interface Props {
  userId: number
  isSelf: boolean
  viewerLoggedIn: boolean
}

export function ProfilePreviewInline({ userId, isSelf, viewerLoggedIn }: Props) {
  // Plain fetch (not authedFetch) — /api/users/<id> is anon-readable
  // and an anon viewer in a session must not be redirected to /login
  // if the call ever 401s.
  const { data, isError } = useQuery<UserPayload>({
    queryKey: ['user-profile', userId],
    queryFn: () => fetch(`/api/users/${userId}`).then(r => {
      if (!r.ok) throw new Error(`status ${r.status}`)
      return r.json()
    }),
    staleTime: 30_000,
  })

  return (
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
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 40, height: 40, borderRadius: '50%',
              background: 'rgba(200,150,60,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, fontWeight: 700, color: 'var(--accent)',
              flexShrink: 0,
            }}>
              {data.name[0]?.toUpperCase() ?? '?'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {data.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 2 }}>
                {data.level.icon} {data.level.name} · {data.xp.toLocaleString()} XP
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Link href={`/u/${userId}`} className="btn-s" style={{ flex: 1, fontSize: 9, textAlign: 'center', textDecoration: 'none' }}>
              visit profile
            </Link>
            {isSelf && (
              <Link href={`/u/${userId}`} className="btn-s" style={{ flex: 1, fontSize: 9, textAlign: 'center', textDecoration: 'none' }}>
                settings
              </Link>
            )}
            {!isSelf && viewerLoggedIn && (
              <div style={{ flex: 1 }}>
                <FollowButton userId={data.id} initialFollowing={data.isFollowing} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
