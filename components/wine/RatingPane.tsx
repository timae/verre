'use client'
import { useState, useEffect } from 'react'
import { FlavorChips } from '@/components/rate/FlavorChips'
import { IntensityHelp } from '@/components/rate/IntensityHelp'
import { ScoreSlider } from '@/components/ui/ScoreSlider'
import { StarRating } from '@/components/ui/StarRating'
import { PolarChart } from '@/components/charts/PolarChart'
import { CHART_SIZE } from '@/components/charts/sizes'
import { getFL, detectFL, FL } from '@/lib/flavours'

export type RatingValue = {
  score: number
  flavors: Record<string, number>
  notes: string
}

interface BasePaneProps {
  // Wine type drives the flavour-dimension set (red vs white vs spark…).
  // Pass null when the wine is blind-redacted — falls back to FL generic.
  wineType: string | null
  // Caller-supplied existing rating, used to seed editor state or render
  // the read-only view.
  existing: RatingValue | null
}

interface EditableProps extends BasePaneProps {
  readOnly?: false
  // Caller subscribes to local edits so it can commit them with its own
  // button placement. The pane doesn't render its own commit CTA —
  // primary-action placement is the caller's call.
  onChange: (value: RatingValue) => void
}

interface ReadOnlyProps extends BasePaneProps {
  readOnly: true
}

type Props = EditableProps | ReadOnlyProps

// Pure rating UI — score, flavour profile, notes. No commit button
// (caller positions the primary action relative to its surrounding
// buttons). No wine-management actions. No modal chrome.
//
// Editable mode: ScoreSlider + FlavorChips + textarea. Read-only:
// StarRating + PolarChart + paragraph. Read-only is for surfaces that
// render someone else's rating (feed, /u/<id>). Server-side auth is
// the real gate; this flag just picks input vs display widgets.
//
// IMPORTANT: when the same `<RatingPane>` instance might host different
// wines (swipe-between-wines in step 11), the caller MUST pass
// `key={wineId}` so React remounts the pane on wine change. Polling
// the live ratings every few seconds returns a fresh `existing` object
// reference each tick — if we re-seeded on every reference change, the
// user's in-progress edits would get clobbered. Remount-on-key is the
// only state reset path.
export function RatingPane(props: Props) {
  const { wineType, existing } = props
  const readOnly = 'readOnly' in props && props.readOnly === true

  // Detect flavour dimensions from existing rating's stored keys (so
  // historic ratings with old key names still render right), else use
  // the wine type's standard set, else generic.
  const fl = existing?.flavors && Object.keys(existing.flavors).length
    ? detectFL(existing.flavors as Record<string, number>)
    : wineType ? getFL(wineType) : FL

  const [score, setScore] = useState(existing?.score || 0)
  const [flavors, setFlavors] = useState<Record<string, number>>(() => {
    const base = fl.reduce((o, f) => ({ ...o, [f.k]: 0 }), {} as Record<string, number>)
    if (existing?.flavors) Object.assign(base, existing.flavors)
    return base
  })
  const [notes, setNotes] = useState(existing?.notes || '')

  // Surface local edits to the caller so it can drive its own commit
  // button. Skipped in read-only mode (no onChange exists).
  const onChange = !readOnly ? (props as EditableProps).onChange : undefined
  useEffect(() => {
    if (!onChange) return
    onChange({ score, flavors, notes })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score, flavors, notes])

  if (readOnly) {
    const hasFlavors = Object.values(flavors).some(v => v > 0)
    return (
      <>
        <div className="panel">
          <div className="panel-hdr">score</div>
          {score > 0 ? <StarRating value={score} size="detail" /> : <p style={{fontSize:12,color:'var(--fg-faint)'}}>not rated</p>}
        </div>
        {hasFlavors && (
          <div className="panel">
            <div className="panel-hdr">flavour profile</div>
            <div style={{display:'flex',justifyContent:'center'}}>
              <PolarChart flavors={flavors} fl={fl} size={CHART_SIZE.DETAIL} />
            </div>
          </div>
        )}
        {notes && (
          <div className="panel">
            <div className="panel-hdr">tasting notes</div>
            <p style={{fontSize:13,color:'var(--fg)',fontFamily:'var(--mono)',whiteSpace:'pre-wrap',margin:0}}>{notes}</p>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <div className="panel">
        <div className="panel-hdr">score</div>
        <ScoreSlider value={score} onChange={setScore} />
      </div>
      <div className="panel">
        <div className="panel-hdr">flavour profile</div>
        <IntensityHelp />
        <FlavorChips flavors={flavors} fl={fl} onChange={setFlavors} />
      </div>
      <div className="panel">
        <div className="panel-hdr">tasting notes</div>
        <textarea
          value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="aroma, palate, finish…" rows={3}
          style={{width:'100%',background:'transparent',fontSize:13,color:'var(--fg)',resize:'none',outline:'none',fontFamily:'var(--mono)',border:'none'}}
        />
      </div>
    </>
  )
}
