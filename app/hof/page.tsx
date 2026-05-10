import { WineIdentity } from '@/components/wine/WineIdentity'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

// SSR — read directly from Prisma instead of fetching our own API route.
// The previous version did `fetch(NEXTAUTH_URL/api/hof)` which depended
// on a public-URL env var that's not always set in dev/local, and
// added a needless network hop in prod. Direct DB access from a server
// component is the canonical Next.js App Router pattern.
export default async function HofPage() {
  const entries = await prisma.hallOfFame.findMany({
    orderBy: { ratedAt: 'desc' },
    take: 100,
    include: { user: { select: { name: true } } },
  })

  return (
    <div className="min-h-screen bg-[var(--bg)] p-4">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-extrabold text-accent mb-2">Hall of Fame</h1>
        <p className="text-fg-dim text-sm mb-6">Every wine awarded 5 stars</p>

        {!entries.length && (
          <p className="text-fg-dim">No 5-star wines yet. The first perfect score will land here.</p>
        )}

        <div className="space-y-3">
          {entries.map((e) => (
            <div key={e.id} className="bg-bg2 border border-border rounded-xl p-4 flex items-center gap-4">
              <span className="text-2xl">{ICO[e.style || ''] || '🍷'}</span>
              <div className="flex-1 min-w-0">
                <WineIdentity wine={{ name: e.wineName, vintage: e.vintage, producer: e.producer }} size="compact" />
                <p className="text-xs text-fg-faint mt-0.5">{e.user?.name || e.raterName} · {new Date(e.ratedAt).toLocaleDateString()}</p>
              </div>
              {/* Hardcoded `★ 5` not the formatScore-driven `★ 5.0` —
                  HoF's identity is "perfect score wall"; the .0 suffix
                  reads as a measurement not a celebration. */}
              <div className="text-2xl font-extrabold text-accent">★ 5</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
