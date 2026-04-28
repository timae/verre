'use client'
import { useSession } from './SessionShell'
import { WineCard } from '@/components/wine/WineCard'
import { AddWineModal } from '@/components/wine/AddWineModal'
import { useState } from 'react'
import { useRouter, useParams } from 'next/navigation'

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }
const LBL: Record<string, string> = { red: 'Red', white: 'White', spark: 'Sparkling', rose: 'Rosé', nonalc: 'Non-Alc' }

export function WineListScreen() {
  const { wines, myRatings, isHost, code, displayName, refresh } = useSession()
  const [showAdd, setShowAdd] = useState(false)
  const router = useRouter()

  return (
    <div className="p-4 max-w-screen-md mx-auto">
      <div className="flex items-end justify-between mb-4">
        <div>
          <p className="text-xs text-fg-dim uppercase tracking-widest mb-1">// Wine list</p>
          <h2 className="text-2xl font-bold text-fg">{wines.length} bottle{wines.length !== 1 ? 's' : ''}</h2>
        </div>
        {isHost && (
          <button
            onClick={() => setShowAdd(true)}
            className="bg-bg3 border border-border text-fg text-sm font-bold px-4 py-2 rounded-xl hover:border-accent transition-colors"
          >
            + Add wine
          </button>
        )}
      </div>

      {wines.length === 0 && (
        <div className="text-center py-16 text-fg-dim text-sm">
          {isHost ? 'Add the first wine to get started.' : 'Waiting for the host to add wines.'}
        </div>
      )}

      <div className="flex flex-col gap-1">
        {wines.map(wine => {
          const rating = myRatings[wine.id]
          return (
            <WineCard
              key={wine.id}
              wine={wine}
              score={rating?.score}
              onClick={() => router.push(`/session/${code}/rate/${wine.id}?name=${encodeURIComponent(displayName)}`)}
            />
          )
        })}
      </div>

      {showAdd && (
        <AddWineModal
          code={code}
          userName={displayName}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); refresh() }}
        />
      )}
    </div>
  )
}
