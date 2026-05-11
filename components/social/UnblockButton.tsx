'use client'
import { useState } from 'react'

interface Props {
  userId: number
  onUnblock?: () => void
}

// Unblock action from the blocker-side stripped profile view. Calls
// DELETE /api/me/blocks/:id and reloads to surface the freshly-visible
// profile. The simple reload (vs cache invalidation) matches the
// stripped view's flow: the page itself was a stripped state; we want
// the next render to fetch a fresh gate result, which includes pulling
// the full profile back.
//
// Inside the modal / participant-preview cache surfaces, we'll wire
// a proper invalidate-and-refetch path. This component is for the
// /u/[id] route where the whole page rerenders.
export function UnblockButton({ userId, onUnblock }: Props) {
  const [loading, setLoading] = useState(false)

  async function toggle() {
    setLoading(true)
    const res = await fetch(`/api/me/blocks/${userId}`, { method: 'DELETE' })
    setLoading(false)
    if (res.ok) {
      onUnblock?.()
      // Hard reload — the page was server-rendered as the stripped
      // view; we need a fresh SSR to surface the unblocked profile.
      if (typeof window !== 'undefined') window.location.reload()
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
        // Red destructive-accent — same treatment as the (un)mute and
        // (un)block visual primitives elsewhere.
        background: 'rgba(184,64,64,0.08)',
        borderColor: 'rgba(184,64,64,0.4)',
        color: 'rgba(184,64,64,0.95)',
      }}
    >
      {loading ? '…' : 'unblock'}
    </button>
  )
}
