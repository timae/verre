'use client'
import { useState } from 'react'

interface Props { checkinId: number; initialLiked: boolean; initialCount: number }

export function LikeButton({ checkinId, initialLiked, initialCount }: Props) {
  const [liked, setLiked] = useState(initialLiked)
  const [count, setCount] = useState(initialCount)
  const [loading, setLoading] = useState(false)

  async function toggle() {
    setLoading(true)
    // Optimistic
    setLiked(!liked)
    setCount(c => liked ? c - 1 : c + 1)
    const method = liked ? 'DELETE' : 'POST'
    const res = await fetch(`/api/checkins/${checkinId}/like`, { method })
    setLoading(false)
    if (res.ok) {
      const data = await res.json()
      setLiked(data.liked)
      setCount(data.count)
    } else {
      // Revert on error
      setLiked(liked)
      setCount(c => liked ? c + 1 : c - 1)
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={loading}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        background: 'none', border: 'none', cursor: 'pointer',
        fontSize: 12, color: liked ? '#e07070' : 'var(--fg-faint)',
        fontFamily: 'var(--mono)', transition: 'color .15s',
        padding: '4px 8px', borderRadius: 6,
      }}
    >
      <span style={{ fontSize: 14, lineHeight: 1 }}>{liked ? '❤️' : '🤍'}</span>
      {count > 0 && <span>{count}</span>}
    </button>
  )
}
