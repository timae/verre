'use client'
import { useEffect, useState } from 'react'
import { sessionFetch } from '@/lib/sessionFetch'

interface Props {
  code: string
  // banCount from the polled session GET. Drives the refetch on
  // cross-host ban events: when count changes, re-read the list. Parent
  // gates render on count > 0 so this component never sees count === 0.
  count: number
}

interface BanRow {
  identityId: string
  displayName: string
  imageUrl: string | null
}

// Collapsible "banned users" row in the session overview panel. Host
// and cohost can read + unban. Visual style mirrors the participants
// row above: bare collapsible header with chevron, no card chrome.
// Only the parent renders this when bans exist, so the empty-state
// branch is gone.
export function BannedUsersSection({ code, count }: Props) {
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

  // Lazy-load when first expanded, and refetch when `count` changes so
  // an open list updates in-place after a cross-host ban/unban.
  useEffect(() => {
    if (open) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, count])

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
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 0',
          background: 'none',
          border: 'none',
          borderTop: '1px solid var(--border)',
          cursor: 'pointer',
          color: 'var(--fg-dim)',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          marginBottom: open ? 12 : 0,
        }}
      >
        <span>banned users ({count})</span>
        <span style={{ fontSize: 11, color: 'var(--fg-faint)' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {rows === null ? (
            <span style={{ fontSize: 11, color: 'var(--fg-dim)', padding: '4px 0' }}>{'// loading…'}</span>
          ) : rows.map(r => (
            <div
              key={r.identityId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 0',
              }}
            >
              <span style={{ flex: 1, fontSize: 11, color: 'var(--fg)' }}>{r.displayName}</span>
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
          {error && <p style={{ color: '#e07070', fontSize: 11, marginTop: 4 }}>{error}</p>}
        </div>
      )}
    </div>
  )
}
