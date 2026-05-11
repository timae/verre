'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  userId: number
  viewerMutes: boolean
  // Optional callbacks — wired by callers in a TanStack Query context
  // so a state change invalidates the relevant caches (feed, user
  // profile, session-meta, etc.). SSR usage can omit them.
  onMuteToggle?: () => void
  onBlockToggle?: () => void
}

// 3-dot menu next to the FollowButton on a profile header. Houses Mute
// and Block — both "manage relationship" gestures that don't belong as
// direct buttons (header has limited horizontal space; both are
// secondary to Follow).
//
// Two-tap commit on both actions, matching the ConfirmDeleteButton
// pattern used for other reversible-but-meaningful actions in the app:
//   - First tap arms the button (color shifts to the accent), label
//     becomes "Confirm …".
//   - Second tap commits.
//   - Outside-click or Escape resets the armed state.
//
// Visual treatment:
//   - Mute uses the accent (orange) — it's a softer action.
//   - Block uses the .btn-del red accent — it's the stronger action.
//
// Unmute is single-tap (undo is harmless). Block path is one-way in
// this menu: the upstream gate routes blocker-side views to
// <ProfileBlockedView>, which has its own inline unblock. The settings
// "Blocked users" list is the canonical place to manage past blocks.
type Flash = 'muted' | 'unmuted' | 'blocked' | null

export function ProfileActionsMenu({ userId, viewerMutes, onMuteToggle, onBlockToggle }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [muted, setMuted] = useState(viewerMutes)
  const [muteArmed, setMuteArmed] = useState(false)
  const [blockArmed, setBlockArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  // Brief confirmation flash in the menu item label after a successful
  // toggle. Mute flash auto-closes the menu after ~700ms. Block flash
  // bridges the gap before the cache invalidates and the profile view
  // flips to ProfileBlockedView. Mutual exclusion (only one flash at a
  // time) is encoded in the single state.
  const [flash, setFlash] = useState<Flash>(null)
  const ref = useRef<HTMLDivElement>(null)
  // Track the post-success setTimeout so we can clear it on unmount —
  // otherwise React logs a setState-after-unmount warning and a stray
  // router.refresh() / window.location.reload() can fire after the
  // component is gone.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
  }, [])

  // Sync local state when the parent passes fresh server values (e.g.
  // after a cache invalidation re-fetched the profile).
  useEffect(() => { setMuted(viewerMutes) }, [viewerMutes])

  // Close on outside click / Escape so the menu doesn't get stuck open
  // when the user moves on. Resets any armed state so the next open
  // starts clean.
  useEffect(() => {
    if (!open) return
    const dismiss = () => {
      setOpen(false)
      setMuteArmed(false)
      setBlockArmed(false)
    }
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) dismiss()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Toggle mute. Unmute is single-tap (harmless undo). Mute requires
  // a confirm tap so accidental selection in a small menu doesn't
  // silently hide someone.
  async function doMute() {
    if (busy) return
    if (muted) {
      // Unmute path — single-tap.
      setBusy(true)
      const res = await fetch(`/api/me/mutes/${userId}`, { method: 'DELETE' })
      setBusy(false)
      if (res.ok) {
        setMuted(false)
        setFlash('unmuted')
        onMuteToggle?.()
        flashTimer.current = setTimeout(() => { setFlash(null); setOpen(false) }, 700)
      }
      return
    }
    if (!muteArmed) {
      setMuteArmed(true)
      // Disarm the block button if the user was about to confirm that
      // and changed direction — only one action can be armed at a time.
      setBlockArmed(false)
      return
    }
    setBusy(true)
    const res = await fetch(`/api/me/mutes/${userId}`, { method: 'POST' })
    setBusy(false)
    if (res.ok) {
      setMuted(true)
      setMuteArmed(false)
      setFlash('muted')
      onMuteToggle?.()
      flashTimer.current = setTimeout(() => { setFlash(null); setOpen(false) }, 700)
    }
  }

  // Block is one-way from this menu — upstream gate replaces this view
  // with <ProfileBlockedView> once a block exists. Two-tap commit.
  async function doBlock() {
    if (busy) return
    if (!blockArmed) {
      setBlockArmed(true)
      setMuteArmed(false)
      return
    }
    setBusy(true)
    const res = await fetch(`/api/me/blocks/${userId}`, { method: 'POST' })
    setBusy(false)
    if (res.ok) {
      setBlockArmed(false)
      setFlash('blocked')
      // Flash for ~700ms so the user sees something happened before
      // the profile view flips to ProfileBlockedView. Modal-based
      // callers wire onBlockToggle for TanStack invalidation; SSR
      // callers (e.g. /u/[id]) use router.refresh() to re-run the
      // gate server-side without a full document reload.
      flashTimer.current = setTimeout(() => {
        setOpen(false)
        setFlash(null)
        if (onBlockToggle) onBlockToggle()
        else router.refresh()
      }, 700)
    }
  }

  // Color tokens — kept inline for clarity. Mute armed = accent orange,
  // matches FollowButton's accent treatment. Block armed = .btn-del red.
  const accentBg = 'rgba(200,150,60,0.12)'
  const accentColor = 'var(--accent)'
  const delBg = 'rgba(184,64,64,0.12)'
  const delColor = 'rgba(184,64,64,0.95)'
  const muteFlashing = flash === 'muted' || flash === 'unmuted'
  const blockFlashing = flash === 'blocked'

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(v => !v)}
        aria-label="More actions"
        className="btn-s"
        style={{
          width: 36, marginTop: 0, padding: '10px 0',
          textAlign: 'center', fontSize: 16, lineHeight: 1,
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 6,
            minWidth: 160, zIndex: 20,
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            padding: 4, display: 'flex', flexDirection: 'column', gap: 2,
          }}
        >
          <button
            onClick={doMute}
            disabled={busy || flash !== null}
            style={{
              textAlign: 'left', padding: '8px 10px', fontSize: 12,
              background: muteArmed || muteFlashing ? accentBg : 'transparent',
              border: 'none', cursor: 'pointer',
              color: muteArmed || muteFlashing ? accentColor : 'var(--fg)',
              borderRadius: 4,
            }}
            onMouseEnter={e => { if (!muteArmed && !muteFlashing) e.currentTarget.style.background = 'var(--bg3)' }}
            onMouseLeave={e => { if (!muteArmed && !muteFlashing) e.currentTarget.style.background = 'transparent' }}
          >
            {flash === 'muted' ? 'Muted ✓'
              : flash === 'unmuted' ? 'Unmuted ✓'
              : muted ? 'Unmute'
              : muteArmed ? 'Confirm mute'
              : 'Mute'}
          </button>
          <button
            onClick={doBlock}
            disabled={busy || flash !== null}
            style={{
              textAlign: 'left', padding: '8px 10px', fontSize: 12,
              background: blockArmed || blockFlashing ? delBg : 'transparent',
              border: 'none', cursor: 'pointer',
              color: blockArmed || blockFlashing ? delColor : 'var(--fg)',
              borderRadius: 4,
            }}
            onMouseEnter={e => { if (!blockArmed && !blockFlashing) e.currentTarget.style.background = 'var(--bg3)' }}
            onMouseLeave={e => { if (!blockArmed && !blockFlashing) e.currentTarget.style.background = 'transparent' }}
          >
            {blockFlashing ? 'Blocked ✓' : blockArmed ? 'Confirm block' : 'Block'}
          </button>
        </div>
      )}
    </div>
  )
}
