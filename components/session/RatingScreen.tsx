'use client'
import { use, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from './SessionShell'
import { PolarChart } from '@/components/charts/PolarChart'
import { AddWineModal } from '@/components/wine/AddWineModal'
import { getFL, detectFL, FL } from '@/lib/flavours'
import type { WineMeta } from '@/lib/session'

interface Props { params: Promise<{ code: string; wineId: string }> }
const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

export function RatingScreen({ params }: Props) {
  const { wineId } = use(params)
  const { wines, myRatings, code, displayName, refresh, isHost, bookmarkedIds, isBlind } = useSession()
  const router = useRouter()

  const wine = wines.find(w => w.id === wineId)
  const w = wine as (WineMeta & { _blind?: boolean }) | undefined
  const isRedacted = isBlind && w?._blind && !wine?.revealedAt
  const existing = myRatings[wineId]
  const fl = existing?.flavors && Object.keys(existing.flavors).length
    ? detectFL(existing.flavors as Record<string, number>)
    : isRedacted ? FL  // generic dimensions for blind wines
    : wine ? getFL(wine.type) : getFL('white')

  const [score, setScore] = useState(existing?.score || 0)
  const [flavors, setFlavors] = useState<Record<string, number>>(() => {
    const base = fl.reduce((o, f) => ({ ...o, [f.k]: 0 }), {} as Record<string, number>)
    if (existing?.flavors) Object.assign(base, existing.flavors)
    return base
  })
  const [notes, setNotes] = useState(existing?.notes || '')
  const [saving, setSaving] = useState(false)
  const [bookmarked, setBookmarked] = useState(() => bookmarkedIds?.has(wineId) || false)
  const [showEdit, setShowEdit] = useState(false)
  const [movePos, setMovePos] = useState('')
  const [moveError, setMoveError] = useState('')

  useEffect(() => {
    if (existing) {
      setScore(existing.score || 0)
      setNotes(existing.notes || '')
      const base = fl.reduce((o, f) => ({ ...o, [f.k]: 0 }), {} as Record<string, number>)
      if (existing.flavors) Object.assign(base, existing.flavors as Record<string, number>)
      setFlavors(base)
    }
  }, [wineId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!wine) return <div style={{padding:16,color:'var(--fg-dim)',fontSize:13}}>Wine not found.</div>

  async function save() {
    setSaving(true)
    await fetch(`/api/session/${code}/rate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName, wineId, score, flavors, notes }),
    })
    setSaving(false); refresh(); router.back()
  }

  async function resetRating() {
    if (!confirm('Reset your rating?')) return
    await fetch(`/api/session/${code}/rate/${wineId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName }),
    })
    refresh(); router.back()
  }

  async function toggleBookmark() {
    const method = bookmarked ? 'DELETE' : 'POST'
    await fetch(`/api/session/${code}/wines/${wineId}/bookmark`, {
      method, headers: { 'Content-Type': 'application/json' },
    })
    setBookmarked(!bookmarked)
  }

  async function moveWine(delta: number) {
    const idx = wines.findIndex(w => w.id === wineId)
    if (idx === -1) return
    const ordered = [...wines]
    const [w] = ordered.splice(idx, 1)
    ordered.splice(idx + delta, 0, w)
    await fetch(`/api/session/${code}/wines/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: ordered.map(w => w.id), userName: displayName }),
    })
    refresh()
  }

  async function moveToPosition() {
    setMoveError('')
    const target = parseInt(movePos, 10)
    if (!Number.isInteger(target) || target < 1 || target > wines.length) {
      setMoveError(`Position must be between 1 and ${wines.length}.`)
      return
    }
    const idx = wines.findIndex(w => w.id === wineId)
    if (idx === -1) return
    if (target - 1 === idx) { setMovePos(''); return } // already there
    const ordered = [...wines]
    const [w] = ordered.splice(idx, 1)
    ordered.splice(target - 1, 0, w)
    await fetch(`/api/session/${code}/wines/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: ordered.map(w => w.id), userName: displayName }),
    })
    setMovePos('')
    refresh()
  }

  async function deleteWine() {
    if (!confirm(`Delete "${wine!.name}"? This removes it for everyone.`)) return
    await fetch(`/api/session/${code}/wines/${wineId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName }),
    })
    refresh(); router.back()
  }

  const sub = !isRedacted ? [wine.producer, wine.grape].filter(Boolean).join(' · ') : ''
  const wineIndex = wines.findIndex(w2 => w2.id === wineId)

  return (
    <div style={{padding:'14px 14px 28px',maxWidth:580,margin:'0 auto'}}>
      {/* Back + title */}
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
        <button onClick={() => router.back()} style={{fontSize:12,color:'var(--fg-dim)',background:'none',border:'none',cursor:'pointer',fontFamily:'var(--mono)'}}>← back</button>
        <div style={{flex:1,minWidth:0}}>
          {isRedacted ? (
            <>
              <div style={{fontWeight:700,fontSize:14,color:'var(--fg-dim)'}}>🙈 Wine {wineIndex + 1}</div>
              <div style={{fontSize:10,color:'var(--fg-faint)',marginTop:1,letterSpacing:'0.06em'}}>identity hidden · host will reveal</div>
            </>
          ) : (
            <>
              <div style={{fontWeight:700,fontSize:14,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                {wine.revealedAt && isBlind && <span style={{fontSize:9,color:'var(--accent2)',letterSpacing:'0.08em',textTransform:'uppercase',marginRight:6,border:'1px solid rgba(143,184,122,0.3)',padding:'1px 5px',borderRadius:2}}>revealed</span>}
                {wine.name}
                {wine.vintage && <span style={{fontWeight:400,color:'var(--fg-dim)',marginLeft:6}}>– {wine.vintage}</span>}
              </div>
              {sub && <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:1}}>{sub}</div>}
            </>
          )}
        </div>
        <span style={{fontSize:22,flexShrink:0}}>{isRedacted ? '🙈' : (ICO[wine.type] || '🍷')}</span>
      </div>

      {!isRedacted && wine.imageUrl && (
        <img src={wine.imageUrl} alt={wine.name} style={{width:'100%',height:140,objectFit:'cover',borderRadius:14,marginBottom:10}} />
      )}

      {/* Stars */}
      <div className="panel">
        <div className="panel-hdr">overall score</div>
        <div style={{display:'flex',justifyContent:'center',gap:12}}>
          {[1,2,3,4,5].map(n => (
            <button key={n} onClick={() => setScore(n === score ? 0 : n)} style={{fontSize:28,background:'none',border:'none',cursor:'pointer',color:n<=score?'var(--accent)':'var(--fg-faint)',transition:'transform .1s',lineHeight:1}}>★</button>
          ))}
        </div>
      </div>

      {/* Polar chart */}
      <div className="panel" style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
        <div className="panel-hdr" style={{alignSelf:'flex-start',width:'100%'}}>flavour profile</div>
        <PolarChart flavors={flavors} fl={fl} size={280} />
      </div>

      {/* Sliders */}
      <div className="panel">
        {fl.map(f => {
          const v = flavors[f.k] || 0
          return (
            <div key={f.k} style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
              <span style={{fontSize:11,color:'var(--fg-dim)',width:70,flexShrink:0,fontFamily:'var(--mono)'}}>{f.l}</span>
              <div style={{flex:1}}>
                <input
                  type="range" min={0} max={5} step={1} value={v}
                  onChange={e => setFlavors(prev => ({ ...prev, [f.k]: Number(e.target.value) }))}
                  style={{width:'100%',height:4,appearance:'none',borderRadius:2,background:`linear-gradient(to right,${f.c} ${v*20}%,var(--bg3) ${v*20}%)`}}
                />
              </div>
              <span style={{fontSize:11,color:'var(--fg)',width:14,textAlign:'right',fontFamily:'var(--mono)'}}>{v}</span>
            </div>
          )
        })}
      </div>

      {/* Notes */}
      <div className="panel">
        <div className="panel-hdr">tasting notes</div>
        <textarea
          value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="aroma, palate, finish…" rows={3}
          style={{width:'100%',background:'transparent',fontSize:13,color:'var(--fg)',resize:'none',outline:'none',fontFamily:'var(--mono)',border:'none'}}
        />
      </div>

      {/* Host actions */}
      {isHost && (
        <>
          <div style={{display:'flex',gap:6,marginTop:10,flexWrap:'wrap',alignItems:'stretch'}}>
            <button className="btn-s" style={{flex:1}} onClick={() => setShowEdit(true)}>edit wine</button>
            <button className="btn-s" style={{flex:1}} onClick={() => moveWine(-1)}>move earlier</button>
            <button className="btn-s" style={{flex:1}} onClick={() => moveWine(1)}>move later</button>
            <div style={{display:'flex',gap:4,alignItems:'stretch'}}>
              <input
                type="number" min={1} max={wines.length} value={movePos}
                onChange={e => { setMovePos(e.target.value); setMoveError('') }}
                onKeyDown={e => e.key === 'Enter' && moveToPosition()}
                placeholder="#"
                style={{width:48,fontFamily:'var(--mono)',fontSize:10,textAlign:'center',background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.06)',borderRadius:10,color:'var(--fg)',padding:'10px 6px',outline:'none'}}
              />
              <button className="btn-s" onClick={moveToPosition} disabled={!movePos}>move to #</button>
            </div>
          </div>
          {moveError && <p style={{color:'#e07070',fontSize:11,marginTop:6}}>{moveError}</p>}
        </>
      )}

      <button className="btn-p" onClick={save} disabled={saving}>{saving ? 'saving…' : '→ commit rating'}</button>
      <button className="btn-g" onClick={toggleBookmark} style={{opacity: bookmarked ? 1 : 0.6}}>
        {bookmarked ? '★ saved' : '☆ save wine'}
      </button>
      <button className="btn-g" onClick={() => router.back()}>cancel</button>
      {existing && <button className="btn-g" onClick={resetRating}>⌫ reset my rating</button>}
      {isHost && <button className="btn-del" onClick={deleteWine}>⌫ delete this wine</button>}

      {showEdit && wine && (
        <AddWineModal
          code={code} userName={displayName} editWine={wine}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); refresh() }}
        />
      )}
    </div>
  )
}
