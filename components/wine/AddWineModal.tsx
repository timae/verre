'use client'
import { useState, useEffect } from 'react'

const TYPES = [
  { k: 'red', l: 'Red', ico: '🍷' },
  { k: 'white', l: 'White', ico: '🥂' },
  { k: 'spark', l: 'Bubbles', ico: '🍾' },
  { k: 'rose', l: 'Rosé', ico: '🌸' },
  { k: 'nonalc', l: 'Non-alc', ico: '🌿' },
]

interface Props { code: string; userName: string; onClose: () => void; onSaved: () => void }

export function AddWineModal({ code, userName, onClose, onSaved }: Props) {
  const [name, setName] = useState('')
  const [producer, setProducer] = useState('')
  const [vintage, setVintage] = useState('')
  const [grape, setGrape] = useState('')
  const [type, setType] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [photoDataUrl, setPhotoDataUrl] = useState('')

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [onClose])

  async function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      // Resize to max 1200px via canvas
      const img = new Image()
      img.onload = () => {
        const max = 1200
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = img.width * scale; canvas.height = img.height * scale
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
        setPhotoDataUrl(canvas.toDataURL('image/jpeg', 0.82))
      }
      img.src = ev.target?.result as string
    }
    reader.readAsDataURL(file)
  }

  async function save() {
    if (!name.trim()) { setError('Name required'); return }
    if (!type) { setError('Select a type'); return }
    setSaving(true); setError('')
    const res = await fetch(`/api/session/${code}/wines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, producer, vintage, grape, type, userName, ...(photoDataUrl ? { image: photoDataUrl } : {}) }),
    })
    setSaving(false)
    if (!res.ok) { setError('Could not save wine'); return }
    onSaved()
  }

  return (
    <div
      style={{position:'fixed',inset:0,zIndex:50,display:'flex',alignItems:'flex-end',justifyContent:'center',background:'rgba(0,0,0,0.6)',backdropFilter:'blur(4px)',padding:0}}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{width:'100%',maxWidth:600,background:'var(--bg2)',borderRadius:'22px 22px 0 0',padding:18,paddingBottom:32}}>
        <div className="sheet-bar" />
        <div style={{fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.04em',marginBottom:18}}>
          Add wine <span style={{fontSize:9,border:'1px solid var(--border2)',padding:'1px 6px',borderRadius:2,color:'var(--fg-dim)',letterSpacing:'0.08em',textTransform:'uppercase',marginLeft:4}}>shared</span>
        </div>

        {/* Photo */}
        <div style={{marginBottom:14,border:'1px solid var(--border)',borderRadius:12,padding:12,background:'var(--bg3)'}}>
          {photoDataUrl ? (
            <div style={{position:'relative'}}>
              <img src={photoDataUrl} alt="bottle" style={{width:'100%',maxHeight:140,objectFit:'contain',borderRadius:8}} />
              <button className="btn-s" style={{position:'absolute',top:6,right:6}} onClick={() => setPhotoDataUrl('')}>remove</button>
            </div>
          ) : (
            <label style={{display:'flex',flexDirection:'column',alignItems:'center',gap:8,cursor:'pointer',padding:'12px 0'}}>
              <span style={{fontSize:24}}>📷</span>
              <span style={{fontSize:10,color:'var(--fg-dim)',letterSpacing:'0.08em',textTransform:'uppercase'}}>attach bottle photo</span>
              <input type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={handlePhoto} />
            </label>
          )}
        </div>

        <div className="field">
          <div className="fl">name *</div>
          <input className="fi" value={name} onChange={e => setName(e.target.value)} placeholder="Château de Whatever, 2019" />
        </div>

        <div style={{display:'flex',gap:8}}>
          <div className="field" style={{flex:1}}>
            <div className="fl">producer</div>
            <input className="fi" value={producer} onChange={e => setProducer(e.target.value)} placeholder="Domaine…" />
          </div>
          <div className="field" style={{maxWidth:88}}>
            <div className="fl">vintage</div>
            <input className="fi" value={vintage} onChange={e => setVintage(e.target.value)} maxLength={4} placeholder="20XX" />
          </div>
        </div>

        <div className="field">
          <div className="fl">type *</div>
          <div className="chips">
            {TYPES.map(t => (
              <div key={t.k} className="chip" data-sel={type === t.k ? t.k : undefined} onClick={() => setType(t.k)}>
                <span>{t.ico}</span>{t.l}
              </div>
            ))}
          </div>
        </div>

        <div className="field">
          <div className="fl">grape / style</div>
          <input className="fi" value={grape} onChange={e => setGrape(e.target.value)} placeholder="Pinot Noir, Pét-Nat…" />
        </div>

        {error && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{error}</p>}

        <button className="btn-p" onClick={save} disabled={saving}>{saving ? 'saving…' : '→ add to session'}</button>
        <button className="btn-g" onClick={onClose}>cancel</button>
      </div>
    </div>
  )
}
