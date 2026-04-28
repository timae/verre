'use client'
import { useState } from 'react'

const TYPES = [
  { k: 'red', l: 'Red', ico: '🍷' },
  { k: 'white', l: 'White', ico: '🥂' },
  { k: 'spark', l: 'Bubbles', ico: '🍾' },
  { k: 'rose', l: 'Rosé', ico: '🌸' },
  { k: 'nonalc', l: 'Non-alc', ico: '🌿' },
]

interface Props {
  code: string
  userName: string
  onClose: () => void
  onSaved: () => void
}

export function AddWineModal({ code, userName, onClose, onSaved }: Props) {
  const [name, setName] = useState('')
  const [producer, setProducer] = useState('')
  const [vintage, setVintage] = useState('')
  const [grape, setGrape] = useState('')
  const [type, setType] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    if (!name.trim()) { setError('Name required'); return }
    if (!type) { setError('Select a type'); return }
    setSaving(true); setError('')
    const res = await fetch(`/api/session/${code}/wines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, producer, vintage, grape, type, userName }),
    })
    setSaving(false)
    if (!res.ok) { setError('Could not save wine'); return }
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-lg bg-bg2 border border-border2 rounded-card p-5 space-y-4">
        <h3 className="font-bold text-lg">Add wine</h3>

        <div>
          <label className="text-xs text-fg-dim uppercase tracking-widest mb-1 block">Name *</label>
          <input value={name} onChange={e => setName(e.target.value)}
            className="w-full bg-bg3 border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-accent"
            placeholder="Château de Whatever, 2019" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-fg-dim uppercase tracking-widest mb-1 block">Producer</label>
            <input value={producer} onChange={e => setProducer(e.target.value)}
              className="w-full bg-bg3 border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-accent"
              placeholder="Domaine…" />
          </div>
          <div>
            <label className="text-xs text-fg-dim uppercase tracking-widest mb-1 block">Vintage</label>
            <input value={vintage} onChange={e => setVintage(e.target.value)} maxLength={4}
              className="w-full bg-bg3 border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-accent"
              placeholder="20XX" />
          </div>
        </div>

        <div>
          <label className="text-xs text-fg-dim uppercase tracking-widest mb-1 block">Type *</label>
          <div className="flex gap-2 flex-wrap">
            {TYPES.map(t => (
              <button
                key={t.k} onClick={() => setType(t.k)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors
                  ${type === t.k ? 'border-accent bg-accent/15 text-accent' : 'border-border text-fg-dim hover:border-border2'}`}
              >
                {t.ico} {t.l}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-fg-dim uppercase tracking-widest mb-1 block">Grape / Style</label>
          <input value={grape} onChange={e => setGrape(e.target.value)}
            className="w-full bg-bg3 border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-accent"
            placeholder="Pinot Noir, Pét-Nat…" />
        </div>

        {error && <p className="text-red-400 text-xs">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button onClick={save} disabled={saving}
            className="flex-1 bg-accent text-bg font-bold py-2.5 rounded-lg text-sm disabled:opacity-50">
            {saving ? 'Saving…' : '→ Add to session'}
          </button>
          <button onClick={onClose}
            className="flex-1 bg-bg3 border border-border text-fg-dim font-bold py-2.5 rounded-lg text-sm">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
