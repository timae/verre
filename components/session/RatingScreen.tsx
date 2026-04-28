'use client'
import { use, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from './SessionShell'
import { PolarChart } from '@/components/charts/PolarChart'
import { getFL, detectFL } from '@/lib/flavours'

interface Props { params: Promise<{ code: string; wineId: string }> }

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

export function RatingScreen({ params }: Props) {
  const { wineId } = use(params)
  const { wines, myRatings, code, displayName, refresh, isHost } = useSession()
  const router = useRouter()

  const wine = wines.find(w => w.id === wineId)
  const existing = myRatings[wineId]

  const fl = existing?.flavors && Object.keys(existing.flavors).length
    ? detectFL(existing.flavors as Record<string, number>)
    : wine ? getFL(wine.type) : getFL('white')

  const [score, setScore] = useState(existing?.score || 0)
  const [flavors, setFlavors] = useState<Record<string, number>>(() => {
    const base = fl.reduce((o, f) => ({ ...o, [f.k]: 0 }), {} as Record<string, number>)
    if (existing?.flavors) Object.assign(base, existing.flavors)
    return base
  })
  const [notes, setNotes] = useState(existing?.notes || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (existing) {
      setScore(existing.score || 0)
      setNotes(existing.notes || '')
      const base = fl.reduce((o, f) => ({ ...o, [f.k]: 0 }), {} as Record<string, number>)
      if (existing.flavors) Object.assign(base, existing.flavors as Record<string, number>)
      setFlavors(base)
    }
  }, [wineId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!wine) return <div className="p-4 text-fg-dim">Wine not found.</div>

  async function save() {
    setSaving(true)
    await fetch(`/api/session/${code}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName, wineId, score, flavors, notes }),
    })
    setSaving(false)
    refresh()
    router.back()
  }

  async function resetRating() {
    if (!confirm('Reset your rating?')) return
    await fetch(`/api/session/${code}/rate/${wineId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName }),
    })
    refresh()
    router.back()
  }

  async function deleteWine() {
    if (!confirm(`Delete "${wine!.name}"? This removes it for everyone.`)) return
    await fetch(`/api/session/${code}/wines/${wineId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: displayName }),
    })
    refresh()
    router.back()
  }

  return (
    <div className="p-4 max-w-screen-sm mx-auto pb-8">
      {/* Back + title */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => router.back()} className="text-fg-dim text-sm">← back</button>
        <div className="min-w-0">
          <p className="font-bold text-fg truncate">{wine.name}</p>
          <p className="text-xs text-fg-dim">{[wine.producer, wine.vintage, wine.grape].filter(Boolean).join(' · ')}</p>
        </div>
        <span className="text-2xl flex-shrink-0">{ICO[wine.type] || '🍷'}</span>
      </div>

      {wine.imageUrl && (
        <img src={wine.imageUrl} alt={wine.name} className="w-full h-40 object-cover rounded-xl mb-4" />
      )}

      {/* Stars */}
      <div className="bg-bg2 border border-border rounded-xl p-4 mb-3">
        <p className="text-xs text-fg-dim uppercase tracking-widest mb-3">// Overall score</p>
        <div className="flex justify-center gap-3">
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} onClick={() => setScore(n === score ? 0 : n)} className="text-3xl transition-transform active:scale-90">
              <span className={n <= score ? 'text-accent' : 'text-fg-faint'}>★</span>
            </button>
          ))}
        </div>
      </div>

      {/* Polar chart */}
      <div className="bg-bg2 border border-border rounded-xl p-4 mb-3 flex flex-col items-center">
        <p className="text-xs text-fg-dim uppercase tracking-widest mb-2 self-start">// Flavour profile</p>
        <PolarChart flavors={flavors} fl={fl} size={280} />
      </div>

      {/* Sliders */}
      <div className="bg-bg2 border border-border rounded-xl p-4 mb-3 space-y-3">
        {fl.map(f => {
          const v = flavors[f.k] || 0
          return (
            <div key={f.k} className="flex items-center gap-3">
              <span className="text-xs text-fg-dim w-20 flex-shrink-0">{f.l}</span>
              <input
                type="range" min={0} max={5} step={1} value={v}
                onChange={e => {
                  const val = Number(e.target.value)
                  setFlavors(prev => ({ ...prev, [f.k]: val }))
                }}
                className="flex-1 h-1.5 appearance-none rounded-full cursor-pointer"
                style={{ background: `linear-gradient(to right, ${f.c} ${v * 20}%, var(--bg3) ${v * 20}%)` }}
              />
              <span className="text-xs text-fg w-4 text-right">{v}</span>
            </div>
          )
        })}
      </div>

      {/* Notes */}
      <div className="bg-bg2 border border-border rounded-xl p-4 mb-4">
        <p className="text-xs text-fg-dim uppercase tracking-widest mb-2">// Tasting notes</p>
        <textarea
          value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="aroma, palate, finish…"
          rows={3}
          className="w-full bg-transparent text-sm text-fg resize-none focus:outline-none placeholder:text-fg-faint"
        />
      </div>

      {/* Actions */}
      <button onClick={save} disabled={saving}
        className="w-full bg-accent text-bg font-bold py-3 rounded-xl text-sm mb-2 disabled:opacity-50">
        {saving ? 'Saving…' : '→ Commit rating'}
      </button>
      <button onClick={() => router.back()}
        className="w-full bg-bg3 border border-border text-fg-dim font-bold py-2.5 rounded-xl text-sm mb-2">
        Cancel
      </button>
      {existing && (
        <button onClick={resetRating}
          className="w-full bg-bg3 border border-border text-fg-dim font-bold py-2.5 rounded-xl text-sm mb-2">
          ⌫ Reset my rating
        </button>
      )}
      {isHost && (
        <button onClick={deleteWine}
          className="w-full border border-red-900/40 text-red-400/60 font-bold py-2.5 rounded-xl text-xs mt-2">
          ⌫ Delete this wine
        </button>
      )}
    </div>
  )
}
