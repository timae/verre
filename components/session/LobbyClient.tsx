'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import Link from 'next/link'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LifespanSelector } from '@/components/session/LifespanSelector'

type User = { id: string; name: string; email: string; role: string; pro: boolean } | null

export function LobbyClient({ user }: { user: User }) {
  const router = useRouter()
  const [displayName, setDisplayName] = useState(user?.name || '')
  const [sessionName, setSessionName] = useState('')
  const [lifespan, setLifespan] = useState('48h')
  const [joinCode, setJoinCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function createSession() {
    if (!displayName.trim()) { setError('Enter your name'); return }
    setLoading(true); setError('')
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostName: displayName.trim(), sessionName: sessionName.trim(), lifespan }),
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

          <LifespanSelector value={lifespan} onChange={setLifespan} isPro={false} />

          {/* Blind tasting toggle — greyed out when not logged in or not pro */}
          <div
            style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 12px',borderRadius:8,border:'1px solid var(--border)',background:'var(--bg3)',marginBottom:10,opacity:0.5,cursor:'default'}}
            title="Requires a Pro account"
          >
            <div>
              <div style={{fontSize:11,fontWeight:700,color:'var(--fg)',display:'flex',alignItems:'center',gap:6}}>
                🙈 Blind tasting
                <span style={{fontSize:9,background:'var(--bg)',border:'1px solid rgba(200,150,60,0.4)',borderRadius:3,padding:'1px 5px',letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent)'}}>pro</span>
              </div>
              <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:2}}>Tasters see numbers only — host reveals after</div>
            </div>
            <div style={{width:36,height:20,borderRadius:10,background:'var(--bg4)',border:'1px solid var(--border2)',position:'relative',flexShrink:0}}>
              <div style={{width:14,height:14,borderRadius:'50%',background:'#fff',opacity:0.4,position:'absolute',top:2,left:2}} />
            </div>
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

      {/* Feature showcase — anonymous only */}
      {!user && <FeatureShowcase />}
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

const FREE_FEATURES = [
  { icon: '🍷', title: 'Shared wine list',       copy: 'One session code. Everyone adds to the same lineup from their phone.',  pro: false },
  { icon: '⭐', title: 'Private ratings',          copy: 'Stars, flavour sliders, and notes stay yours until you compare.',       pro: false },
  { icon: '◉',  title: 'Flavour radar',            copy: 'Wine Folly-style polar chart tailored to red, white, sparkling, rosé.', pro: false },
  { icon: '◈',  title: 'Compare & overlay',        copy: 'See everyone\'s profiles stacked on one chart. Find where you agree.',  pro: false },
  { icon: '📋', title: 'Tasting history',          copy: 'Every session saved. Rejoin active tastings with one tap.',             pro: false },
  { icon: '★',  title: 'Save wines',               copy: 'Bookmark any bottle across sessions. Tap ☆ on the detail screen.',      pro: false },
  { icon: '🏅', title: 'Badges & XP',              copy: '60+ achievements. Level up from Novice to Legend.',                     pro: false },
  { icon: '📄', title: 'PDF export',               copy: 'Print a clean A4 tasting report straight from the compare view.',       pro: false },
  { icon: '🙈', title: 'Blind tastings',           copy: 'Tasters see Wine #1, #2… Host reveals after everyone has scored.',      pro: true  },
  { icon: '👑', title: 'Co-host roles',            copy: 'Delegate wine management to trusted co-hosts mid-session.',             pro: true  },
  { icon: '🔖', title: 'AI label scanning',        copy: 'Point your camera at a label — fields fill themselves.',                pro: false },
  { icon: '🎯', title: 'Hall of Fame',             copy: 'Every 5-star rating is permanent. Your name on the board.',            pro: false },
]

function FeatureShowcase() {
  return (
    <div style={{maxWidth:1040,margin:'32px auto 0',padding:'0 0 40px'}}>
      {/* Divider */}
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:24}}>
        <div style={{flex:1,height:'1px',background:'var(--border)'}} />
        <span style={{fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:'var(--fg-faint)',fontFamily:'var(--mono)'}}>what you get</span>
        <div style={{flex:1,height:'1px',background:'var(--border)'}} />
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))',gap:8}}>
        {FREE_FEATURES.map(f => (
          <div
            key={f.title}
            style={{
              padding:'14px 14px 12px',
              borderRadius:14,
              border: f.pro ? '1px solid rgba(200,150,60,0.2)' : '1px solid rgba(255,255,255,0.05)',
              background: f.pro ? 'rgba(200,150,60,0.04)' : 'rgba(255,255,255,0.02)',
              opacity: f.pro ? 0.6 : 1,
              position:'relative',
            }}
          >
            {f.pro && (
              <div style={{position:'absolute',top:10,right:10,fontSize:8,letterSpacing:'0.1em',textTransform:'uppercase',color:'var(--accent)',border:'1px solid rgba(200,150,60,0.35)',background:'rgba(200,150,60,0.1)',padding:'2px 6px',borderRadius:3}}>
                pro
              </div>
            )}
            <div style={{fontSize:22,marginBottom:8,lineHeight:1}}>{f.icon}</div>
            <div style={{fontSize:12,fontWeight:700,color: f.pro ? 'var(--accent)' : 'var(--fg)',marginBottom:4,lineHeight:1.2}}>{f.title}</div>
            <div style={{fontSize:10,color:'var(--fg-dim)',lineHeight:1.6}}>{f.copy}</div>
          </div>
        ))}
      </div>

      <p style={{textAlign:'center',marginTop:20,fontSize:10,color:'var(--fg-faint)',letterSpacing:'0.06em'}}>
        Free to taste. <Link href="/register" style={{color:'var(--accent)'}}>Create an account</Link> to keep your history.
        Pro features unlock blind tastings and more.
      </p>
    </div>
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
