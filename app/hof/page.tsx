import { WineIdentity } from '@/components/wine/WineIdentity'

export const dynamic = 'force-dynamic'

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

export default async function HofPage() {
  const res = await fetch(`${process.env.NEXTAUTH_URL || 'http://localhost:8080'}/api/hof`, { cache: 'no-store' })
  const entries = res.ok ? await res.json() : []

  return (
    <div className="min-h-screen bg-[var(--bg)] p-4">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-extrabold text-accent mb-2">Hall of Fame</h1>
        <p className="text-fg-dim text-sm mb-6">Every wine awarded 5 stars</p>

        {!entries.length && (
          <p className="text-fg-dim">No 5-star wines yet. The first perfect score will land here.</p>
        )}

        <div className="space-y-3">
          {entries.map((e: { wineName: string; producer?: string; vintage?: string; type?: string; rater: string; accountName?: string; at: string }, i: number) => (
            <div key={i} className="bg-bg2 border border-border rounded-xl p-4 flex items-center gap-4">
              <span className="text-2xl">{ICO[e.type || ''] || '🍷'}</span>
              <div className="flex-1 min-w-0">
                <WineIdentity wine={{ name: e.wineName, vintage: e.vintage, producer: e.producer }} size="compact" />
                <p className="text-xs text-fg-faint mt-0.5">{e.accountName || e.rater} · {new Date(e.at).toLocaleDateString()}</p>
              </div>
              <div className="text-2xl font-extrabold text-accent">★5</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
