'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { useEffect, useRef } from 'react'
import { PolarChart } from '@/components/charts/PolarChart'
import { CHART_SIZE } from '@/components/charts/sizes'
import { openWheelLightbox } from '@/components/charts/wheelLightbox'
import { detectFL, FL } from '@/lib/flavours'
import { ConfirmDeleteButton } from '@/components/ui/ConfirmDeleteButton'
import { WineIdentity } from '@/components/wine/WineIdentity'

type Bookmark = { wine_id: string; name: string; producer: string | null; vintage: string | null; grape: string | null; style: string | null; image_url: string | null; session_code: string }
type Rating = { wine_name: string; score: number; flavors: Record<string,number>; notes: string | null; session_code: string }

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

interface Props { wine: Bookmark; ratings: Rating[]; onClose: () => void; onRemove?: () => void | Promise<void> }

export function SavedWineModal({ wine, ratings, onClose, onRemove }: Props) {
  const rating = ratings.find(r => r.session_code === wine.session_code && r.wine_name === wine.name)
  const fl = rating?.flavors ? detectFL(rating.flavors) : FL
  const wheelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [onClose])

  return (
    <div style={{position:'fixed',inset:0,zIndex:50,display:'flex',alignItems:'flex-end',justifyContent:'center',background:'rgba(0,0,0,0.6)',backdropFilter:'blur(4px)'}}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{width:'100%',maxWidth:560,maxHeight:'90vh',overflowY:'auto',background:'var(--bg2)',borderRadius:'22px 22px 0 0',padding:18,paddingBottom:32}}>
        <div className="sheet-bar" />

        {wine.image_url && (
          <img src={wine.image_url} alt={wine.name} onClick={()=>openLightbox(wine.image_url!,wine.name)} style={{width:'100%',height:140,objectFit:'cover',borderRadius:12,marginBottom:14,cursor:'zoom-in'}} />
        )}

        <div style={{display:'flex',alignItems:'flex-start',gap:12,marginBottom:16}}>
          {!wine.image_url && <span style={{fontSize:28}}>{ICO[wine.style||'']||'🍷'}</span>}
          <div style={{flex:1, minWidth:0}}>
            <WineIdentity wine={wine} size="card" />
            <p style={{fontSize:10,color:'var(--fg-faint)',marginTop:4,fontFamily:'var(--mono)'}}>session {wine.session_code}</p>
          </div>
        </div>

        {rating ? (
          <>
            <div className="panel">
              <div className="panel-hdr">your score</div>
              <div style={{display:'flex',justifyContent:'center',gap:8}}>
                {[1,2,3,4,5].map(n => (
                  <span key={n} style={{fontSize:24,color:n<=rating.score?'var(--accent)':'var(--fg-faint)'}}>★</span>
                ))}
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

        <button className="btn-g" onClick={onClose}>close</button>
        {onRemove && (
          <ConfirmDeleteButton
            label="⌫ remove from saved"
            confirmLabel="tap again to remove"
            onConfirm={onRemove}
          />
        )}
      </div>
    </div>
  )
}
