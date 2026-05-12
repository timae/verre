'use client'
import { useRef, useEffect, useState } from 'react'
import { StarIcon } from '@/components/ui/icons'
import { getFL, detectFL, FL, type FlItem } from '@/lib/flavours'

export type RatingValue = {
  score: number
  flavors: Record<string, number>
  notes: string
}

interface BasePaneProps {
  // Wine type drives the flavour-dimension set (red vs white vs spark…).
  // Pass null when the wine is blind-redacted — falls back to FL generic.
  wineType: string | null
}

interface EditableProps extends BasePaneProps {
  readOnly?: false
  // Controlled mode: caller owns the rating state. The pane reads from
  // `value`, calls `onChange` on every edit. Lifting state up lets the
  // outer modal preserve in-progress edits across tab switches (RatingPane
  // unmounts when the user taps Wine info; on remount, the parent's
  // state survives so nothing is lost).
  value: RatingValue
  onChange: (value: RatingValue) => void
}

interface ReadOnlyProps extends BasePaneProps {
  readOnly: true
  // Read-only mode displays a fixed rating with no input handlers.
  existing: RatingValue | null
}

type Props = EditableProps | ReadOnlyProps

// v4 layout: big serif score number + horizontal drag bar with stars,
// flavour intensity tracks (one bar per flavour, colored fill), notes
// textarea in serif. Read-only mode renders the same widgets without
// the input handlers.
//
// **Controlled in edit mode.** Editable callers must own the
// `RatingValue` state and pass it back via `value`/`onChange`. The pane
// keeps no internal state in edit mode, so unmount/remount (e.g. when
// the host tab strip swaps panes) cannot drop in-progress edits.
//
// Read-only mode still owns its state — it derives display values from
// `existing` once at mount; no need for the caller to manage anything.
export function RatingPane(props: Props) {
  const { wineType } = props
  const readOnly = 'readOnly' in props && props.readOnly === true

  if (readOnly) {
    return <ReadOnlyPane wineType={wineType} existing={(props as ReadOnlyProps).existing} />
  }

  const { value, onChange } = props as EditableProps

  // Detect flavour dimensions from the current rating's stored keys (so
  // historic ratings with old key names still render right), else use
  // the wine type's standard set, else generic.
  const fl = value.flavors && Object.keys(value.flavors).length
    ? detectFL(value.flavors)
    : wineType ? getFL(wineType) : FL

  function setScore(score: number) { onChange({ ...value, score }) }
  function setFlavor(k: string, v: number) {
    onChange({ ...value, flavors: { ...value.flavors, [k]: v } })
  }
  function setNotes(notes: string) { onChange({ ...value, notes }) }

  return (
    <div style={{display:'flex',flexDirection:'column',gap:24}}>
      <ScoreSection score={value.score} setScore={setScore} />
      <FlavourSection fl={fl} flavors={value.flavors} setFlavor={setFlavor} />
      <NotesSection notes={value.notes} setNotes={setNotes} />
    </div>
  )
}

function ReadOnlyPane({ wineType, existing }: { wineType: string | null; existing: RatingValue | null }) {
  const fl = existing?.flavors && Object.keys(existing.flavors).length
    ? detectFL(existing.flavors as Record<string, number>)
    : wineType ? getFL(wineType) : FL
  const flavors = (() => {
    const base = fl.reduce((o, f) => ({ ...o, [f.k]: 0 }), {} as Record<string, number>)
    if (existing?.flavors) Object.assign(base, existing.flavors)
    return base
  })()
  return (
    <div style={{display:'flex',flexDirection:'column',gap:24}}>
      <ScoreSection score={existing?.score || 0} />
      <FlavourSection fl={fl} flavors={flavors} />
      <NotesSection notes={existing?.notes || ''} />
    </div>
  )
}

// ─── score ─────────────────────────────────────────────

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{
      display:'flex',alignItems:'baseline',justifyContent:'space-between',
      marginBottom:14,gap:12,
    }}>
      <h3 style={{
        margin:0,fontSize:10,letterSpacing:'0.18em',textTransform:'uppercase',
        color:'var(--fg-dim)',fontWeight:700,
      }}>{title}</h3>
      {hint && <span style={{
        fontFamily:'var(--serif)',fontStyle:'italic',
        fontSize:11,color:'var(--fg-faint)',
      }}>{hint}</span>}
    </div>
  )
}

