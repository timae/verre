'use client'
import { useSession } from './SessionShell'
import { AddWineModal } from '@/components/wine/AddWineModal'
import { LineupLocked } from './LineupLocked'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { WineMeta } from '@/lib/session'

const TCOL: Record<string, string> = { red:'#B84040', white:'#C8A84B', spark:'#7AAFC8', rose:'#C86880', nonalc:'#6AAA82' }
const ICO:  Record<string, string> = { red:'🍷', white:'🥂', spark:'🍾', rose:'🌸', nonalc:'🌿' }

function renderWithLinks(text: string) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  return parts.map((part, i) =>
    /^https?:\/\//.test(part)
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{color:'var(--accent)'}}>{part}</a>
      : part
  )
}

function formatDate(dt: string) {
  if (!dt) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(dt))
  } catch { return dt }
}

export function WineListScreen() {
  const { wines, myRatings, isHost, code, displayName, refresh, isBlind, sessionMeta } = useSession()
  const [showAdd, setShowAdd] = useState(false)
  const router = useRouter()

  const m = sessionMeta as typeof sessionMeta & {
    address?: string; dateFrom?: string | null; dateTo?: string | null
    description?: string; link?: string
    hideLineup?: boolean; hideLineupMinutesBefore?: number
  }

  const revealAt = m?.hideLineup && m.dateFrom
    ? new Date(new Date(m.dateFrom).getTime() - (m.hideLineupMinutesBefore || 0) * 60 * 1000)
    : null
  const lineupHidden = !isHost && !!revealAt && Date.now() < revealAt.getTime()

  const allRevealed = wines.length > 0 && wines.every(w => w.revealedAt)
  const mapsUrl = m?.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(m.address)}` : ''

  async function revealWine(wineId: string) {
    await fetch(`/api/session/${code}/wines/${wineId}/reveal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName }),
    })
    refresh()
  }

  async function hideWine(wineId: string) {
    await fetch(`/api/session/${code}/wines/${wineId}/reveal`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName }),
    })
    refresh()
  }

  async function revealAll() {
    await fetch(`/api/session/${code}/wines/reveal-all`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName }),
    })
    refresh()
  }

  async function hideAll() {
    await fetch(`/api/session/${code}/wines/hide-all`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName }),
    })
    refresh()
  }

  return (
    <div style={{padding:'14px 14px 28px'}}>
      <div style={{maxWidth:980,margin:'0 auto'}}>

        {/* Session title + blind badge */}
        {sessionMeta?.name && (
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10,flexWrap:'wrap'}}>
            <div style={{fontFamily:'var(--mono)',fontSize:'var(--fs-title)',fontWeight:800,letterSpacing:'0.02em',color:'var(--fg)'}}>
              {sessionMeta.name}
            </div>
            {isBlind && <div style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:9,letterSpacing:'0.12em',textTransform:'uppercase',color:'var(--accent)',border:'1px solid rgba(200,150,60,0.3)',background:'rgba(200,150,60,0.08)',padding:'3px 8px',borderRadius:3}}>🙈 Blind tasting</div>}
          </div>
        )}

        {/* Session metadata block — order: description, date, address, link */}
        {(m?.description || m?.dateFrom || m?.address || m?.link) && (
          <div style={{marginBottom:16,padding:'10px 12px',background:'var(--bg2)',borderRadius:8,border:'1px solid var(--border)',display:'flex',flexDirection:'column',gap:6}}>
            {m.description && (
              <div style={{fontSize:12,color:'var(--fg)',lineHeight:1.5,whiteSpace:'pre-wrap'}}>{renderWithLinks(m.description)}</div>
            )}
            {m.dateFrom && (
              <div style={{fontSize:11,color:'var(--fg-dim)',display:'flex',alignItems:'center',gap:4,flexWrap:'wrap'}}>
                <span>🕐</span>
                <span>{formatDate(m.dateFrom)}</span>
                {m.dateTo && <><span>→</span><span>{formatDate(m.dateTo)}</span></>}
              </div>
            )}
            {m.address && (
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
                style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:'var(--accent)',textDecoration:'none'}}>
                <span>📍</span>{m.address}
              </a>
            )}
            {m.link && (
              <a href={m.link} target="_blank" rel="noopener noreferrer"
                style={{fontSize:11,color:'var(--accent)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'flex',alignItems:'center',gap:6}}>
                <span>🔗</span>{m.link}
              </a>
            )}
          </div>
        )}

        {/* Wine list header */}
        <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:12,marginBottom:16}}>
          <div>
            {isBlind && !sessionMeta?.name && <div style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:9,letterSpacing:'0.12em',textTransform:'uppercase',color:'var(--accent)',border:'1px solid rgba(200,150,60,0.3)',background:'rgba(200,150,60,0.08)',padding:'3px 8px',borderRadius:3,marginBottom:8}}>🙈 Blind tasting</div>}
            <div className="subhead" style={{margin:0}}>
              <div className="subhead-title">Wine list</div>
              <div className="subhead-copy">{lineupHidden ? '??' : wines.length} bottle{!lineupHidden && wines.length !== 1 ? 's' : lineupHidden ? 's' : ''}</div>
            </div>
          </div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            {isHost && isBlind && wines.length > 0 && (
              allRevealed
                ? <button className="btn-s" onClick={hideAll}>hide all</button>
                : <button className="btn-s" onClick={revealAll}>reveal all</button>
            )}
            {isHost && <button className="btn-s" onClick={() => setShowAdd(true)}>+ add wine</button>}
          </div>
        </div>

        {/* Lineup hidden */}
        {lineupHidden && revealAt && <LineupLocked revealAt={revealAt} />}

        {!lineupHidden && wines.length === 0 && (
          <div style={{textAlign:'center',padding:'48px 0',color:'var(--fg-dim)',fontSize:13}}>
            {isHost ? 'Add the first wine to get started.' : 'Waiting for the host to add wines.'}
          </div>
        )}

        {!lineupHidden && (
          <div className="wine-stack">
            {wines.map((wine, idx) => {
              const w = wine as WineMeta & { _blind?: boolean }
              const isRevealed = !!wine.revealedAt
              const isRedacted = isBlind && w._blind
              const rating = myRatings[wine.id]
              const accentColor = TCOL[wine.type] || TCOL.red

              return (
                <div key={wine.id} className="wine-card" style={{cursor:'pointer'}}
                  onClick={() => router.push(`/session/${code}/rate/${wine.id}?name=${encodeURIComponent(displayName)}`)}>
                  <div style={{position:'absolute',left:0,top:0,bottom:0,width:2,background: isRedacted ? 'var(--fg-faint)' : accentColor,opacity:0.6}} />
                  <div style={{width:24,flexShrink:0,textAlign:'right',fontFamily:'var(--mono)',fontSize:18,fontWeight:700,color:'var(--fg-faint)',lineHeight:1}}>{idx + 1}</div>

                  {!isRedacted && wine.imageUrl ? (
                    <img src={wine.imageUrl} alt={wine.name} style={{width:38,height:38,borderRadius:8,objectFit:'cover',flexShrink:0}} />
                  ) : (
                    <div style={{width:38,height:38,borderRadius:8,background:'var(--bg3)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize: isRedacted ? 22 : 18}}>
                      {isRedacted ? '🙈' : (ICO[wine.type] || '🍷')}
                    </div>
                  )}

                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color: isRedacted ? 'var(--fg-dim)' : 'var(--fg)'}}>
                      {wine.name}
                      {!isRedacted && wine.vintage && <span style={{fontWeight:400,color:'var(--fg-dim)',marginLeft:6}}>– {wine.vintage}</span>}
                    </div>
                    {!isRedacted && wine.producer && (
                      <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:2}}>{wine.producer}</div>
                    )}
                    {isRedacted && (
                      <div style={{fontSize:10,color:'var(--fg-faint)',marginTop:2,letterSpacing:'0.06em'}}>hidden until revealed</div>
                    )}
                  </div>

                  <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}} onClick={e => e.stopPropagation()}>
                    {isHost && isBlind && !isRevealed && (
                      <button onClick={() => revealWine(wine.id)}
                        style={{fontSize:9,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent)',border:'1px solid rgba(200,150,60,0.3)',background:'rgba(200,150,60,0.08)',padding:'4px 8px',borderRadius:3,cursor:'pointer'}}>
                        reveal
                      </button>
                    )}
                    {isHost && isBlind && isRevealed && (
                      <button onClick={() => hideWine(wine.id)}
                        style={{fontSize:9,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent2)',border:'1px solid rgba(143,184,122,0.2)',background:'transparent',padding:'4px 8px',borderRadius:3,cursor:'pointer'}}>
                        ✓ hide
                      </button>
                    )}
                    {rating?.score && rating.score > 0 && (
                      <div style={{textAlign:'right'}}>
                        <span style={{fontSize:22,fontWeight:800,lineHeight:1,color:'var(--accent)'}}>{rating.score}</span>
                        <span style={{fontSize:10,color:'var(--fg-dim)'}}>/5</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {showAdd && (
          <AddWineModal code={code} userName={displayName} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); refresh() }} />
        )}
      </div>
    </div>
  )
}
