'use client'
import { useState } from 'react'

interface Props { userId: number; initialFollowing: boolean; onToggle?: (following: boolean) => void }

export function FollowButton({ userId, initialFollowing, onToggle }: Props) {
  const [following, setFollowing] = useState(initialFollowing)
  const [loading, setLoading] = useState(false)

  async function toggle() {
    setLoading(true)
    const method = following ? 'DELETE' : 'POST'
    const res = await fetch(`/api/users/${userId}/follow`, { method })
    setLoading(false)
    if (res.ok) {
      const next = !following
      setFollowing(next)
      onToggle?.(next)
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={loading}
      className={following ? 'btn-g' : 'btn-s'}
      style={{
        minWidth: 80, marginTop: 0,
        ...(following ? {} : { background: 'rgba(200,150,60,0.1)', borderColor: 'rgba(200,150,60,0.4)', color: 'var(--accent)' }),
      }}
    >
      {loading ? '…' : following ? 'following' : '+ follow'}
    </button>
  )
}
