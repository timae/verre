import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
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

export const uploadImage = async (wineId: string, dataUrl: string): Promise<string> => {
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
  const ext = mime.split('/')[1] || 'jpg'
  const key = `wines/${wineId}.${ext}`
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