function ScoreSection({ score, setScore }: { score: number; setScore?: (s: number) => void }) {
  // barRef points at the INNER visible bar — that's the measurement
  // reference. The outer hit-wrapper has lateral padding so the thumb
  // overhang at 0%/100% still receives pointerdown, but mapping from
  // clientX to score needs to use the inner bar's bounds so the ends
  // line up visually.
  const barRef = useRef<HTMLDivElement>(null)
  const readOnly = !setScore

  // PointerCapture pattern (same as the legacy ScoreSlider): once
  // pointerdown lands on the wrapper, all subsequent pointermoves
  // route here regardless of where the cursor actually is — even off
  // the modal entirely. Modal's mousedown-on-backdrop guard keeps the
  // modal open during such a drag.
  function handlePointer(e: React.PointerEvent<HTMLDivElement>) {
    if (!setScore || !barRef.current) return
    const rect = barRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    setScore(Math.round(pct * 5 * 4) / 4)   // snap to 0.25
  }

  const pct = (score / 5) * 100
  const filled = Math.floor(score)
  const half = score - filled >= 0.5

  return (
    <section>
      <SectionHeader title="Your score" hint={readOnly ? undefined : 'drag or tap the bar to rate'} />
      <div style={{
        display:'grid',gridTemplateColumns:'auto 1fr',gap:24,alignItems:'center',
      }}>
        <div style={{display:'flex',alignItems:'baseline',gap:4,whiteSpace:'nowrap'}}>
          <span style={{
            fontFamily:'var(--serif)',fontSize:52,lineHeight:1,
            color:'var(--accent)',fontWeight:400,
          }}>{score.toFixed(2)}</span>
          <span style={{fontFamily:'var(--mono)',fontSize:13,color:'var(--fg-faint)'}}>/ 5</span>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:14,minWidth:0}}>
          <div style={{display:'flex',gap:4}}>
            {[0,1,2,3,4].map(i => {
              const isFilled = i < filled
              const isHalf = !isFilled && i === filled && half
              return (
                <span key={i} style={{position:'relative',display:'inline-flex'}}>
                  <StarIcon size={18} style={{ color: 'var(--fg-faint)' }} />
                  {(isFilled || isHalf) && (
                    <span style={{
                      position:'absolute',inset:0,overflow:'hidden',
                      width: isHalf ? '50%' : '100%',color:'var(--accent)',
                      display:'inline-flex',
                    }}>
                      <StarIcon size={18} filled style={{color:'var(--accent)'}} />
                    </span>
                  )}
                </span>
              )
            })}
          </div>
          {/* Hit-area wrapper (22px tall) holds the listeners and the
              6px visual track. PointerCapture grabs the gesture on
              pointerdown — once active, the cursor can wander anywhere
              and pointermove still routes here. */}
          {/* Outer flex container = the entire hit area. Pointer
              listeners + setPointerCapture live here so the gesture
              holds even if the cursor leaves the bar. The visual bar
              is centered inside; the thumb is positioned absolutely
              relative to THIS wrapper, using `pct% - thumbRadius` to
              center it on the bar's percentage. Mirrors main's
              ScoreSlider — its track wrapper IS the pointer target
              and the thumb is a sibling of (not inside) the bar. */}
          <div
            // `data-no-pull` opts this element out of the parent
            // modal's pull-to-swap gesture (usePullToSwap reads it on
            // pointerdown via closest()). Without this, a vertical
            // wobble during a horizontal score drag could trip a
            // wine-swap when the rate pane is at the modal's scroll
            // top boundary.
            data-no-pull
            onPointerDown={readOnly ? undefined : e => {
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
              handlePointer(e)
            }}
            onPointerMove={readOnly ? undefined : e => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) handlePointer(e)
            }}
            style={{
              // 36px tall hit area = comfortable touch target (close
              // enough to Apple's 44px guideline without the bar
              // visually dominating). The visible 6px bar centers
              // inside; the rest is invisible padding that catches
              // off-bar taps.
              position:'relative',height:36,
              cursor: readOnly ? 'default' : 'pointer',
              userSelect:'none',touchAction:'none',
              display:'flex',alignItems:'center',
            }}
          >
            {/* Visual bar inset by 7px (= thumb radius) on each side.
                That makes room for the thumb's overhang at score=0
                and score=5 to land WITHIN the wrapper, so the entire
                thumb is grabbable. The bar's actual pixel width is
                narrower than the wrapper; `pct` is measured against
                this inner bar so 0%/100% map to its edges, not the
                wrapper's. */}
            <div ref={barRef} style={{
              position:'relative',
              width:'calc(100% - 14px)',
              marginLeft:7,marginRight:7,
              height:6,borderRadius:3,
              background:'var(--border)',pointerEvents:'none',
            }}>
              <div style={{
                position:'absolute',top:0,bottom:0,left:0,width:`${pct}%`,
                borderRadius:3,
                background:'linear-gradient(90deg, rgba(200,150,60,0.5), var(--accent))',
              }} />
              {[1,2,3,4].map(i => (
                <div key={i} style={{
                  position:'absolute',top:-2,bottom:-2,
                  width:1,background:'rgba(0,0,0,0.6)',
                  left:`${(i/5)*100}%`,pointerEvents:'none',
                }} />
              ))}
              {/* Thumb positioned INSIDE the bar — at `left:pct%`,
                  centered with -7px offset. Since the bar is inset 7px
                  from the wrapper, the thumb's left half at pct=0
                  sits in the wrapper's left padding (still inside),
                  and the right half at pct=100% sits in the right
                  padding. Entire thumb always inside the hit area. */}
              {!readOnly && (
                <div style={{
                  position:'absolute',top:'50%',
                  left:`calc(${pct}% - 7px)`,
                  width:14,height:14,borderRadius:'50%',
                  background:'var(--accent)',
                  transform:'translateY(-50%)',pointerEvents:'none',
                  boxShadow:'0 0 0 4px rgba(200,150,60,0.25), 0 2px 8px rgba(0,0,0,0.4)',
                }} />
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── flavour ───────────────────────────────────────────

const INTENSITY_LABELS = ['none', 'faint', 'light', 'medium', 'bold', 'intense']

function FlavourSection({
  fl, flavors, setFlavor,
}: {
  fl: FlItem[]
  flavors: Record<string, number>
  setFlavor?: (k: string, v: number) => void
}) {
  const readOnly = !setFlavor
  return (
    <section>
      <SectionHeader
        title="Flavour profile"
        hint={readOnly ? undefined : 'tap or drag a segment to set intensity'}
      />
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px 16px'}}>
        {fl.map(f => (
          <FlavourBar
            key={f.k}
            item={f}
            value={flavors[f.k] || 0}
            setValue={setFlavor ? v => setFlavor(f.k, v) : undefined}
          />
        ))}
      </div>
    </section>
  )
}

function FlavourBar({
  item, value, setValue,
}: {
  item: FlItem
  value: number
  setValue?: (v: number) => void
}) {
  const [hover, setHover] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  const hadMoved = useRef(false)
  const display = hover ?? value
  const fillPct = (display / 5) * 100
  const hasValue = display > 0
  const readOnly = !setValue

  // Compute the segment (1..5) under a clientX position. Returns null
  // if the position is left of the bar — taps on the bar's leading edge
  // should still register as segment 1, but we clamp explicitly below.
  function segAt(clientX: number): number {
    if (!barRef.current) return 0
    const rect = barRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    // Each segment owns 20% of the bar; ceil so x=0..0.2 → seg 1.
    return Math.max(1, Math.min(5, Math.ceil(pct * 5)))
  }

  // Pointer-up listener while dragging. PointerEvents (vs mouse + touch
  // pair) gives unified mouse/pen/touch handling without duplicate code.
  useEffect(() => {
    if (!dragging) return
    function onMove(e: PointerEvent) {
      if (!setValue) return
      setHover(segAt(e.clientX))
    }
    function onUp(e: PointerEvent) {
      if (!setValue) { setDragging(false); return }
      const seg = segAt(e.clientX)
      // Tap on the current value to clear — only treat it as a "clear"
      // when the user didn't drag away from it. A drag that lands on
      // the same segment commits that segment (no clear surprise).
      setValue(seg === value && !hadMoved.current ? 0 : seg)
      setDragging(false)
      setHover(null)
      hadMoved.current = false
    }
    function onCancel() {
      // System-initiated cancel (iOS edge-swipe, browser context loss,
      // app switch). Discard the in-progress gesture — committing
      // whatever happened to be under the finger at cancel time would
      // be a hostile surprise.
      setDragging(false)
      setHover(null)
      hadMoved.current = false
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging])

  return (
    <div
      ref={barRef}
      // `data-no-pull` opts this flavor bar out of the parent modal's
      // pull-to-swap gesture (see usePullToSwap.onPointerDown). The
      // bar's horizontal drag would otherwise trip vertical pull-swap
      // when the rate pane is at the modal's scroll bottom boundary.
      data-no-pull
      style={{
        position:'relative',height:36,borderRadius:6,
        overflow:'hidden',cursor: readOnly ? 'default' : 'pointer',
        touchAction:'none',  // prevent page scroll on drag
      }}
      onPointerDown={readOnly ? undefined : e => {
        // Prevent the drag from selecting text or starting a scroll.
        e.preventDefault()
        hadMoved.current = false
        setHover(segAt(e.clientX))
        setDragging(true)
      }}
      onPointerMove={readOnly || !dragging ? undefined : () => {
        hadMoved.current = true
      }}
      onMouseLeave={dragging ? undefined : () => setHover(null)}
    >
      {/* base + fill */}
      <div style={{
        position:'absolute',inset:0,
        background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:6,
      }} />
      <div style={{
        position:'absolute',top:0,bottom:0,left:0,
        width:`${fillPct}%`,borderRadius:6,
        background:item.c,
        // Muted: drop fill opacity so the bg3 shows through and the
        // hue desaturates against the dark backdrop. Hover further
        // dims any "not committed yet" preview.
        opacity: hover !== null && hover !== value ? 0.55 : 0.7,
        transition:'width .15s, opacity .15s',
      }} />
      {/* dividers between zones */}
      {[1,2,3,4].map(i => (
        <div key={i} style={{
          position:'absolute',top:3,bottom:3,width:1,
          background:'rgba(0,0,0,0.55)',
          left:`${(i/5)*100}%`,pointerEvents:'none',zIndex:2,
        }} />
      ))}
      {/* content layer */}
      <div style={{
        position:'absolute',inset:0,
        display:'flex',alignItems:'center',justifyContent:'space-between',
        padding:'0 12px',pointerEvents:'none',zIndex:2,
      }}>
        <span style={{
          display:'inline-flex',alignItems:'center',gap:8,
          fontSize:12,fontWeight:600,
          color: hasValue ? '#fff' : 'var(--fg)',
          textShadow: hasValue ? '0 1px 2px rgba(0,0,0,0.5)' : 'none',
        }}>
          <span style={{
            width:6,height:6,borderRadius:'50%',
            background:item.c,flexShrink:0,
          }} />
          {item.l}
        </span>
        <span style={{
          fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',
          fontWeight:700,
          color: hasValue ? '#fff' : 'var(--fg-faint)',
          textShadow: hasValue ? '0 1px 2px rgba(0,0,0,0.5)' : 'none',
        }}>{INTENSITY_LABELS[display]}</span>
      </div>
      {/* Keyboard activation surface. `pointerEvents:'none'` blocks
          mouse/touch (those flow through the wrapper's pointer
          listeners for drag-to-set). Keyboard-synthesized clicks from
          Enter/Space on a focused button DO still fire onClick — that's
          how keyboard activation reaches setValue here. Tab moves
          focus between segments; Enter/Space commits. */}
      {!readOnly && [1,2,3,4,5].map(seg => (
        <button
          key={seg}
          onClick={() => setValue && setValue(value === seg ? 0 : seg)}
          onFocus={() => setHover(seg)}
          onBlur={() => setHover(null)}
          aria-label={`${item.l} ${INTENSITY_LABELS[seg]}`}
          style={{
            position:'absolute',top:0,bottom:0,
            left:`${((seg-1)/5)*100}%`,width:'20%',
            background:'transparent',border:'none',cursor:'pointer',
            padding:0,zIndex:3,
            pointerEvents:'none',
          }}
        />
      ))}
    </div>
  )
}

// ─── notes ─────────────────────────────────────────────

function NotesSection({ notes, setNotes }: { notes: string; setNotes?: (n: string) => void }) {
  const readOnly = !setNotes
  if (readOnly) {
    return (
      <section>
        <SectionHeader title="Tasting notes" />
        {notes ? (
          <p style={{
            fontFamily:'var(--serif)',fontSize:14,lineHeight:1.5,
            color:'var(--fg-warm-soft)',whiteSpace:'pre-wrap',margin:0,
          }}>{notes}</p>
        ) : (
          <p style={{fontSize:12,color:'var(--fg-faint)',fontStyle:'italic',margin:0}}>
            no notes
          </p>
        )}
      </section>
    )
  }
  return (
    <section>
      <SectionHeader title="Tasting notes" />
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Cherry on the nose, soft tannins, surprisingly bright finish…"
        rows={3}
        style={{
          width:'100%',background:'var(--bg3)',
          border:'1px solid var(--border)',borderRadius:8,
          padding:'12px 14px',color:'var(--fg-warm-soft)',
          // Sans for input — the editorial Fraunces serif fights the
          // stream-of-consciousness register of quick tasting notes.
          // Committed notes still render in serif on the read-only
          // surface (in <RatingPane readOnly>).
          fontSize:14,lineHeight:1.5,
          resize:'vertical',minHeight:72,outline:'none',
        }}
      />
    </section>
  )
}
