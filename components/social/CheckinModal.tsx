'use client'
import { useState, useEffect } from 'react'
import { PolarChart } from '@/components/charts/PolarChart'
import { LocationPicker } from './LocationPicker'
import { getFL } from '@/lib/flavours'

const TYPES = [
  { k: 'red', l: 'Red', ico: '🍷' }, { k: 'white', l: 'White', ico: '🥂' },
  { k: 'spark', l: 'Bubbles', ico: '🍾' }, { k: 'rose', l: 'Rosé', ico: '🌸' },
  { k: 'nonalc', l: 'Non-alc', ico: '🌿' },
]

interface Props { onClose: () => void; onPosted: () => void }

export function CheckinModal({ onClose, onPosted }: Props) {
  const [wineName, setWineName] = useState('')
  const [producer, setProducer] = useState('')
  const [vintage, setVintage] = useState('')
  const [grape, setGrape] = useState('')
  const [type, setType] = useState('')
  const [score, setScore] = useState(0)
  const [flavors, setFlavors] = useState<Record<string, number>>({})
  const [notes, setNotes] = useState('')
  const [imageData, setImageData] = useState('')
  const [location, setLocation] = useState<{ venueName?: string; city?: string; country?: string; lat?: number; lng?: number }>({})
  const [isPublic, setIsPublic] = useState(true)
  const [showLocation, setShowLocation] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const fl = getFL(type || 'white')

  useEffect(() => {
    setFlavors(fl.reduce((o, f) => ({ ...o, [f.k]: 0 }), {}))
  }, [type])

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [onClose])

  async function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const img = new Image()
      img.onload = () => {
        const max = 1200, scale = Math.min(1, max / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = img.width * scale; canvas.height = img.height * scale
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
        setImageData(canvas.toDataURL('image/jpeg', 0.82))
      }
      img.src = ev.target?.result as string
    }
    reader.readAsDataURL(file)
  }

  async function submit() {
    if (!wineName.trim()) { setError('Wine name required'); return }
    setSaving(true); setError('')
    const res = await fetch('/api/checkins', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wineName, producer, vintage, grape, type, score: score || null, flavors, notes, imageData: imageData || undefined, isPublic, ...location }),
    })
    setSaving(false)
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed'); return }
    onPosted()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ width: '100%', maxWidth: 560, maxHeight: '92vh', overflowY: 'auto', background: 'var(--bg2)', borderRadius: '22px 22px 0 0', padding: 18, paddingBottom: 32 }}>
        <div className="sheet-bar" />
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', marginBottom: 16 }}>
          Check in a wine
        </div>

        {/* Photo */}
        <div style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--bg3)' }}>
          {imageData ? (
            <div style={{ position: 'relative' }}>
              <img src={imageData} alt="bottle" style={{ width: '100%', maxHeight: 120, objectFit: 'contain', borderRadius: 8 }} />
              <button className="btn-s" style={{ position: 'absolute', top: 6, right: 6 }} onClick={() => setImageData('')}>remove</button>
            </div>
          ) : (
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '8px 0' }}>
              <span style={{ fontSize: 22 }}>📷</span>
              <span style={{ fontSize: 10, color: 'var(--fg-dim)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>attach bottle photo</span>
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhoto} />
            </label>
          )}
        </div>

        {/* Wine details */}
        <div className="field"><div className="fl">wine name *</div><input className="fi" value={wineName} onChange={e => setWineName(e.target.value)} placeholder="Château de Whatever" /></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field" style={{ flex: 1 }}><div className="fl">producer</div><input className="fi" value={producer} onChange={e => setProducer(e.target.value)} placeholder="Domaine…" /></div>
          <div className="field" style={{ maxWidth: 88 }}><div className="fl">vintage</div><input className="fi" value={vintage} onChange={e => setVintage(e.target.value)} maxLength={4} placeholder="20XX" /></div>
        </div>

        {/* Type */}
        <div className="field">
          <div className="fl">type</div>
          <div className="chips">
            {TYPES.map(t => (
              <div key={t.k} className="chip" data-sel={type === t.k ? t.k : undefined} onClick={() => setType(t.k)}>
                <span>{t.ico}</span>{t.l}
              </div>
            ))}
          </div>
        </div>

        {/* Stars */}
        <div className="field">
          <div className="fl">score</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} type="button" onClick={() => setScore(n === score ? 0 : n)}
                style={{ fontSize: 24, background: 'none', border: 'none', cursor: 'pointer', color: n <= score ? 'var(--accent)' : 'var(--fg-faint)', lineHeight: 1 }}>★</button>
            ))}
          </div>
        </div>

        {/* Flavour chart + sliders (only if type selected) */}
        {type && (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 8px' }}>
              <PolarChart flavors={flavors} fl={fl} size={220} />
            </div>
            <div className="panel" style={{ marginBottom: 10 }}>
              {fl.map(f => {
                const v = flavors[f.k] || 0
                return (
                  <div key={f.k} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--fg-dim)', width: 72, flexShrink: 0, fontFamily: 'var(--mono)' }}>{f.l}</span>
                    <input type="range" min={0} max={5} step={1} value={v}
                      onChange={e => setFlavors(p => ({ ...p, [f.k]: Number(e.target.value) }))}
                      style={{ flex: 1, height: 4, appearance: 'none', borderRadius: 2, background: `linear-gradient(to right,${f.c} ${v * 20}%,var(--bg3) ${v * 20}%)` }} />
                    <span style={{ fontSize: 11, color: 'var(--fg)', width: 14, textAlign: 'right', fontFamily: 'var(--mono)' }}>{v}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* Notes */}
        <div className="field">
          <div className="fl">tasting notes</div>
          <textarea className="fi" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="aroma, palate, finish…" style={{ resize: 'none' }} />
        </div>

        {/* Location toggle */}
        <button type="button" className="btn-s" onClick={() => setShowLocation(!showLocation)} style={{ marginBottom: 10 }}>
          📍 {showLocation ? 'hide location' : 'add location'}
        </button>
        {showLocation && <LocationPicker value={location} onChange={setLocation} />}

        {/* Privacy */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', marginTop: 10, cursor: 'pointer' }}
          onClick={() => setIsPublic(!isPublic)}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700 }}>{isPublic ? '🌍 Public' : '🔒 Private'}</div>
            <div style={{ fontSize: 10, color: 'var(--fg-dim)', marginTop: 2 }}>{isPublic ? 'Visible in your feed and profile' : 'Only visible to you'}</div>
          </div>
          <div style={{ width: 36, height: 20, borderRadius: 10, background: isPublic ? 'var(--accent)' : 'var(--bg4)', border: '1px solid var(--border2)', position: 'relative', flexShrink: 0 }}>
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: isPublic ? 18 : 2, transition: 'left .2s' }} />
          </div>
        </div>

        {error && <p style={{ color: '#e07070', fontSize: 11, marginTop: 8 }}>{error}</p>}
        <button className="btn-p" onClick={submit} disabled={saving} style={{ marginTop: 14 }}>{saving ? 'posting…' : '→ post check-in'}</button>
        <button className="btn-g" onClick={onClose}>cancel</button>
      </div>
    </div>
  )
}
