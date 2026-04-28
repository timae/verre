'use client'
import { useSession } from '@/components/session/SessionShell'
import { PolarChart } from '@/components/charts/PolarChart'
import { getFL, detectFL } from '@/lib/flavours'

export default function ComparePage() {
  const { wines, allRatings, displayName } = useSession()

  const ratedWines = wines.filter(w =>
    Object.values(allRatings).some(u => u[w.id]?.score)
  )

  if (ratedWines.length === 0) {
    return (
      <div className="p-4 text-center py-16 text-fg-dim text-sm">
        No ratings yet. Rate some wines to compare.
      </div>
    )
  }

  return (
    <div className="p-4 max-w-screen-md mx-auto">
      <div className="mb-4">
        <p className="text-xs text-fg-dim uppercase tracking-widest mb-1">// Compare</p>
        <h2 className="text-2xl font-bold text-fg">Tasting comparison</h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {ratedWines.map(wine => {
          const raters = Object.entries(allRatings)
            .filter(([, u]) => u[wine.id])
            .map(([user, u]) => ({ user, ...u[wine.id] }))

          const myRating = allRatings[displayName]?.[wine.id]
          const fl = myRating?.flavors
            ? detectFL(myRating.flavors as Record<string, number>)
            : getFL(wine.type)

          const avgScore = raters.length
            ? (raters.reduce((s, r) => s + (r.score || 0), 0) / raters.length).toFixed(1)
            : '—'

          return (
            <div key={wine.id} className="bg-bg2 border border-border rounded-xl p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="min-w-0">
                  <p className="font-bold text-sm">{wine.name}</p>
                  <p className="text-xs text-fg-dim mt-0.5">{[wine.producer, wine.vintage].filter(Boolean).join(' · ')}</p>
                </div>
                <div className="text-right flex-shrink-0 ml-2">
                  <span className="text-2xl font-extrabold text-accent">{avgScore}</span>
                  <span className="text-xs text-fg-dim block">avg</span>
                </div>
              </div>

              {myRating && (
                <div className="flex justify-center mb-2">
                  <PolarChart
                    flavors={(myRating.flavors || {}) as Record<string, number>}
                    fl={fl}
                    size={200}
                  />
                </div>
              )}

              <div className="flex flex-wrap gap-1">
                {raters.map(r => (
                  <span key={r.user} className="text-xs bg-bg3 border border-border px-2 py-0.5 rounded-full text-fg-dim">
                    {r.user} {r.score}★
                  </span>
                ))}
              </div>

              {myRating?.notes && (
                <p className="text-xs text-fg-dim mt-2 italic">&ldquo;{myRating.notes}&rdquo;</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
