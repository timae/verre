'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { useSession } from './SessionShell'
import { AddWineModal } from '@/components/wine/AddWineModal'
import { WineIdentity } from '@/components/wine/WineIdentity'
import { StarRating } from '@/components/ui/StarRating'
import { LineupLocked } from './LineupLocked'
import { WineModal } from '@/components/wine/WineModal'
import { useState, useEffect } from 'react'
import type { WireWine } from '@/lib/session'
import { sessionFetch } from '@/lib/sessionFetch'
import { renderWithLinks } from '@/lib/renderWithLinks'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { TCOL, ICO } from '@/lib/wineTypeColors'

function formatDate(dt: string) {
  if (!dt) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(dt))
  } catch { return dt }
}

// Single wine-list surface. Tapping a row opens the modal on the
// Wine Info pane. Unrated rows render an inline "Rate" button that
// opens the modal on the Rate pane directly; rated rows render the
// StarRating chip as a tap-target with the same intent. Hosts/cohosts/
// providers see the management affordances inline (add wine, reveal,
// drag-to-reorder); tasters see a plain list.
export function WineListScreen() {
  const { wines, myRatings, isHost, isProvider, code, refresh, isBlind, sessionMeta, winesLoading } = useSession()
  const [showAdd, setShowAdd] = useState(false)
  // When opening the wine modal, track which pane to start on so the
  // row-body tap (info) and the inline Rate button (rate) can share
  // one modal-open path.
  const [openWine, setOpenWine] = useState<{ id: string; pane: 'info' | 'rate' } | null>(null)
  const canManage = isHost || isProvider

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

  // "Blind for everyone" — toggles whether the host/cohost/provider/wine-
  // adder bypass is in effect for blind redaction. When ON, even the host
  // sees redacted wines (until they reveal). PATCHes the session settings;
  // the next refresh pulls the new meta and the server-side wine GET
  // applies the redaction accordingly. No optimistic update — the toggle
  // is rare and the visual change is global, so wait for the round-trip.
  // Label uses "everyone" instead of "all" to avoid colliding with the
  // adjacent "reveal all" button.
  async function toggleBlindForAll() {
    const next = !sessionMeta?.blindForEveryone
    await sessionFetch(code, `/api/session/${code}/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blindForEveryone: next }),
    })
    refresh()
  }
  const blindForEveryone = !!sessionMeta?.blindForEveryone

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
            {isHost && isBlind && (
              // "Blind for everyone" toggle — sits beside reveal-all so it
              // reads as a per-session control on the blind state. Visible
              // to host/cohost in any blind session; rendering doesn't
              // depend on wines.length so the host can pre-arm it before
              // adding wines. When ON, the host also sees redacted wines
              // until reveal — including their own and providers'. Tap
              // to flip; the next refresh applies the new redaction.
              // Label is "for everyone" (not "for all") so it doesn't
              // collide visually with the neighbouring "reveal all" button.
              <button
                className="btn-s"
                onClick={toggleBlindForAll}
                title={blindForEveryone
                  ? 'You see redacted wines too. Tap to see the lineup again (still hidden from tasters).'
                  : 'Hide wines from yourself too. Even you won\'t know the lineup until reveal.'}
                style={blindForEveryone ? {
                  borderColor: 'rgba(200,150,60,0.5)',
                  background: 'rgba(200,150,60,0.12)',
                  color: 'var(--accent)',
                } : undefined}
              >
                🙈 blind for everyone{blindForEveryone ? ' ✓' : ''}
              </button>
            )}
            {isHost && isBlind && wines.length > 0 && (
              allRevealed
                ? <button className="btn-s" onClick={hideAll}>hide all</button>
                : <button className="btn-s" onClick={revealAll}>reveal all</button>
            )}
            {canManage && (
              <button className="btn-s" onClick={() => setShowAdd(true)}>+ add wine</button>
            )}
          </div>
        </div>

        {/* Lineup hidden */}
        {lineupHidden && revealAt && <LineupLocked revealAt={revealAt} onReveal={refresh} />}

        {!lineupHidden && wines.length === 0 && (
          <div style={{textAlign:'center',padding:'48px 0',color:'var(--fg-dim)',fontSize:13}}>
            {winesLoading
              ? 'Loading wines…'
              : canManage
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
                    wine={wine}
                    idx={idx}
                    isBlind={isBlind}
                    showHostControls={isHost}
                    rating={myRatings[wine.id]}
                    onOpen={pane => setOpenWine({ id: wine.id, pane })}
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

        {openWine && (
          <WineModal
            wineId={openWine.id}
            initialPane={openWine.pane}
            onClose={() => setOpenWine(null)}
          />
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
  wine, idx, isBlind, showHostControls, rating, onOpen, onReveal, onHide,
}: {
  wine: WireWine
  idx: number
  isBlind: boolean
  // Renders the drag-to-reorder handle and per-row reveal/hide
  // buttons. Wires into dnd-kit's `disabled` flag too, so the row
  // doesn't accidentally become draggable when controls are hidden.
  showHostControls: boolean
  rating?: { score: number }
  // Tap on row body → 'info'. Tap on inline Rate button or score chip → 'rate'.
  onOpen: (pane: 'info' | 'rate') => void
  onReveal: () => void
  onHide: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: wine.id, disabled: !showHostControls })

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
    <div ref={setNodeRef} style={style} className="wine-card" onClick={() => onOpen('info')}>
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

      <div style={{display:'flex',alignItems:'center',gap:0,flexShrink:0}} onClick={e => e.stopPropagation()}>
        {showHostControls && isBlind && !isRevealed && (
          <button onClick={onReveal}
            style={{fontSize:9,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent)',border:'1px solid rgba(200,150,60,0.3)',background:'rgba(200,150,60,0.08)',padding:'4px 8px',borderRadius:3,cursor:'pointer'}}>
            reveal
          </button>
        )}
        {showHostControls && isBlind && isRevealed && (
          <button onClick={onHide}
            style={{fontSize:9,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent2)',border:'1px solid rgba(143,184,122,0.2)',background:'transparent',padding:'4px 8px',borderRadius:3,cursor:'pointer'}}>
            hide
          </button>
        )}
        {/* Score chip if rated, Rate button if not. Both are tap
            targets that open the modal on the Rate pane. The Rate
            button is intentionally prominent (accent-tinted pill) so
            unrated wines stand out in a mixed list.
            stopPropagation prevents the parent row's onClick (which
            opens the Info pane) from firing alongside.

            Fixed-width right-aligned slot so the drag handle stays
            at the same x across all row variants (rated/unrated ×
            host/taster). Width is tight on the widest realistic
            score chip so narrow viewports don't lose wine-title
            space to slack. Slot is always rendered — rating a
            redacted blind wine is exactly the point of blind
            tasting, so the Rate button must be reachable inline. */}
        <div style={{
          width: 80,
          display:'flex',alignItems:'center',justifyContent:'flex-end',
          paddingRight: 1,
          flexShrink:0,
        }}>
            {rating?.score ? (
              <button
                type="button"
                aria-label="Edit rating"
                onClick={e => { e.stopPropagation(); onOpen('rate') }}
                style={{
                  // 6×10 padding bumps the touch target to ~44×40px around
                  // the star+number, meeting WCAG 2.5.5 (44×44 minimum).
                  // Negative margin keeps the row's visual rhythm by
                  // absorbing the padding into surrounding gap, so layout
                  // doesn't shift vs. the prior padding:0 version.
                  background:'transparent',border:'none',
                  padding:'6px 10px',margin:'-6px -10px',
                  cursor:'pointer',display:'inline-flex',alignItems:'center',
                }}
              >
                <StarRating value={rating.score} />
              </button>
            ) : (
              // Prominent accent-gold pill — same style for every role
              // (host, cohost, provider, taster). Rating is the primary
              // action on this surface for everyone, so the visual
              // emphasis is uniform.
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onOpen('rate') }}
                style={{
                  background:'var(--accent)',color:'var(--bg)',
                  border:'none',padding:'7px 14px',borderRadius:100,
                  fontSize:11,fontWeight:700,letterSpacing:'0.08em',
                  textTransform:'uppercase',cursor:'pointer',
                }}
              >
                Rate
              </button>
            )}
          </div>
        {showHostControls && (
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
              color: 'var(--fg-warm)', fontSize: 14, lineHeight: 1,
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
