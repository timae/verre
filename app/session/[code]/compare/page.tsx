'use client'
import { useState, useEffect, useRef } from 'react'
import { useSession } from '@/components/session/SessionShell'
import { LineupLocked } from '@/components/session/LineupLocked'
import { PolarChart } from '@/components/charts/PolarChart'
import { RadarChart } from '@/components/charts/RadarChart'
import { getFL, detectFL, FL } from '@/lib/flavours'

const COLORS = ['rgba(200,150,60,.85)','rgba(122,175,200,.85)','rgba(184,64,64,.85)','rgba(106,170,130,.85)','rgba(200,104,128,.85)','rgba(160,110,200,.85)']

const RATER_CHIP_LIMIT = 3

type RaterEntry = { user: string; score: number }

function RaterChip({ user, score }: RaterEntry) {
  return (
    <span style={{fontSize:10,background:'var(--bg3)',border:'1px solid var(--border)',padding:'2px 8px',borderRadius:3,color:'var(--fg-dim)',fontFamily:'var(--mono)',whiteSpace:'nowrap'}}>
      {user} <span style={{color:'var(--accent)'}}>{score}★</span>
    </span>
  )
}

function RaterChips({ ratings }: { ratings: RaterEntry[] }) {
  const [showPopover, setShowPopover] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showPopover) return
    function onDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setShowPopover(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setShowPopover(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [showPopover])

  if (ratings.length === 0) return null

  const visible = ratings.slice(0, RATER_CHIP_LIMIT)
  const overflow = ratings.length - visible.length

  return (
    <div ref={wrapperRef} style={{display:'flex',flexWrap:'nowrap',gap:4,position:'relative',overflow:'hidden'}}>
      {visible.map(r => <RaterChip key={r.user} {...r} />)}
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setShowPopover(s => !s)}
          style={{fontSize:10,background:'rgba(200,150,60,0.08)',border:'1px solid rgba(200,150,60,0.3)',padding:'2px 8px',borderRadius:3,color:'var(--accent)',fontFamily:'var(--mono)',cursor:'pointer',whiteSpace:'nowrap'}}
        >
          +{overflow} more
        </button>
      )}
      {showPopover && (
        <div style={{position:'absolute',top:'calc(100% + 4px)',right:0,zIndex:20,background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:8,padding:10,boxShadow:'0 8px 24px rgba(0,0,0,0.4)',minWidth:160,maxWidth:260}}>
          <div style={{fontSize:9,letterSpacing:'0.1em',textTransform:'uppercase',color:'var(--fg-faint)',marginBottom:6,fontFamily:'var(--mono)'}}>all raters ({ratings.length})</div>
          <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
            {ratings.map(r => <RaterChip key={r.user} {...r} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function useIsNarrow(): boolean {
  const [isNarrow, setIsNarrow] = useState(false)
  useEffect(() => {
    const m = window.matchMedia('(max-width: 619px)')
    setIsNarrow(m.matches)
    const handler = (e: MediaQueryListEvent) => setIsNarrow(e.matches)
    m.addEventListener('change', handler)
    return () => m.removeEventListener('change', handler)
  }, [])
  return isNarrow
}

export default function ComparePage() {
  const { wines, allRatings, displayName, isBlind, isHost, sessionMeta } = useSession()
  type BlindWine = typeof wines[0] & { _blind?: boolean }
  const [viewUser, setViewUser] = useState('__me')
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())
  const isNarrow = useIsNarrow()

  const m = sessionMeta as typeof sessionMeta & { hideLineup?: boolean; hideLineupMinutesBefore?: number; dateFrom?: string | null }
  const revealAt = m?.hideLineup && m.dateFrom
    ? new Date(new Date(m.dateFrom).getTime() - (m.hideLineupMinutesBefore || 0) * 60 * 1000)
    : null
  const lineupHidden = !isHost && !!revealAt && Date.now() < revealAt.getTime()

  if (lineupHidden && revealAt) return (
    <div style={{padding:'14px 14px 28px',maxWidth:980,margin:'0 auto'}}>
      <LineupLocked revealAt={revealAt} />
    </div>
  )

  const ratedWines = wines.filter(w => Object.values(allRatings).some(u => u[w.id]?.score))
  const raters = [...new Set(Object.keys(allRatings).filter(u => Object.keys(allRatings[u]).length > 0))]

  if (ratedWines.length === 0) return (
    <div style={{padding:16,textAlign:'center',paddingTop:64,color:'var(--fg-dim)',fontSize:13}}>
      No ratings yet. Rate some wines to compare.
    </div>
  )

  const activeUser = viewUser === '__me' ? displayName : viewUser === '__all' ? null : viewUser

  function toggleCard(wineId: string) {
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (next.has(wineId)) next.delete(wineId); else next.add(wineId)
      return next
    })
  }

  return (
    <div style={{padding:'14px 14px 28px',maxWidth:980,margin:'0 auto'}}>
      {sessionMeta?.name && (
        <div style={{fontFamily:'var(--mono)',fontSize:'var(--fs-title)',fontWeight:800,letterSpacing:'0.02em',color:'var(--fg)',marginBottom:10}}>
          {sessionMeta.name}
        </div>
      )}
      <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:12,marginBottom:16,flexWrap:'wrap'}}>
        <div>
          <p style={{fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:4}}>// Compare</p>
          <h2 style={{fontSize:24,fontWeight:700,color:'#F0E3C6'}}>Tasting comparison</h2>
        </div>
        <button className="btn-s" onClick={() => window.print()}>export PDF</button>
      </div>

      {/* User filter tabs */}
      <div style={{display:'flex',gap:6,marginBottom:18,flexWrap:'wrap'}}>
        <button className="btn-s" style={{opacity:viewUser==='__me'?1:0.5}} onClick={() => setViewUser('__me')}>
          my ratings
        </button>
        {raters.filter(u => u !== displayName).map(u => (
          <button key={u} className="btn-s" style={{opacity:viewUser===u?1:0.5}} onClick={() => setViewUser(u)}>
            {u}
          </button>
        ))}
        {raters.length > 1 && (
          <button className="btn-s" style={{opacity:viewUser==='__all'?1:0.5}} onClick={() => setViewUser('__all')}>
            overlay all
          </button>
        )}
      </div>

      {/* Wine cards */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12}}>
        {ratedWines.map((wine, wineIdx) => {
          const bw = wine as BlindWine
          const isRedacted = isBlind && bw._blind && !wine.revealedAt
          const wasRevealed = isBlind && wine.revealedAt
          const allWineRatings = Object.entries(allRatings)
            .filter(([, u]) => u[wine.id])
            .map(([user, u], i) => ({ user, rating: u[wine.id], color: COLORS[i % COLORS.length] }))

          const avgScore = allWineRatings.length
            ? (allWineRatings.reduce((s, r) => s + (r.rating.score || 0), 0) / allWineRatings.length).toFixed(1)
            : '—'

          const singleRating = activeUser ? allRatings[activeUser]?.[wine.id] : null
          const fl = singleRating?.flavors
            ? detectFL(singleRating.flavors as Record<string, number>)
            : getFL(wine.type)

          // For overlay: use FL from first rater that has data
          const overlayFL = FL

          const overlaySeries = allWineRatings.map(r => ({
            label: r.user,
            flavors: (r.rating.flavors || {}) as Record<string, number>,
          }))

          const chartShown = !isNarrow || expandedCards.has(wine.id)
          const raterEntries: RaterEntry[] = allWineRatings.map(r => ({ user: r.user, score: r.rating.score || 0 }))

          return (
            <div key={wine.id} className="panel" style={{marginBottom:0}}>
              <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8,marginBottom:12}}>
                <div style={{minWidth:0}}>
                  {isRedacted ? (
                    <p style={{fontWeight:700,fontSize:13,color:'var(--fg-dim)'}}>🙈 Wine {wineIdx + 1}</p>
                  ) : (
                    <>
                      {wasRevealed && <span style={{fontSize:9,color:'var(--accent2)',letterSpacing:'0.08em',textTransform:'uppercase',display:'block',marginBottom:2}}>✓ revealed</span>}
                      <p style={{fontWeight:700,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                        {wine.name}
                        {wine.vintage && <span style={{fontWeight:400,color:'var(--fg-dim)',marginLeft:6}}>– {wine.vintage}</span>}
                      </p>
                      {wine.producer && <p style={{fontSize:10,color:'var(--fg-dim)',marginTop:2}}>{wine.producer}</p>}
                    </>
                  )}
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <span style={{fontSize:24,fontWeight:800,lineHeight:1,color:'var(--accent)'}}>{avgScore}</span>
                  <span style={{fontSize:10,color:'var(--fg-dim)',display:'block'}}>avg</span>
                </div>
              </div>

              {chartShown && (
                <div style={{display:'flex',justifyContent:'center',marginBottom:10}}>
                  {viewUser === '__all' ? (
                    <div style={{width:'100%'}}>
                      <RadarChart series={overlaySeries} fl={overlayFL} size={380} />
                      <div style={{display:'flex',flexWrap:'wrap',gap:6,marginTop:8,justifyContent:'center'}}>
                        {overlaySeries.map((s, i) => (
                          <div key={s.label} style={{display:'flex',alignItems:'center',gap:4,fontSize:10,color:'var(--fg-dim)'}}>
                            <div style={{width:8,height:3,borderRadius:2,background:COLORS[i%COLORS.length],flexShrink:0}} />
                            {s.label}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : singleRating ? (
                    <PolarChart flavors={(singleRating.flavors||{}) as Record<string,number>} fl={fl} size={380} />
                  ) : (
                    <div style={{height:200,display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,color:'var(--fg-faint)'}}>
                      no rating from {activeUser}
                    </div>
                  )}
                </div>
              )}

              {/* All rater scores */}
              <RaterChips ratings={raterEntries} />

              {singleRating?.notes && chartShown && (
                <p style={{fontSize:11,color:'var(--fg-dim)',marginTop:8,fontStyle:'italic',borderTop:'1px solid var(--border)',paddingTop:6}}>
                  &ldquo;{singleRating.notes}&rdquo;
                </p>
              )}

              {isNarrow && (
                <button
                  type="button" onClick={() => toggleCard(wine.id)}
                  style={{marginTop:10,width:'100%',background:'transparent',border:'1px dashed var(--border)',borderRadius:6,padding:'6px 0',color:'var(--fg-dim)',fontFamily:'var(--mono)',fontSize:10,letterSpacing:'0.1em',textTransform:'uppercase',cursor:'pointer'}}
                >
                  {chartShown ? '▴ hide chart' : '▾ show chart'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
