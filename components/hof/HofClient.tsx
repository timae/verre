'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { openLightbox } from '@/components/ui/ImageLightbox'

const TYPES = [
  { k: 'all',    l: 'All' },
  { k: 'red',    l: '🍷 Red' },
  { k: 'white',  l: '🥂 White' },
  { k: 'spark',  l: '🍾 Sparkling' },
  { k: 'rose',   l: '🌸 Rosé' },
  { k: 'nonalc', l: '🌿 Non-alc' },
]
const ICO: Record<string, string> = { red:'🍷', white:'🥂', spark:'🍾', rose:'🌸', nonalc:'🌿' }

type RankEntry = {
  rank: number; wineKey: string; name: string
  producer: string|null; vintage: string|null; style: string|null; imageUrl: string|null
  avgScore: number; ratingCount: number; sessionCount: number; userCount: number
}

function ScoreBar({ score }: { score: number }) {
  const pct = (score / 5) * 100
  return (
    <div style={{ height:3, background:'var(--bg3)', borderRadius:2, overflow:'hidden', marginTop:4, width:'100%' }}>
      <div style={{ height:'100%', width:`${pct}%`, background:`linear-gradient(90deg,var(--accent2),var(--accent))`, borderRadius:2 }} />
    </div>
  )
}

export function HofClient() {
  const [type, setType] = useState('all')

  const { data: entries = [], isLoading } = useQuery<RankEntry[]>({
    queryKey: ['hof-rankings', type],
    queryFn: () => fetch(`/api/hof/rankings?type=${type}`).then(r => r.json()),
    staleTime: 60_000,
  })

  return (
    <div style={{ marginTop:20 }}>
      {/* Type filter */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:20 }}>
        {TYPES.map(t => (
          <button key={t.k} onClick={() => setType(t.k)}
            style={{
              padding:'5px 12px', borderRadius:6, border:'1px solid',
              fontSize:10, fontFamily:'var(--mono)', letterSpacing:'0.06em',
              cursor:'pointer', transition:'all .15s',
              background: type===t.k ? 'rgba(200,150,60,0.12)' : 'transparent',
              borderColor: type===t.k ? 'rgba(200,150,60,0.4)' : 'var(--border)',
              color: type===t.k ? 'var(--accent)' : 'var(--fg-dim)',
            }}>
            {t.l}
          </button>
        ))}
      </div>

      {isLoading && (
        <div style={{ textAlign:'center', padding:'40px 0', color:'var(--fg-dim)', fontSize:13 }}>loading…</div>
      )}

      {!isLoading && entries.length === 0 && (
        <div className="panel" style={{ textAlign:'center', padding:'40px 16px' }}>
          <div style={{ fontSize:32, marginBottom:12 }}>🏆</div>
          <p style={{ fontSize:13, color:'var(--fg-dim)', lineHeight:1.7 }}>
            No wines qualify yet. Rankings appear once a wine has been rated
            at least 3 times across at least 2 separate sessions.
          </p>
        </div>
      )}

      {entries.length > 0 && (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {entries.map(e => {
            const sub = [e.producer, e.vintage].filter(Boolean).join(' · ')
            return (
              <div key={e.wineKey} className="panel" style={{ display:'flex', gap:14, alignItems:'center', padding:'14px 16px', marginBottom:0 }}>
                {/* Rank */}
                <div style={{ flexShrink:0, width:28, textAlign:'center' }}>
                  {e.rank <= 3 ? (
                    <span style={{ fontSize:20 }}>{e.rank===1?'🥇':e.rank===2?'🥈':'🥉'}</span>
                  ) : (
                    <span style={{ fontSize:13, fontWeight:700, color:'var(--fg-faint)', fontFamily:'var(--mono)' }}>#{e.rank}</span>
                  )}
                </div>

                {/* Photo or icon */}
                {e.imageUrl ? (
                  <img src={e.imageUrl} alt={e.name}
                    onClick={() => openLightbox(e.imageUrl!, e.name)}
                    style={{ width:40, height:40, borderRadius:8, objectFit:'contain', flexShrink:0, cursor:'zoom-in', background:'var(--bg3)' }} />
                ) : (
                  <div style={{ width:40, height:40, borderRadius:8, background:'var(--bg3)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, flexShrink:0 }}>
                    {ICO[e.style??''] ?? '🍷'}
                  </div>
                )}

                {/* Name + confidence */}
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:700, fontSize:14, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.name}</div>
                  {sub && <div style={{ fontSize:10, color:'var(--fg-dim)', marginTop:2 }}>{sub}</div>}
                  <ScoreBar score={e.avgScore} />
                  <div style={{ fontSize:9, color:'var(--fg-faint)', marginTop:4, fontFamily:'var(--mono)', letterSpacing:'0.04em' }}>
                    {e.ratingCount} rating{e.ratingCount!==1?'s':''} · {e.sessionCount} session{e.sessionCount!==1?'s':''}
                    {e.userCount > 0 && ` · ${e.userCount} taster${e.userCount!==1?'s':''}`}
                  </div>
                </div>

                {/* Score */}
                <div style={{ flexShrink:0, textAlign:'right' }}>
                  <span style={{ fontSize:26, fontWeight:800, color:'var(--accent)', lineHeight:1 }}>{e.avgScore.toFixed(1)}</span>
                  <span style={{ fontSize:11, color:'var(--fg-dim)' }}>/5</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
