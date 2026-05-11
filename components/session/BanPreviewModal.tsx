'use client'
import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { WineIdentity } from '@/components/wine/WineIdentity'
import { sessionFetch } from '@/lib/sessionFetch'

interface Props {
  code: string
  identityId: string
  displayName: string
  mode: 'kick' | 'ban'
  onClose: () => void
  onConfirmed: () => void
}

interface Preview {
  ratingCount: number
  addedWines: { id: string; name: string; vintage?: string | null; producer?: string | null }[]
}

// Modal shown when a host picks Kick or Ban from a participant row. The
// preview enumerates the target's session-scoped data so the host can
// decide what to do with their wines and (for ban) understands what
// gets wiped.
//
// Both modes use the same payload + same toggle ("Delete their wines?").
// Ban additionally surfaces ratingCount so the host sees the scale of
// the wipe; kick shows it as informational (the user gets to choose
// later via the bounce screen).
export function BanPreviewModal({ code, identityId, displayName, mode, onClose, onConfirmed }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [deleteWines, setDeleteWines] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const enc = encodeURIComponent(identityId)
        // sessionFetch attaches the anon-token header for anon hosts and
        // handles X-Vr-Auth headers consistently with the rest of the
        // session UI. Also tells the browser to skip its own cache so
        // a re-open of the modal sees fresh wine + rating counts.
        const res = await sessionFetch(code, `/api/session/${code}/bans/preview/${enc}`, {
          cache: 'no-store',
        })
        if (cancelled) return
        if (!res.ok) { setError('Could not load preview'); return }
        const data = await res.json()
        setPreview({ ratingCount: data.ratingCount ?? 0, addedWines: data.addedWines ?? [] })
      } catch {
        if (!cancelled) setError('Could not load preview')
      }
    })()
    return () => { cancelled = true }
  }, [code, identityId])

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      const res = await sessionFetch(code, `/api/session/${code}/bans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityId, mode, deleteAddedWines: deleteWines }),
      })
      setSubmitting(false)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Could not complete the action')
        return
      }
      onConfirmed()
    } catch {
      setSubmitting(false)
      setError('Network error')
    }
  }

  const verb = mode === 'kick' ? 'Remove' : 'Ban'
  const wineCount = preview?.addedWines.length ?? 0
  const accentRed = 'rgba(184,64,64,0.95)'

  return (
    <Modal onClose={onClose} maxWidth={460}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
          {verb} {displayName}?
        </div>
        <button className="btn-s" onClick={onClose} style={{ fontSize: 9 }}>close</button>
      </div>

      {mode === 'ban' && (
        <p style={{ fontSize: 12, color: 'var(--fg-dim)', marginBottom: 14, lineHeight: 1.5 }}>
          They'll be removed from this tasting and prevented from rejoining. Their ratings, hall-of-fame entries, and bookmarks from this session will be deleted.
        </p>
      )}
      {mode === 'kick' && (
        <p style={{ fontSize: 12, color: 'var(--fg-dim)', marginBottom: 14, lineHeight: 1.5 }}>
          They'll be removed from this tasting. They can rejoin if they have the code. They'll choose later whether to keep their ratings in their personal history.
        </p>
      )}

      {preview ? (
        <>
          {preview.ratingCount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 10 }}>
              They added <strong style={{ color: 'var(--fg)' }}>{preview.ratingCount}</strong> rating{preview.ratingCount === 1 ? '' : 's'}.
              {mode === 'kick' ? ' (Their call to keep or delete.)' : ' (Will be deleted.)'}
            </div>
          )}

          {wineCount > 0 && (
            <div style={{ marginBottom: 14, border: '1px solid var(--border)', borderRadius: 10, padding: '12px 12px 8px', background: 'var(--bg3)' }}>
              <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 8 }}>
                They added <strong style={{ color: 'var(--fg)' }}>{wineCount}</strong> wine{wineCount === 1 ? '' : 's'} to this tasting:
              </div>
              <div style={{ maxHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 4 }}>
                {preview.addedWines.map(w => (
                  <div key={w.id} style={{ paddingLeft: 4 }}>
                    <WineIdentity wine={{ name: w.name, vintage: w.vintage ?? '', producer: w.producer ?? '', grape: '' }} size="compact" />
                  </div>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer', fontSize: 12 }}>
                <input type="checkbox" checked={deleteWines} onChange={e => setDeleteWines(e.target.checked)} />
                <span>Also remove these wines from the tasting</span>
              </label>
              {deleteWines && (
                <p style={{ fontSize: 10, color: 'var(--fg-dim)', marginTop: 4, lineHeight: 1.4 }}>
                  Other tasters' ratings on these wines will also be cleared from the live tasting. Bookmarks on the wines stay reachable from <code>/me/saved</code>.
                </p>
              )}
            </div>
          )}

          {preview.ratingCount === 0 && wineCount === 0 && (
            <p style={{ fontSize: 12, color: 'var(--fg-dim)', marginBottom: 14 }}>They have no contributions to this tasting yet.</p>
          )}
        </>
      ) : (
        <p style={{ fontSize: 11, color: 'var(--fg-dim)', textAlign: 'center', padding: '16px 0' }}>// loading…</p>
      )}

      {error && <p style={{ color: '#e07070', fontSize: 11, marginTop: 8 }}>{error}</p>}

      <button
        className="btn-p"
        onClick={submit}
        disabled={submitting || !preview}
        style={{
          marginTop: 14,
          background: mode === 'ban' ? accentRed : undefined,
          color: mode === 'ban' ? '#fff' : undefined,
        }}
      >
        {submitting ? '…' : mode === 'ban' ? '→ ban' : '→ remove'}
      </button>
      <button className="btn-g" onClick={onClose}>cancel</button>
    </Modal>
  )
}
