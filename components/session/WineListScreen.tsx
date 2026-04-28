'use client'
import { useSession } from './SessionShell'
import { WineCard } from '@/components/wine/WineCard'
import { AddWineModal } from '@/components/wine/AddWineModal'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function WineListScreen() {
  const { wines, myRatings, isHost, code, displayName, refresh } = useSession()
  const [showAdd, setShowAdd] = useState(false)
  const router = useRouter()

  return (
    <div style={{padding:'14px 14px 28px'}}>
      <div style={{maxWidth:980,margin:'0 auto'}}>
        <div className="subhead">
          <div className="subhead-title">Wine list</div>
          <div className="subhead-copy">{wines.length} bottle{wines.length !== 1 ? 's' : ''} in this session</div>
        </div>

        {wines.length === 0 && (
          <div style={{textAlign:'center',padding:'48px 0',color:'var(--fg-dim)',fontSize:13}}>
            {isHost ? 'Add the first wine to get started.' : 'Waiting for the host to add wines.'}
          </div>
        )}

        <div className="wine-stack">
          {wines.map(wine => (
            <WineCard
              key={wine.id}
              wine={wine}
              score={myRatings[wine.id]?.score}
              onClick={() => router.push(`/session/${code}/rate/${wine.id}?name=${encodeURIComponent(displayName)}`)}
            />
          ))}
        </div>

        {isHost && (
          <button
            className="btn-g"
            onClick={() => setShowAdd(true)}
            style={{marginTop:14,display:'block'}}
          >
            + add wine to session
          </button>
        )}

        {showAdd && (
          <AddWineModal
            code={code} userName={displayName}
            onClose={() => setShowAdd(false)}
            onSaved={() => { setShowAdd(false); refresh() }}
          />
        )}
      </div>
    </div>
  )
}
