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
      className="btn-s"
      style={{
        width: 'auto', marginTop: 0, padding: '10px 14px',
        position: 'relative',
        textAlign: 'center',
        // Accent fill differentiates "do this" (follow) from "done"
        // (following) without changing typography or shape.
        ...(following ? {} : { background: 'rgba(200,150,60,0.1)', borderColor: 'rgba(200,150,60,0.4)', color: 'var(--accent)' }),
      }}
    >
      {/* Invisible width-anchor (longest label) sets the button's
          intrinsic width; visible label is absolutely positioned on
          top so the button doesn't reflow across loading/follow/
          following transitions. */}
      <span aria-hidden="true" style={{ visibility: 'hidden' }}>following</span>
      <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {loading ? '…' : following ? 'following' : '+ follow'}
      </span>
    </button>
  )
}
