'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { useSession } from './SessionShell'
import { AddWineModal } from '@/components/wine/AddWineModal'
import { WineIdentity } from '@/components/wine/WineIdentity'
import { StarRating } from '@/components/ui/StarRating'
import { LineupLocked } from './LineupLocked'
import { RatingScreen } from './RatingScreen'
import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import type { WineMeta } from '@/lib/session'
import { sessionFetch } from '@/lib/sessionFetch'
import { sessionPath } from '@/lib/sessionCode'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

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

interface Props { initialRateWineId?: string }

export function WineListScreen({ initialRateWineId }: Props = {}) {
  const { wines, myRatings, isHost, code, refresh, isBlind, sessionMeta, winesLoading } = useSession()
  const [showAdd, setShowAdd] = useState(false)
  const [rateWineId, setRateWineId] = useState<string | null>(initialRateWineId ?? null)
  const router = useRouter()
  const pathname = usePathname()

  const m = sessionMeta as typeof sessionMeta & {
    address?: string; dateFrom?: string | null; dateTo?: string | null
    description?: string; link?: string
    hideLineup?: boolean; hideLineupMinutesBefore?: number
  }

  const revealAt = m?.hideLineup && m.dateFrom
    ? new Date(new Date(m.dateFrom).getTime() - (m.hideLineupMinutesBefore || 0) * 60 * 1000)
    : null
  const lineupHidden = !isHost && !!revealAt && Date.now() < revealAt.getTime()

  useEffect(() => {
    if (!lineupHidden || !revealAt) return
    const ms = revealAt.getTime() - Date.now()
    if (ms <= 0) { refresh(); return }
    const t = setTimeout(() => refresh(), ms + 500)
    return () => clearTimeout(t)
  }, [lineupHidden, revealAt?.getTime()])

  const allRevealed = wines.length > 0 && wines.every(w => w.revealedAt)
  const mapsUrl = m?.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(m.address)}` : ''

  async function revealWine(wineId: string) {
    await sessionFetch(code, `/api/session/${code}/wines/${wineId}/reveal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    refresh()
  }

  async function hideWine(wineId: string) {
    await sessionFetch(code, `/api/session/${code}/wines/${wineId}/reveal`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    refresh()
  }

  async function revealAll() {
    await sessionFetch(code, `/api/session/${code}/wines/reveal-all`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    refresh()
  }

  async function hideAll() {
    await sessionFetch(code, `/api/session/${code}/wines/hide-all`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    refresh()
  }

  // Optimistic drag-reorder. We override the displayed wine order with
  // `pendingOrder` while a reorder POST is in flight; on success we drop
  // the override and let the next refresh's order win, on failure we
  // drop the override AND refresh to surface the server's truth.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)

  // Reset the pending override whenever the server-side order changes —
  // protects against stale overrides surviving a refresh from another
  // tab or a co-host's reorder.
  useEffect(() => { setPendingOrder(null) }, [wines.map(w => w.id).join(',')])

  const displayWines = (() => {
    if (!pendingOrder) return wines
    const byId = new Map(wines.map(w => [w.id, w]))
    const ordered: typeof wines = []
    for (const id of pendingOrder) {
      const w = byId.get(id)
      if (w) ordered.push(w)
    }
    // Append any wines added since the override (extremely rare race) so
    // we don't drop rows on screen.
    for (const w of wines) if (!pendingOrder.includes(w.id)) ordered.push(w)
    return ordered
  })()

  const sensors = useSensors(
    // Drag from the handle — `distance: 4` means a small finger jitter
    // doesn't initiate a drag, but a deliberate move does. Activation
    // requires the dnd-kit `listeners` to be attached to the handle, so
    // tapping anywhere else on the row stays a click-to-rate.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = displayWines.map(w => w.id)
    const oldIdx = ids.indexOf(String(active.id))
    const newIdx = ids.indexOf(String(over.id))
    if (oldIdx === -1 || newIdx === -1) return
    const next = arrayMove(ids, oldIdx, newIdx)
    setPendingOrder(next)
    const res = await sessionFetch(code, `/api/session/${code}/wines/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: next }),
    })
    if (!res.ok) {
      setPendingOrder(null)
      refresh()
      return
    }
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
            {m.description && (m.dateFrom || m.address || m.link) && (
              <div style={{borderTop:'1px solid var(--border)',margin:'6px 0 2px'}} />
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
              <div className="subhead-copy">{lineupHidden || (winesLoading && wines.length === 0) ? '??' : wines.length} bottle{(lineupHidden || (winesLoading && wines.length === 0)) ? 's' : wines.length !== 1 ? 's' : ''}</div>
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
        {lineupHidden && revealAt && <LineupLocked revealAt={revealAt} onReveal={refresh} />}

        {!lineupHidden && wines.length === 0 && (
          <div style={{textAlign:'center',padding:'48px 0',color:'var(--fg-dim)',fontSize:13}}>
            {winesLoading
              ? 'Loading wines…'
              : isHost
                ? 'Add the first wine to get started.'
                : 'No wines yet — the host hasn\'t added any.'}
          </div>
        )}

        {!lineupHidden && (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={displayWines.map(w => w.id)} strategy={verticalListSortingStrategy}>
              <div className="wine-stack">
                {displayWines.map((wine, idx) => (
                  <WineRow
                    key={wine.id}
                    wine={wine as WineMeta & { _blind?: boolean }}
                    idx={idx}
                    isBlind={isBlind}
                    isHost={isHost}
                    rating={myRatings[wine.id]}
                    onClick={() => setRateWineId(wine.id)}
                    onReveal={() => revealWine(wine.id)}
                    onHide={() => hideWine(wine.id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}

        {showAdd && (
          <AddWineModal code={code} winesCount={wines.length} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); refresh() }} />
        )}

        {rateWineId && (
          <RatingScreen wineId={rateWineId} onClose={() => {
            setRateWineId(null)
            // If the user landed via direct URL /session/<code>/rate/<wineId>,
            // closing the modal should leave them on the wine list URL —
            // not on the rate URL where a refresh would re-open the modal.
            if (pathname?.includes('/rate/')) router.replace(sessionPath(code))
          }} />
        )}
      </div>
    </div>
  )
}

// Sortable wine-list row. Drag handle is host-only and lives on the
// right edge between the reveal/hide control and the score chip;
// activating it requires a small (4px / 200ms-touch) movement, so taps
// elsewhere on the card still open the rate modal. Tasters see no
// handle and the SortableContext's listeners are simply not attached
// — the API would reject any reorder POST from a non-host anyway, but
// hiding the affordance is the right UX.
function WineRow({
  wine, idx, isBlind, isHost, rating, onClick, onReveal, onHide,
}: {
  wine: WineMeta & { _blind?: boolean }
  idx: number
  isBlind: boolean
  isHost: boolean
  rating?: { score: number }
  onClick: () => void
  onReveal: () => void
  onHide: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: wine.id, disabled: !isHost })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: 'pointer',
    // Lift the dragged row above its siblings so the `transform` from
    // dnd-kit doesn't get clipped by neighbouring cards' stacking.
    zIndex: isDragging ? 2 : undefined,
    opacity: isDragging ? 0.85 : 1,
    boxShadow: isDragging ? '0 12px 32px rgba(0,0,0,0.5)' : undefined,
  }

  const isRevealed = !!wine.revealedAt
  const isRedacted = isBlind && wine._blind
  const accentColor = TCOL[wine.type] || TCOL.red

  return (
    <div ref={setNodeRef} style={style} className="wine-card" onClick={onClick}>
      <div style={{position:'absolute',left:0,top:0,bottom:0,width:2,background: isRedacted ? 'var(--fg-faint)' : accentColor,opacity:0.6}} />
      <div style={{width:24,flexShrink:0,textAlign:'right',fontFamily:'var(--mono)',fontSize:18,fontWeight:700,color:'var(--fg-faint)',lineHeight:1}}>{idx + 1}</div>

      {!isRedacted && wine.imageUrl ? (
        <img src={wine.imageUrl} alt={wine.name} onClick={e=>{e.stopPropagation();openLightbox(wine.imageUrl!,wine.name)}} style={{width:38,height:38,borderRadius:8,objectFit:'cover',flexShrink:0,cursor:'zoom-in'}} />
      ) : (
        <div style={{width:38,height:38,borderRadius:8,background:'var(--bg3)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize: isRedacted ? 22 : 18}}>
          {isRedacted ? '🙈' : (ICO[wine.type] || '🍷')}
        </div>
      )}

      <div style={{flex:1,minWidth:0}}>
        {isRedacted ? (
          <>
            <div style={{fontWeight:700,fontSize:13,color:'var(--fg-dim)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{wine.name}</div>
            <div style={{fontSize:10,color:'var(--fg-faint)',marginTop:2,letterSpacing:'0.06em'}}>hidden until revealed</div>
          </>
        ) : (
          <WineIdentity wine={wine} size="compact" />
        )}
      </div>

      <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}} onClick={e => e.stopPropagation()}>
        {isHost && isBlind && !isRevealed && (
          <button onClick={onReveal}
            style={{fontSize:9,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent)',border:'1px solid rgba(200,150,60,0.3)',background:'rgba(200,150,60,0.08)',padding:'4px 8px',borderRadius:3,cursor:'pointer'}}>
            reveal
          </button>
        )}
        {isHost && isBlind && isRevealed && (
          <button onClick={onHide}
            style={{fontSize:9,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent2)',border:'1px solid rgba(143,184,122,0.2)',background:'transparent',padding:'4px 8px',borderRadius:3,cursor:'pointer'}}>
            ✓ hide
          </button>
        )}
        {rating?.score ? <StarRating value={rating.score} /> : null}
        {isHost && (
          // Activator pattern: spread `attributes` + `listeners` and set
          // the node ref on the handle (NOT the row), so dnd-kit knows
          // which element initiated the drag and the keyboard sensor
          // works from a focused handle. Spreading on the row would
          // make every taster's row a Tab-stop with role="button".
          <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
            onClick={e => e.stopPropagation()}
            style={{
              touchAction: 'none', cursor: 'grab', padding: '6px 4px',
              background: 'transparent', border: 'none',
              color: 'var(--fg-faint)', fontSize: 14, lineHeight: 1,
              display: 'flex', alignItems: 'center',
            }}
          >
            ⋮⋮
          </button>
        )}
      </div>
    </div>
  )
}
