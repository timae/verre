'use client'
import { useState, useEffect, useRef } from 'react'
import { useSession } from '@/components/session/SessionShell'
import type { RatingMeta } from '@/lib/session'
import { LineupLocked } from '@/components/session/LineupLocked'
import { PolarChart } from '@/components/charts/PolarChart'
import { RadarChart } from '@/components/charts/RadarChart'
import { CHART_SIZE } from '@/components/charts/sizes'
import { getFL, detectFL, FL } from '@/lib/flavours'
import { WineIdentity } from '@/components/wine/WineIdentity'

const COLORS = ['rgba(200,150,60,.85)','rgba(122,175,200,.85)','rgba(184,64,64,.85)','rgba(106,170,130,.85)','rgba(200,104,128,.85)','rgba(160,110,200,.85)']

const TCOL: Record<string, string> = { red:'#B84040', white:'#C8A84B', spark:'#7AAFC8', rose:'#C86880', nonalc:'#6AAA82' }
const ICO:  Record<string, string> = { red:'🍷', white:'🥂', spark:'🍾', rose:'🌸', nonalc:'🌿' }

const RATER_CHIP_LIMIT = 3

type RaterEntry = { user: string; score: number }

function RaterChip({ user, score }: RaterEntry) {
  return (
    <span style={{fontSize:10,background:'var(--bg3)',border:'1px solid var(--border)',padding:'2px 8px',borderRadius:3,color:'var(--fg-dim)',fontFamily:'var(--mono)',whiteSpace:'nowrap'}}>
      {user} <span style={{color:'var(--accent)'}}>{score}★</span>
    </span>
  )
}

function RaterChips({ ratings, isOpen, onToggle, onClose }: {
  ratings: RaterEntry[]; isOpen: boolean; onToggle: () => void; onClose: () => void
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    function onDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen, onClose])

  if (ratings.length === 0) return null

  const visible = ratings.slice(0, RATER_CHIP_LIMIT)
  const overflow = ratings.length - visible.length

  return (
    <div ref={wrapperRef} style={{position:'relative'}}>
      <div style={{display:'flex',flexWrap:'nowrap',gap:4,overflow:'hidden'}}>
        {visible.map(r => <RaterChip key={r.user} {...r} />)}
        {overflow > 0 && (
          <button
            type="button"
            onClick={onToggle}
            style={{fontSize:10,background:'rgba(200,150,60,0.08)',border:'1px solid rgba(200,150,60,0.3)',padding:'2px 8px',borderRadius:3,color:'var(--accent)',fontFamily:'var(--mono)',cursor:'pointer',whiteSpace:'nowrap'}}
          >
            +{overflow} more
          </button>
        )}
      </div>
      {isOpen && (
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
    const m = window.matchMedia('(max-width: 600px)')
    setIsNarrow(m.matches)
    const handler = (e: MediaQueryListEvent) => setIsNarrow(e.matches)
    m.addEventListener('change', handler)
    return () => m.removeEventListener('change', handler)
  }, [])
  return isNarrow
}

