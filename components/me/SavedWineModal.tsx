'use client'
import { useEffect, useState } from 'react'
import { PolarChart } from '@/components/charts/PolarChart'
import { detectFL, FL } from '@/lib/flavours'

type Bookmark = { wine_id: string; name: string; producer: string | null; vintage: string | null; style: string | null; image_url: string | null; session_code: string }
type Rating = { wine_name: string; score: number; flavors: Record<string,number>; notes: string | null; session_code: string }

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

interface Props { wine: Bookmark; ratings: Rating[]; onClose: () => void }

export function SavedWineModal({ wine, ratings, onClose }: Props) {
  const rating = ratings.find(r => r.session_code === wine.session_code && r.wine_name === wine.name)
  const fl = rating?.flavors ? detectFL(rating.flavors) : FL

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [onClose])

  const sub = [wine.producer, wine.vintage].filter(Boolean).join(' · ')

  return (
    <div style={{position:'fixed',inset:0,zIndex:50,display:'flex',alignItems:'flex-end',justifyContent:'center',background:'rgba(0,0,0,0.6)',backdropFilter:'blur(4px)'}}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{width:'100%',maxWidth:560,maxHeight:'90vh',overflowY:'auto',background:'var(--bg2)',borderRadius:'22px 22px 0 0',padding:18,paddingBottom:32}}>
        <div className="sheet-bar" />

        {wine.image_url && (
          <img src={wine.image_url} alt={wine.name} style={{width:'100%',height:140,objectFit:'cover',borderRadius:12,marginBottom:14}} />
        )}

        <div style={{display:'flex',alignItems:'flex-start',gap:12,marginBottom:16}}>
          {!wine.image_url && <span style={{fontSize:28}}>{ICO[wine.style||'']||'🍷'}</span>}
          <div>
            <h2 style={{fontSize:16,fontWeight:800,lineHeight:1.2}}>{wine.name}</h2>
            {sub && <p style={{fontSize:11,color:'var(--fg-dim)',marginTop:3}}>{sub}</p>}
            <p style={{fontSize:10,color:'var(--fg-faint)',marginTop:2,fontFamily:'var(--mono)'}}>session {wine.session_code}</p>
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
                <PolarChart flavors={rating.flavors} fl={fl} size={260} />
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
      </div>
    </div>
  )
}
