'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SavedWineModal } from './SavedWineModal'
import { authedFetch } from '@/lib/authedFetch'
import { WineIdentity } from '@/components/wine/WineIdentity'
import { formatCode } from '@/lib/sessionCode'
import { StarRating } from '@/components/ui/StarRating'
import { ICO } from '@/lib/wineTypeColors'

type Bookmark = {
  wine_id: string; name: string; producer: string | null; vintage: string | null
  grape: string | null; style: string | null; image_url: string | null
  session_code: string | null
  // session_deleted: true when the source session has been soft-deleted
  // (the §8 contract scrubs the session row). Renderer shows
  // "[deleted session]" instead of the join code.
  session_deleted?: boolean
  session_id?: number | null
}
type Rating = {
  wine_id: string
  wine_name: string; score: number; flavors: Record<string,number>; notes: string | null
  session_code: string | null
  session_deleted?: boolean
  session_id?: number | null
}

export function SavedClient() {
  const [selected, setSelected] = useState<Bookmark | null>(null)
  const qc = useQueryClient()

  const { data: bookmarks = [], isLoading } = useQuery<Bookmark[]>({
    queryKey: ['me-bookmarks'],
    queryFn: () => authedFetch<Bookmark[]>('/api/me/bookmarks'),
    // Always refetch on mount so a bookmark made elsewhere in the app
    // (modal save in a session) shows up immediately when the user
    // arrives at /me/saved, even if RSC navigation served a cached
    // page shell.
    refetchOnMount: 'always',
  })
  const { data: ratings = [] } = useQuery<Rating[]>({
    queryKey: ['me-ratings'],
    queryFn: () => authedFetch<Rating[]>('/api/me/ratings'),
    refetchOnMount: 'always',
  })

  if (isLoading) return <p style={{color:'var(--fg-dim)',fontSize:13}}>Loading…</p>
  if (!bookmarks.length) return (
    <p style={{color:'var(--fg-dim)',fontSize:13,padding:'32px 0',textAlign:'center'}}>No saved wines yet — tap ☆ on any wine detail to save it.</p>
  )

  return (
    <>
      <h1 style={{fontSize:24,fontWeight:700,color:'#F0E3C6',marginBottom:16}}>Saved wines</h1>
      <div className="wine-stack">
        {bookmarks.map(b => {
          // Cross-match on wine_id (the only stable join key). The legacy
          // session_code/wine_name name-based join collided across two
          // deleted-session ratings of differently-spelled same-name wines
          // once the §8 scrub nulled session_code on both rows.
          const rating = ratings.find(r => r.wine_id === b.wine_id)
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
                {b.session_deleted ? (
                  <p style={{fontSize:9,color:'var(--fg-faint)',marginTop:2,fontFamily:'var(--mono)',letterSpacing:'0.06em'}}>[deleted session]</p>
                ) : b.session_code ? (
                  <p style={{fontSize:9,color:'var(--fg-faint)',marginTop:2,fontFamily:'var(--mono)',letterSpacing:'0.06em'}}>session {formatCode(b.session_code)}</p>
                ) : null}
              </div>
              {rating?.score ? (
                <div style={{flexShrink:0}}>
                  <StarRating value={rating.score} />
                </div>
              ) : null}
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
