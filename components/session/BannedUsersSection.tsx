'use client'
import { useEffect, useState } from 'react'
import { sessionFetch } from '@/lib/sessionFetch'

interface Props {
  code: string
}

interface BanRow {
  identityId: string
  displayName: string
  imageUrl: string | null
}

// Collapsible "Banned users" section in the session settings tab. Host
// and cohost can read + unban. Empty state is just an empty list (we
// still render the collapsible header so the affordance is visible when
// the host first wants to use it). Unban is uncapped on the server, so
// the client doesn't need to debounce.
export function BannedUsersSection({ code }: Props) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<BanRow[] | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function refresh() {
    setError('')
    try {
      const res = await sessionFetch(code, `/api/session/${code}/bans`, { cache: 'no-store' })
      if (!res.ok) { setRows([]); setError('Could not load banned users.'); return }
      const data = await res.json()
      setRows(data.bans ?? [])
    } catch {
      setRows([])
      setError('Could not load banned users.')
    }
  }

  // Lazy-load: only fetch when the section is first expanded. Keeps the
  // settings tab fast when nobody's banned.
  useEffect(() => {
    if (open && rows === null) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function unban(identityId: string) {
    if (working !== null) return
    setWorking(identityId)
    try {
      const enc = encodeURIComponent(identityId)
      const res = await sessionFetch(code, `/api/session/${code}/bans/${enc}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        setError('Could not unban.')
      } else {
        setRows(prev => prev?.filter(r => r.identityId !== identityId) ?? null)
      }
    } catch {
      setError('Network error.')
    } finally {
      setWorking(null)
    }
  }

  return (
    <div style={{ marginTop: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg3)' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--fg-dim)', fontFamily: 'var(--mono)' }}>
          banned users {rows ? `(${rows.length})` : ''}
        </span>
        <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          {rows === null && (
            <p style={{ fontSize: 11, color: 'var(--fg-dim)' }}>// loading…</p>
          )}
          {rows && rows.length === 0 && (
            <p style={{ fontSize: 11, color: 'var(--fg-dim)' }}>Nobody is banned from this tasting.</p>
          )}
          {rows && rows.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.map(r => (
                <div key={r.identityId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 6, background: 'var(--bg2)' }}>
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{r.displayName}</span>
                  <button
                    className="btn-s"
                    onClick={() => unban(r.identityId)}
                    disabled={working === r.identityId}
                    style={{ fontSize: 9, padding: '3px 8px' }}
                  >
                    {working === r.identityId ? '…' : 'unban'}
                  </button>
                </div>
              ))}
            </div>
          )}
          {error && <p style={{ color: '#e07070', fontSize: 11, marginTop: 8 }}>{error}</p>}
        </div>
      )}
    </div>
  )
}
