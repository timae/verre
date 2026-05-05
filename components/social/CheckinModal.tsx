'use client'
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { PolarChart } from '@/components/charts/PolarChart'
import { CHART_SIZE } from '@/components/charts/sizes'
import { LocationPicker } from './LocationPicker'
import { useQuery } from '@tanstack/react-query'
import { getFL } from '@/lib/flavours'
import { ConfirmDeleteButton } from '@/components/ui/ConfirmDeleteButton'

const TYPES = [
  { k: 'red', l: 'Red', ico: '🍷' }, { k: 'white', l: 'White', ico: '🥂' },
  { k: 'spark', l: 'Bubbles', ico: '🍾' }, { k: 'rose', l: 'Rosé', ico: '🌸' },
  { k: 'nonalc', l: 'Non-alc', ico: '🌿' },
]

type EditCheckin = {
  id: number; wineName: string; producer?: string|null; vintage?: string|null
  grape?: string|null; type?: string|null; score?: number|null; flavors?: Record<string,number>|null
  notes?: string|null; imageUrl?: string|null; venueName?: string|null; city?: string|null
  country?: string|null; lat?: number|null; lng?: number|null; isPublic?: boolean
}

interface Props { onClose: () => void; onPosted: () => void; editCheckin?: EditCheckin; onDelete?: () => void }

export function CheckinModal({ onClose, onPosted, editCheckin, onDelete }: Props) {
  const isEdit = !!editCheckin
  const [wineName, setWineName] = useState(editCheckin?.wineName || '')
  const [producer, setProducer] = useState(editCheckin?.producer || '')
  const [vintage, setVintage] = useState(editCheckin?.vintage || '')
  const [grape, setGrape] = useState(editCheckin?.grape || '')
  const [type, setType] = useState(editCheckin?.type || '')
  const [score, setScore] = useState(editCheckin?.score || 0)
  const [flavors, setFlavors] = useState<Record<string, number>>(
    (editCheckin?.flavors as Record<string,number>) || {}
  )
  const [notes, setNotes] = useState(editCheckin?.notes || '')
  const [imageData, setImageData] = useState('')
  const [existingImageUrl] = useState(editCheckin?.imageUrl || '')
  const [location, setLocation] = useState<{ venueName?: string; city?: string; country?: string; lat?: number; lng?: number }>({
    venueName: editCheckin?.venueName || undefined,
    city: editCheckin?.city || undefined,
    country: editCheckin?.country || undefined,
    lat: editCheckin?.lat || undefined,
    lng: editCheckin?.lng || undefined,
  })
  const [isPublic, setIsPublic] = useState(editCheckin?.isPublic !== false)
  const [showLocation, setShowLocation] = useState(false)
  const [showTagPicker, setShowTagPicker] = useState(false)
  const [taggedIds, setTaggedIds] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const fl = getFL(type || 'white')
  const { data: friends = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ['friends'], queryFn: () => fetch('/api/me/friends').then(r => r.json()) })

  // Reset flavors when the user picks a different type (the dimensions change).
  // Skip the very first run so editing a check-in keeps its stored flavors.
  const firstTypeChange = useRef(true)
  useEffect(() => {
    if (firstTypeChange.current) { firstTypeChange.current = false; return }
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
    const url = isEdit ? `/api/checkins/${editCheckin!.id}` : '/api/checkins'
    const method = isEdit ? 'PATCH' : 'POST'
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wineName, producer, vintage, grape, type,
        score: score || null, flavors, notes,
        imageData: imageData === '__remove__' ? null : (imageData || undefined),
        isPublic, ...location,
        ...(isEdit ? {} : { taggedUserIds: taggedIds }),
      }),
    })
    setSaving(false)
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed'); return }
    onPosted()
  }

  // Render via a portal on document.body so the fixed-position overlay is
  // never trapped inside a parent stacking context. Several ancestor styles
  // in this app (notably `.panel` with backdrop-filter) create a containing
  // block for fixed descendants — without the portal the modal renders
  // inside the card it was opened from instead of covering the viewport.
  if (typeof document === 'undefined') return null
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', overflowY: 'auto' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ width: '100%', maxWidth: 560, minHeight: 'min(70vh, 600px)', background: 'var(--bg2)', borderRadius: '22px 22px 0 0', padding: 18, paddingBottom: 32, marginTop: 'auto' }}>
        <div className="sheet-bar" />
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', marginBottom: 16 }}>
          {isEdit ? 'Edit check-in' : 'Check in a wine'}
        </div>

        {/* Photo */}
        <div style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--bg3)' }}>
          {imageData || existingImageUrl ? (
            <div style={{ position: 'relative' }}>
              <img src={imageData || existingImageUrl} alt="bottle" style={{ width: '100%', maxHeight: 120, objectFit: 'contain', borderRadius: 8 }} />
              <button className="btn-s" style={{ position: 'absolute', top: 6, right: 6 }} onClick={() => setImageData('__remove__')}>remove</button>
            </div>
          ) : (
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '8px 0' }}>
              <span style={{ fontSize: 22 }}>📷</span>
              <span style={{ fontSize: 10, color: 'var(--fg-dim)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {isEdit ? 'replace photo' : 'attach bottle photo'}
              </span>
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhoto} />
            </label>
          )}
        </div>

        {/* Wine details */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field" style={{ flex: 1 }}><div className="fl">wine name *</div><input className="fi" value={wineName} onChange={e => setWineName(e.target.value)} placeholder="Château de Whatever" /></div>
          <div className="field" style={{ maxWidth: 88 }}><div className="fl">vintage</div><input className="fi" value={vintage} onChange={e => setVintage(e.target.value)} maxLength={4} placeholder="20XX" /></div>
        </div>
        <div className="field"><div className="fl">producer</div><input className="fi" value={producer} onChange={e => setProducer(e.target.value)} placeholder="Domaine…" /></div>

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
              <PolarChart flavors={flavors} fl={fl} size={CHART_SIZE.EMBED} />
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

        {/* Tag friends */}
        {friends.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <button type="button" className="btn-s" onClick={() => setShowTagPicker(!showTagPicker)}>
              👥 {taggedIds.length > 0 ? `with ${taggedIds.length} friend${taggedIds.length > 1 ? 's' : ''}` : 'tag friends'}
            </button>
            {showTagPicker && (
              <div style={{ marginTop: 8, padding: '10px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 10 }}>
                <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-dim)', marginBottom: 8 }}>mutual follows</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {friends.map(f => {
                    const selected = taggedIds.includes(f.id)
                    return (
                      <button key={f.id} type="button"
                        onClick={() => setTaggedIds(prev => selected ? prev.filter(id => id !== f.id) : [...prev, f.id])}
                        style={{ padding: '5px 10px', borderRadius: 999, border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, background: selected ? 'rgba(200,150,60,0.1)' : 'var(--bg)', color: selected ? 'var(--accent)' : 'var(--fg-dim)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--mono)' }}>
                        {selected ? '✓ ' : ''}{f.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

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
        <button className="btn-p" onClick={submit} disabled={saving} style={{ marginTop: 14 }}>{saving ? (isEdit ? 'saving…' : 'posting…') : (isEdit ? '→ save changes' : '→ post check-in')}</button>
        <button className="btn-g" onClick={onClose}>cancel</button>
        {isEdit && onDelete && (
          <ConfirmDeleteButton
            label="⌫ delete check-in"
            confirmLabel="tap again to delete"
            onConfirm={onDelete}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}
