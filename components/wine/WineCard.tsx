import type { WineMeta } from '@/lib/session'

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

interface Props {
  wine: WineMeta
  score?: number
  onClick?: () => void
}

export function WineCard({ wine, score, onClick }: Props) {
  const sub = [wine.producer, wine.vintage, wine.grape].filter(Boolean).join(' · ')

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-3.5 bg-white/[0.025] border border-white/5 rounded-xl text-left hover:bg-white/5 transition-colors active:scale-[0.99]"
    >
      {wine.imageUrl ? (
        <img src={wine.imageUrl} alt={wine.name} className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
      ) : (
        <div className="w-10 h-10 rounded-lg bg-bg3 flex items-center justify-center text-xl flex-shrink-0">
          {ICO[wine.type] || '🍷'}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="font-bold text-sm text-fg truncate">{wine.name}</p>
        {sub && <p className="text-xs text-fg-dim mt-0.5 truncate">{sub}</p>}
      </div>
      {score != null && score > 0 && (
        <div className="flex-shrink-0 text-right">
          <span className="text-xl font-extrabold text-accent">{score}</span>
          <span className="text-xs text-fg-dim">/5</span>
        </div>
      )}
    </button>
  )
}
