'use client'
import { useState, useEffect, useRef } from 'react'
import { FlavorChips } from '@/components/rate/FlavorChips'
import { IntensityHelp } from '@/components/rate/IntensityHelp'
import { LocationPicker } from './LocationPicker'
import { useQuery } from '@tanstack/react-query'
import { resolveAxes, resolveAxesColoured, structureSubset } from '@/lib/flavours'
import { ConfirmDeleteButton } from '@/components/ui/ConfirmDeleteButton'
import { Modal } from '@/components/ui/Modal'
import { ScoreSlider } from '@/components/ui/ScoreSlider'

const TYPES = [
  { k: 'red', l: 'Red', ico: '🍷' }, { k: 'white', l: 'White', ico: '🥂' },
  { k: 'spark', l: 'Bubbles', ico: '🍾' }, { k: 'rose', l: 'Rosé', ico: '🌸' },
  { k: 'nonalc', l: 'Non-alc', ico: '🌿' },
]

type EditCheckin = {
  id: number; wineName: string; producer?: string|null; vintage?: string|null
  grape?: string|null; type?: string|null; score?: number|null; flavors?: Record<string,number>|null
  notes?: string|null; imageUrl?: string|null; venueName?: string|null; city?: string|null
  country?: string|null; lat?: number|null; lng?: number|null
  tags?: { id: number; name: string }[]
}

export type CopySource = {
  id: number
  wineName: string; producer?: string|null; vintage?: string|null
  grape?: string|null; type?: string|null
  imageUrl?: string|null
  venueName?: string|null; city?: string|null; country?: string|null
  author: { id: number; name: string }
  // True when the viewer was tagged on the source — implies they were there,
  // so the modal auto-fills the venue group on mount.
  taggedViewer?: boolean
}

interface Props {
  onClose: () => void
  onPosted: () => void
  editCheckin?: EditCheckin
  copyFromCheckin?: CopySource
  onDelete?: () => void
}

