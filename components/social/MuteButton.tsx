'use client'
import { useState } from 'react'

interface Props {
  userId: number
  initialMuted: boolean
  onToggle?: () => void
}

// Per-pair soft-hide button. Toggles `user_mutes` for (viewer → target).
// Independent of follow state — muting doesn't unfollow, unfollowing
// doesn't unmute. Action is silent to the muted user.
//
// Visual treatment: "mute" is the destructive/strong action and uses the
// red accent shared with `.btn-del` so its weight matches `<FollowButton>`'s
// accent fill while signalling its different intent. Once muted, the
// button drops back to neutral ("unmute" — the undo action).
export function MuteButton({ userId, initialMuted, onToggle }: Props) {
  const [muted, setMuted] = useState(initialMuted)
  const [loading, setLoading] = useState(false)

  async function toggle() {
    setLoading(true)
    const method = muted ? 'DELETE' : 'POST'
    const res = await fetch(`/api/me/mutes/${userId}`, { method })
    setLoading(false)
    if (res.ok) {
      setMuted(!muted)
      onToggle?.()
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
        // Same red-accent treatment as `.btn-del` while the action is
        // available ("mute"). Once muted, drop back to neutral so the
        // page doesn't carry a constant red anchor.
        ...(muted
          ? {}
          : { background: 'rgba(184,64,64,0.08)', borderColor: 'rgba(184,64,64,0.4)', color: 'rgba(184,64,64,0.95)' }),
      }}
    >
      <span aria-hidden="true" style={{ visibility: 'hidden' }}>unmute</span>
      <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {loading ? '…' : muted ? 'unmute' : 'mute'}
      </span>
    </button>
  )
}
