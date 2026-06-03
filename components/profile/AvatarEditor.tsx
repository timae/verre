'use client'
import { useRef, useState, useCallback } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDeleteButton } from '@/components/ui/ConfirmDeleteButton'
import { Avatar } from './Avatar'

interface Props {
  name: string
  currentUrl: string | null
  onClose: () => void
  // Receives the freshly-rendered crop data URL on save (used for
  // optimistic UI before SSR refetch lands), or null on remove.
  onSaved: (newDataUrl: string | null) => void
}

const OUTPUT_SIZE = 512
const JPEG_QUALITY = 0.85

export function AvatarEditor({ name, currentUrl, onClose, onSaved }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  // The data URL of the picked file. Once set, the cropper UI takes
  // over. Initial state shows either the existing avatar (with a
  // pick-new prompt) or just the picker.
  const [src, setSrc] = useState<string | null>(null)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedArea, setCroppedArea] = useState<Area | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCroppedArea(areaPixels)
  }, [])

  function pickFile() {
    fileInputRef.current?.click()
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError('')
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('Please pick an image file.'); return }
    // Quick client-side cap; server still validates. 10MB raw input is
    // generous — the cropper downsamples to 512×512 JPEG before upload.
    if (file.size > 10 * 1024 * 1024) { setError('Image is too large (10 MB max).'); return }
    const reader = new FileReader()
    reader.onload = () => setSrc(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => setError("Couldn't read the file.")
    reader.readAsDataURL(file)
  }

  async function save() {
    if (!src || !croppedArea) return
    setBusy(true); setError('')
    try {
      const dataUrl = await renderCroppedJpeg(src, croppedArea)
      const res = await fetch('/api/me/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageData: dataUrl }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `upload failed (${res.status})`)
      }
      await res.json()
      onSaved(dataUrl)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // ConfirmDeleteButton handles its own pending/failed states from the
  // throw, but the modal also has an error region — set that too so
  // both surfaces stay informative.
  async function remove() {
    setError('')
    try {
      const res = await fetch('/api/me/avatar', { method: 'DELETE' })
      if (!res.ok) throw new Error(`delete failed (${res.status})`)
      onSaved(null)
    } catch (e) {
      setError((e as Error).message)
      throw e
    }
  }

  return (
    <Modal onClose={onClose} maxWidth={480} maxHeight="90vh">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
          {src ? 'Adjust avatar' : currentUrl ? 'Change avatar' : 'Choose avatar'}
        </div>
        <button className="btn-s" onClick={onClose} style={{ fontSize: 9 }} disabled={busy}>close</button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={onFile}
        style={{ display: 'none' }}
      />

      {!src && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '20px 0' }}>
          <Avatar name={name} imageUrl={currentUrl} size={120} />
          <button className="btn-s" onClick={pickFile} disabled={busy}>
            {currentUrl ? 'replace' : 'choose photo'}
          </button>
          {currentUrl && (
            <ConfirmDeleteButton
              label="⌫ remove avatar"
              confirmLabel="tap again to remove"
              onConfirm={remove}
              disabled={busy}
            />
          )}
        </div>
      )}

      {src && (
        <>
          {/* Cropper viewport — fixed-height square so the avatar
              circle preview is meaningful. react-easy-crop renders
              its own <img> on top with the round mask. */}
          <div style={{ position: 'relative', width: '100%', height: 320, background: 'var(--bg3)', borderRadius: 12, overflow: 'hidden' }}>
            <Cropper
              image={src}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              showGrid={false}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <span style={{ fontSize: 10, color: 'var(--fg-dim)', fontFamily: 'var(--mono)' }}>zoom</span>
            <input
              type="range" min="1" max="4" step="0.05" value={zoom}
              onChange={e => setZoom(Number(e.target.value))}
              style={{ flex: 1 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            <button className="btn-s" onClick={() => setSrc(null)} disabled={busy} style={{ flex: 1 }}>
              pick another
            </button>
            <button className="btn-s" onClick={save} disabled={busy || !croppedArea} style={{ flex: 1 }}>
              {busy ? 'saving…' : 'save'}
            </button>
          </div>
        </>
      )}

      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 11, marginTop: 12 }}>{error}</p>
      )}
    </Modal>
  )
}

// Render the cropped region of the source image to a square JPEG data
// URL at OUTPUT_SIZE (512×512 — large enough that the lightbox view
// still looks crisp on a phone, small enough that the wire payload
// stays well under the 2MB server cap). Drawing through canvas
// incidentally strips metadata (canvas reads pixels, not EXIF),
// giving us defense-in-depth alongside the server-side strip in lib/s3.ts.
async function renderCroppedJpeg(src: string, area: Area): Promise<string> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = OUTPUT_SIZE
  canvas.height = OUTPUT_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}
