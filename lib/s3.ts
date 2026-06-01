import { S3Client, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'

const BUCKET = process.env.S3_BUCKET
const ENDPOINT = process.env.S3_ENDPOINT

const s3 = ENDPOINT
  ? new S3Client({
      endpoint: ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
      forcePathStyle: true,
    })
  : null

// Cap on the decoded image payload. 2MB is generous for a wine label
// photo; bigger uploads bloat the bucket and edge platform body-parse
// limits. Rejected payloads return '' so call sites land in their
// existing "no image" branch.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

// Cap on the raw `data:image/...;base64,...` URL string a route
// accepts before invoking uploadImage. 3 MB string ≈ 2.25 MB decoded,
// matching MAX_IMAGE_BYTES with a small margin. Exported so the route
// guards stay aligned with the s3-side limit.
export const MAX_IMAGE_DATA_URL_BYTES = 3_000_000

// MIME → magic byte signatures. SVG is omitted deliberately: SVG is XML,
// can carry <script>, and gets executed when served as `image/svg+xml`.
// Polyglot uploads (ZIP, PHP, JS) fail the magic-byte check even when
// the wire MIME claims `image/png`.
const IMAGE_SIGS: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png':  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [0x52, 0x49, 0x46, 0x46],  // RIFF; full check below
  'image/gif':  [0x47, 0x49, 0x46, 0x38],
}

function magicMatches(mime: string, body: Buffer): boolean {
  const sig = IMAGE_SIGS[mime]
  if (!sig || body.length < sig.length) return false
  for (let i = 0; i < sig.length; i++) {
    if (body[i] !== sig[i]) return false
  }
  // WEBP needs the additional check that bytes 8..11 are 'WEBP'.
  if (mime === 'image/webp') {
    if (body.length < 12) return false
    return body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50
  }
  return true
}

// JPEG metadata strip — drops APP0..APP15 segments (FFE0..FFEF). APP1
// is where EXIF lives, including GPS coordinates from mobile cameras;
// APP13 carries Photoshop IPTC. Image data (SOF/SOS/DQT/DHT/etc.) is
// preserved untouched. Pure byte-pattern operation, no decode/re-encode.
//
// Why JPEG-only: iOS Safari converts HEIC → JPEG on upload; Android
// camera defaults are JPEG; nearly all mobile-camera GPS leaks travel
// in JPEG APP1. PNG/WebP/GIF rarely carry sensitive metadata from
// device cameras and would need format-specific parsers. If a future
// upload path (Capacitor camera plugin, custom client) ever emits
// HEIC/PNG/WebP with EXIF, we'll need to expand this.
function stripJpegMetadata(body: Buffer): Buffer {
  // SOI must be 0xFFD8.
  if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return body
  // Output buffer can never grow larger than input (we only ever drop
  // segments). Pre-allocate and track write offset — `Buffer.copy` is
  // O(n) memcpy. Per-byte `push(...subarray)` would blow V8's argument
  // stack on a 2MB SOS payload.
  const out = Buffer.alloc(body.length)
  let w = 0
  out[w++] = 0xff
  out[w++] = 0xd8
  let i = 2
  while (i < body.length) {
    if (body[i] !== 0xff) { out[w++] = body[i]; i++; continue }
    // Skip fill bytes (FF FF ...).
    let m = i + 1
    while (m < body.length && body[m] === 0xff) m++
    if (m >= body.length) break
    const marker = body[m]
    // SOS (0xDA) starts compressed image data — copy to EOI without
    // further parsing.
    if (marker === 0xda) {
      const copied = body.copy(out, w, i, body.length)
      w += copied
      i = body.length
      break
    }
    // Standalone markers (no length): SOI(D8), EOI(D9), RST0..7(D0-D7).
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      out[w++] = 0xff
      out[w++] = marker
      i = m + 1
      continue
    }
    // All other markers carry a 2-byte length immediately after the marker.
    if (m + 2 >= body.length) break
    const segLen = (body[m + 1] << 8) | body[m + 2]
    if (segLen < 2) break
    const segEnd = m + 1 + segLen
    if (segEnd > body.length) break
    // Drop APP0..APP15 (E0..EF) and COM (FE). Keep everything else.
    const drop = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe
    if (!drop) {
      const copied = body.copy(out, w, i, segEnd)
      w += copied
    }
    i = segEnd
  }
  return out.subarray(0, w)
}

// `keyBase` is the bucket-relative key without extension. Caller picks
// the prefix and uniqueness scheme — wines keyed by id (stable),
// avatars and check-ins keyed by id + timestamp (so replacement leaves
// the prior bytes addressable for reclaim).
export const uploadImage = async (keyBase: string, dataUrl: string): Promise<string> => {
  if (!s3 || !BUCKET) return ''
  // Strict data-URL match. Rejects `data:image/svg+xml`, anything not
  // base64-encoded, and obviously-garbage prefixes.
  const match = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/)
  if (!match) return ''
  const [, mime, b64] = match
  if (!IMAGE_SIGS[mime]) return ''
  let body: Buffer
  try { body = Buffer.from(b64, 'base64') } catch { return '' }
  if (body.length === 0 || body.length > MAX_IMAGE_BYTES) return ''
  // Magic-byte check defends against polyglots — a PHP shell, ZIP, or
  // JS payload claiming Content-Type: image/png would fail here.
  if (!magicMatches(mime, body)) return ''
  // Strip JPEG metadata (APP segments + comments) so EXIF GPS from
  // mobile cameras doesn't end up in publicly-readable S3 objects.
  if (mime === 'image/jpeg') body = stripJpegMetadata(body)
  const ext = mime.split('/')[1] || 'jpg'
  const key = `${keyBase}.${ext}`
  const upload = new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: key, Body: body, ContentType: mime },
  })
  await upload.done()
  return `${ENDPOINT}/${BUCKET}/${key}`
}

export const deleteImage = async (wineId: string): Promise<void> => {
  if (!s3 || !BUCKET) return
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif']) {
    const key = `wines/${wineId}.${ext}`
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
    } catch (err) {
      console.warn('[s3] deleteImage failed:', { key, err })
    }
  }
}

// Generic raw-bytes get for arbitrary keys (the image helpers above are
// MIME/magic-byte gated and not suitable for binary data files). Used by the
// geo-data delivery: the app downloads the lookup tables from S3 at boot. (The
// matching upload runs in the deploy job's standalone .mjs with its own S3
// client — it can't import this TS module — so there's no put helper here.)
// Returns null when S3 isn't configured or the object is missing/unreadable.
export const getObjectBytes = async (key: string): Promise<Buffer | null> => {
  if (!s3 || !BUCKET) return null
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const bytes = await res.Body?.transformToByteArray()
    return bytes ? Buffer.from(bytes) : null
  } catch {
    return null
  }
}

