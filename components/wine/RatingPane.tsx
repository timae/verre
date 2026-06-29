'use client'
import { useRef, useState } from 'react'
import { StarIcon } from '@/components/ui/icons'
import { resolveAxesColoured, perRatingAxes, type FlItem } from '@/lib/flavours'
import type { RatingValue } from '@/lib/rating'

// Re-exported for back-compat — callers historically imported from this
// file. Canonical definition lives in lib/rating.ts.
export type { RatingValue }

interface BasePaneProps {
  // Wine STYLE (red/white/spark/rose) — drives the structure axis set
  // (resolveAxes); spark adds Bubbles. Pass the real style even for a blind-
  // redacted wine (style is not identity). null/unknown → base wine set.
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

  // INPUT surface (§6d): hand the full structure axis set for this style so the
  // user rates every structure axis. A blind-redacted wine passes its REAL style
  // (style isn't identity — the taster perceives fizz from the glass), so a blind
  // sparkling wine still offers Bubbles. wineType only falls to null/base for a
  // genuinely unknown style (the defensive resolveAxes fallback). Legacy
  // descriptor keys in a loaded rating are NOT shown as chips — the edit-path
  // transform (§6g) strips them on save (in WineModal.commitWineRating).
  const fl = resolveAxesColoured('wine', wineType)

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
  // READ surface (§6d): only the axes present in the rating (present-and-0
  // drawn as a centre point).
  const ex = existing?.flavors as Record<string, number> | undefined
  const fl = perRatingAxes(ex, resolveAxesColoured('wine', wineType))
  const flavors = ex ?? {}
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
  // Intent-detection refs (see slider's pointerdown/move handlers).
  // Defer pointer capture until SLOP-distance movement reveals
  // whether the gesture is horizontal (score drag) or vertical
  // (page scroll). Same pattern as the FlavorChips track on main.
  const scorePendingDownRef = useRef<{ x: number; y: number } | null>(null)
  const scoreDraggingRef = useRef(false)
  const readOnly = !setScore

