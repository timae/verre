'use client'
import { useState, useRef, useEffect } from 'react'
import { Modal } from '@/components/ui/Modal'
import { WineInfoPane } from '@/components/wine/WineInfoPane'
import { RatingPane, type RatingValue } from '@/components/wine/RatingPane'
import { AddWineModal } from '@/components/wine/AddWineModal'
import { useSession } from '@/components/session/SessionShell'
import { sessionFetch } from '@/lib/sessionFetch'
import { useQueryClient } from '@tanstack/react-query'
import { ProfilePreviewInline } from '@/components/profile/ProfilePreviewInline'
import type { ProvenanceRenderMode } from '@/components/wine/WineInfoPane'
import {
  CloseIcon, HeartIcon, MoreIcon,
  PencilIcon, TrashIcon, ArrowLeftIcon, ArrowRightIcon,
  StarIcon, CheckIcon, ResetIcon,
} from '@/components/ui/icons'

type Pane = 'info' | 'rate'

interface Props {
  wineId: string
  initialPane?: Pane
  onClose: () => void
}

// Two-pane wine modal: info on one tab, rating on the other. v4
// editorial chrome — header (3-dot menu + name + vintage + Save heart
// + close), underline-indicator tab strip, footer action bar (Rate
// CTA on info tab; Reset/Cancel/Commit on rate tab).
//
// Reads `wine` + `existing` rating from session context every render
// so live polling updates flow through — a host revealing a blind
// wine causes the open modal's info tab to populate without reload.
export function WineModal({ wineId, initialPane = 'rate', onClose }: Props) {
  const { wines, myRatings, code, refresh, isHost, isProvider, isBlind, bookmarkedIds, isLoggedIn, sessionMeta, myId } = useSession()
  const wine = wines.find(w => w.id === wineId)
  const existing = myRatings[wineId]
  const qc = useQueryClient()

  const [pane, setPane] = useState<Pane>(initialPane)
  const [saving, setSaving] = useState(false)
  const [bookmarked, setBookmarked] = useState(() => bookmarkedIds?.has(wineId) || false)
  const [showEdit, setShowEdit] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [rating, setRating] = useState<RatingValue>({
    score: existing?.score || 0,
    flavors: (existing?.flavors as Record<string, number>) || {},
    notes: existing?.notes || '',
  })
  // Provenance preview expanded/collapsed. The brought-by name in the
  // info pane toggles this; the preview mounts inline below the
  // callout. Mirrors SessionPanel's expanded-row pattern.
  const [provenanceOpen, setProvenanceOpen] = useState(false)
  // Ref on the brought-by callout — used to (1) scroll the expanded
  // preview into view if the user had scrolled past the callout
  // before opening it, and (2) detect outside-clicks so the floating
  // preview dismisses like any other popover.
  const broughtByRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!provenanceOpen) return
    broughtByRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    function onDoc(e: MouseEvent) {
      if (broughtByRef.current && !broughtByRef.current.contains(e.target as Node)) {
        setProvenanceOpen(false)
      }
    }
    // setTimeout so the click that just opened it doesn't immediately
    // close (mousedown+mouseup propagate before the listener attaches).
    const t = setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [provenanceOpen])

  if (!wine) return (
    <Modal onClose={onClose} maxWidth={400}>
      <p style={{padding:16,color:'var(--fg-dim)',fontSize:13}}>Wine not found.</p>
      <button className="btn-g" onClick={onClose}>close</button>
    </Modal>
  )

  // Blind redaction — server-side strips identifying fields for
  // non-host viewers. Host/cohost/provider-on-own-wine bypass.
  const isRedacted = !!(isBlind && wine._blind && !wine.revealedAt)
  const canEditThisWine = isHost || (isProvider && !!wine.isMine)
  const canReorderThisWine = isHost

  // Brought-by clickability + block-pair rendering. Mirrors the
  // participants-list matrix in SessionPanel. We only get a click
  // path for logged-in adders (server only surfaces addedByUserId for
  // u:<id>). Block lists are scoped to current session participants —
  // a kicked-out adder won't appear in either set, so block state
  // can't be reflected at this layer and the callout falls through to
  // 'clickable'. The /api/users/<id> route the inline preview hits is
  // still block-aware, so a viewer who's blocked the kicked adder
  // sees the stripped profile view on tap — block enforcement holds
  // server-side, just not pre-emptively in the brought-by render.
  const adderIdentity = wine.addedByUserId != null ? `u:${wine.addedByUserId}` : null
  const blocksOut = new Set(sessionMeta?.viewerBlocksOut ?? [])
  const blocksIn = new Set(sessionMeta?.viewerBlocksIn ?? [])
  const adderIsMe = !!adderIdentity && adderIdentity === myId
  const blockedByMe = !!adderIdentity && blocksOut.has(adderIdentity)
  const blockingMe = !!adderIdentity && blocksIn.has(adderIdentity)
  const provenanceMode: ProvenanceRenderMode =
    !adderIdentity         ? 'plain'
    : adderIsMe            ? 'clickable'   // self — opens own profile preview, "· you" suffix from isSelf prop
    : blockedByMe && blockingMe ? 'anon-style'  // mutual
    : blockedByMe          ? 'blocked-by-me'
    : blockingMe           ? 'anon-style'
    : 'clickable'
  // Only logged-in viewers can open a profile preview AT ALL — anon
  // session participants get plain rendering. The mode above stays
  // accurate either way; this just gates the click handler.
  const provenanceClickable = isLoggedIn && (provenanceMode === 'clickable' || provenanceMode === 'blocked-by-me')

  async function commitRating() {
    setSaving(true)
    await sessionFetch(code, `/api/session/${code}/rate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wineId, ...rating }),
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
    // Optimistic flip — revert on server failure so the heart doesn't
    // lie. On success, invalidate the in-session bookmarkedIds query
    // AND the /me/saved page's query so the bookmark surfaces there
    // immediately on next navigation.
    setBookmarked(!bookmarked)
    const res = await sessionFetch(code, `/api/session/${code}/wines/${wineId}/bookmark`, {
      method, headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      setBookmarked(bookmarked)
      return
    }
    qc.invalidateQueries({ queryKey: ['bookmarks'] })
    qc.invalidateQueries({ queryKey: ['me-bookmarks'] })
  }

  async function moveWine(delta: number) {
    const idx = wines.findIndex(w => w.id === wineId)
    if (idx === -1) return
    // Bounds clamp: bail when the target index would fall outside the
    // list. Without this, splice(-1, ...) at idx=0 wraps to the
    // second-to-last slot (a noisy reorder, not a no-op).
    const target = idx + delta
    if (target < 0 || target >= wines.length) return
    const ordered = [...wines]
    const [w] = ordered.splice(idx, 1)
    ordered.splice(target, 0, w)
    await sessionFetch(code, `/api/session/${code}/wines/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: ordered.map(w => w.id) }),
    })
    refresh()
  }

  async function deleteWine() {
    await sessionFetch(code, `/api/session/${code}/wines/${wineId}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    refresh(); onClose()
  }

  return (
    <Modal onClose={onClose} maxWidth={620} maxHeight="90vh">
      {/* HEADER — 3-dot menu (host-only) + wine name + vintage + Save + close */}
      <div style={{
        display:'flex',alignItems:'center',gap:8,
        marginBottom:14,paddingBottom:14,
        borderBottom:'1px solid var(--border)',
      }}>
        {canEditThisWine && (
          <OverflowMenu
            open={menuOpen}
            setOpen={setMenuOpen}
            canReorder={canReorderThisWine}
            onEdit={() => { setMenuOpen(false); setShowEdit(true) }}
            onMoveEarlier={() => { setMenuOpen(false); moveWine(-1) }}
            onMoveLater={() => { setMenuOpen(false); moveWine(1) }}
            onDelete={deleteWine}
          />
        )}
        <div style={{flex:1,minWidth:0,display:'flex',alignItems:'baseline',gap:10}}>
          <span style={{
            fontSize:15,fontWeight:700,color:'var(--fg-warm)',
            whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',
            letterSpacing:'-0.005em',
          }}>{wine.name}</span>
          {wine.vintage && (
            <span style={{
              fontFamily:'var(--mono)',fontSize:11,color:'var(--fg-dim)',
              letterSpacing:'0.06em',flexShrink:0,
            }}>{wine.vintage}</span>
          )}
        </div>
        {isLoggedIn && (
          <button
            onClick={toggleBookmark}
            title={bookmarked ? 'remove from saved' : 'save wine'}
            style={{
              display:'inline-flex',alignItems:'center',gap:6,
              padding:'6px 12px',borderRadius:100,
              border:'1px solid',
              background: bookmarked ? 'rgba(200,150,60,0.12)' : 'transparent',
              borderColor: bookmarked ? 'rgba(200,150,60,0.4)' : 'var(--border2)',
              color: bookmarked ? 'var(--accent)' : 'var(--fg-dim)',
              fontSize:10,fontWeight:600,letterSpacing:'0.1em',
              textTransform:'uppercase',cursor:'pointer',
              transition:'all .15s',flexShrink:0,
            }}
          >
            <HeartIcon size={13} filled={bookmarked} />
            <span>{bookmarked ? 'Saved' : 'Save'}</span>
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            background:'transparent',border:'none',
            width:32,height:32,borderRadius:8,
            color:'var(--fg-dim)',cursor:'pointer',
            display:'inline-flex',alignItems:'center',justifyContent:'center',
            flexShrink:0,
          }}
        ><CloseIcon size={18} /></button>
      </div>

      {/* TAB STRIP — underline-indicator. Rate tab carries a pip with
          the current score when one exists. Tabs are tap-only;
          horizontal swipe is reserved for step 11 (between-wines). */}
      <div style={{
        display:'flex',gap:4,borderBottom:'1px solid var(--border)',
        marginBottom:18,
      }}>
        <TabButton active={pane === 'info'} onClick={() => setPane('info')}>
          Wine info
        </TabButton>
        <TabButton active={pane === 'rate'} onClick={() => setPane('rate')}>
          <span>Rate</span>
          {existing?.score ? (
            <span style={{
              fontFamily:'var(--mono)',fontSize:10,
              padding:'2px 6px',borderRadius:3,
              border:'1px solid rgba(200,150,60,0.3)',
              background:'rgba(200,150,60,0.1)',
              color:'var(--accent)',letterSpacing:'0.04em',
            }}>{existing.score.toFixed(2)}</span>
          ) : null}
        </TabButton>
      </div>

      {/* BODY */}
      {pane === 'info' && (
        isRedacted ? (
          // Blind placeholder. Updates live: when the host hits reveal,
          // the next poll flips `_blind` to false and the real info
          // pane renders without modal close/reopen.
          <div style={{textAlign:'center',padding:'40px 16px'}}>
            <div style={{fontSize:48,marginBottom:12}}>🙈</div>
            <div style={{
              fontFamily:'var(--mono)',fontSize:14,fontWeight:700,
              color:'var(--fg-dim)',marginBottom:6,
            }}>{wine.name}</div>
            <div style={{fontSize:11,color:'var(--fg-faint)',letterSpacing:'0.06em'}}>
              hidden until revealed
            </div>
          </div>
        ) : (
          <WineInfoPane
            wine={wine}
            provenanceMode={provenanceMode}
            isSelf={adderIsMe}
            onProvenanceClick={provenanceClickable
              ? () => setProvenanceOpen(o => !o)
              : undefined}
            broughtByRef={broughtByRef}
            provenancePreview={provenanceOpen && wine.addedByUserId != null && (
              <ProfilePreviewInline
                userId={wine.addedByUserId}
                isSelf={adderIsMe}
                viewerLoggedIn={isLoggedIn}
                myId={myId.startsWith('u:') ? Number(myId.slice(2)) : null}
              />
            )}
          />
        )
      )}

      {pane === 'rate' && (
        <RatingPane
          key={wineId}
          wineType={isRedacted ? null : wine.type}
          existing={existing || null}
          onChange={setRating}
        />
      )}

      {/* FOOTER — action bar. Different per tab. */}
      <div style={{
        marginTop:18,paddingTop:14,
        borderTop:'1px solid var(--border)',
        display:'flex',gap:8,
      }}>
        {pane === 'info' && (
          <button
            onClick={() => setPane('rate')}
            style={{
              flex:1,
              display:'inline-flex',alignItems:'center',justifyContent:'center',gap:8,
              background:'var(--accent)',color:'var(--bg)',
              border:'none',padding:'12px 22px',borderRadius:8,
              fontWeight:700,fontSize:12,
              letterSpacing:'0.08em',textTransform:'uppercase',
              cursor:'pointer',
              boxShadow:'0 6px 24px -8px var(--accent)',
            }}
          >
            <StarIcon size={16} filled />
            Rate this wine
          </button>
        )}
        {pane === 'rate' && (
          <>
            {existing && (
              <ResetButton onReset={resetRating} />
            )}
            <button
              onClick={onClose}
              style={{
                display:'inline-flex',alignItems:'center',justifyContent:'center',
                background:'transparent',color:'var(--fg-dim)',
                border:'1px solid var(--border)',padding:'12px 14px',
                borderRadius:8,fontSize:11,letterSpacing:'0.08em',
                textTransform:'uppercase',fontWeight:600,cursor:'pointer',
                flexShrink:0,
              }}
            >Cancel</button>
            <button
              onClick={commitRating}
              disabled={saving}
              style={{
                flex:1,
                display:'inline-flex',alignItems:'center',justifyContent:'center',gap:8,
                background:'var(--accent)',color:'var(--bg)',
                border:'none',padding:'12px 22px',borderRadius:8,
                fontWeight:700,fontSize:12,
                letterSpacing:'0.08em',textTransform:'uppercase',
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.6 : 1,
                boxShadow:'0 6px 24px -8px var(--accent)',
              }}
            >
              <CheckIcon size={16} stroke={2.2} />
              {saving ? 'Saving…' : 'Commit rating'}
            </button>
          </>
        )}
      </div>

      {showEdit && (
        <AddWineModal
          code={code} editWine={wine}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); refresh() }}
        />
      )}
    </Modal>
  )
}

// Tight icon-button for the rate-tab footer's Reset action. Two-press
// confirm (first tap arms with a warning tint, second tap fires). Sits
// next to Cancel + Commit without stealing room from the primary CTA.
function ResetButton({ onReset }: { onReset: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      onClick={() => { if (armed) onReset(); else setArmed(true) }}
      style={{
        display:'inline-flex',alignItems:'center',justifyContent:'center',gap:6,
        background:'transparent',
        color: armed ? 'rgba(220,90,90,1)' : 'var(--fg-dim)',
        border: `1px solid ${armed ? 'rgba(184,64,64,0.7)' : 'var(--border)'}`,
        padding:'12px 14px',borderRadius:8,
        fontSize:11,letterSpacing:'0.08em',
        textTransform:'uppercase',fontWeight:600,cursor:'pointer',
        flexShrink:0,
        // Fixed width sized to the wider label ("Reset rating") so
        // the button doesn't grow/shrink between idle and armed.
        width:148,
        transition:'border-color .15s, color .15s',
      }}
    >
      <ResetIcon size={13} />
      <span>{armed ? 'Tap to confirm' : 'Reset rating'}</span>
    </button>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        position:'relative',background:'transparent',border:'none',
        padding:'12px 16px',
        fontSize:11,letterSpacing:'0.12em',textTransform:'uppercase',
        fontWeight:700,
        color: active ? 'var(--fg)' : 'var(--fg-dim)',
        cursor:'pointer',display:'inline-flex',alignItems:'center',gap:8,
        whiteSpace:'nowrap',transition:'color .15s',
      }}
    >
      {children}
      {active && (
        <span style={{
          position:'absolute',bottom:-1,left:12,right:12,
          height:2,borderRadius:'2px 2px 0 0',
          background:'var(--accent)',
        }} />
      )}
    </button>
  )
}

// 3-dot overflow menu for wine-management actions. Closes on outside
// click and Escape. Host-only callers (or provider on their own wines)
// see it; others don't render the trigger.
function OverflowMenu({
  open, setOpen, canReorder,
  onEdit, onMoveEarlier, onMoveLater, onDelete,
}: {
  open: boolean
  setOpen: (v: boolean) => void
  canReorder: boolean
  onEdit: () => void
  onMoveEarlier: () => void
  onMoveLater: () => void
  onDelete: () => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  return (
    <div ref={wrapRef} style={{position:'relative',flexShrink:0}}>
      <button
        onClick={() => setOpen(!open)}
        aria-label="More actions"
        style={{
          background:'transparent',border:'none',
          width:32,height:32,borderRadius:8,
          color:'var(--fg-dim)',cursor:'pointer',
          display:'inline-flex',alignItems:'center',justifyContent:'center',
        }}
      ><MoreIcon size={18} /></button>
      {open && (
        <div style={{
          position:'absolute',top:'calc(100% + 6px)',left:0,
          minWidth:180,background:'var(--bg3)',
          border:'1px solid var(--border)',borderRadius:10,
          padding:6,boxShadow:'0 12px 32px -8px rgba(0,0,0,0.6)',
          zIndex:20,
        }}>
          <MenuItem icon={<PencilIcon size={14} />} onClick={onEdit}>Edit wine</MenuItem>
          {canReorder && <>
            <MenuItem icon={<ArrowLeftIcon size={14} />} onClick={onMoveEarlier}>Move earlier</MenuItem>
            <MenuItem icon={<ArrowRightIcon size={14} />} onClick={onMoveLater}>Move later</MenuItem>
          </>}
          <div style={{height:1,background:'var(--border)',margin:'4px 4px'}} />
          <DeleteMenuItem onConfirm={onDelete} />
        </div>
      )}
    </div>
  )
}

// Two-press delete row inside the overflow menu. First tap arms with
// the "tap to confirm" label tinted red; second tap within 3s fires.
// Keeps the menu open while armed so the user sees the state change.
function DeleteMenuItem({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      onClick={e => {
        // Don't bubble — the overflow menu's outside-click handler
        // would close us on the first tap otherwise.
        e.stopPropagation()
        if (armed) onConfirm()
        else setArmed(true)
      }}
      style={{
        display:'flex',alignItems:'center',gap:10,
        width:'100%',padding:'8px 10px',
        background: armed ? 'rgba(199,86,96,0.12)' : 'transparent',
        border:'none',cursor:'pointer',borderRadius:6,
        fontSize:13,textAlign:'left',
        color: '#c75660',
        fontWeight: armed ? 700 : 400,
        transition:'background .12s',
      }}
    >
      <span style={{display:'inline-flex',opacity:0.8}}>
        <TrashIcon size={14} />
      </span>
      <span>{armed ? 'Tap again to delete' : 'Delete'}</span>
    </button>
  )
}

function MenuItem({ icon, onClick, danger, children }: {
  icon: React.ReactNode
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display:'flex',alignItems:'center',gap:10,
        width:'100%',padding:'8px 10px',
        background:'transparent',border:'none',
        cursor:'pointer',borderRadius:6,
        fontSize:13,textAlign:'left',
        color: danger ? '#c75660' : 'var(--fg)',
        transition:'background .12s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? 'rgba(199,86,96,0.1)' : 'var(--bg4)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <span style={{display:'inline-flex',opacity:0.8}}>{icon}</span>
      <span>{children}</span>
    </button>
  )
}