export function CheckinModal({ onClose, onPosted, editCheckin, copyFromCheckin, onDelete }: Props) {
  const isEdit = !!editCheckin
  const isCopy = !isEdit && !!copyFromCheckin
  const prefill = editCheckin || (isCopy ? copyFromCheckin : null)
  const [wineName, setWineName] = useState(prefill?.wineName || '')
  const [producer, setProducer] = useState(prefill?.producer || '')
  const [vintage, setVintage] = useState(prefill?.vintage || '')
  const [grape, setGrape] = useState(prefill?.grape || '')
  const [type, setType] = useState(prefill?.type || '')
  const [score, setScore] = useState(editCheckin?.score || 0)
  const [flavors, setFlavors] = useState<Record<string, number>>(
    (editCheckin?.flavors as Record<string,number>) || {}
  )
  const [notes, setNotes] = useState(editCheckin?.notes || '')
  const [imageData, setImageData] = useState('')
  const [existingImageUrl] = useState(editCheckin?.imageUrl || copyFromCheckin?.imageUrl || '')
  const [location, setLocation] = useState<{ venueName?: string; city?: string; country?: string; lat?: number; lng?: number }>({
    venueName: editCheckin?.venueName || undefined,
    city: editCheckin?.city || undefined,
    country: editCheckin?.country || undefined,
    lat: editCheckin?.lat || undefined,
    lng: editCheckin?.lng || undefined,
  })
  const [showLocation, setShowLocation] = useState(false)
  // Bump to force-remount LocationPicker — its internal query state is seeded
  // from props on mount, so wholesale replacements (copy-from-original) need
  // a fresh instance to keep the input field in sync.
  const [locationVersion, setLocationVersion] = useState(0)
  const [showTagPicker, setShowTagPicker] = useState(false)
  const [taggedIds, setTaggedIds] = useState<number[]>(editCheckin?.tags?.map(t => t.id) ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Input chips = the STRUCTURE axis set for this style (§6d input surface).
  const fl = resolveAxesColoured('wine', type || 'white')
  const { data: friends = [] } = useQuery<{ id: number; name: string }[]>({ queryKey: ['friends'], queryFn: () => fetch('/api/me/friends').then(r => r.json()) })

  const sourceAuthorId = copyFromCheckin?.author.id
  const autoTagPrimed = useRef(false)
  useEffect(() => {
    if (!isCopy || autoTagPrimed.current || !sourceAuthorId) return
    if (friends.some(f => f.id === sourceAuthorId)) {
      setTaggedIds(prev => prev.includes(sourceAuthorId) ? prev : [...prev, sourceAuthorId])
      autoTagPrimed.current = true
    }
  }, [friends, isCopy, sourceAuthorId])

  // If the viewer was tagged on the source, they were there — auto-fill the
  // venue group rather than making them click "copy from original".
  useEffect(() => {
    if (!isCopy || !copyFromCheckin?.taggedViewer || !copyFromCheckin.venueName) return
    setLocation({
      venueName: copyFromCheckin.venueName || undefined,
      city: copyFromCheckin.city || undefined,
      country: copyFromCheckin.country || undefined,
    })
    setShowLocation(true)
    setLocationVersion(v => v + 1)
    // Run once on mount with the copy source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Type-change flavor reset lives in the chip's onClick. An effect on
  // [type] would also fire on mount, and StrictMode's double-invoke
  // wipes the initial flavors of an edited check-in.

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
    // Send the source id when the user kept the source image — server resolves
    // and authorizes the row, then CopyObjects the bytes. Replacement/remove
    // paths fall through to the normal imageData branch.
    const copyFromCheckinId = isCopy && !imageData && existingImageUrl ? copyFromCheckin!.id : undefined
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wineName, producer, vintage, grape, type,
        // Edit-path transform (§6g): strip a loaded legacy row to the structure
        // subset so the registry-keyed write gate doesn't 400 a no-touch re-save.
        score: score || null, flavors: structureSubset(flavors, 'wine', type), notes,
        imageData: imageData === '__remove__' ? null : (imageData || undefined),
        copyFromCheckinId,
        ...location,
        taggedUserIds: taggedIds,
      }),
    })
    setSaving(false)
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed'); return }
    onPosted()
  }

  return (
    <Modal onClose={onClose} maxWidth={560} minHeight="min(70vh, 600px)" maxHeight="90vh">
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
            {isEdit ? 'Edit check-in' : isCopy ? 'Had a sip' : 'Check in a wine'}
          </div>
          <button className="btn-s" onClick={onClose} style={{fontSize:9}}>close</button>
        </div>
        {isCopy && copyFromCheckin && (
          <p style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: -10, marginBottom: 14 }}>
            Wine details copied from {copyFromCheckin.author.name}&rsquo;s check-in. Add your own rating, flavours, and notes.
          </p>
        )}

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
                attach bottle photo
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
        <div className="field"><div className="fl">grape / style</div><input className="fi" value={grape} onChange={e => setGrape(e.target.value)} placeholder="Pinot Noir, Pét-Nat…" /></div>

        {/* Type */}
        <div className="field">
          <div className="fl">type</div>
          <div className="chips">
            {TYPES.map(t => (
              <div key={t.k} className="chip" data-sel={type === t.k ? t.k : undefined} onClick={() => {
                if (t.k === type) return
                setType(t.k)
                setFlavors(resolveAxes('wine', t.k).reduce((o, f) => ({ ...o, [f.k]: 0 }), {}))
              }}>
                <span>{t.ico}</span>{t.l}
              </div>
            ))}
          </div>
        </div>

        {/* Score slider — drag or tap, snaps to 0.25.
            Wrapped in a panel so the visual width matches the rest of
            the form (the inputs above/below sit inside `field` blocks,
            but a slider full-width inside a `field` looked stretched). */}
        <div className="panel">
          <div className="panel-hdr">score</div>
          <ScoreSlider value={score} onChange={setScore} />
        </div>

        {/* Flavour chips (only if type selected) */}
        {type && (
          <div className="panel" style={{ marginBottom: 10 }}>
            <div className="panel-hdr">flavour profile</div>
            <IntensityHelp />
            <FlavorChips flavors={flavors} fl={fl} onChange={setFlavors} />
          </div>
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn-s" onClick={() => setShowLocation(!showLocation)}>
            📍 {showLocation ? 'hide location' : 'add location'}
          </button>
          {isCopy && copyFromCheckin?.venueName && (
            <button type="button" className="btn-s"
              onClick={() => {
                setLocation({
                  venueName: copyFromCheckin.venueName || undefined,
                  city: copyFromCheckin.city || undefined,
                  country: copyFromCheckin.country || undefined,
                })
                setShowLocation(true)
                setLocationVersion(v => v + 1)
              }}>
              copy from original
            </button>
          )}
        </div>
        {showLocation && <LocationPicker key={locationVersion} value={location} onChange={setLocation} />}

        {error && <p style={{ color: 'var(--danger)', fontSize: 11, marginTop: 8 }}>{error}</p>}
        <button className="btn-p" onClick={submit} disabled={saving} style={{ marginTop: 14 }}>{saving ? (isEdit ? 'saving…' : 'posting…') : (isEdit ? '→ save changes' : '→ post check-in')}</button>
        <button className="btn-g" onClick={onClose}>cancel</button>
        {isEdit && onDelete && (
          <ConfirmDeleteButton
            label="⌫ delete check-in"
            confirmLabel="tap again to delete"
            onConfirm={onDelete}
          />
        )}
    </Modal>
  )
}