export default function ComparePage() {
  const { wines, allRatings, myId, isBlind, isHost, sessionMeta } = useSession()
  type BlindWine = typeof wines[0] & { _blind?: boolean }
  // viewUser holds an identity id (e.g. "u:42", "a:<uuid>") or one of the
  // sentinels "__me" / "__all". Storing the id rather than the display name
  // means the filter survives a participant being renamed mid-session and
  // never confuses two participants who share a display name.
  const [viewUser, setViewUser] = useState('__me')
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())
  const [openRaterCard, setOpenRaterCard] = useState<string | null>(null)
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

  // Build the rater list from the id-keyed allRatings shape. Each entry is
  // { id, displayName, ratings } — id drives state, displayName drives UI.
  type Rater = { id: string; displayName: string; ratings: Record<string, RatingMeta> }
  const ratersWithRatings: Rater[] = Object.entries(allRatings)
    .filter(([, bucket]) => bucket && Object.keys(bucket.ratings || {}).length > 0)
    .map(([id, bucket]) => ({ id, displayName: bucket.displayName, ratings: bucket.ratings }))

  const ratedWines = wines.filter(w => ratersWithRatings.some(r => r.ratings[w.id]?.score))

  if (ratedWines.length === 0) return (
    <div style={{padding:16,textAlign:'center',paddingTop:64,color:'var(--fg-dim)',fontSize:13}}>
      No ratings yet. Rate some wines to compare.
    </div>
  )

  // activeUserId resolves "__me" / "__all" / specific-id into the id whose
  // ratings should be shown (or null for "__all").
  const activeUserId = viewUser === '__me' ? myId : viewUser === '__all' ? null : viewUser

  function toggleCard(wineId: string) {
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (next.has(wineId)) next.delete(wineId); else next.add(wineId)
      return next
    })
  }

  const allExpanded = ratedWines.length > 0 && ratedWines.every(w => expandedCards.has(w.id))
  function toggleAll() {
    if (allExpanded) setExpandedCards(new Set())
    else setExpandedCards(new Set(ratedWines.map(w => w.id)))
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
        {ratersWithRatings.filter(r => r.id !== myId).map(r => (
          <button key={r.id} className="btn-s" style={{opacity:viewUser===r.id?1:0.5}} onClick={() => setViewUser(r.id)}>
            {r.displayName}
          </button>
        ))}
        {ratersWithRatings.length > 1 && (
          <button className="btn-s" style={{opacity:viewUser==='__all'?1:0.5}} onClick={() => setViewUser('__all')}>
            overlay all
          </button>
        )}
      </div>

      {/* Show/hide all charts toggle (narrow viewports only) */}
      {isNarrow && ratedWines.length > 0 && (
        <div style={{marginBottom:12}}>
          <button className="btn-s" onClick={toggleAll} style={{width:'100%'}}>
            {allExpanded ? '▴ hide all charts' : '▾ show all charts'}
          </button>
        </div>
      )}

      {/* Wine cards */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12}}>
        {ratedWines.map((wine, wineIdx) => {
          const bw = wine as BlindWine
          const isRedacted = isBlind && bw._blind && !wine.revealedAt
          const wasRevealed = isBlind && wine.revealedAt
          // For each rater that rated *this* wine: pull their rating, attach a
          // chart color, and remember their displayName for legends and chips.
          const allWineRatings = ratersWithRatings
            .filter(r => r.ratings[wine.id])
            .map((r, i) => ({
              id: r.id,
              user: r.displayName,
              rating: r.ratings[wine.id],
              color: COLORS[i % COLORS.length],
            }))

          const avgScore = allWineRatings.length
            ? (allWineRatings.reduce((s, r) => s + (r.rating.score || 0), 0) / allWineRatings.length).toFixed(1)
            : '—'

          const singleRating = activeUserId ? allRatings[activeUserId]?.ratings[wine.id] : null
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

          const accentColor = TCOL[wine.type] || TCOL.red
          const isRaterOpen = openRaterCard === wine.id
          return (
            <div key={wine.id} className="panel" style={{marginBottom:0,position:'relative',zIndex: isRaterOpen ? 30 : undefined}}>
              <div aria-hidden style={{position:'absolute',inset:0,overflow:'hidden',borderRadius:'inherit',pointerEvents:'none'}}>
                <div style={{position:'absolute',left:0,top:0,bottom:0,width:2,background: isRedacted ? 'var(--fg-faint)' : accentColor,opacity:0.6}} />
              </div>
              <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8,marginBottom:12}}>
                <div style={{minWidth:0}}>
                  {isRedacted ? (
                    <p style={{fontWeight:700,fontSize:13,color:'var(--fg-dim)'}}>🙈 Wine {wineIdx + 1}</p>
                  ) : (
                    <>
                      {wasRevealed && <span style={{fontSize:9,color:'var(--accent2)',letterSpacing:'0.08em',textTransform:'uppercase',display:'block',marginBottom:2}}>✓ revealed</span>}
                      <WineIdentity
                        wine={wine}
                        size="compact"
                        titlePrefix={<span style={{marginRight:6}}>{ICO[wine.type] || '🍷'}</span>}
                      />
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
                      <RadarChart series={overlaySeries} fl={overlayFL} size={CHART_SIZE.COMPARE} />
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
                    <PolarChart flavors={(singleRating.flavors||{}) as Record<string,number>} fl={fl} size={CHART_SIZE.COMPARE} />
                  ) : (
                    <div style={{height:200,display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,color:'var(--fg-faint)'}}>
                      no rating from {(activeUserId && allRatings[activeUserId]?.displayName) || 'this user'}
                    </div>
                  )}
                </div>
              )}

              {/* All rater scores */}
              <RaterChips
                ratings={raterEntries}
                isOpen={isRaterOpen}
                onToggle={() => setOpenRaterCard(prev => prev === wine.id ? null : wine.id)}
                onClose={() => setOpenRaterCard(null)}
              />

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
