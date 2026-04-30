'use client'
import { useSession } from './SessionShell'
import { AddWineModal } from '@/components/wine/AddWineModal'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { WineMeta } from '@/lib/session'

const TCOL: Record<string, string> = { red:'#B84040', white:'#C8A84B', spark:'#7AAFC8', rose:'#C86880', nonalc:'#6AAA82' }

function formatDate(dt: string, tz?: string) {
  if (!dt) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz || undefined,
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(dt))
  } catch { return dt }
}

export function WineListScreen() {
  const { wines, myRatings, isHost, code, displayName, refresh, isBlind, sessionMeta } = useSession()
  const m = sessionMeta as typeof sessionMeta & {
    address?: string; dateFrom?: string | null; dateTo?: string | null
    timezone?: string; description?: string; link?: string
  }
  const [showAdd, setShowAdd] = useState(false)
  const router = useRouter()

  async function revealWine(wineId: string) {
    await fetch(`/api/session/${code}/wines/${wineId}/reveal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName }),
    })
    refresh()
  }

  return (
    <div style={{padding:'14px 14px 28px'}}>
      <div style={{maxWidth:980,margin:'0 auto'}}>
        <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:12,marginBottom:16}}>
          <div>
            {isBlind && <div style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:9,letterSpacing:'0.12em',textTransform:'uppercase',color:'var(--accent)',border:'1px solid rgba(200,150,60,0.3)',background:'rgba(200,150,60,0.08)',padding:'3px 8px',borderRadius:3,marginBottom:8}}>🙈 Blind tasting</div>}
            <div className="subhead" style={{margin:0}}>
              <div className="subhead-title">Wine list</div>
              <div className="subhead-copy">{wines.length} bottle{wines.length !== 1 ? 's' : ''}</div>
            </div>
          </div>
          {isHost && <button className="btn-s" onClick={() => setShowAdd(true)}>+ add wine</button>}
        </div>

        {/* Session metadata block */}
        {(m?.address || m?.dateFrom || m?.description || m?.link) && (
          <div style={{marginBottom:14,padding:'10px 12px',background:'var(--bg2)',borderRadius:8,border:'1px solid var(--border)',display:'flex',flexDirection:'column',gap:6}}>
            {m.address && (
              <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(m.address)}`}
                target="_blank" rel="noopener noreferrer"
                style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:'var(--accent)',textDecoration:'none'}}>
                <span>📍</span>{m.address}
              </a>
            )}
            {m.dateFrom && (
              <div style={{fontSize:11,color:'var(--fg-dim)',display:'flex',alignItems:'center',gap:4,flexWrap:'wrap'}}>
                <span>🕐</span>
                <span>{formatDate(m.dateFrom, m.timezone)}</span>
                {m.dateTo && <><span>→</span><span>{formatDate(m.dateTo, m.timezone)}</span></>}
                {m.timezone && <span style={{fontSize:9,opacity:0.6}}>({m.timezone})</span>}
              </div>
            )}
            {m.description && <div style={{fontSize:12,color:'var(--fg)',lineHeight:1.5}}>{m.description}</div>}
            {m.link && (
              <a href={m.link} target="_blank" rel="noopener noreferrer"
                style={{fontSize:11,color:'var(--accent)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'flex',alignItems:'center',gap:6}}>
                <span>🔗</span>{m.link}
              </a>
            )}
          </div>
        )}

        {wines.length === 0 && (
          <div style={{textAlign:'center',padding:'48px 0',color:'var(--fg-dim)',fontSize:13}}>
            {isHost ? 'Add the first wine to get started.' : 'Waiting for the host to add wines.'}
          </div>
        )}

        <div className="wine-stack">
          {wines.map((wine, idx) => {
            const w = wine as WineMeta & { _blind?: boolean }
            const isRevealed = !!wine.revealedAt
            const isRedacted = isBlind && w._blind
            const rating = myRatings[wine.id]
            const accentColor = TCOL[wine.type] || TCOL.red

            return (
              <div key={wine.id} style={{position:'relative'}}>
                <button
                  onClick={() => router.push(`/session/${code}/rate/${wine.id}?name=${encodeURIComponent(displayName)}`)}
                  className="wine-card"
                  style={{width:'100%',textAlign:'left'}}
                >
                  <div style={{position:'absolute',left:0,top:0,bottom:0,width:2,background: isRedacted ? 'var(--fg-faint)' : accentColor,opacity:0.6}} />
                  <div style={{width:24,flexShrink:0,textAlign:'right',fontFamily:'var(--mono)',fontSize:18,fontWeight:700,color:'var(--fg-faint)',lineHeight:1}}>{idx + 1}</div>

                  {/* Icon / photo */}
                  {!isRedacted && wine.imageUrl ? (
                    <img src={wine.imageUrl} alt={wine.name} style={{width:38,height:38,borderRadius:8,objectFit:'cover',flexShrink:0}} />
                  ) : (
                    <div style={{width:38,height:38,borderRadius:8,background:'var(--bg3)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize: isRedacted ? 22 : 18}}>
                      {isRedacted ? '🙈' : '🍷'}
                    </div>
                  )}

                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color: isRedacted ? 'var(--fg-dim)' : 'var(--fg)'}}>
                      {wine.name}
                    </div>
                    {!isRedacted && wine.producer && (
                      <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:2}}>{[wine.producer, wine.vintage].filter(Boolean).join(' · ')}</div>
                    )}
                    {isRedacted && (
                      <div style={{fontSize:10,color:'var(--fg-faint)',marginTop:2,letterSpacing:'0.06em'}}>hidden until revealed</div>
                    )}
                  </div>

                  {rating?.score && rating.score > 0 && (
                    <div style={{flexShrink:0,textAlign:'right'}}>
                      <span style={{fontSize:22,fontWeight:800,lineHeight:1,color:'var(--accent)'}}>{rating.score}</span>
                      <span style={{fontSize:10,color:'var(--fg-dim)'}}>/5</span>
                    </div>
                  )}
                </button>

                {/* Host reveal button */}
                {isHost && isBlind && !isRevealed && (
                  <button
                    onClick={() => revealWine(wine.id)}
                    style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',fontSize:9,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent)',border:'1px solid rgba(200,150,60,0.3)',background:'rgba(200,150,60,0.08)',padding:'4px 8px',borderRadius:3,cursor:'pointer',zIndex:1}}
                  >
                    reveal
                  </button>
                )}
                {isHost && isBlind && isRevealed && (
                  <div style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',fontSize:9,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent2)',zIndex:1}}>
                    ✓ revealed
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {showAdd && (
          <AddWineModal code={code} userName={displayName} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); refresh() }} />
        )}
      </div>
    </div>
  )
}
