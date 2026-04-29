'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ThemeToggle } from '@/components/ThemeToggle'

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

  async function join() {
    if (!name.trim()) { setError('Enter your name'); return }
    setLoading(true); setError('')
    const res = await fetch('/api/session/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, userName: name.trim() }),
    })
    setLoading(false)
    if (!res.ok) { setError('Could not join — session may have expired'); return }
    router.push(`/session/${code}?name=${encodeURIComponent(name.trim())}`)
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
            ) : (
              <>
                <div style={{fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:16}}>
                  {isLoggedIn ? '// joining as your account' : '// enter your name to join'}
                </div>

                <div className="field">
                  <div className="fl">your name</div>
                  <input
                    className="fi"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && join()}
                    placeholder="firstname or alias"
                    autoFocus={!defaultName}
                  />
                </div>

                {error && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{error}</p>}

                <button className="btn-p" onClick={join} disabled={loading}>
                  {loading ? 'joining…' : `→ join ${sessionLabel}`}
                </button>

                {!isLoggedIn && (
                  <p style={{textAlign:'center',marginTop:14,fontSize:11,color:'var(--fg-faint)'}}>
                    Have an account?{' '}
                    <Link href={`/login?redirect=/join/${code}`} style={{color:'var(--accent)'}}>Sign in first</Link>
                    {' '}to save your ratings.
                  </p>
                )}
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
