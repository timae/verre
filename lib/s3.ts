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

export async function uploadImage(wineId: string, dataUrl: string): Promise<string> {
  if (!s3 || !BUCKET) return ''
  const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/)
  if (!match) return ''
  const [, mime, b64] = match
  const ext = mime.split('/')[1] || 'jpg'
  const key = `wines/${wineId}.${ext}`
  const body = Buffer.from(b64, 'base64')
  const upload = new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: key, Body: body, ContentType: mime },
  })
  await upload.done()
  return `${ENDPOINT}/${BUCKET}/${key}`
}

export async function deleteImage(wineId: string) {
  if (!s3 || !BUCKET) return
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `wines/${wineId}.${ext}` }))
    } catch {}
  }
}
