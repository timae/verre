'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ThemeToggle } from '@/components/ThemeToggle'
import { setAnonToken } from '@/lib/sessionFetch'

interface Props {
  code: string
  sessionMeta: { host: string; name: string } | null
  defaultName: string
  isLoggedIn: boolean
}

export function JoinClient({ code, sessionMeta, defaultName, isLoggedIn }: Props) {
  const router = useRouter()
  const [name, setName] = useState(defaultName)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const sessionLabel = sessionMeta?.name || `Session ${code}`
  const isExpired = !sessionMeta

  // Anonymous user who already joined from this browser → skip invite page
  useEffect(() => {
    if (isLoggedIn || isExpired) return
    if (typeof window === 'undefined') return
    const stored = sessionStorage.getItem(`vr_name_${code}`)
    if (stored) router.replace(`/session/${code}`)
  }, [code, isLoggedIn, isExpired])

  async function join(joinName?: string) {
    const n = (joinName ?? name).trim()
    if (!n) { setError('Enter your name'); return }
    setLoading(true); setError('')
    const res = await fetch('/api/session/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, userName: n }),
    })
    setLoading(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Could not join — session may have expired')
      return
    }
    const data = await res.json()
    if (data.anonToken) setAnonToken(code, data.anonToken)
    // Server may have suffixed the name with a food emoji to disambiguate
    // from someone already in the room. Use the returned form as canonical.
    const finalName = data.userName || n
    router.push(`/session/${code}?name=${encodeURIComponent(finalName)}`)
  }

  return (
    <div className="app-bg" style={{minHeight:'100vh',display:'flex',flexDirection:'column'}}>
      <header style={{padding:'0 16px',height:'var(--hdr-h)',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid rgba(255,255,255,0.04)',background:'rgba(14,14,12,0.5)',backdropFilter:'blur(18px)'}}>
        <Link href="/" style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)',textDecoration:'none'}}>Verre</Link>
        <ThemeToggle />
      </header>

      <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
        <div style={{width:'100%',maxWidth:400}}>

          {/* Invite card */}
          <div style={{textAlign:'center',marginBottom:24}}>
            <div style={{fontSize:48,marginBottom:12}}>🍷</div>
            <p style={{fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:'var(--accent2)',marginBottom:8}}>you've been invited</p>
            <h1 style={{fontSize:26,fontWeight:800,color:'#F0E3C6',lineHeight:1.1,marginBottom:8}}>{sessionLabel}</h1>
            {sessionMeta?.host && (
              <p style={{fontSize:12,color:'var(--fg-dim)'}}>Hosted by <strong style={{color:'var(--fg)'}}>{sessionMeta.host}</strong></p>
            )}
          </div>

          <div className="lobby-card lobby-form">
            {isExpired ? (
              <div style={{textAlign:'center',padding:'16px 0'}}>
                <p style={{fontSize:13,color:'var(--fg-dim)',marginBottom:16}}>This session has expired. Sessions last 48 hours.</p>
                <Link href="/" className="btn-p" style={{textDecoration:'none',display:'block',textAlign:'center'}}>← back to lobby</Link>
              </div>
            ) : isLoggedIn ? (
              <>
                <div style={{fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:16}}>
                  // joining as <span style={{color:'var(--fg)'}}>{defaultName}</span>
                </div>
                {error && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{error}</p>}
                <button className="btn-p" onClick={() => join(defaultName)} disabled={loading}>
                  {loading ? 'joining…' : `→ join ${sessionLabel}`}
                </button>
              </>
            ) : (
              <>
                <div style={{fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:16}}>
                  // enter your name to join
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

                {error && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{error}</p>}

                <button className="btn-p" onClick={() => join()} disabled={loading}>
                  {loading ? 'joining…' : `→ join ${sessionLabel}`}
                </button>

                <p style={{textAlign:'center',marginTop:14,marginBottom:10,fontSize:11,color:'var(--fg-faint)'}}>
                  Sign in or create an account to save your ratings.
                </p>
                <div style={{display:'flex',gap:6}}>
                  <Link href={`/login?redirect=/join/${code}`} className="btn-g" style={{flex:1,textAlign:'center',textDecoration:'none',marginTop:0}}>→ sign in</Link>
                  <Link href={`/register?redirect=/join/${code}`} className="btn-g" style={{flex:1,textAlign:'center',textDecoration:'none',marginTop:0}}>→ create account</Link>
                </div>
              </>
            )}
          </div>

          <p style={{textAlign:'center',marginTop:16,fontSize:10,color:'var(--fg-faint)',fontFamily:'var(--mono)',letterSpacing:'0.08em'}}>
            SESSION CODE: {code}
          </p>
        </div>
      </div>
    </div>
  )
}
