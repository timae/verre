'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

type User = { id: string; name: string; email: string; role: string; pro: boolean }
type Session = { id: number; code: string; host_name: string; name: string | null; created_at: string; joined_at: string; wines_rated: number; avg_score: string | null }
type Bookmark = { wine_id: string; name: string; producer: string | null; vintage: string | null; style: string | null; image_url: string | null; session_code: string }

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

export function MeDashboard({ user }: { user: User }) {
  const router = useRouter()
  const [name, setName] = useState(user.name)
  const [sessionName, setSessionName] = useState('')
  const [blind, setBlind] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const isPro = user.pro

  const { data: sessions = [] } = useQuery<Session[]>({
    queryKey: ['me-sessions'],
    queryFn: () => fetch('/api/me/sessions').then(r => r.json()),
  })
  const { data: bookmarks = [] } = useQuery<Bookmark[]>({
    queryKey: ['me-bookmarks'],
    queryFn: () => fetch('/api/me/bookmarks').then(r => r.json()),
  })

  async function createSession() {
    if (!name.trim()) { setError('Enter your name'); return }
    setLoading(true); setError('')
    const res = await fetch('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostName: name.trim(), sessionName: sessionName.trim(), blind: isPro && blind }),
    })
    setLoading(false)
    if (!res.ok) { setError('Could not create session'); return }
    const { code } = await res.json()
    router.push(`/session/${code}?host=1&name=${encodeURIComponent(name.trim())}`)
  }

  async function joinSession() {
    if (!name.trim()) { setError('Enter your name'); return }
    if (joinCode.trim().length < 4) { setError('Enter a 4-char code'); return }
    setLoading(true); setError('')
    const res = await fetch('/api/session/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: joinCode.trim().toUpperCase(), userName: name.trim() }),
    })
    setLoading(false)
    if (!res.ok) { setError('Session not found'); return }
    router.push(`/session/${joinCode.trim().toUpperCase()}?name=${encodeURIComponent(name.trim())}`)
  }

  const recent = sessions.slice(0, 3)
  const recentBooks = bookmarks.slice(0, 4)

  return (
    <div style={{padding:'14px 14px 40px',maxWidth:980,margin:'0 auto',minHeight:'calc(100vh - var(--hdr-h))'}}>
      {/* Greeting */}
      <div style={{marginBottom:24}}>
        <p style={{fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:'var(--accent2)',marginBottom:6}}>your dashboard</p>
        <h1 style={{fontSize:28,fontWeight:800,color:'#F0E3C6',lineHeight:1}}>Good to see you, {user.name}.</h1>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr)',gap:14}} data-dash-grid>
        {/* New tasting card */}
        <div className="lobby-card lobby-form">
          <p style={{fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:'var(--accent2)',marginBottom:14}}>start or join</p>
          <div className="field">
            <div className="fl">your name</div>
            <input className="fi" value={name} onChange={e => setName(e.target.value)} placeholder="firstname or alias" />
          </div>
          <div className="field">
            <div className="fl">session name <span style={{opacity:.5,textTransform:'none',letterSpacing:0}}>(optional)</span></div>
            <input className="fi" value={sessionName} onChange={e => setSessionName(e.target.value)} maxLength={80} placeholder="e.g. Friday Bordeaux tasting" />
          </div>
          {/* Blind tasting toggle */}
          <div
            onClick={() => isPro ? setBlind(!blind) : null}
            style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 12px',borderRadius:8,border:`1px solid ${blind ? 'rgba(200,150,60,0.4)' : 'var(--border)'}`,background: blind ? 'rgba(200,150,60,0.08)' : 'var(--bg3)',cursor: isPro ? 'pointer' : 'default',marginBottom:10,opacity: isPro ? 1 : 0.5}}>
            <div>
              <div style={{fontSize:11,fontWeight:700,color: blind ? 'var(--accent)' : 'var(--fg)',display:'flex',alignItems:'center',gap:6}}>
                🙈 Blind tasting
                {!isPro && <span style={{fontSize:9,background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:3,padding:'1px 5px',letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--fg-dim)'}}>pro</span>}
              </div>
              <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:2}}>Tasters see numbers only — you reveal after</div>
            </div>
            <div style={{width:36,height:20,borderRadius:10,background: blind ? 'var(--accent)' : 'var(--bg4)',border:'1px solid var(--border2)',position:'relative',transition:'background .2s',flexShrink:0}}>
              <div style={{width:14,height:14,borderRadius:'50%',background:'#fff',position:'absolute',top:2,left: blind ? 18 : 2,transition:'left .2s'}} />
            </div>
          </div>

          <button className="btn-p" onClick={createSession} disabled={loading} style={{marginBottom:8}}>
            {loading ? 'creating…' : blind ? '→ create blind tasting' : '→ create new tasting'}
          </button>
          <div className="lobby-divider">or join an existing room</div>
          <div className="field">
            <div className="fl">session code</div>
            <input className="fi" value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} maxLength={4}
              placeholder="e.g. A3F7" style={{textTransform:'uppercase',textAlign:'center',fontSize:18,letterSpacing:'0.3em'}} />
          </div>
          <button className="btn-g" onClick={joinSession} disabled={loading}>→ join session</button>
          {error && <p style={{color:'#e07070',fontSize:11,marginTop:8}}>{error}</p>}
        </div>

        {/* Right column */}
        <div style={{display:'flex',flexDirection:'column',gap:14}}>
          {/* Recent sessions */}
          {recent.length > 0 && (
            <div className="panel" style={{margin:0}}>
              <div className="panel-hdr">recent tastings</div>
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {recent.map(s => {
                  const hoursAgo = (Date.now() - new Date(s.joined_at).getTime()) / 3600000
                  const active = hoursAgo < 47
                  const date = new Date(s.joined_at).toLocaleDateString(undefined, { month:'short', day:'numeric' })
                  return (
                    <div key={s.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid var(--bg3)'}}>
                      <div style={{minWidth:0}}>
                        <p style={{fontSize:12,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.name || `Session ${s.code}`}</p>
                        <p style={{fontSize:10,color:'var(--fg-dim)',marginTop:1}}>{date} · {s.wines_rated} wines rated</p>
                      </div>
                      {active && (
                        <button className="btn-s" style={{flexShrink:0,marginLeft:8}} onClick={() => router.push(`/session/${s.code}?name=${encodeURIComponent(name)}`)}>
                          → rejoin
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
              <Link href="/me/history" style={{display:'block',fontSize:10,color:'var(--accent)',marginTop:10,letterSpacing:'0.06em',fontFamily:'var(--mono)'}}>view all →</Link>
            </div>
          )}

          {/* Saved wines preview */}
          {recentBooks.length > 0 && (
            <div className="panel" style={{margin:0}}>
              <div className="panel-hdr">saved wines</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                {recentBooks.map(b => (
                  <Link key={b.wine_id} href={`/me/saved`} style={{display:'flex',alignItems:'center',gap:8,padding:'8px 10px',background:'var(--bg3)',borderRadius:8,textDecoration:'none'}}>
                    {b.image_url
                      ? <img src={b.image_url} alt={b.name} style={{width:28,height:28,borderRadius:6,objectFit:'cover',flexShrink:0}} />
                      : <span style={{fontSize:16,flexShrink:0}}>{ICO[b.style||'']||'🍷'}</span>}
                    <div style={{minWidth:0}}>
                      <p style={{fontSize:11,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:'var(--fg)'}}>{b.name}</p>
                      {b.vintage && <p style={{fontSize:9,color:'var(--fg-dim)'}}>{b.vintage}</p>}
                    </div>
                  </Link>
                ))}
              </div>
              <Link href="/me/saved" style={{display:'block',fontSize:10,color:'var(--accent)',marginTop:10,letterSpacing:'0.06em',fontFamily:'var(--mono)'}}>view all →</Link>
            </div>
          )}

          {/* Quick links */}
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {[{href:'/me/history',l:'◷ history'},{href:'/me/profile',l:'◉ profile'},{href:'/me/badges',l:'🏅 badges'},{href:'/hof',l:'★ hall of fame'}].map(({href,l}) => (
              <Link key={href} href={href} className="btn-s" style={{textDecoration:'none',display:'inline-block'}}>{l}</Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
