'use client'
import { useEffect, useRef, useState } from 'react'
import { sessionFetch } from '@/lib/sessionFetch'

export type ParticipantRole = 'taster' | 'co_host' | 'provider'

interface Props {
  code: string
  // Target participant identity-id (`u:<n>` or `a:<uuid>`).
  identityId: string
  // Current role of the target (used to omit the current option from
  // the picker — there's no point in offering "set to what they
  // already are").
  currentRole: ParticipantRole
  // Whether the viewer is the strict (original) host. Strict-host sees
  // co-host as an option in the picker; cohost viewers don't (cohost
  // role changes are strict-host only).
  viewerIsStrictHost: boolean
  // Called after a successful role change so the parent can invalidate
  // cached session-state / refetch.
  onChanged: () => void
}

// Picker for changing a participant's role. Tap the inline button →
// popover opens to the left → tap the desired role → POST set-role.
//
// Order is locked: Co-host, Provider, Taster (top to bottom).
// The target's current role is omitted from the list (offering "set to
// what they already are" is noise).
//
// Cohost viewers see only Taster + Provider — promoting/demoting cohost
// is strict-host-only, enforced both here and server-side.
export function SetRoleButton({ code, identityId, currentRole, viewerIsStrictHost, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = () => { setOpen(false); setError('') }
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) dismiss()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Build picker options. Always omit the current role. Cohost option
  // hidden for non-strict-host viewers (server would 403 anyway, but
  // not offering it is the better UX).
  const options: { role: ParticipantRole; label: string; hint: string }[] = []
  if (viewerIsStrictHost && currentRole !== 'co_host') {
    options.push({ role: 'co_host', label: 'Co-host', hint: 'Co-runs with you; deletion stays yours' })
  }
  if (currentRole !== 'provider') {
    options.push({ role: 'provider', label: 'Provider', hint: 'Brings wines; can edit only the ones they added' })
  }
  if (currentRole !== 'taster') {
    options.push({ role: 'taster', label: 'Taster', hint: 'Rate and bookmark, no other powers' })
  }

  async function setRole(role: ParticipantRole) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await sessionFetch(code, `/api/session/${code}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-role', targetId: identityId, role }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Could not change role')
        return
      }
      setOpen(false)
      onChanged()
    } catch {
      setError('Network error')
    } finally {
      setBusy(false)
    }
  }

  // Button label reflects the current state. "Set role" when the target
  // is a plain taster, "Change role" otherwise.
  const buttonLabel = currentRole === 'taster' ? 'set role' : 'change role'

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        className="btn-s"
        style={{ fontSize: 9, padding: '3px 8px' }}
      >
        {buttonLabel}
      </button>
      {open && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 200,
            zIndex: 30,
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {options.length === 0 && (
            <p style={{ padding: '8px 10px', fontSize: 11, color: 'var(--fg-dim)' }}>No role changes available.</p>
          )}
          {options.map(o => (
            <button
              key={o.role}
              onClick={() => setRole(o.role)}
              disabled={busy}
              style={{
                textAlign: 'left',
                padding: '8px 10px',
                fontSize: 12,
                background: 'transparent',
                border: 'none',
                cursor: busy ? 'wait' : 'pointer',
                color: 'var(--fg)',
                borderRadius: 4,
                lineHeight: 1.4,
              }}
              onMouseEnter={e => { if (!busy) e.currentTarget.style.background = 'var(--bg3)' }}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{ fontWeight: 600 }}>{o.label}</div>
              <div style={{ fontSize: 10, color: 'var(--fg-dim)', marginTop: 2 }}>{o.hint}</div>
            </button>
          ))}
          {error && <p style={{ color: 'var(--danger)', fontSize: 11, padding: '4px 10px' }}>{error}</p>}
        </div>
      )}
    </div>
  )
}
