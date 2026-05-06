'use client'
import { useState, useEffect } from 'react'
import { useSession } from './SessionShell'
import { FlavorWheel, type WheelGeometry } from '@/components/charts/FlavorWheel'
import { CHART_SIZE } from '@/components/charts/sizes'
import { AddWineModal } from '@/components/wine/AddWineModal'
import { getFL, detectFL, FL } from '@/lib/flavours'
import type { WineMeta } from '@/lib/session'
import { sessionFetch } from '@/lib/sessionFetch'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { ConfirmDeleteButton } from '@/components/ui/ConfirmDeleteButton'
import { WineIdentity } from '@/components/wine/WineIdentity'
import { Modal } from '@/components/ui/Modal'

// Geometry preference is stored per-device in localStorage. Sunset:
// after a couple of weeks of real-world use we expect to settle on one
// preset and remove the toggle. Until then, the console.warn fires on
// each toggle interaction so the next maintainer (or future me) can't
// miss it.
const GEOMETRY_KEY = 'vr_wheel_geometry'
const GEOMETRY_SUNSET = '2026-05-20'

function readGeometry(): WheelGeometry {
  if (typeof window === 'undefined') return 'spacious'
  try {
    const v = window.localStorage.getItem(GEOMETRY_KEY)
    return v === 'compact' ? 'compact' : 'spacious'
  } catch {
    return 'spacious'
  }
}
function writeGeometry(g: WheelGeometry): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(GEOMETRY_KEY, g) } catch { /* private mode / quota */ }
}

interface Props { wineId: string; onClose: () => void }
const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

