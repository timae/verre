'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ThemeToggle } from '@/components/ThemeToggle'
import { formatCode, joinPath } from '@/lib/sessionCode'

interface Props {
  code: string
  sessionLabel: string
  // Drives the final destination after the user dismisses the screen.
  // Logged-in → /me (dashboard); anon → / (lobby). The decision is
  // made server-side and passed in so we don't need a client-side
  // cookie check.
  isLoggedIn: boolean
}

// Destination after the user dismisses the bounce screen.
function homePath(isLoggedIn: boolean): string {
  return isLoggedIn ? '/me' : '/'
}

type RemovedState =
  | { kind: 'loading' }
  | { kind: 'banned' }
  | { kind: 'kicked'; hasRatings: boolean }
  // Fallback for network errors during the state lookup. The "you're
  // not removed" case redirects to the regular join flow before
  // surfacing here, so 'unknown' is only the error path.
  | { kind: 'unknown' }

// Bounce screen rendered after the server emits X-Vr-Auth: removed. The
// client preserved its anon token / cookie, so the server can identify
// the caller and tell us whether they were kicked or banned via
// /api/session/<code>/removed-state. Kicked-with-ratings gets a Keep /
// Delete prompt; everything else gets an info screen with a Go-home link.
export function RemovedView({ code, sessionLabel, isLoggedIn }: Props) {
  const [state, setState] = useState<RemovedState>({ kind: 'loading' })
  const [acting, setActing] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Strip ?removed=1 from the URL after we've read it. The query
    // param is a hint from the bounce handler; if a user later shares
    // /join/<C>?removed=1 someone else shouldn't get trapped here.
    //
    // Use window.history.replaceState rather than router.replace —
    // router.replace triggers a Next.js navigation which re-runs the
    // SSR page, sees no `?removed=1`, and renders JoinClient instead
    // of RemovedView. replaceState updates the URL bar without any
    // re-render, so we stay on RemovedView while the URL is clean.
    if (typeof window !== 'undefined' && window.location.search.includes('removed=1')) {
      window.history.replaceState(null, '', joinPath(code))
    }
    ;(async () => {
      try {
        // Attach anon token if we have one — server resolves identity
        // from cookie OR x-vr-anon-token header.
        const token = typeof localStorage !== 'undefined'
          ? localStorage.getItem(`vr_anon_${code}`)
          : null
        const headers: Record<string, string> = {}
        if (token) headers['x-vr-anon-token'] = token
        const res = await fetch(`/api/session/${code}/removed-state`, { headers })
        if (cancelled) return
        if (!res.ok) { setState({ kind: 'unknown' }); return }
        const data = await res.json() as { state: string; hasRatings?: boolean }
        if (data.state === 'banned') setState({ kind: 'banned' })
        else if (data.state === 'kicked') setState({ kind: 'kicked', hasRatings: !!data.hasRatings })
        else {
          // state: 'none' — a stale ?removed=1 shared link, or the
          // caller already rejoined. Send them to the normal join flow
          // instead of leaving them on the bounce screen.
          if (typeof window !== 'undefined') window.location.href = joinPath(code)
        }
      } catch {
        if (!cancelled) setState({ kind: 'unknown' })
      }
    })()
    return () => { cancelled = true }
  }, [code])

  async function pick(cleanup: 'keep' | 'full') {
    if (acting) return
    setActing(true)
    const token = typeof localStorage !== 'undefined'
      ? localStorage.getItem(`vr_anon_${code}`)
      : null
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['x-vr-anon-token'] = token
    try {
      await fetch(`/api/session/${code}/leave?cleanup=${cleanup}`, {
        method: 'POST',
        headers,
      })
    } catch {}
    // Clear local state regardless of cleanup choice — the user is done
    // with this session.
    try {
      localStorage.removeItem(`vr_anon_${code}`)
      localStorage.removeItem(`vr_name_${code}`)
      localStorage.removeItem(`vr_id_${code}`)
    } catch {}
    window.location.href = homePath(isLoggedIn)
  }

  return (
    <div className="app-bg" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '0 16px', height: 'var(--hdr-h)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--chrome-border)', background: 'var(--chrome-bg)', backdropFilter: 'blur(18px)' }}>
        <Link href="/" style={{ fontFamily: 'var(--mono)', fontSize: 21, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--accent)', textDecoration: 'none' }}>Verre</Link>
        <ThemeToggle />
      </header>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ width: '100%', maxWidth: 400 }}>
          {state.kind === 'loading' && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--fg-dim)' }}>
              <p style={{ fontSize: 11, fontFamily: 'var(--mono)', letterSpacing: '0.1em' }}>{'// checking your status…'}</p>
            </div>
          )}

          {state.kind === 'banned' && (
            <>
              <div style={{ textAlign: 'center', marginBottom: 24 }}>
                <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.5 }}>🚫</div>
                <p style={{ fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'rgba(184,64,64,0.95)', marginBottom: 8 }}>removed</p>
                <h1 style={{ fontSize: 22, fontWeight: 800, color: '#F0E3C6', lineHeight: 1.2, marginBottom: 8 }}>You have been banned from this session</h1>
                <p style={{ fontSize: 13, color: 'var(--fg-dim)' }}>The host of <strong style={{ color: 'var(--fg)' }}>{sessionLabel}</strong> banned you. Your ratings and notes from this session have been removed.</p>
              </div>
              <div className="lobby-card lobby-form">
                <Link href={homePath(isLoggedIn)} className="btn-p" style={{ textDecoration: 'none', display: 'block', textAlign: 'center' }}>← back to {isLoggedIn ? 'dashboard' : 'home'}</Link>
              </div>
            </>
          )}

          {state.kind === 'kicked' && (
            <>
              <div style={{ textAlign: 'center', marginBottom: 24 }}>
                <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.6 }}>👋</div>
                <p style={{ fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--accent2)', marginBottom: 8 }}>removed</p>
                <h1 style={{ fontSize: 22, fontWeight: 800, color: '#F0E3C6', lineHeight: 1.2, marginBottom: 8 }}>You have been removed from this session</h1>
                <p style={{ fontSize: 13, color: 'var(--fg-dim)' }}>The host of <strong style={{ color: 'var(--fg)' }}>{sessionLabel}</strong> removed you from the tasting.</p>
              </div>

              {state.hasRatings ? (
                <div className="lobby-card lobby-form">
                  <div style={{ fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-dim)', marginBottom: 12 }}>
                    {'// your ratings and notes'}
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--fg-dim)', marginBottom: 16, lineHeight: 1.5 }}>
                    Keep them in your tasting history, or delete them entirely.
                  </p>
                  <button className="btn-p" onClick={() => pick('keep')} disabled={acting}>
                    {acting ? '…' : '→ keep in my history'}
                  </button>
                  <button className="btn-g" onClick={() => pick('full')} disabled={acting} style={{ color: 'rgba(184,64,64,0.95)' }}>
                    {acting ? '…' : 'delete my ratings'}
                  </button>
                </div>
              ) : (
                <div className="lobby-card lobby-form">
                  <p style={{ fontSize: 13, color: 'var(--fg-dim)', marginBottom: 16, textAlign: 'center' }}>
                    You hadn&apos;t added any ratings yet, so there&apos;s nothing to keep or delete.
                  </p>
                  <button className="btn-p" onClick={() => pick('keep')} disabled={acting}>
                    {acting ? '…' : '← back to home'}
                  </button>
                </div>
              )}
            </>
          )}

          {state.kind === 'unknown' && (
            <div className="lobby-card lobby-form" style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: 'var(--fg-dim)', marginBottom: 16 }}>You&apos;re no longer part of this session.</p>
              <Link href={homePath(isLoggedIn)} className="btn-p" style={{ textDecoration: 'none', display: 'block', textAlign: 'center' }}>← back to {isLoggedIn ? 'dashboard' : 'home'}</Link>
            </div>
          )}

          <p style={{ textAlign: 'center', marginTop: 16, fontSize: 10, color: 'var(--fg-faint)', fontFamily: 'var(--mono)', letterSpacing: '0.08em' }}>
            SESSION CODE: {formatCode(code)}
          </p>
        </div>
      </div>
    </div>
  )
}
