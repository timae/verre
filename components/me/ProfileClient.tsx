'use client'
import { useQuery } from '@tanstack/react-query'
import { PolarChart } from '@/components/charts/PolarChart'
import { FL } from '@/lib/flavours'
import { authedFetch } from '@/lib/authedFetch'

type Profile = Record<string, number | string | null> & {
  total_rated?: number; avg_score?: string; five_star?: number
}

export function ProfileClient() {
  const { data: profile, isLoading } = useQuery<Profile>({
    queryKey: ['me-profile'],
    queryFn: () => authedFetch<Profile>('/api/me/profile'),
  })

  if (isLoading) return <p className="text-fg-dim text-sm">Loading…</p>

  const total = Number(profile?.total_rated || 0)
  if (!total) return (
    <p className="text-fg-dim text-sm py-8">No ratings yet. Your flavour profile will appear here once you rate wines while signed in.</p>
  )

  const flavors = FL.reduce((o, f) => ({ ...o, [f.k]: parseFloat(String(profile?.[f.k] || 0)) }), {} as Record<string, number>)
  const sorted = [...FL].sort((a, b) => (flavors[b.k] || 0) - (flavors[a.k] || 0))
  const topFlavors = sorted.slice(0, 3).filter(f => (flavors[f.k] || 0) > 0)

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Flavour profile</h1>

      <div className="bg-bg2 border border-border rounded-xl p-4 mb-4">
        <div className="flex gap-6 justify-center mb-4">
          {[
            { label: 'Wines rated', value: total },
            { label: 'Avg score', value: profile?.avg_score || '—' },
            { label: '5-star', value: profile?.five_star || 0 },
          ].map(({ label, value }) => (
            <div key={label} className="text-center">
              <p className="text-3xl font-extrabold text-accent">{String(value)}</p>
              <p className="text-xs text-fg-dim uppercase tracking-widest mt-1">{label}</p>
            </div>
          ))}
        </div>

        <div className="flex justify-center">
          <PolarChart flavors={flavors} fl={FL} size={300} />
        </div>

        {topFlavors.length > 0 && (
          <div className="mt-4">
            <p className="text-xs text-fg-dim uppercase tracking-widest mb-2">Top flavours</p>
            <div className="flex gap-2 flex-wrap">
              {topFlavors.map(f => (
                <span
                  key={f.k}
                  style={{ borderColor: f.c + '44', background: f.c + '18', color: f.c }}
                  className="text-xs font-bold px-3 py-1.5 rounded-full border"
                >
                  {f.l} {(flavors[f.k] || 0).toFixed(1)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
