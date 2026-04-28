'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import Link from 'next/link'
import { ThemeToggle } from '@/components/ThemeToggle'

type User = { id: string; name: string; email: string; role: string; pro: boolean } | null

export function LobbyClient({ user }: { user: User }) {
  const router = useRouter()
  const [displayName, setDisplayName] = useState(user?.name || '')
  const [sessionName, setSessionName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function createSession() {
    if (!displayName.trim()) { setError('Enter your name'); return }
    setLoading(true); setError('')
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostName: displayName.trim(), sessionName: sessionName.trim() }),
    })
    setLoading(false)
    if (!res.ok) { setError('Could not create session'); return }
    const { code } = await res.json()
    router.push(`/session/${code}?host=1&name=${encodeURIComponent(displayName.trim())}`)
  }

  async function joinSession() {
    if (!displayName.trim()) { setError('Enter your name'); return }
    if (!joinCode.trim() || joinCode.trim().length < 4) { setError('Enter a 4-char code'); return }
    setLoading(true); setError('')
    const res = await fetch('/api/session/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: joinCode.trim().toUpperCase(), userName: displayName.trim() }),
    })
    setLoading(false)
    if (!res.ok) { setError('Session not found'); return }
    router.push(`/session/${joinCode.trim().toUpperCase()}?name=${encodeURIComponent(displayName.trim())}`)
  }

  return (
    <div className="app-bg" style={{padding:'16px 16px 40px'}}>
      <header className="flex items-center justify-between mb-6 max-w-[1040px] mx-auto">
        <div style={{fontFamily:'var(--mono)',fontSize:21,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)',display:'flex',alignItems:'baseline',gap:6}}>
          Verre
          <span style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--fg-dim)',letterSpacing:'0.1em',border:'1px solid var(--border2)',padding:'1px 5px',borderRadius:2,marginLeft:4}}>v3</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <ThemeToggle />
          {user ? (
            <button onClick={() => signOut()} style={{fontSize:10,color:'var(--fg-dim)',letterSpacing:'0.06em',fontFamily:'var(--mono)',background:'none',border:'none',cursor:'pointer'}}>
              {user.name} · sign out
            </button>
          ) : (
            <Link href="/login" style={{fontSize:10,color:'var(--accent)',letterSpacing:'0.06em',fontFamily:'var(--mono)'}}>Sign in</Link>
          )}
        </div>
      </header>

      <div className="max-w-[1040px] mx-auto" style={{display:'grid',gridTemplateColumns:'minmax(0,1fr)',gap:18,alignItems:'start'}} data-lobby-grid>
        {/* Session card */}
        <div className="lobby-card lobby-form">
          <div className="hero-kicker">Start or join</div>
          <div className="subhead" style={{margin:'0 0 18px'}}>
            <div className="subhead-title" style={{fontSize:24}}>Open the table</div>
          </div>

          <div className="field">
            <div className="fl">your name</div>
            <input className="fi" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="firstname or alias" />
          </div>

          <div className="field">
            <div className="fl">session name <span style={{opacity:.5,textTransform:'none',letterSpacing:0}}>(optional)</span></div>
            <input className="fi" value={sessionName} onChange={e => setSessionName(e.target.value)} maxLength={80} placeholder="e.g. Friday Bordeaux tasting" />
          </div>

          <button className="btn-p" onClick={createSession} disabled={loading} style={{marginBottom:8}}>
            {loading ? 'creating…' : '→ create new tasting'}
          </button>

          <div className="lobby-divider">or join an existing room</div>

          <div className="field">
            <div className="fl">session code</div>
            <input
              className="fi"
              value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase())}
              maxLength={4}
              placeholder="e.g. A3F7"
              style={{textTransform:'uppercase',textAlign:'center',fontSize:18,letterSpacing:'0.3em'}}
            />
          </div>
          <button className="btn-g" onClick={joinSession} disabled={loading}>→ join session</button>

          {error && <p style={{color:'#e07070',fontSize:11,marginTop:8}}>{error}</p>}

          <button className="btn-g" onClick={() => router.push('/hof')} style={{marginTop:20}}>★ hall of fame</button>
        </div>

        {/* Account card */}
        <div className="lobby-card" id="lobbyAccountCard">
          {user ? <AccountDashboard user={user} /> : <AccountPromo />}
        </div>
      </div>
    </div>
  )
}

function AccountPromo() {
  return (
    <>
      <div style={{fontFamily:'var(--mono)',fontSize:'clamp(28px,5vw,42px)',fontWeight:800,lineHeight:1,color:'#F3E9D3',marginBottom:8}}>
        Your palate,<br />remembered.
      </div>
      <p style={{fontSize:12,color:'var(--fg-dim)',lineHeight:1.8,maxWidth:'36ch',marginBottom:20}}>
        Taste anonymously or create a free account to save your history, bookmark wines, and build your flavour profile over time.
      </p>
      <div style={{display:'flex',flexDirection:'column',gap:7,marginBottom:22,paddingTop:14,borderTop:'1px solid var(--border)'}}>
        {['Save and revisit any tasting session','Bookmark wines across sessions','Hall of Fame entries credited to your name','Flavour radar profile over time'].map(p => (
          <div key={p} style={{display:'flex',alignItems:'center',gap:8,fontSize:11,color:'var(--fg-dim)'}}>
            <div style={{width:5,height:5,borderRadius:'50%',background:'var(--accent)',flexShrink:0}} />
            {p}
          </div>
        ))}
      </div>
      <div style={{display:'flex',gap:8}}>
        <Link href="/register" className="btn-p" style={{flex:1,textAlign:'center',textDecoration:'none',display:'block'}}>Create account</Link>
        <Link href="/login" className="btn-g" style={{flex:1,textAlign:'center',textDecoration:'none',display:'block',marginTop:0}}>Sign in</Link>
      </div>
    </>
  )
}

function AccountDashboard({ user }: { user: NonNullable<User> }) {
  return (
    <>
      <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:'rgba(143,184,122,0.07)',border:'1px solid rgba(143,184,122,0.18)',borderRadius:10,marginBottom:16}}>
        <div style={{width:8,height:8,borderRadius:'50%',background:'var(--accent2)',flexShrink:0}} />
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:700,fontSize:14}}>{user.name}</div>
          <div style={{fontSize:11,color:'var(--fg-dim)',marginTop:1}}>{user.email}</div>
        </div>
      </div>
      {[{href:'/me',label:'⊞  my dashboard'},{href:'/me/history',label:'◷  tasting history'},{href:'/me/saved',label:'★  saved wines'},{href:'/me/profile',label:'◉  flavour profile'}].map(({href,label}) => (
        <Link key={href} href={href} className="btn-g" style={{display:'block',textAlign:'left',textDecoration:'none',marginTop:0,marginBottom:6}}>
          {label}
        </Link>
      ))}
    </>
  )
}
