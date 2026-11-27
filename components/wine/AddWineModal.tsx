'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { useState, useEffect, useRef } from 'react'
import { nanoid } from 'nanoid'
import type { WireWine } from '@/lib/session'
import { sessionFetch } from '@/lib/sessionFetch'
import { Modal } from '@/components/ui/Modal'
import { UnsavedChangesConfirm } from '@/components/ui/UnsavedChangesConfirm'
import { useDirtyGuard } from '@/lib/dirtyGuard'
import { normalizeVintageText, scanText, scanVintage } from '@verre/core'
import { CatalogPicker, type CatalogChoice, type ScanPrefill } from '@/components/wine/CatalogPicker'
import { ChosenWine } from '@/components/wine/ChosenWine'
import { useSession } from '@/components/session/SessionShell'
import { wineShown } from '@/lib/wineDisplay'

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
  // 🔒 The wine is a catalogue entry (catalogue model change step 4): picked,
  // or created (signed in only). Its name, producer, year and kind come from
  // the entry; this sheet keeps only the bottle's own fields.
  const { myId } = useSession()
  const canCreate = myId.startsWith('u:')
  const [choice, setChoice] = useState<CatalogChoice | null>(null)
  // Edit: the current wine stays unless the host changes it.
  const [relinking, setRelinking] = useState(!isEdit)
  const [scanPrefill, setScanPrefill] = useState<ScanPrefill | null>(null)
  // The choice last SENT (frozen into its summary; see the wine section).
  const [sentChoice, setSentChoice] = useState<CatalogChoice | null>(null)
  const [position, setPosition] = useState(String(winesCount + 1))
  const [description, setDescription] = useState(editWine?.description || '')
  const [vinification, setVinification] = useState(editWine?.vinification || '')
  const [purchaseUrl, setPurchaseUrl] = useState(editWine?.purchaseUrl || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [photoDataUrl, setPhotoDataUrl] = useState('')
  const [existingPhotoUrl] = useState(editWine?.imageUrl || editWine?.image || '')
  const [scanning, setScanning] = useState(false)
  const [scanStatus, setScanStatus] = useState('')

  const maxPosition = winesCount + 1
  const current = editWine ? wineShown(editWine) : null
  // The bottle's id, minted once per open sheet: a Save retried after a lost
  // answer finds the same bottle instead of adding a second one (the server
  // answers `alreadyAdded`). The photo follows with its own call.
  const newId = useRef(nanoid())
  // Once the bottle is saved but its photo is not (a failed photo call), the
  // sheet stays open: the next Save edits that bottle (PATCH) and retries only
  // the photo, and closing refreshes the list. `savedFields` is the dirty
  // baseline from then on.
  const savedId = useRef<string | null>(null)
  const [savedFields, setSavedFields] = useState<Record<string, string> | null>(null)
  // The choice the saved bottle was created or re-linked with: a later Save
  // sends the link again only when the choice changed (a create is never sent
  // twice: it would mint a second entry).
  const appliedChoice = useRef<CatalogChoice | null>(null)
  // The choice the FIRST add post carried (the one a lost answer may have
  // landed), and the frozen choice a "change wine" left (offered back as "keep").
  const firstPosted = useRef<CatalogChoice | null>(null)
  const [undo, setUndo] = useState<CatalogChoice | null>(null)


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
    if (!key) { setScanStatus(`no ${cfg.label} key saved: add one below`); return }
    setScanning(true); setScanStatus('scanning label…')
    try {
      const prompt = 'This is a wine bottle label. Extract: wine name, producer/winery, vintage (the 4-digit year, or "NV" if the label says non-vintage / NV / N.V.), grape variety/blend, wine type (red/white/sparkling/rosé). Return JSON: {name,producer,vintage,grape,type} where type is one of: red,white,spark,rose. Only return the JSON object.'
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
      // A 4-digit year OR the literal NV survives; anything else is dropped.
      // The label seeds the SEARCH (never a link: the person still picks).
      const gotVintage = scanVintage(result.vintage)
      const gotType = scanText(result.type)
      setScanPrefill({
        producer: scanText(result.producer) || undefined,
        name: scanText(result.name) || undefined,
        grape: scanText(result.grape) || undefined,
        year: gotVintage ? normalizeVintageText(gotVintage) : undefined,
        type: gotType || undefined,
      })
      setRelinking(true)
      setScanStatus('search prefilled from the label ✓')
    } catch {
      setScanStatus('scan failed: check your key')
    }
    setScanning(false)
  }

  async function save(): Promise<boolean> {
    const linkChange = relinking ? choice : null
    if (!isEdit && !savedId.current && !choice) { setError('Choose a wine, or add a new one'); return false }
    if (isEdit && relinking && !choice) { setError('Choose a wine, or keep the current one'); return false }
    let parsedPos: number | null = null
    if (!isEdit) {
      parsedPos = parseInt(position, 10)
      if (!Number.isInteger(parsedPos) || parsedPos < 1 || parsedPos > maxPosition) {
        setError(`Position must be between 1 and ${maxPosition}.`)
        return false
      }
    }
    setSaving(true); setError('')
    // The bottle's own fields (ruled 2026-11-20: About and vinification stay
    // on the bottle, like the purchase link).
    const fields = { description, vinification, purchaseUrl }
    const linkBody = (c: CatalogChoice | null) => !c || c === appliedChoice.current ? {}
      : c.kind === 'pick' ? { productId: c.productId, vintageId: c.vintageId, ...(c.abv !== undefined ? { abv: c.abv } : {}) } : { create: c.body }
    const creating = !isEdit && !savedId.current
    const body: Record<string, unknown> = { ...fields, ...linkBody(linkChange) }
    if (creating) body.id = newId.current
    if (creating && parsedPos != null) body.position = parsedPos
    let wineId = isEdit ? editWine!.id : (savedId.current ?? newId.current)
    // Frozen once it may have LANDED (a 2xx, or a lost answer), never on a
    // definite refusal: a 400 / 403 / 429 minted nothing, so the form stays as
    // typed (review r2).
    const sending = linkChange && linkChange !== appliedChoice.current ? linkChange : null
    if (creating && sending && !firstPosted.current) firstPosted.current = sending
    const fail = (msg: string) => { setSaving(false); setError(msg); return false }
    const why = async (res: Response) => (await res.json().catch(() => null) as { error?: string } | null)?.error
    try {
      const res = await sessionFetch(code, creating ? `/api/session/${code}/wines` : `/api/session/${code}/wines/${wineId}`, {
        method: creating ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      // (`firstPosted` is kept on a refusal: it says nothing about whether an
      // earlier lost post landed; the worst case is one redundant re-link,
      // which a pick and a recognised create absorb. Review r3.)
      if (!res.ok) {
        // A 5xx may come after a COMMIT (Codex r1): the choice may have landed,
        // so it is frozen like a lost answer; a 4xx is a definite refusal.
        if (res.status >= 500 && sending) setSentChoice(sending)
        const msg = res.status === 400 || res.status === 403 ? await why(res) : null
        return fail(msg || (isEdit ? 'Could not update wine' : 'Could not save wine'))
      }
      // The id the server stored (an older server mints its own).
      const answer = creating ? await res.json().catch(() => null) as { id?: string; alreadyAdded?: boolean } | null : null
      if (creating) wineId = answer?.id ?? wineId
      if (!isEdit) savedId.current = wineId
      // A retry whose first answer was lost: the bottle exists already, linked
      // as the FIRST post left it; this Save's fields go through the edit, and
      // the link too when the person changed the wine since (a deliberate
      // re-link: the server recognises a retried create of it). The first
      // post's own create is never sent twice.
      if (answer?.alreadyAdded) {
        const changed = linkChange && linkChange !== firstPosted.current ? linkBody(linkChange) : {}
        const upd = await sessionFetch(code, `/api/session/${code}/wines/${wineId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...fields, ...changed }),
        })
        if (!upd.ok) {
          if (upd.status >= 500 && sending) setSentChoice(sending)
          return fail('Could not save wine')
        }
      }
      // Frozen once the request that carries it succeeded (review r3: on a
      // replay that is the follow-up PATCH above).
      if (sending) setSentChoice(sending)
      if (linkChange) appliedChoice.current = linkChange
      if (photoDataUrl) {
        setSavedFields({ ...fields })
        const img = await sessionFetch(code, `/api/session/${code}/wines/${wineId}/image`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: photoDataUrl }),
        })
        if (!img.ok) {
          const msg = await img.json().then((j: { error?: string }) => j.error).catch(() => null)
          return fail((img.status === 400 || img.status === 403) && msg ? msg : 'Saved, but the photo could not be added. Try again.')
        }
      }
    } catch {
      // A lost answer: Save again reuses the same id, so nothing is added twice;
      // the choice may have landed, so it is frozen.
      if (sending) setSentChoice(sending)
      return fail(savedId.current ? 'Saved, but the photo could not be added. Try again.' : (isEdit ? 'Could not update wine' : 'Could not save wine'))
    }
    setSaving(false)
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
    const baseline = savedFields || editWine || {}
    const current: Record<string, string> = { description, vinification, purchaseUrl }
    for (const k of Object.keys(current)) {
      const a = current[k] || ''
      const b = (baseline as Record<string, string | undefined | null>)[k] || ''
      if (a !== b) return true
    }
    if (choice && choice !== appliedChoice.current) return true
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
    finish()
  }
  // A bottle saved without its photo is still a saved bottle: the list refreshes.
  function finish() {
    if (savedId.current) onSaved()
    else onClose()
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

        {/* The wine: its catalogue entry (picked or created). 🔒 Once a choice
            has been SENT it is frozen into its summary (review r1): a Save
            again after a failed photo or a lost answer re-sends the same
            choice (the server recognises the retry), never an edited create
            that would mint a second entry; changing it is a deliberate
            "change wine". */}
        {isEdit && !relinking && editWine ? (
          <ChosenWine label="wine" name={current!.name} year={current!.vintage} producer={current!.producer} action="change wine" onAction={() => setRelinking(true)} />
        ) : sentChoice && choice === sentChoice ? (
          <ChosenWine label="wine *" name={choice.label.name} year={choice.label.year} producer={choice.label.producer}
            note={choice.kind === 'create' ? 'new' : undefined} action="change wine" onAction={() => { setUndo(choice); setChoice(null); setSentChoice(null) }} />
        ) : (
          <>
            <CatalogPicker
              search={(qs) => sessionFetch(code, `/api/session/${code}/catalog/search?${qs}`)}
              canCreate={canCreate}
              value={choice}
              onChange={setChoice}
              prefill={scanPrefill}
            />
            {undo ? (
              <button type="button" className="btn-s" style={{marginBottom:12}} onClick={() => { setChoice(undo); setSentChoice(undo); setUndo(null) }}>
                keep {undo.label.name}
              </button>
            ) : isEdit && (
              <button type="button" className="btn-s" style={{marginBottom:12}} onClick={() => { setRelinking(false); setChoice(null); setSentChoice(null) }}>
                keep the current wine
              </button>
            )}
          </>
        )}

        {/* The bottle's own details (optional): what this bottle is, here. */}
        <div style={{
          marginTop:14,marginBottom:14,padding:'14px 12px 6px',
          border:'1px solid var(--border)',borderRadius:8,
          background:'rgba(255,255,255,0.015)',
        }}>
          <div className="panel-hdr">details (optional)</div>

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
                ↻ not a fixed placement: host &amp; cohost can reorder anytime
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
            finish()
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
