'use client'
import { useSession } from '@/components/session/SessionShell'
import { WineCard } from '@/components/wine/WineCard'
import { useRouter, useParams } from 'next/navigation'

export default function RatePickerPage() {
  const { wines, myRatings, code, displayName } = useSession()
  const router = useRouter()

  return (
    <div className="p-4 max-w-screen-md mx-auto">
      <div className="mb-4">
        <p className="text-xs text-fg-dim uppercase tracking-widest mb-1">// Rate bottles</p>
        <h2 className="text-2xl font-bold text-fg">Select a wine to rate</h2>
      </div>
      {wines.length === 0 && (
        <p className="text-center py-16 text-fg-dim text-sm">No wines added yet.</p>
      )}
      <div className="flex flex-col gap-1">
        {wines.map(wine => (
          <WineCard
            key={wine.id}
            wine={wine}
            score={myRatings[wine.id]?.score}
            onClick={() => router.push(`/session/${code}/rate/${wine.id}?name=${encodeURIComponent(displayName)}`)}
          />
        ))}
      </div>
    </div>
  )
}
