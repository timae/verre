'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getLevel } from '@/lib/badges'
import { FollowButton } from '@/components/social/FollowButton'
import { ProfileActionsMenu } from './ProfileActionsMenu'
import { Avatar } from './Avatar'

type Direction = 'followers' | 'following'
type MutualFilter = 'mutual' | 'all' | 'non'
type PersonRow = {
  id: number; name: string; xp: number
  imageUrl: string | null
  isFollowing: boolean
  viewerMutes: boolean
  profileFollowsThem: boolean | null
}

const EMPTY_COPY: Record<Direction, Record<MutualFilter, string>> = {
  followers: { mutual: 'No mutual followers yet.', all: 'No followers yet.', non: 'No non-mutual followers.' },
  following: { mutual: 'No mutual followings yet.', all: 'Not following anyone yet.', non: 'No non-mutual followings.' },
}

interface Props {
  profileUserId: number
  myId: number | null
}

export function ProfilePanelPeople({ profileUserId, myId }: Props) {
  const qc = useQueryClient()
  const [direction, setDirection] = useState<Direction>('followers')
  const [mutual, setMutual] = useState<MutualFilter>('all')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')

  // Debounce search input → server query. The server enforces a 2-char
  // minimum; mirroring it client-side avoids a wasted request and a flash
  // of "no results" while the user is still typing.
  const trimmed = qInput.trim()
  const tooShort = trimmed.length === 1
  useEffect(() => {
    const t = setTimeout(() => setQ(tooShort ? '' : trimmed), 250)
    return () => clearTimeout(t)
  }, [trimmed, tooShort])

  const queryKey = ['profile-people', profileUserId, direction, mutual, q]
  const { data, isLoading } = useQuery<{ users: PersonRow[]; nextCursor: string | null }>({
    queryKey,
    queryFn: async () => {
      const url = new URL(`/api/users/${profileUserId}/${direction}`, window.location.origin)
      if (mutual !== 'all') url.searchParams.set('mutual', mutual)
      if (q) url.searchParams.set('q', q)
      const res = await fetch(url.pathname + url.search)
      if (!res.ok) return { users: [], nextCursor: null }
      return res.json()
    },
  })

  const users = data?.users ?? []
  const empty = !isLoading && users.length === 0

  return (
    <div>
      {/* Direction toggle */}
      <div className="seg" style={{ marginBottom:10 }}>
        {(['followers', 'following'] as Direction[]).map(d => (
          <button key={d} type="button" onClick={() => setDirection(d)}
            className="seg-item" data-active={direction === d ? '' : undefined}>
            {d === 'followers' ? 'Followers' : 'Following'}
          </button>
        ))}
      </div>

      {/* Mutual filter pill + search */}
      <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap', alignItems:'center' }}>
        <div className="pill-row">
          {([
            ['mutual', 'Mutuals'],
            ['all', 'All'],
            ['non', 'Non-mutuals'],
          ] as [MutualFilter, string][]).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setMutual(k)}
              className="pill" data-active={mutual === k ? '' : undefined}>
              {label}
            </button>
          ))}
        </div>
        <input
          className="fi"
          value={qInput}
          onChange={e => setQInput(e.target.value)}
          placeholder="search by name…"
          style={{ flex:'1 1 160px', minWidth:0, padding:'8px 12px', fontSize:12 }}
        />
      </div>

      {tooShort ? (
        <p style={{ color:'var(--fg-dim)', fontSize:13, padding:'16px 0' }}>
          Type at least 2 characters to search.
        </p>
      ) : (
        <>
          {isLoading && <p style={{ color:'var(--fg-dim)', fontSize:13 }}>Loading…</p>}
          {empty && (
            <p style={{ color:'var(--fg-dim)', fontSize:13, padding:'16px 0' }}>
              {q ? 'No matches.' : EMPTY_COPY[direction][mutual]}
            </p>
          )}
          {users.map(u => (
            <PersonRow
              key={u.id}
              row={u}
              myId={myId}
              direction={direction}
              onFollowToggle={() => {
                // Invalidate all profile-people queries for THIS profile —
                // any active mutual-filter view (mutual/non/all) may need
                // to reclassify rows when an edge flips. Also invalidate
                // the user-profile cache for the toggled user so any
                // inline preview / modal of theirs refreshes the gate.
                qc.invalidateQueries({ queryKey: ['profile-people', profileUserId] })
                qc.invalidateQueries({ queryKey: ['user-profile', u.id] })
              }}
            />
          ))}
        </>
      )}
    </div>
  )
}

function PersonRow({ row, myId, direction, onFollowToggle }: { row: PersonRow; myId: number | null; direction: Direction; onFollowToggle?: () => void }) {
  const level = getLevel(row.xp)
  const showFollowsYou = direction === 'followers' && myId !== null && row.profileFollowsThem === false && row.id !== myId
  const isMe = myId !== null && myId === row.id
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:10, padding:'10px 12px', marginBottom:6,
      borderRadius:10, background:'var(--bg3)', border:'1px solid var(--border)',
    }}>
      <Link href={`/u/${row.id}`} style={{ display:'flex', alignItems:'center', gap:10, flex:1, minWidth:0, textDecoration:'none' }}>
        <Avatar name={row.name} imageUrl={row.imageUrl} size={36} />
        <div style={{ minWidth:0, flex:1 }}>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--fg)', lineHeight:1.2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {row.name}
            {isMe && <span style={{color:'var(--fg-dim)',fontWeight:400,marginLeft:6}}>· you</span>}
          </div>
          <div style={{ fontSize:10, color:'var(--fg-dim)', marginTop:2, display:'flex', gap:8 }}>
            <span>{level.icon} {level.name}</span>
            {showFollowsYou && (
              <span style={{ color:'var(--accent)', fontFamily:'var(--mono)', letterSpacing:'0.04em' }}>· follows you</span>
            )}
          </div>
        </div>
      </Link>
      {myId !== null && !isMe && (
        row.isFollowing
          // Following → status pill ("following", non-interactive) + kebab
          // menu (Unfollow / Mute / Block, all two-tap). The pill mirrors
          // the old single-button look as a read-only indicator; the kebab
          // is the only way to act on the relationship. Tapping anywhere
          // else on the row navigates to the profile via the Link above.
          ? <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
              <span style={{
                fontFamily:'var(--mono)', fontSize:11, letterSpacing:'0.06em',
                color:'var(--fg-dim)', padding:'4px 8px',
                border:'1px solid var(--border)', borderRadius:6,
              }}>following</span>
              <ProfileActionsMenu
                userId={row.id}
                viewerMutes={row.viewerMutes}
                viewerFollowing={true}
                onUnfollowToggle={onFollowToggle}
                onMuteToggle={onFollowToggle}
                onBlockToggle={onFollowToggle}
              />
            </div>
          // Not following → keep the one-tap +follow affordance. Following
          // is non-destructive so a single tap is fine.
          : <FollowButton userId={row.id} initialFollowing={row.isFollowing} onToggle={onFollowToggle} />
      )}
    </div>
  )
}