  // PointerCapture pattern (same as the canonical `<ScoreSlider>`
  // primitive on main): once pointerdown lands on the wrapper, all
  // subsequent pointermoves route here regardless of where the
  // cursor actually is — even off the modal entirely. Modal's
  // mousedown-on-backdrop guard keeps the modal open during such a
  // drag.
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
    // `data-no-pull` on the entire section — not just the 36px slider
    // hit-area wrapper inside it. The section's padding around the
    // bar would otherwise be a small zone where a finger could land
    // and trigger a wine-swap pull when dragging onto the slider.
    <section data-no-pull>
      <SectionHeader title="Your score" hint={readOnly ? undefined : 'drag or tap the bar to rate'} />
      <div style={{
        // Fixed left column width so the digit display can never
        // change the column size (which would cascade into the
        // stars + slider on the right and wobble both during drag).
        // 130px fits "5.00" at 52px in Fraunces + 4px gap + "/ 5"
        // at 13px mono with a tiny safety margin.
        display:'grid',gridTemplateColumns:'130px 1fr',gap:24,alignItems:'center',
      }}>
        <div style={{display:'flex',alignItems:'baseline',gap:4,whiteSpace:'nowrap'}}>
          <span style={{
            fontFamily:'var(--serif)',fontSize:52,lineHeight:1,
            color:'var(--accent)',fontWeight:400,
            // Tabular figures + explicit tnum feature so digit widths
            // match across values (Fraunces' default proportional
            // figures cause widths to drift during a drag through
            // 0.00 → 4.25). Belt-and-suspenders with the fixed column
            // width above; either alone would mostly work, both
            // together guarantee zero wobble.
            fontVariantNumeric:'tabular-nums',
            fontFeatureSettings:'"tnum"',
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
            // Note: data-no-pull is set on the surrounding <section>
            // (so the slider's section-level padding is also covered);
            // no need to repeat it here.
            //
            // Intent detection: defer pointer capture until movement
            // past SLOP reveals horizontal vs vertical intent.
            // Horizontal → capture for slider drag. Vertical → release
            // for native pan-y scroll. Mirrors FlavorBar + the working
            // main FlavorChips pattern.
            onPointerDown={readOnly ? undefined : e => {
              if (!e.isPrimary) return
              scorePendingDownRef.current = { x: e.clientX, y: e.clientY }
              scoreDraggingRef.current = false
            }}
            onPointerMove={readOnly ? undefined : e => {
              if (scoreDraggingRef.current) {
                handlePointer(e)
                return
              }
              const pd = scorePendingDownRef.current
              if (!pd) return
              const dx = e.clientX - pd.x
              const dy = e.clientY - pd.y
              if (Math.abs(dx) < FLAVOR_SLOP && Math.abs(dy) < FLAVOR_SLOP) return
              if (Math.abs(dx) > Math.abs(dy)) {
                scoreDraggingRef.current = true
                try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
                handlePointer(e)
              } else {
                scorePendingDownRef.current = null
              }
            }}
            onPointerUp={readOnly ? undefined : e => {
              const pd = scorePendingDownRef.current
              const wasDragging = scoreDraggingRef.current
              scorePendingDownRef.current = null
              scoreDraggingRef.current = false
              if (wasDragging) {
                handlePointer(e)
              } else if (pd) {
                // Tap: commit the score under the tap.
                handlePointer(e)
              }
            }}
            onPointerCancel={readOnly ? undefined : () => {
              scorePendingDownRef.current = null
              scoreDraggingRef.current = false
            }}
            style={{
              // 36px tall hit area = comfortable touch target (close
              // enough to Apple's 44px guideline without the bar
              // visually dominating). The visible 6px bar centers
              // inside; the rest is invisible padding that catches
              // off-bar taps.
              position:'relative',height:36,
              cursor: readOnly ? 'default' : 'pointer',
              userSelect:'none',
              // No `touch-action` here — inherit `pan-y` from
              // scrollRef. Intent detection in pointerdown/move
              // claims the gesture only for horizontal-dominant
              // drags; vertical drags pass through to native scroll.
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

const INTENSITY_LABELS = ['none', 'faint', 'light', 'medium', 'strong', 'intense']

function FlavourSection({
  fl, flavors, setFlavor,
}: {
  fl: FlItem[]
  flavors: Record<string, number>
  setFlavor?: (k: string, v: number) => void
}) {
  const readOnly = !setFlavor
  return (
    // `data-no-pull` on the entire flavour section — including the
    // grid padding between bars — so a finger landing in the gutter
    // doesn't trigger a wine-swap pull. Also makes the section's
    // children opt out for keyboard nav (Arrow keys on a focused
    // flavor segment shouldn't swap wines).
    <section data-no-pull>
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

// SLOP — distance the finger must move past pointerdown before we
// commit to either a drag (horizontal-dominant) or a release-to-scroll
// (vertical-dominant). Mirrors `FlavorChips` on main, which is the
// proven pattern: touch-action:pan-y on the track + intent-detection
// in onPointerMove. Vertical drags fall through to native scroll;
// horizontal drags capture the pointer for flavor adjustment.
const FLAVOR_SLOP = 6

function FlavourBar({
  item, value, setValue,
}: {
  item: FlItem
  value: number
  setValue?: (v: number) => void
}) {
  const [hover, setHover] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  // Touch start position — used to detect intent on the first
  // significant move.
  const pendingDownRef = useRef<{ x: number; y: number } | null>(null)
  // True once we've committed to a horizontal drag (after pointer
  // capture). Subsequent moves update the flavor value.
  const draggingRef = useRef(false)
  // Whether the user actually moved away from where they pressed.
  // Tap-with-no-drag on the current value clears it; tap on a different
  // segment commits that segment.
  const hadMoved = useRef(false)
  const display = hover ?? value
  const fillPct = (display / 5) * 100
  const hasValue = display > 0
  const readOnly = !setValue

  function segAt(clientX: number): number {
    if (!barRef.current) return 0
    const rect = barRef.current.getBoundingClientRect()
    // Drag past the left edge clears the rating (level 0). Inside
    // the bar, x position maps to segments 1..5. Mirrors the
    // canonical FlavorChips behavior on main.
    if (clientX < rect.left) return 0
    const pct = Math.min(1, (clientX - rect.left) / rect.width)
    return Math.max(1, Math.min(5, Math.ceil(pct * 5)))
  }

  return (
   <div>
    <div
      ref={barRef}
      // Note: data-no-pull is set on the surrounding FlavourSection
      // <section>; no need to repeat it on each bar.
      style={{
        position:'relative',height:36,borderRadius:6,
        overflow:'hidden',cursor: readOnly ? 'default' : 'pointer',
        // No `touch-action` — inherit `pan-y` from scrollRef. Intent
        // detection in onPointerMove claims the gesture only for
        // horizontal-dominant drags; vertical drags pass through to
        // native scroll.
      }}
      onPointerDown={readOnly ? undefined : e => {
        if (!e.isPrimary) return
        // Record the start; don't claim the pointer yet. Wait for
        // movement past SLOP to know whether it's horizontal or
        // vertical, then decide.
        pendingDownRef.current = { x: e.clientX, y: e.clientY }
        draggingRef.current = false
        hadMoved.current = false
      }}
      onPointerMove={readOnly ? undefined : e => {
        if (draggingRef.current) {
          // Already committed — update hover/value.
          hadMoved.current = true
          setHover(segAt(e.clientX))
          return
        }
        const pd = pendingDownRef.current
        if (!pd) return
        const dx = e.clientX - pd.x
        const dy = e.clientY - pd.y
        // Wait until we've moved past the slop threshold so we can
        // reliably classify intent. Pure jitter under SLOP is ignored.
        if (Math.abs(dx) < FLAVOR_SLOP && Math.abs(dy) < FLAVOR_SLOP) return
        if (Math.abs(dx) > Math.abs(dy)) {
          // Horizontal-dominant — claim the gesture. setPointerCapture
          // re-routes subsequent events to this element regardless of
          // where the finger drifts.
          draggingRef.current = true
          try { barRef.current?.setPointerCapture(e.pointerId) } catch {}
          hadMoved.current = true
          setHover(segAt(e.clientX))
        } else {
          // Vertical-dominant — release. The browser handles native
          // pan-y scroll for the rest of the gesture.
          pendingDownRef.current = null
        }
      }}
      onPointerUp={readOnly ? undefined : e => {
        const pd = pendingDownRef.current
        const wasDragging = draggingRef.current
        pendingDownRef.current = null
        draggingRef.current = false
        if (!setValue) return
        if (wasDragging) {
          // Commit the segment under the finger at release.
          setValue(segAt(e.clientX))
          setHover(null)
          return
        }
        if (pd && !hadMoved.current) {
          // Tap, no drag — toggle the segment at the tap.
          const seg = segAt(e.clientX)
          setValue(seg === value ? 0 : seg)
        }
        setHover(null)
        hadMoved.current = false
      }}
      onPointerCancel={readOnly ? undefined : () => {
        // System cancelled (e.g. iOS reclassified as scroll). Drop
        // state, don't commit anything.
        pendingDownRef.current = null
        draggingRef.current = false
        hadMoved.current = false
        setHover(null)
      }}
      onMouseLeave={() => { if (!draggingRef.current) setHover(null) }}
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
      {/* Dividers between zones. Each sits at a fixed percentage
          (20/40/60/80). Over the colored fill, a black divider reads
          as a harsh slash that fights the hue — use a translucent
          white instead so the divider lifts a shade of the same
          color. Off the fill (over bg3), translucent black reads
          cleanly. */}
      {[1,2,3,4].map(i => {
        const dividerPct = (i / 5) * 100
        const overFill = fillPct >= dividerPct
        return (
          <div key={i} style={{
            position:'absolute',top:3,bottom:3,width:1,
            background: overFill ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.55)',
            left:`${dividerPct}%`,pointerEvents:'none',zIndex:2,
            transition:'background .15s',
          }} />
        )
      })}
      {/* content layer */}
      <div style={{
        position:'absolute',inset:0,
        display:'flex',alignItems:'center',justifyContent:'space-between',
        padding:'0 12px',pointerEvents:'none',zIndex:2,
      }}>
        <span style={{
          display:'inline-flex',alignItems:'center',gap:8,
          fontSize:12,fontWeight:600,
          // `--fg-warm` is theme-aware (light on dark, dark on light)
          // and contrasts against both the bg3 base AND the muted
          // colored fill in either theme. The old hard-coded `#fff`
          // was invisible in light mode where bg3 is itself light.
          color: hasValue ? 'var(--fg-warm)' : 'var(--fg)',
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
          color: hasValue ? 'var(--fg-warm)' : 'var(--fg-faint)',
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
    {/* Disambiguating subtitle BELOW the slider, INPUT only (§6f): "smell"
        under Aroma, "taste" under Flavour. From the registry `sub` field — only
        those two axes carry it (aroma + flavour share one grid row, so both
        cells grow together — no ragged height). The read-only wheels ignore it. */}
    {item.sub && (
      <div style={{ fontSize:10, color:'var(--fg-dim)', marginTop:3, paddingLeft:2 }}>{item.sub}</div>
    )}
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
    // `data-no-pull` here is read by WineModal's arrow-key handler
    // to skip wine navigation when focus is inside this section. The
    // textarea check in that handler already covers the textarea
    // itself; this attribute extends the opt-out to any focusable
    // surrounding chrome that might be added later.
    <section data-no-pull>
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
