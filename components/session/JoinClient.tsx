'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ThemeToggle } from '@/components/ThemeToggle'
import { setAnonToken, webApiFetch } from '@/lib/sessionFetch'
import { formatCode } from '@verre/core'
import { sessionPath, joinPath } from '@/lib/sessionCode'

interface Props {
  code: string
  sessionMeta: { host: string; name: string } | null
  // The wrong-code budget is spent and this caller isn't known to be a member
  // (leak-fixes F2). NOT an ended session: nothing local is wiped.
  rateLimited?: { wait: string } | null
  defaultName: string
  isLoggedIn: boolean
}

export function JoinClient({ code, sessionMeta, rateLimited = null, defaultName, isLoggedIn }: Props) {
  const router = useRouter()
  const [name, setName] = useState(defaultName)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const sessionLabel = sessionMeta?.name || `Session ${formatCode(code)}`
  const limited = !sessionMeta && !!rateLimited
  const isExpired = !sessionMeta && !rateLimited

  // Anonymous user who already joined from this browser → skip invite page.
  // On a spent budget only with BOTH their token and name for this code: the
  // moment's API then decides with the token (the gate admits a member), and
  // a token alone would loop (SessionShell bounces a nameless guest back here).
  useEffect(() => {
    if (isLoggedIn || isExpired) return
    if (typeof window === 'undefined') return
    const stored = localStorage.getItem(`vr_name_${code}`)
    if (limited && !localStorage.getItem(`vr_anon_${code}`)) return
    if (stored) router.replace(sessionPath(code))
  }, [code, isLoggedIn, isExpired, limited])

  // Session is gone (deleted, expired, or never existed). Drop any stale
  // local cache for this code so it doesn't linger inertly forever and
  // mislead later code that looks at these keys. 🔒 Never on a spent
  // budget: the moment may well exist, and a guest would lose their identity
  // in it for good.
  useEffect(() => {
    if (!isExpired || typeof window === 'undefined') return
    try {
      localStorage.removeItem(`vr_anon_${code}`)
      localStorage.removeItem(`vr_name_${code}`)
      localStorage.removeItem(`vr_id_${code}`)
    } catch {}
  }, [code, isExpired])

  async function join(joinName?: string) {
    const n = (joinName ?? name).trim()
    if (!n) { setError('Enter your name'); return }
    setLoading(true); setError('')
    const res = await webApiFetch('/api/session/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, displayName: n }),
    })
    setLoading(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      // Banned users hitting the join form directly (e.g., bookmarked
      // join URL after a ban) get a 403 banned response. Bounce them to
      // the full RemovedView screen instead of showing the small inline
      // "banned" error.
      if (res.status === 403 && data.error === 'banned') {
        window.location.href = `${joinPath(code)}?removed=1`
        return
      }
      setError(data.error || 'Could not join. The session may have expired.')
      return
    }
    const data = await res.json()
    if (data.anonToken) setAnonToken(code, data.anonToken)
    // Server may have suffixed the name with a food emoji to disambiguate
    // from someone already in the room. Use the returned form as canonical.
    const finalName = data.displayName || n
    const finalId   = data.id || ''
    const params = new URLSearchParams()
    params.set('name', finalName)
    if (finalId) params.set('id', finalId)
    router.push(`${sessionPath(code)}?${params.toString()}`)
  }

  return (
    <div className="app-bg" style={{minHeight:'100vh',display:'flex',flexDirection:'column'}}>
      <header style={{padding:'0 16px',height:'var(--hdr-h)',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid var(--chrome-border)',background:'var(--chrome-bg)',backdropFilter:'blur(18px)'}}>
        <Link href="/" style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)',textDecoration:'none'}}>Verre</Link>
        <ThemeToggle />
      </header>

      <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
        <div style={{width:'100%',maxWidth:400}}>

          {/* Header — different framing for valid invite vs not-found */}
          {limited ? (
            <div style={{textAlign:'center',marginBottom:24}}>
              <div style={{fontSize:48,marginBottom:12,opacity:0.4}}>⏳</div>
              <p style={{fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:8}}>too many codes</p>
              <h1 style={{fontSize:24,fontWeight:800,color:'#F0E3C6',lineHeight:1.2,marginBottom:8}}>Too many codes tried</h1>
            </div>
          ) : isExpired ? (
            <div style={{textAlign:'center',marginBottom:24}}>
              <div style={{fontSize:48,marginBottom:12,opacity:0.4}}>🚫</div>
              <p style={{fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:8}}>session not found</p>
              <h1 style={{fontSize:24,fontWeight:800,color:'#F0E3C6',lineHeight:1.2,marginBottom:8}}>This session does not exist</h1>
            </div>
          ) : (
            <div style={{textAlign:'center',marginBottom:24}}>
              <div style={{fontSize:48,marginBottom:12}}>🍷</div>
              <p style={{fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:'var(--accent2)',marginBottom:8}}>you&apos;ve been invited</p>
              <h1 style={{fontSize:26,fontWeight:800,color:'#F0E3C6',lineHeight:1.1,marginBottom:8}}>{sessionLabel}</h1>
              {sessionMeta?.host && (
                <p style={{fontSize:12,color:'var(--fg-dim)'}}>Hosted by <strong style={{color:'var(--fg)'}}>{sessionMeta.host}</strong></p>
              )}
            </div>
          )}

          <div className="lobby-card lobby-form">
            {limited ? (
              <div style={{textAlign:'center',padding:'16px 0'}}>
                <p style={{fontSize:13,color:'var(--fg-dim)',marginBottom:16}}>Try again in {rateLimited!.wait}.</p>
                <Link href="/" className="btn-p" style={{textDecoration:'none',display:'block',textAlign:'center'}}>← back to lobby</Link>
              </div>
            ) : isExpired ? (
              <div style={{textAlign:'center',padding:'16px 0'}}>
                <p style={{fontSize:13,color:'var(--fg-dim)',marginBottom:16}}>The code may be wrong, or the session has been deleted or expired.</p>
                <Link href="/" className="btn-p" style={{textDecoration:'none',display:'block',textAlign:'center'}}>← back to lobby</Link>
              </div>
            ) : isLoggedIn ? (
              <>
                <div style={{fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:16}}>
                  {'// joining as '}<span style={{color:'var(--fg)'}}>{defaultName}</span>
                </div>
                {error && <p style={{color:'var(--danger)',fontSize:11,marginBottom:8}}>{error}</p>}
                <button className="btn-p" onClick={() => join(defaultName)} disabled={loading}>
                  {loading ? 'joining…' : `→ join ${sessionLabel}`}
                </button>
              </>
            ) : (
              <>
                <div style={{fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:16}}>
                  {'// enter your name to join'}
                </div>

                <div className="field">
                  <div className="fl">your name</div>
                  <input
                    className="fi"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && join()}
                    placeholder="firstname or alias"
                    autoFocus
                  />
                </div>

                {error && <p style={{color:'var(--danger)',fontSize:11,marginBottom:8}}>{error}</p>}

                <button className="btn-p" onClick={() => join()} disabled={loading}>
                  {loading ? 'joining…' : `→ join ${sessionLabel}`}
                </button>

                <p style={{textAlign:'center',marginTop:14,marginBottom:10,fontSize:11,color:'var(--fg-faint)'}}>
                  Sign in or create an account to save your ratings.
                </p>
                <div style={{display:'flex',gap:6}}>
                  <Link href={`/login?redirect=${encodeURIComponent(joinPath(code))}`} className="btn-g" style={{flex:1,textAlign:'center',textDecoration:'none',marginTop:0}}>→ sign in</Link>
                  <Link href={`/register?redirect=${encodeURIComponent(joinPath(code))}`} className="btn-g" style={{flex:1,textAlign:'center',textDecoration:'none',marginTop:0}}>→ create account</Link>
                </div>
              </>
            )}
          </div>

          <p style={{textAlign:'center',marginTop:16,fontSize:10,color:'var(--fg-faint)',fontFamily:'var(--mono)',letterSpacing:'0.08em'}}>
            SESSION CODE: {formatCode(code)}
          </p>
        </div>
      </div>
    </div>
  )
}
