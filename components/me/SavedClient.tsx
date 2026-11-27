'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SavedWineModal } from './SavedWineModal'
import { authedFetch } from '@/lib/authedFetch'
import { WineIdentity } from '@/components/wine/WineIdentity'
import { formatCode } from '@verre/core'
import { StarRating } from '@/components/ui/StarRating'
import { ICO } from '@/lib/wineTypeColors'
import { kindToken } from '@verre/core'
import { type SavedWine, vintagesLabel } from '@/lib/savedWines'

// /me/saved (catalogue model change § 5): one wine per row, the vintages you
// saved of it underneath, your ratings of it as context (all from
// /api/me/bookmarks). A save of a blind bottle shows here after its reveal.
export function SavedClient() {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: wines = [], isLoading } = useQuery<SavedWine[]>({
    queryKey: ['me-bookmarks'],
    queryFn: () => authedFetch<SavedWine[]>('/api/me/bookmarks'),
    // Always refetch on mount so a save made elsewhere in the app (modal save
    // in a session) shows up immediately when the user arrives at /me/saved,
    // even if RSC navigation served a cached page shell.
    refetchOnMount: 'always',
  })
  const selected = wines.find(w => w.key === selectedKey) ?? null

  if (isLoading) return <p style={{color:'var(--fg-dim)',fontSize:13}}>Loading…</p>
  if (!wines.length) return (
    <p style={{color:'var(--fg-dim)',fontSize:13,padding:'32px 0',textAlign:'center'}}>No saved wines yet. Tap ☆ on any wine detail to save it.</p>
  )

  return (
    <>
      <h1 style={{fontSize:24,fontWeight:700,color:'#F0E3C6',marginBottom:16}}>Saved wines</h1>
      <div className="wine-stack">
        {wines.map(w => {
          const latest = w.ratings[0]
          const where = w.vintages[0]
          return (
            <button key={w.key} className="wine-card" style={{width:'100%',textAlign:'left'}} onClick={() => setSelectedKey(w.key)}>
              {w.image_url ? (
                <img src={w.image_url} alt={w.name} onClick={e=>{e.stopPropagation();openLightbox(w.image_url!,w.name)}} style={{width:38,height:38,borderRadius:8,objectFit:'cover',flexShrink:0,cursor:'zoom-in'}} />
              ) : (
                <div style={{width:38,height:38,borderRadius:8,background:'var(--bg3)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18}}>
                  {ICO[kindToken(w)]||'🍷'}
                </div>
              )}
              <div style={{flex:1,minWidth:0}}>
                <WineIdentity wine={{ name: w.name, producer: w.producer, grape: w.grape, vintage: null }} size="compact" />
                <p style={{fontSize:9,color:'var(--fg-faint)',marginTop:2,fontFamily:'var(--mono)',letterSpacing:'0.06em'}}>
                  {vintagesLabel(w)}
                  {where?.session_deleted ? ' · [deleted session]' : where?.session_code ? ` · session ${formatCode(where.session_code)}` : ''}
                </p>
              </div>
              {latest?.score ? (
                <div style={{flexShrink:0}}>
                  <StarRating value={latest.score} />
                </div>
              ) : null}
            </button>
          )
        })}
      </div>

      {selected && (
        <SavedWineModal
          wine={selected}
          onClose={() => setSelectedKey(null)}
          onRemove={async (key) => {
            const res = await fetch(`/api/me/bookmarks/${encodeURIComponent(key)}`, { method: 'DELETE' })
            if (!res.ok) throw new Error(`remove failed: ${res.status}`)
            if (selected.vintages.length <= 1) setSelectedKey(null)
            qc.invalidateQueries({ queryKey: ['me-bookmarks'] })
          }}
        />
      )}
    </>
  )
}
