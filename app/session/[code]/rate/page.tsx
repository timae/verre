'use client'
import { useSession } from '@/components/session/SessionShell'
import { WineCard } from '@/components/wine/WineCard'
import { useRouter } from 'next/navigation'

export default function RatePickerPage() {
  const { wines, myRatings, code, displayName } = useSession()
  const router = useRouter()

  return (
    <div style={{padding:'14px 14px 28px'}}><div style={{maxWidth:980,margin:'0 auto'}}>
      <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:12,marginBottom:16}}>
        <div className="subhead" style={{margin:0}}>
          <div className="subhead-title">Rate bottles</div>
          <div className="subhead-copy">{wines.length} bottle{wines.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      {wines.length === 0 && (
        <div style={{textAlign:'center',padding:'48px 0',color:'var(--fg-dim)',fontSize:13}}>No wines added yet.</div>
      )}
      <div className="wine-stack">
        {wines.map((wine, idx) => (
          <WineCard
            key={wine.id}
            wine={wine}
            index={idx}
            score={myRatings[wine.id]?.score}
            onClick={() => router.push(`/session/${code}/rate/${wine.id}?name=${encodeURIComponent(displayName)}`)}
          />
        ))}
      </div>
    </div></div>
  )
}
