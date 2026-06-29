'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { useRef } from 'react'
import { PolarChart } from '@/components/charts/PolarChart'
import { CHART_SIZE } from '@/components/charts/sizes'
import { openWheelLightbox } from '@/components/charts/wheelLightbox'
import { detectLegacyDescriptorFL, perRatingAxes, resolveAxesColoured } from '@/lib/flavours'
import { ConfirmDeleteButton } from '@/components/ui/ConfirmDeleteButton'
import { WineIdentity } from '@/components/wine/WineIdentity'
import { Modal } from '@/components/ui/Modal'
import { StarRating } from '@/components/ui/StarRating'
import { formatCode } from '@verre/core'
import { ICO } from '@/lib/wineTypeColors'

type Bookmark = {
  wine_id: string; name: string; producer: string | null; vintage: string | null
  grape: string | null; style: string | null; image_url: string | null
  session_code: string | null
  session_deleted?: boolean
}
type Rating = {
  wine_id: string
  wine_name: string; score: number; flavors: Record<string,number>; notes: string | null
  session_code: string | null
}

interface Props { wine: Bookmark; ratings: Rating[]; onClose: () => void; onRemove?: () => void | Promise<void> }

export function SavedWineModal({ wine, ratings, onClose, onRemove }: Props) {
  // Cross-match on wine_id — name-based join collides across deleted-session
  // ratings of differently-spelled same-name wines once the §8 scrub nulls
  // session_code on both rows.
  const rating = ratings.find(r => r.wine_id === wine.wine_id)
  // Read surface (§6d): legacy descriptor row → legacy wheel; structure row →
  // per-present-key array. Style comes from the bookmark (no type on the rating).
  const fl = (rating?.flavors && detectLegacyDescriptorFL(rating.flavors))
    || perRatingAxes(rating?.flavors, resolveAxesColoured('wine', wine.style))
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
          {!wine.image_url && <span style={{fontSize:28}}>{ICO[wine.style||'']||'🍷'}</span>}
          <div style={{flex:1, minWidth:0}}>
            <WineIdentity wine={wine} size="card" />
            {wine.session_deleted ? (
              <p style={{fontSize:10,color:'var(--fg-faint)',marginTop:4,fontFamily:'var(--mono)'}}>[deleted session]</p>
            ) : wine.session_code ? (
              <p style={{fontSize:10,color:'var(--fg-faint)',marginTop:4,fontFamily:'var(--mono)'}}>session {formatCode(wine.session_code)}</p>
            ) : null}
          </div>
        </div>

        {rating ? (
          <>
            <div className="panel">
              <div className="panel-hdr">your score</div>
              <div style={{display:'flex',justifyContent:'center'}}>
                <StarRating value={rating.score} size="detail" />
              </div>
            </div>

            {Object.values(rating.flavors || {}).some(v => v > 0) && (
              <div className="panel" style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
                <div className="panel-hdr" style={{alignSelf:'flex-start',width:'100%'}}>flavour profile</div>
                <div
                  ref={wheelRef}
                  onClick={() => openWheelLightbox(wheelRef, wine.name)}
                  style={{cursor:'zoom-in'}}
                  title="Click to expand"
                >
                  <PolarChart flavors={rating.flavors} fl={fl} size={CHART_SIZE.DETAIL} />
                </div>
              </div>
            )}

            {rating.notes && (
              <div className="panel">
                <div className="panel-hdr">tasting notes</div>
                <p style={{fontSize:12,color:'var(--fg-dim)',fontStyle:'italic',lineHeight:1.6}}>&ldquo;{rating.notes}&rdquo;</p>
              </div>
            )}
          </>
        ) : (
          <div className="panel">
            <p style={{fontSize:12,color:'var(--fg-dim)'}}>No rating recorded for this wine yet.</p>
          </div>
        )}

        {onRemove && (
          <ConfirmDeleteButton
            label="⌫ remove from saved"
            confirmLabel="tap again to remove"
            onConfirm={onRemove}
          />
        )}
    </Modal>
  )
}
