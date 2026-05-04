'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { useState, useEffect } from 'react'
import type { WineMeta } from '@/lib/session'
import { sessionFetch } from '@/lib/sessionFetch'

const TYPES = [
  { k: 'red', l: 'Red', ico: '🍷' },
  { k: 'white', l: 'White', ico: '🥂' },
  { k: 'spark', l: 'Bubbles', ico: '🍾' },
  { k: 'rose', l: 'Rosé', ico: '🌸' },
  { k: 'nonalc', l: 'Non-alc', ico: '🌿' },
]

const AI_PROVIDERS = {
  openai: { label: 'OpenAI', keyStore: 'vr_ai_key_openai', placeholder: 'sk-...' },
  claude: { label: 'Claude', keyStore: 'vr_ai_key_claude', placeholder: 'sk-ant-...' },
}

interface Props {
  code: string
  userName: string
  onClose: () => void
  onSaved: () => void
  editWine?: WineMeta // if set, we're editing
  winesCount?: number // number of wines already in the list, used for position picker
}

export function AddWineModal({ code, userName, onClose, onSaved, editWine, winesCount = 0 }: Props) {
  const isEdit = !!editWine
  const [name, setName] = useState(editWine?.name || '')
  const [producer, setProducer] = useState(editWine?.producer || '')
  const [vintage, setVintage] = useState(editWine?.vintage || '')
  const [grape, setGrape] = useState(editWine?.grape || '')
  const [type, setType] = useState(editWine?.type || '')
  const [position, setPosition] = useState(String(winesCount + 1))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [photoDataUrl, setPhotoDataUrl] = useState('')
  const [existingPhotoUrl] = useState(editWine?.imageUrl || editWine?.image || '')
  const [scanning, setScanning] = useState(false)
  const [scanStatus, setScanStatus] = useState('')

  const maxPosition = winesCount + 1

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

  async function scanLabel() {
    const photo = photoDataUrl || existingPhotoUrl
    if (!photo) { setScanStatus('attach a photo first'); return }
    const provider = (localStorage.getItem('vr_ai_provider') || 'openai') as 'openai' | 'claude'
    const cfg = AI_PROVIDERS[provider]
    const key = localStorage.getItem(cfg.keyStore)
    if (!key) { setScanStatus(`no ${cfg.label} key saved — add one below`); return }
    setScanning(true); setScanStatus('scanning label…')
    try {
      const prompt = 'This is a wine bottle label. Extract: wine name, producer/winery, vintage year (4 digits), grape variety/blend, wine type (red/white/sparkling/rosé). Return JSON: {name,producer,vintage,grape,type} where type is one of: red,white,spark,rose,nonalc. Only return the JSON object.'
      const b64 = photo.startsWith('data:') ? photo.split(',')[1] : null
      const imageUrl = photo.startsWith('http') ? photo : null
      let result: {name?:string;producer?:string;vintage?:string;grape?:string;type?:string} = {}

      if (provider === 'openai') {
        const imgContent = b64
          ? { type:'image_url', image_url:{ url:`data:image/jpeg;base64,${b64}` } }
          : { type:'image_url', image_url:{ url: imageUrl } }
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
          body: JSON.stringify({ model:'gpt-4o-mini', messages:[{ role:'user', content:[{ type:'text',text:prompt }, imgContent] }], max_tokens:200 }),
        })
        const d = await res.json()
        const text = d.choices?.[0]?.message?.content || ''
        result = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}')
      } else {
        const imgContent = b64
          ? { type:'image', source:{ type:'base64', media_type:'image/jpeg', data:b64 } }
          : { type:'image', source:{ type:'url', url: imageUrl } }
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
          body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:200, messages:[{ role:'user', content:[imgContent,{type:'text',text:prompt}] }] }),
        })
        const d = await res.json()
        const text = d.content?.[0]?.text || ''
        result = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}')
      }

      if (result.name) setName(result.name)
      if (result.producer) setProducer(result.producer)
      if (result.vintage) setVintage(result.vintage.replace(/\D/g,'').slice(0,4))
      if (result.grape) setGrape(result.grape)
      if (result.type && TYPES.find(t=>t.k===result.type)) setType(result.type)
      setScanStatus('fields prefilled ✓')
    } catch {
      setScanStatus('scan failed — check your key')
    }
    setScanning(false)
  }

  async function save() {
    if (!name.trim()) { setError('Name required'); return }
    if (!type) { setError('Select a type'); return }
    let parsedPos: number | null = null
    if (!isEdit) {
      parsedPos = parseInt(position, 10)
      if (!Number.isInteger(parsedPos) || parsedPos < 1 || parsedPos > maxPosition) {
        setError(`Position must be between 1 and ${maxPosition}.`)
        return
      }
    }
    setSaving(true); setError('')
    const body: Record<string, unknown> = { name, producer, vintage, grape, type }
    if (photoDataUrl) body.image = photoDataUrl
    if (!isEdit && parsedPos != null) body.position = parsedPos
    const url = isEdit
      ? `/api/session/${code}/wines/${editWine!.id}`
      : `/api/session/${code}/wines`
    const res = await sessionFetch(code, url, {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(false)
    if (!res.ok) { setError(isEdit ? 'Could not update wine' : 'Could not save wine'); return }
    onSaved()
  }

  const photo = photoDataUrl || existingPhotoUrl

  // AI provider settings (device-local)
  const [showAI, setShowAI] = useState(false)
  const [aiProvider, setAiProvider] = useState(() => typeof window !== 'undefined' ? (localStorage.getItem('vr_ai_provider') || 'openai') : 'openai')
  const [aiKey, setAiKey] = useState(() => typeof window !== 'undefined' ? (localStorage.getItem(AI_PROVIDERS[aiProvider as 'openai'|'claude'].keyStore) || '') : '')

  function saveAiKey() {
    localStorage.setItem('vr_ai_provider', aiProvider)
    localStorage.setItem(AI_PROVIDERS[aiProvider as 'openai'|'claude'].keyStore, aiKey)
    setScanStatus('key saved')
    setShowAI(false)
  }

  return (
    <div style={{position:'fixed',inset:0,zIndex:50,display:'flex',alignItems:'flex-end',justifyContent:'center',background:'rgba(0,0,0,0.6)',backdropFilter:'blur(4px)'}}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{width:'100%',maxWidth:600,maxHeight:'90vh',overflowY:'auto',background:'var(--bg2)',borderRadius:'22px 22px 0 0',padding:18,paddingBottom:32}}>
        <div className="sheet-bar" />
        <div style={{fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.04em',marginBottom:18}}>
          {isEdit ? 'Edit wine' : 'Add wine'}{' '}
          <span style={{fontSize:9,border:'1px solid var(--border2)',padding:'1px 6px',borderRadius:2,color:'var(--fg-dim)',letterSpacing:'0.08em',textTransform:'uppercase',marginLeft:4}}>shared</span>
        </div>

        {/* Photo + scan */}
        <div style={{marginBottom:14,border:'1px solid var(--border)',borderRadius:12,padding:12,background:'var(--bg3)'}}>
          {photo ? (
            <div style={{position:'relative',marginBottom:8}}>
              <img src={photo} alt="bottle" onClick={()=>openLightbox(photo)} style={{width:'100%',maxHeight:140,objectFit:'contain',borderRadius:8,cursor:'zoom-in'}} />
              {photoDataUrl && <button className="btn-s" style={{position:'absolute',top:6,right:6}} onClick={() => setPhotoDataUrl('')}>remove</button>}
            </div>
          ) : null}
          <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
            <label className="btn-s" style={{cursor:'pointer'}}>
              choose photo
              <input type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={handlePhoto} />
            </label>
            {photo && (
              <button className="btn-s" onClick={scanLabel} disabled={scanning}>
                {scanning ? 'scanning…' : 'read label'}
              </button>
            )}
            <button className="btn-s" onClick={() => setShowAI(!showAI)} style={{opacity:0.6}}>⚙ ai key</button>
          </div>
          {scanStatus && <div style={{fontSize:10,color:'var(--accent2)',marginTop:6,fontFamily:'var(--mono)'}}>{scanStatus}</div>}

          {showAI && (
            <div style={{marginTop:10,paddingTop:10,borderTop:'1px solid var(--border)'}}>
              <div style={{display:'flex',gap:6,marginBottom:8}}>
                {(['openai','claude'] as const).map(p => (
                  <button key={p} className="btn-s" style={{opacity:aiProvider===p?1:0.5}} onClick={() => {
                    setAiProvider(p)
                    setAiKey(localStorage.getItem(AI_PROVIDERS[p].keyStore) || '')
                  }}>{AI_PROVIDERS[p].label}</button>
                ))}
              </div>
              <input className="fi" type="password" value={aiKey} onChange={e => setAiKey(e.target.value)}
                placeholder={AI_PROVIDERS[aiProvider as 'openai'|'claude'].placeholder} style={{marginBottom:8}} />
              <button className="btn-s" onClick={saveAiKey}>save key</button>
            </div>
          )}
        </div>

        <div style={{display:'flex',gap:8}}>
          <div className="field" style={{flex:1}}>
            <div className="fl">name *</div>
            <input className="fi" value={name} onChange={e => setName(e.target.value)} placeholder="Château de Whatever" />
          </div>
          <div className="field" style={{maxWidth:88}}>
            <div className="fl">vintage</div>
            <input className="fi" value={vintage} onChange={e => setVintage(e.target.value)} maxLength={4} placeholder="20XX" />
          </div>
        </div>
        <div className="field">
          <div className="fl">producer</div>
          <input className="fi" value={producer} onChange={e => setProducer(e.target.value)} placeholder="Domaine…" />
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
        <div style={{display:'flex',gap:8}}>
          <div className="field" style={{flex:1}}>
            <div className="fl">grape / style</div>
            <input className="fi" value={grape} onChange={e => setGrape(e.target.value)} placeholder="Pinot Noir, Pét-Nat…" />
          </div>
          {!isEdit && (
            <div className="field" style={{maxWidth:96}}>
              <div className="fl">position</div>
              <input className="fi" type="text" inputMode="numeric" pattern="[0-9]*"
                value={position} onChange={e => setPosition(e.target.value.replace(/\D/g,''))}
                placeholder={String(maxPosition)} />
            </div>
          )}
        </div>

        {error && <p style={{color:'#e07070',fontSize:11,marginBottom:8}}>{error}</p>}
        <button className="btn-p" onClick={save} disabled={saving}>{saving ? 'saving…' : isEdit ? '→ save changes' : '→ add to session'}</button>
        <button className="btn-g" onClick={onClose}>cancel</button>
      </div>
    </div>
  )
}
