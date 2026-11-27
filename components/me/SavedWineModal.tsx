'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { useRef } from 'react'
import { PolarChart } from '@/components/charts/PolarChart'
import { CHART_SIZE } from '@/components/charts/sizes'
import { openWheelLightbox } from '@/components/charts/wheelLightbox'
import { perRatingAxes, resolveAxesColoured } from '@/lib/flavours'
import { ConfirmDeleteButton } from '@/components/ui/ConfirmDeleteButton'
import { WineIdentity } from '@/components/wine/WineIdentity'
import { Modal } from '@/components/ui/Modal'
import { StarRating } from '@/components/ui/StarRating'
import { formatCode } from '@verre/core'
import { ICO } from '@/lib/wineTypeColors'
import { kindToken } from '@verre/core'
import { type SavedWine, type SavedVintage, vintageLabel } from '@/lib/savedWines'

interface Props { wine: SavedWine; onClose: () => void; onRemove?: (key: string) => void | Promise<void> }

const where = (x: Pick<SavedVintage, 'session_code' | 'session_deleted'>) =>
  x.session_deleted ? '[deleted session]' : x.session_code ? `session ${formatCode(x.session_code)}` : null

// One saved wine: the vintages you saved (each removable on its own) and your
// ratings of it (where you had it: derived from your ratings, never stored).
export function SavedWineModal({ wine, onClose, onRemove }: Props) {
  const latest = wine.ratings[0]
  // Read surface (§6d): per-present-key array. The kind comes from the wine.
  const fl = perRatingAxes(latest?.flavors, resolveAxesColoured('wine', wine))
  const wheelRef = useRef<HTMLDivElement>(null)

  return (
    <Modal onClose={onClose} maxWidth={560} maxHeight="90vh">
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
          <div style={{fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.04em'}}>saved wine</div>
          <button className="btn-s" onClick={onClose} style={{fontSize:9}}>close</button>
        </div>
        {wine.image_url && (
          <img src={wine.image_url} alt={wine.name} onClick={()=>openLightbox(wine.image_url!,wine.name)} style={{width:'100%',height:140,objectFit:'cover',borderRadius:12,marginBottom:14,cursor:'zoom-in'}} />
        )}

        <div style={{display:'flex',alignItems:'flex-start',gap:12,marginBottom:16}}>
          {!wine.image_url && <span style={{fontSize:28}}>{ICO[kindToken(wine)]||'🍷'}</span>}
          <div style={{flex:1, minWidth:0}}>
            <WineIdentity wine={{ name: wine.name, producer: wine.producer, grape: wine.grape, vintage: null }} size="card" />
          </div>
        </div>

        <div className="panel">
          <div className="panel-hdr">saved</div>
          {wine.vintages.map(v => (
            <div key={v.key} style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,padding:'4px 0'}}>
              <span style={{fontFamily:'var(--mono)',fontSize:12}}>{vintageLabel(v.vintage, wine.linked)}</span>
              {where(v) && <span style={{fontSize:10,color:'var(--fg-faint)',fontFamily:'var(--mono)'}}>{where(v)}</span>}
            </div>
          ))}
        </div>

        {latest ? (
          <>
            <div className="panel">
              <div className="panel-hdr">your ratings</div>
              {wine.ratings.map(r => (
                <div key={r.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,padding:'4px 0'}}>
                  <span style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--fg-dim)'}}>
                    {[r.vintage, where(r)].filter(Boolean).join(' · ')}
                  </span>
                  {r.score ? <StarRating value={r.score} /> : null}
                </div>
              ))}
            </div>

            {Object.values(latest.flavors || {}).some(v => v > 0) && (
              <div className="panel" style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
                <div className="panel-hdr" style={{alignSelf:'flex-start',width:'100%'}}>flavour profile</div>
                <div
                  ref={wheelRef}
                  onClick={() => openWheelLightbox(wheelRef, wine.name)}
                  style={{cursor:'zoom-in'}}
                  title="Click to expand"
                >
                  <PolarChart flavors={latest.flavors} fl={fl} size={CHART_SIZE.DETAIL} />
                </div>
              </div>
            )}

            {latest.notes && (
              <div className="panel">
                <div className="panel-hdr">tasting notes</div>
                <p style={{fontSize:12,color:'var(--fg-dim)',fontStyle:'italic',lineHeight:1.6}}>&ldquo;{latest.notes}&rdquo;</p>
              </div>
            )}
          </>
        ) : (
          <div className="panel">
            <p style={{fontSize:12,color:'var(--fg-dim)'}}>No rating recorded for this wine yet.</p>
          </div>
        )}

        {onRemove && wine.vintages.map(v => (
          <ConfirmDeleteButton
            key={v.key}
            label={wine.vintages.length > 1 ? `⌫ remove ${vintageLabel(v.vintage, wine.linked)} from saved` : '⌫ remove from saved'}
            confirmLabel="tap again to remove"
            onConfirm={() => onRemove(v.key)}
          />
        ))}
    </Modal>
  )
}
