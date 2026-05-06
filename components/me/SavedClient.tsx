'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SavedWineModal } from './SavedWineModal'
import { authedFetch } from '@/lib/authedFetch'
import { WineIdentity } from '@/components/wine/WineIdentity'

type Bookmark = { wine_id: string; name: string; producer: string | null; vintage: string | null; grape: string | null; style: string | null; image_url: string | null; session_code: string }
type Rating = { wine_name: string; score: number; flavors: Record<string,number>; notes: string | null; session_code: string }

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

export function SavedClient() {
  const [selected, setSelected] = useState<Bookmark | null>(null)
  const qc = useQueryClient()

  const { data: bookmarks = [], isLoading } = useQuery<Bookmark[]>({
    queryKey: ['me-bookmarks'],
    queryFn: () => authedFetch<Bookmark[]>('/api/me/bookmarks'),
  })
  const { data: ratings = [] } = useQuery<Rating[]>({
    queryKey: ['me-ratings'],
    queryFn: () => authedFetch<Rating[]>('/api/me/ratings'),
  })

  if (isLoading) return <p style={{color:'var(--fg-dim)',fontSize:13}}>Loading…</p>
  if (!bookmarks.length) return (
    <p style={{color:'var(--fg-dim)',fontSize:13,padding:'32px 0'}}>No saved wines yet — tap ☆ on any wine detail to save it.</p>
  )

  return (
    <>
      <h1 style={{fontSize:24,fontWeight:700,color:'#F0E3C6',marginBottom:16}}>Saved wines</h1>
      <div className="wine-stack">
        {bookmarks.map(b => {
          const rating = ratings.find(r => r.session_code === b.session_code && r.wine_name === b.name)
          return (
            <button key={b.wine_id} className="wine-card" style={{width:'100%',textAlign:'left'}} onClick={() => setSelected(b)}>
              {b.image_url ? (
                <img src={b.image_url} alt={b.name} onClick={e=>{e.stopPropagation();openLightbox(b.image_url!,b.name)}} style={{width:38,height:38,borderRadius:8,objectFit:'cover',flexShrink:0,cursor:'zoom-in'}} />
              ) : (
                <div style={{width:38,height:38,borderRadius:8,background:'var(--bg3)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18}}>
                  {ICO[b.style||'']||'🍷'}
                </div>
              )}
              <div style={{flex:1,minWidth:0}}>
                <WineIdentity wine={b} size="compact" />
                <p style={{fontSize:9,color:'var(--fg-faint)',marginTop:2,fontFamily:'var(--mono)',letterSpacing:'0.06em'}}>session {b.session_code}</p>
              </div>
              {rating && (
                <div style={{flexShrink:0,textAlign:'right'}}>
                  <span style={{fontSize:20,fontWeight:800,lineHeight:1,color:'var(--accent)'}}>{rating.score}</span>
                  <span style={{fontSize:10,color:'var(--fg-dim)'}}>/5</span>
                </div>
              )}
            </button>
          )
        })}
      </div>

      {selected && (
        <SavedWineModal
          wine={selected}
          ratings={ratings}
          onClose={() => setSelected(null)}
          onRemove={async () => {
            const res = await fetch(`/api/me/bookmarks/${selected.wine_id}`, { method: 'DELETE' })
            if (!res.ok) throw new Error(`remove failed: ${res.status}`)
            setSelected(null)
            qc.invalidateQueries({ queryKey: ['me-bookmarks'] })
          }}
        />
      )}
    </>
  )
}
