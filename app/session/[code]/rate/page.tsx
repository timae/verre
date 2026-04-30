'use client'
import { useSession } from '@/components/session/SessionShell'
import { WineCard } from '@/components/wine/WineCard'
import { LineupLocked } from '@/components/session/LineupLocked'
import { useRouter } from 'next/navigation'

export default function RatePickerPage() {
  const { wines, myRatings, code, displayName, isHost, sessionMeta } = useSession()
  const router = useRouter()

  const m = sessionMeta as typeof sessionMeta & { hideLineup?: boolean; hideLineupMinutesBefore?: number; dateFrom?: string | null }
  const revealAt = m?.hideLineup && m.dateFrom
    ? new Date(new Date(m.dateFrom).getTime() - (m.hideLineupMinutesBefore || 0) * 60 * 1000)
    : null
  const lineupHidden = !isHost && !!revealAt && Date.now() < revealAt.getTime()

  return (
    <div style={{padding:'14px 14px 28px'}}><div style={{maxWidth:980,margin:'0 auto'}}>
      <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:12,marginBottom:16}}>
        <div className="subhead" style={{margin:0}}>
          <div className="subhead-title">Rate bottles</div>
          <div className="subhead-copy">{lineupHidden ? '??' : wines.length} bottle{lineupHidden ? 's' : wines.length !== 1 ? 's' : ''}</div>
        </div>
      </div>

      {lineupHidden && revealAt && <LineupLocked revealAt={revealAt} />}

      {!lineupHidden && wines.length === 0 && (
        <div style={{textAlign:'center',padding:'48px 0',color:'var(--fg-dim)',fontSize:13}}>No wines added yet.</div>
      )}
      {!lineupHidden && (
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
      )}
    </div></div>
  )
}