export function RatingScreen({ wineId, onClose }: Props) {
  const { wines, myRatings, code, refresh, isHost, bookmarkedIds, isBlind } = useSession()

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
  const [geometry, setGeometry] = useState<WheelGeometry>(readGeometry)
  // One-shot warning if the sunset date has passed and the toggle is
  // still in the codebase. Fires on mount of the rate modal — much more
  // likely to be noticed than a per-click warning that only surfaces if
  // someone happens to be at devtools at the moment of toggle.
  useEffect(() => {
    if (new Date() > new Date(GEOMETRY_SUNSET)) {
      console.warn(`[wheel] geometry toggle was scheduled for removal ${GEOMETRY_SUNSET} — please clean up`)
    }
  }, [])
  function toggleGeometry() {
    const next: WheelGeometry = geometry === 'spacious' ? 'compact' : 'spacious'
    setGeometry(next)
    writeGeometry(next)
  }
  const [showEdit, setShowEdit] = useState(false)
  const [movePos, setMovePos] = useState('')
  const [moveError, setMoveError] = useState('')
  const [moveSuccess, setMoveSuccess] = useState('')

  useEffect(() => {
    if (existing) {
      setScore(existing.score || 0)
      setNotes(existing.notes || '')
      const base = fl.reduce((o, f) => ({ ...o, [f.k]: 0 }), {} as Record<string, number>)
      if (existing.flavors) Object.assign(base, existing.flavors as Record<string, number>)
      setFlavors(base)
    }
  }, [wineId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!wine) return (
    <Modal onClose={onClose} maxWidth={400}>
      <div className="sheet-bar" />
      <p style={{padding:16,color:'var(--fg-dim)',fontSize:13}}>Wine not found.</p>
      <button className="btn-g" onClick={onClose}>close</button>
    </Modal>
  )

  async function save() {
    setSaving(true)
    await sessionFetch(code, `/api/session/${code}/rate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wineId, score, flavors, notes }),
    })
    setSaving(false); refresh(); onClose()
  }

  async function resetRating() {
    await sessionFetch(code, `/api/session/${code}/rate/${wineId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    refresh(); onClose()
  }

  async function toggleBookmark() {
    const method = bookmarked ? 'DELETE' : 'POST'
    await sessionFetch(code, `/api/session/${code}/wines/${wineId}/bookmark`, {
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
    await sessionFetch(code, `/api/session/${code}/wines/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: ordered.map(w => w.id) }),
    })
    refresh()
  }

  async function moveToPosition() {
    setMoveError('')
    setMoveSuccess('')
    const target = parseInt(movePos, 10)
    if (!Number.isInteger(target) || target < 1 || target > wines.length) {
      setMoveError(`Position must be between 1 and ${wines.length}.`)
      return
    }
    const idx = wines.findIndex(w => w.id === wineId)
    if (idx === -1) return
    if (target - 1 === idx) { setMoveSuccess(`already at position ${target}`); return }
    const ordered = [...wines]
    const [w] = ordered.splice(idx, 1)
    ordered.splice(target - 1, 0, w)
    await sessionFetch(code, `/api/session/${code}/wines/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: ordered.map(w => w.id) }),
    })
    setMoveSuccess(`moved to position ${target}`)
    refresh()
  }

  async function deleteWine() {
    await sessionFetch(code, `/api/session/${code}/wines/${wineId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    refresh(); onClose()
  }

  const wineIndex = wines.findIndex(w2 => w2.id === wineId)

  return (
    <Modal onClose={onClose} maxWidth={580} maxHeight="90vh">
      <div className="sheet-bar" />
      {/* Title row */}
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
        <div style={{flex:1,minWidth:0}}>
          {isRedacted ? (
            <>
              <div style={{fontWeight:700,fontSize:14,color:'var(--fg-dim)'}}>🙈 Wine {wineIndex + 1}</div>
              <div style={{fontSize:10,color:'var(--fg-faint)',marginTop:1,letterSpacing:'0.06em'}}>identity hidden · host will reveal</div>
            </>
          ) : (
            <WineIdentity
              wine={wine}
              size="compact"
              titlePrefix={wine.revealedAt && isBlind ? (
                <span style={{fontSize:9,color:'var(--accent2)',letterSpacing:'0.08em',textTransform:'uppercase',marginRight:6,border:'1px solid rgba(143,184,122,0.3)',padding:'1px 5px',borderRadius:2}}>revealed</span>
              ) : undefined}
            />
          )}
        </div>
        <span style={{fontSize:22,flexShrink:0}}>{isRedacted ? '🙈' : (ICO[wine.type] || '🍷')}</span>
      </div>

      {!isRedacted && wine.imageUrl && (
        <img src={wine.imageUrl} alt={wine.name} onClick={() => openLightbox(wine.imageUrl!, wine.name)} style={{width:'100%',height:140,objectFit:'cover',borderRadius:14,marginBottom:10,cursor:'zoom-in'}} />
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

      {/* Flavour wheel — input + visualization in one widget. Replaces
          the previous read-only polar chart + slider stack. */}
      <div className="panel" style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
        <div className="panel-hdr" style={{alignSelf:'flex-start',width:'100%'}}>flavour profile</div>
        <FlavorWheel flavors={flavors} fl={fl} onChange={setFlavors} size={CHART_SIZE.INPUT} geometry={geometry} />
        <button
          type="button"
          className="btn-s"
          onClick={toggleGeometry}
          style={{marginTop:14,fontSize:10,padding:'8px 14px'}}
          aria-label="switch wheel layout"
          aria-pressed={geometry === 'compact'}
        >
          try {geometry === 'spacious' ? 'compact' : 'spacious'} wheel
        </button>
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
            <button className="btn-s" style={{flex:1,padding:'10px 8px'}} onClick={() => setShowEdit(true)}>edit wine</button>
            <button className="btn-s" style={{flex:1,padding:'10px 8px'}} onClick={() => moveWine(-1)}>move earlier</button>
            <button className="btn-s" style={{flex:1,padding:'10px 8px'}} onClick={() => moveWine(1)}>move later</button>
            <div className="btn-s" style={{flex:1,padding:'4px 8px',display:'flex',alignItems:'center',justifyContent:'center',gap:6,cursor:'default'}}>
              <span style={{whiteSpace:'nowrap'}}>move to:</span>
              <input
                type="text" inputMode="numeric" pattern="[0-9]*"
                value={movePos}
                onChange={e => { setMovePos(e.target.value.replace(/\D/g,'')); setMoveError(''); setMoveSuccess('') }}
                onKeyDown={e => e.key === 'Enter' && moveToPosition()}
                onBlur={() => { if (movePos && !moveSuccess) moveToPosition() }}
                placeholder="#"
                style={{width:60,fontFamily:'var(--mono)',fontSize:12,textAlign:'center',
                  background: moveSuccess ? 'rgba(143,184,122,0.12)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${moveSuccess ? 'rgba(143,184,122,0.5)' : 'rgba(255,255,255,0.08)'}`,
                  borderRadius:6,color:'var(--fg)',padding:'4px 6px',outline:'none',transition:'background .25s, border-color .25s'}}
              />
            </div>
          </div>
          {moveError && <p style={{color:'#e07070',fontSize:11,marginTop:6}}>{moveError}</p>}
          {moveSuccess && <p style={{color:'var(--accent2)',fontSize:11,marginTop:6}}>✓ {moveSuccess}</p>}
        </>
      )}

      <button className="btn-p" onClick={save} disabled={saving}>{saving ? 'saving…' : '→ commit rating'}</button>
      <button className="btn-g" onClick={toggleBookmark} style={{opacity: bookmarked ? 1 : 0.6}}>
        {bookmarked ? '★ saved' : '☆ add to saved wines'}
      </button>
      <button className="btn-g" onClick={() => onClose()}>cancel</button>
      {existing && <ConfirmDeleteButton className="btn-g" label="⌫ reset my rating" confirmLabel="tap again to reset" onConfirm={resetRating} />}
      {isHost && <ConfirmDeleteButton label="⌫ delete this wine" confirmLabel="tap again to delete" onConfirm={deleteWine} />}

      {showEdit && wine && (
        <AddWineModal
          code={code} editWine={wine}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); refresh() }}
        />
      )}
    </Modal>
  )
}
