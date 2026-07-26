'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { useState, useEffect, useRef } from 'react'
import type { WireWine } from '@/lib/session'
import { sessionFetch } from '@/lib/sessionFetch'
import { Modal } from '@/components/ui/Modal'
import { CountrySelect } from '@/components/ui/CountrySelect'
import { UnsavedChangesConfirm } from '@/components/ui/UnsavedChangesConfirm'
import { useDirtyGuard } from '@/lib/dirtyGuard'
import { normalizeVintageText, scanText, scanVintage } from '@verre/core'

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
  onClose: () => void
  onSaved: () => void
  editWine?: WireWine // if set, we're editing
  winesCount?: number // number of wines already in the list, used for position picker
}

export function AddWineModal({ code, onClose, onSaved, editWine, winesCount = 0 }: Props) {
  const isEdit = !!editWine
  const [name, setName] = useState(editWine?.name || '')
  const [producer, setProducer] = useState(editWine?.producer || '')
  const [vintage, setVintage] = useState(editWine?.vintage || '')
  const [grape, setGrape] = useState(editWine?.grape || '')
  const [type, setType] = useState(editWine?.type || '')
  const [position, setPosition] = useState(String(winesCount + 1))
  const [description, setDescription] = useState(editWine?.description || '')
  const [region, setRegion] = useState(editWine?.region || '')
  const [country, setCountry] = useState(editWine?.country || '')
  const [vinification, setVinification] = useState(editWine?.vinification || '')
  const [purchaseUrl, setPurchaseUrl] = useState(editWine?.purchaseUrl || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [photoDataUrl, setPhotoDataUrl] = useState('')
  const [existingPhotoUrl] = useState(editWine?.imageUrl || editWine?.image || '')
  const [scanning, setScanning] = useState(false)
  const [scanStatus, setScanStatus] = useState('')

  const maxPosition = winesCount + 1


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
      const prompt = 'This is a wine bottle label. Extract: wine name, producer/winery, vintage (the 4-digit year, or "NV" if the label says non-vintage / NV / N.V.), grape variety/blend, wine type (red/white/sparkling/rosé). Return JSON: {name,producer,vintage,grape,type} where type is one of: red,white,spark,rose,nonalc. Only return the JSON object.'
      const b64 = photo.startsWith('data:') ? photo.split(',')[1] : null
      const imageUrl = photo.startsWith('http') ? photo : null
      // 🔒 UNTRUSTED: this is model-generated JSON, not a typed API. Asserting
      // string-valued fields here was a lie the compiler couldn't catch — a
      // conventional `"vintage": 2019` reached normalizeVintageText(2019) and
      // threw on .trim(), failing the whole scan. Values stay `unknown` and are
      // narrowed at each use.
      let result: Record<string, unknown> = {}

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

      // Coercion lives in @verre/core (`scanText` / `scanVintage`) so the tests
      // exercise the SHIPPED behaviour — a local copy tested by a copy stayed
      // green while production broke. Text fields are strings only; vintage
      // additionally accepts an integer, since a model answering "the 4-digit
      // year" with a JSON number is a legitimate reading of the label.
      const gotName = scanText(result.name); if (gotName) setName(gotName)
      const gotProducer = scanText(result.producer); if (gotProducer) setProducer(gotProducer)
      // A 4-digit year OR the literal NV survives; anything else is dropped.
      // Stripping non-digits unconditionally turned a scanned non-vintage
      // bottling into a blank field, destroying what the label actually said —
      // "NV" is a valid Char(4) value.
      const gotVintage = scanVintage(result.vintage)
      if (gotVintage) setVintage(normalizeVintageText(gotVintage))
      const gotGrape = scanText(result.grape); if (gotGrape) setGrape(gotGrape)
      const gotType = scanText(result.type)
      if (gotType && TYPES.find(t => t.k === gotType)) setType(gotType)
      setScanStatus('fields prefilled ✓')
    } catch {
      setScanStatus('scan failed — check your key')
    }
    setScanning(false)
  }

  async function save(): Promise<boolean> {
    if (!name.trim()) { setError('Name required'); return false }
    if (!type) { setError('Select a type'); return false }
    let parsedPos: number | null = null
    if (!isEdit) {
      parsedPos = parseInt(position, 10)
      if (!Number.isInteger(parsedPos) || parsedPos < 1 || parsedPos > maxPosition) {
        setError(`Position must be between 1 and ${maxPosition}.`)
        return false
      }
    }
    setSaving(true); setError('')
    const body: Record<string, unknown> = {
      // Canonicalize on the way out so the official client sends the same form
      // the server stores (the server normalizes too — this is for UX parity,
      // not correctness).
      name, producer, vintage: normalizeVintageText(vintage), grape, type,
      description, region, country, vinification, purchaseUrl,
    }
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
    if (!res.ok) { setError(isEdit ? 'Could not update wine' : 'Could not save wine'); return false }
    onSaved()
    return true
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

  // Dirty detection. Drives the close-confirm gate (X / backdrop /
  // Escape) AND the cross-cutting DirtyGuard for external nav surfaces.
  // Add mode: dirty if any field has content OR a fresh photo was
  // selected. Edit mode: dirty if any field differs from editWine.
  // The single-array form (vs. the parallel Add/Edit ternaries it
  // replaced) prevents the "forget to add the new field to one branch"
  // hazard.
  const dirty = (() => {
    const baseline = editWine || {}
    const current: Record<string, string> = {
      name, producer, vintage, grape, type,
      description, region, country, vinification, purchaseUrl,
    }
    for (const k of Object.keys(current)) {
      const a = current[k] || ''
      const b = (baseline as Record<string, string | undefined | null>)[k] || ''
      if (a !== b) return true
    }
    return !!photoDataUrl
  })()

  // Inner save-confirm modal state. Mirrors WineModal's pattern: the
  // close path (X / backdrop / Escape) and the external-nav gate both
  // route through this so the user gets one consistent prompt.
  // `pendingNavRef` carries the proceed callback when the gate fired
  // from an external nav (DirtyGuard); null when fired from a local
  // close action — in that case, resolving the confirm just unmounts.
  const [pendingClose, setPendingClose] = useState(false)
  const pendingNavRef = useRef<(() => void) | null>(null)

  // Register the cross-cutting DirtyGuard so bottom-nav / Leave /
  // header-logo clicks while this modal is open route through the
  // save-confirm. Re-registers every render so closures stay fresh.
  const dirtyGuard = useDirtyGuard()
  useEffect(() => {
    if (!dirtyGuard) return
    return dirtyGuard.register({
      isDirty: () => dirty && !saving,
      onAttempt: (proceed) => {
        // First-attempt-wins: same posture as WineModal. Drop the
        // second nav if the user is already resolving an earlier one.
        if (pendingClose) return
        pendingNavRef.current = proceed
        setPendingClose(true)
      },
    })
  })

  // Local close gate (X / backdrop / Escape). Opens the inner confirm
  // when dirty, otherwise unmounts immediately.
  function requestClose() {
    if (saving) return
    if (dirty) {
      pendingNavRef.current = null
      setPendingClose(true)
      return
    }
    onClose()
  }

  return (
    <Modal onClose={requestClose} maxWidth={600} minHeight="90svh" maxHeight="90svh">
      <div style={{
        display:'flex',flexDirection:'column',
        flex:1,minHeight:0,
      }}>
        <div style={{
          display:'flex',alignItems:'center',justifyContent:'space-between',
          flexShrink:0,
          marginBottom:14,paddingBottom:14,
          borderBottom:'1px solid var(--border)',
        }}>
          <div style={{fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.04em'}}>
            {isEdit ? 'Edit wine' : 'Add wine'}
          </div>
          <button
            onClick={requestClose}
            aria-label="Close"
            style={{
              background:'transparent',border:'none',
              width:32,height:32,borderRadius:8,
              color:'var(--fg-dim)',cursor:'pointer',
              display:'inline-flex',alignItems:'center',justifyContent:'center',
              flexShrink:0,fontSize:18,lineHeight:1,
            }}
          >×</button>
        </div>

        {/* Scrollable body */}
        <div style={{
          flex:1,minHeight:0,overflowY:'auto',
          marginRight:-8,paddingRight:8,
        }}>

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
              <input type="file" accept="image/*" style={{display:'none'}} onChange={handlePhoto} />
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

        {/* Optional details — wine identity beyond name/type. Separated
            visually so the required fields stay the focal point. */}
        <div style={{
          marginTop:14,marginBottom:14,padding:'14px 12px 6px',
          border:'1px solid var(--border)',borderRadius:8,
          background:'rgba(255,255,255,0.015)',
        }}>
          <div className="panel-hdr">details (optional)</div>

          <div className="field">
            <div className="fl">grape / style</div>
            <input className="fi" value={grape} onChange={e => setGrape(e.target.value)} placeholder="Pinot Noir, Pét-Nat…" />
          </div>

          <div style={{display:'flex',gap:8}}>
            <div className="field" style={{flex:1,minWidth:0}}>
              <div className="fl">region</div>
              <input className="fi" value={region} maxLength={255}
                onChange={e => setRegion(e.target.value)}
                placeholder="Burgundy, Wachau…" />
            </div>
            <div className="field" style={{flex:1,minWidth:0}}>
              <div className="fl">country</div>
              <CountrySelect value={country} onChange={setCountry} />
            </div>
          </div>

          <div className="field">
            <div className="fl">vinification</div>
            <textarea
              className="fi" value={vinification} maxLength={1000}
              onChange={e => setVinification(e.target.value)}
              placeholder="stainless steel, 10 months in oak…"
              rows={2}
              style={{resize:'vertical',minHeight:48,fontFamily:'var(--mono)'}}
            />
          </div>

          <div className="field">
            <div className="fl">description</div>
            <textarea
              className="fi" value={description} maxLength={1000}
              onChange={e => setDescription(e.target.value)}
              placeholder="character, story, tasting impression…"
              rows={3}
              style={{resize:'vertical',minHeight:60,fontFamily:'var(--mono)'}}
            />
          </div>

          <div className="field" style={{marginBottom: !isEdit ? 12 : 4}}>
            <div className="fl">purchase link</div>
            <input className="fi" value={purchaseUrl} maxLength={1000}
              onChange={e => setPurchaseUrl(e.target.value)}
              placeholder="https://…" type="url" />
          </div>

          {!isEdit && (
            <div className="field" style={{marginBottom:4}}>
              <div className="fl">placement in list</div>
              <input className="fi" type="text" inputMode="numeric" pattern="[0-9]*"
                value={position} onChange={e => setPosition(e.target.value.replace(/\D/g,''))}
                placeholder={String(maxPosition)}
                style={{width:88}} />
              <div style={{fontSize:10,color:'var(--fg-faint)',marginTop:4,fontFamily:'var(--mono)'}}>
                ↻ not a fixed placement — host &amp; cohost can reorder anytime
              </div>
            </div>
          )}
        </div>

        </div>{/* /scrollable body */}

        {/* Sticky footer — error banner stays visible regardless of scroll
            position; Save is the only action (close paths: X / Escape /
            backdrop / dirty-confirm). The cancel ghost button was dropped
            as redundant. */}
        <div style={{
          marginTop:14,paddingTop:14,
          borderTop:'1px solid var(--border)',
          display:'flex',flexDirection:'column',gap:8,flexShrink:0,
        }}>
          {error && <p style={{color:'var(--danger)',fontSize:11,margin:0}}>{error}</p>}
          <button
            className="btn-p"
            onClick={save}
            disabled={saving}
            style={{marginTop:0}}
          >{saving ? 'saving…' : isEdit ? '→ save changes' : '→ add to session'}</button>
        </div>
      </div>

        {/* Uncommitted-edits confirm. Save success unmounts via the
            existing onSaved() in save(); we just need to fire
            pendingNav afterwards if it was set. */}
        <UnsavedChangesConfirm
          open={pendingClose}
          title={isEdit ? 'Save your changes?' : 'Save this wine?'}
          subtitle={`You have unsaved ${isEdit ? 'edits' : 'details'}.`}
          error={error}
          saving={saving}
          onDismiss={() => {
            if (saving) return
            pendingNavRef.current = null
            setPendingClose(false)
          }}
          onKeep={() => {
            pendingNavRef.current = null
            setPendingClose(false)
          }}
          onDiscard={() => {
            const nav = pendingNavRef.current
            pendingNavRef.current = null
            setPendingClose(false)
            onClose()
            if (nav) nav()
          }}
          onSave={async () => {
            // Capture pendingNav before await so we know what to fire
            // on success. save() returns true after firing onSaved()
            // (which the parent uses to unmount). On success the
            // setState below lands on an unmounted component (React
            // dev-mode no-op + warning) — acceptable since the
            // unmount is fired by save() itself and the warning is
            // benign. On failure we keep the confirm open with the
            // error banner so the user can retry; pendingNav stays
            // set for the eventual success path.
            const nav = pendingNavRef.current
            const ok = await save()
            if (ok) {
              pendingNavRef.current = null
              setPendingClose(false)
              if (nav) nav()
            }
            return ok
          }}
        />
    </Modal>
  )
}
