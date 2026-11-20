'use client'
import { useState, useEffect, useRef } from 'react'
import { nanoid } from 'nanoid'
import { FlavorChips } from '@/components/rate/FlavorChips'
import { IntensityHelp } from '@/components/rate/IntensityHelp'
import { LocationPicker } from './LocationPicker'
import { useQuery } from '@tanstack/react-query'
import { resolveAxes, resolveAxesColoured, fillFlavourZeros } from '@/lib/flavours'
import { CatalogPicker, type CatalogChoice } from '@/components/wine/CatalogPicker'
import { ChosenWine } from '@/components/wine/ChosenWine'
import { ConfirmDeleteButton } from '@/components/ui/ConfirmDeleteButton'
import { Modal } from '@/components/ui/Modal'
import { ScoreSlider } from '@/components/ui/ScoreSlider'

type EditCheckin = {
  id: number; wineName: string; producer?: string|null; vintage?: string|null
  grape?: string|null; sparkling?: boolean; score?: number|null; flavors?: Record<string,number>|null
  notes?: string|null; imageUrl?: string|null; venueName?: string|null; city?: string|null
  country?: string|null; lat?: number|null; lng?: number|null
  tags?: { id: string; name: string }[]
}

export type CopySource = {
  id: number
  wineName: string; producer?: string|null; vintage?: string|null
  grape?: string|null; sparkling?: boolean
  imageUrl?: string|null
  venueName?: string|null; city?: string|null; country?: string|null
  author: { id: string; name: string }
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
  // Minted once per open sheet: a Post retried after a lost answer replays the
  // same check-in.
  const occurrenceId = useRef(nanoid())
  // Posted, but its photo failed: the next Post edits that check-in (fields +
  // photo) instead of replaying the create, and closing refreshes the feed.
  const postedId = useRef<number | null>(null)
  const isCopy = !isEdit && !!copyFromCheckin
  const prefill = editCheckin || (isCopy ? copyFromCheckin : null)
  // 🔒 The wine is a catalogue entry (catalogue model change step 4): picked or
  // created here; an edit keeps its wine unless changed; "had a sip" takes the
  // source's wine server-side (the picker shows only if the source has nothing
  // linkable left).
  const [choice, setChoice] = useState<CatalogChoice | null>(null)
  const [relinking, setRelinking] = useState(!prefill)
  const appliedChoice = useRef<CatalogChoice | null>(null)
  const [sentChoice, setSentChoice] = useState<CatalogChoice | null>(null)
  const firstPosted = useRef<CatalogChoice | null>(null)
  // "change wine" remembers what it left: the frozen choice (offered back as
  // "keep …") and the chips, restored on "keep" (review r2: keeping the wine
  // re-ran the kind reset and zeroed an edit's stored structure).
  const [undo, setUndo] = useState<CatalogChoice | null>(null)
  const stashedFlavors = useRef<Record<string, number> | null>(null)
  // The bottle's kind drives the axes: the chosen entry's, else the stored one.
  const sparkling = relinking ? (choice ? choice.label.sparkling : null) : !!prefill?.sparkling
  const kindKnown = sparkling !== null
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
  const [taggedIds, setTaggedIds] = useState<string[]>(editCheckin?.tags?.map(t => t.id) ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Input chips = the STRUCTURE axis set for this bottle's kind (§6d input surface).
  const kind = { sparkling: !!sparkling }
  const fl = resolveAxesColoured('wine', kind)
  // 🔒 Only a real change of KIND resets the chips to its axis set (Bubbles on
  // or off), between two KNOWN kinds (review r1: "change wine" passes through
  // "no wine yet", and that wiped an edited check-in's stored structure; so did
  // picking another wine of the same kind).
  const lastKnownSparkling = useRef(sparkling)
  useEffect(() => {
    if (sparkling === null) return
    const was = lastKnownSparkling.current
    lastKnownSparkling.current = sparkling
    if (was === null || was === sparkling) return
    setFlavors(resolveAxes('wine', { sparkling }).reduce((o, f) => ({ ...o, [f.k]: 0 }), {}))
  }, [sparkling])
  const { data: friends = [] } = useQuery<{ id: string; name: string }[]>({ queryKey: ['friends'], queryFn: () => fetch('/api/me/friends').then(r => r.json()) })

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
    if (relinking && !choice) { setError(isEdit ? 'Choose a wine, or keep the current one' : 'Choose a wine, or add a new one'); return }
    setSaving(true); setError('')
    const linkChange = relinking && choice && choice !== appliedChoice.current ? choice : null
    // Frozen once it may have LANDED (a 2xx, or a lost answer), never on a
    // definite refusal (review r2). The first post's choice is remembered: a
    // replay's follow-up re-links only when the person changed the wine since.
    const firstPost = !isEdit && postedId.current === null
    if (firstPost && linkChange && !firstPosted.current) firstPosted.current = linkChange
    const link = !linkChange ? {} : linkChange.kind === 'pick'
      ? { productId: linkChange.productId, vintageId: linkChange.vintageId } : { create: linkChange.body }
    const editing = isEdit || postedId.current !== null
    const url = isEdit ? `/api/checkins/${editCheckin!.id}` : postedId.current !== null ? `/api/checkins/${postedId.current}` : '/api/checkins'
    const method = editing ? 'PATCH' : 'POST'
    // "Had a sip": the source id always goes (the server copies the source's
    // WINE from it, catalogue model change step 4); its photo is copied only
    // when the user kept it (`copyPhoto: false` otherwise: a replaced photo
    // follows through the PATCH, a removed one stays removed).
    const copyFromCheckinId = isCopy ? copyFromCheckin!.id : undefined
    const copyPhoto = isCopy ? !imageData && !!existingImageUrl : undefined
    // A new check-in carries its client occurrence id (a retried Post replays
    // the same check-in, the server answers the existing one) and never the
    // photo: that attaches afterwards through the check-in's own PATCH.
    const photo = imageData === '__remove__' ? null : (imageData || undefined)
    const fail = (msg: string) => { setSaving(false); setError(msg) }
    try {
      const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...link,
          // Normalise flavours (structure-wheel §5 zero rule): any axis rated →
          // every axis of this kind stored (untouched = explicit 0); all-None →
          // {}. Also the edit-path transform (§6g) — only registry keys survive, so
          // a stale descriptor row can't 400 the write gate. One shape web+native.
          score: score || null, flavors: fillFlavourZeros(flavors, 'wine', kind), notes,
          ...(editing ? { imageData: photo } : { occurrenceId: occurrenceId.current }),
          ...(editing ? {} : { copyFromCheckinId, ...(copyPhoto === false ? { copyPhoto } : {}) }),
          ...location,
          taggedUserIds: taggedIds,
        }),
      })
      if (!res.ok) {
        // A 5xx may come after a COMMIT (Codex r1): frozen like a lost answer.
        if (res.status >= 500 && linkChange) setSentChoice(linkChange)
        const d = await res.json().catch(() => ({}))
        // "Had a sip" of a source with nothing linkable left: choose the wine
        // (only that refusal: any other 400 keeps the sheet as it is).
        if (isCopy && d.code === 'link-required' && !relinking) setRelinking(true)
        return fail(d.error || 'Failed')
      }
      // Applied once the request that CARRIES it succeeded (review r3: on a
      // replay the follow-up PATCH below carries a changed wine).
      const apply = () => { if (linkChange) { appliedChoice.current = linkChange; setSentChoice(linkChange) } }
      if (editing || res.status !== 200) apply()
      if (!editing) {
        const posted = await res.json().catch(() => null) as { id?: number } | null
        if (posted?.id) postedId.current = posted.id
        // 200 = the server replayed a check-in whose first answer was lost
        // (Codex r1): the sheet's fields may have changed since, so they go
        // through the edit, with the photo; 201 = fresh, only the photo follows.
        const replayed = res.status === 200
        if (posted?.id && (replayed || photo)) {
          const img = await fetch(`/api/checkins/${posted.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(replayed
              ? { ...(linkChange && linkChange !== firstPosted.current ? link : {}), score: score || null, flavors: fillFlavourZeros(flavors, 'wine', kind), notes, ...location, taggedUserIds: taggedIds, ...(photo !== undefined ? { imageData: photo } : {}) }
              : { imageData: photo }),
          })
          if (!img.ok) {
            if (replayed && img.status >= 500 && linkChange) setSentChoice(linkChange)
            return fail(replayed ? 'Posted, but your latest changes could not be saved. Try again.' : 'Posted, but the photo could not be added. Try again.')
          }
        }
        if (replayed) apply()
      }
    } catch {
      // A lost answer: Post again replays the same check-in (or edits it once
      // posted); the choice may have landed, so it is frozen.
      if (linkChange) setSentChoice(linkChange)
      return fail(postedId.current !== null ? 'Posted, but the photo could not be added. Try again.' : 'Could not post. Try again.')
    }
    setSaving(false)
    onPosted()
  }
  // A check-in posted without its photo is still posted: the feed refreshes.
  const close = () => (postedId.current !== null ? onPosted() : onClose())

  return (
    <Modal onClose={close} maxWidth={560} minHeight="min(70vh, 600px)" maxHeight="90vh">
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
            {isEdit ? 'Edit check-in' : isCopy ? 'Had a sip' : 'Check in a wine'}
          </div>
          <button className="btn-s" onClick={close} style={{fontSize:9}}>close</button>
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

        {/* The wine: its catalogue entry. 🔒 A choice once SENT is frozen into
            its summary (review r1): Post again re-sends the same choice (the
            server recognises the retry), never an edited create that would
            mint a second entry; changing it is a deliberate "change wine". */}
        {!relinking ? (
          <ChosenWine label="wine" name={prefill?.wineName ?? ''} year={prefill?.vintage} producer={prefill?.producer}
            action={isEdit ? 'change wine' : undefined} onAction={isEdit ? () => { stashedFlavors.current = flavors; setRelinking(true) } : undefined} />
        ) : sentChoice && choice === sentChoice ? (
          <ChosenWine label="wine *" name={choice.label.name} year={choice.label.year} producer={choice.label.producer}
            note={choice.kind === 'create' ? 'new' : undefined} action="change wine" onAction={() => { stashedFlavors.current = flavors; setUndo(choice); setChoice(null); setSentChoice(null) }} />
        ) : (
          <>
            <CatalogPicker
              search={(qs) => fetch(`/api/catalog/search?${qs}`)}
              canCreate
              value={choice}
              onChange={setChoice}
            />
            {undo ? (
              <button type="button" className="btn-s" style={{marginBottom:12}} onClick={() => {
                lastKnownSparkling.current = undo.label.sparkling
                if (stashedFlavors.current) setFlavors(stashedFlavors.current)
                setChoice(undo); setSentChoice(undo); setUndo(null)
              }}>
                keep {undo.label.name}
              </button>
            ) : isEdit && (
              <button type="button" className="btn-s" style={{marginBottom:12}} onClick={() => {
                lastKnownSparkling.current = !!prefill?.sparkling
                if (stashedFlavors.current) setFlavors(stashedFlavors.current)
                setRelinking(false); setChoice(null); setSentChoice(null)
              }}>
                keep the current wine
              </button>
            )}
          </>
        )}

        {/* Score slider — drag or tap, snaps to 0.25.
            Wrapped in a panel so the visual width matches the rest of
            the form (the inputs above/below sit inside `field` blocks,
            but a slider full-width inside a `field` looked stretched). */}
        <div className="panel">
          <div className="panel-hdr">score</div>
          <ScoreSlider value={score} onChange={setScore} />
        </div>

        {/* Flavour chips (only once the wine, and so its kind, is known) */}
        {kindKnown && (
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
        <button className="btn-g" onClick={close}>cancel</button>
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
