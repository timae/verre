'use client'
import { useEffect, useRef, useState } from 'react'

interface Props {
  // Target participant identity-id (`u:<n>` or `a:<uuid>`).
  identityId: string
  // Display name for the host-side confirm modal copy.
  displayName: string
  // Whether the target is currently a cohost — affects which actions are
  // shown and whether strict-host gating is needed downstream. The
  // strict-host check itself happens on the server; this flag exists so
  // the menu can be hidden entirely when a cohost is viewing another
  // cohost (the server would reject anyway, but no menu = no confusion).
  targetIsCohost: boolean
  // Whether the viewer is the strict (original) host. Cohosts and strict
  // host both call this menu; only strict host can target a cohost.
  viewerIsStrictHost: boolean
  // Called when the user picks Kick or Ban — caller opens the preview
  // modal and follows through with the POST.
  onPickKick: (identityId: string, displayName: string) => void
  onPickBan: (identityId: string, displayName: string) => void
}

// 3-dot ⋯ menu next to a participant row in SessionPanel. Host-only.
// Items: Kick, Ban. Tapping either fires the corresponding callback so
// the parent can open the preview modal — confirmation lives in the
// modal, not here. (Unlike ProfileActionsMenu's two-tap mute/block, the
// ban/kick flow already has a confirmation step via the modal.)
//
// Cohosts can target regular participants only — when a cohost would
// view another cohost's row, the parent hides this menu entirely.
export function ParticipantActionsMenu({
  identityId,
  displayName,
  targetIsCohost,
  viewerIsStrictHost,
  onPickKick,
  onPickBan,
}: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = () => setOpen(false)
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) dismiss()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
    // pointerdown covers mouse + touch + pen consistently across
    // browsers; mousedown-only listeners miss first-touch dismissal
    // on older iOS Safari.
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // If the target is a cohost and the viewer is just a cohost (not
  // strict host), the menu shouldn't appear at all. Parent should gate
  // this, but defense-in-depth here too.
  if (targetIsCohost && !viewerIsStrictHost) return null

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        aria-label="Participant actions"
        className="btn-s"
        style={{
          width: 28, padding: '3px 0',
          textAlign: 'center', fontSize: 14, lineHeight: 1,
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4,
            minWidth: 140, zIndex: 20,
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            padding: 4, display: 'flex', flexDirection: 'column', gap: 2,
          }}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={() => { setOpen(false); onPickKick(identityId, displayName) }}
            style={{
              textAlign: 'left', padding: '8px 10px', fontSize: 12,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--fg)', borderRadius: 4,
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            Kick
          </button>
          <button
            onClick={() => { setOpen(false); onPickBan(identityId, displayName) }}
            style={{
              textAlign: 'left', padding: '8px 10px', fontSize: 12,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'rgba(184,64,64,0.95)', borderRadius: 4,
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(184,64,64,0.08)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            Ban
          </button>
        </div>
      )}
    </div>
  )
}
