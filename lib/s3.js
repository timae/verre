const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const BUCKET = process.env.S3_BUCKET;
const ENDPOINT = process.env.S3_ENDPOINT;

const s3 = ENDPOINT ? new S3Client({
  endpoint: ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || '',
    secretAccessKey: process.env.S3_SECRET_KEY || '',
  },
  forcePathStyle: true,
}) : null;

// Upload base64 data-url to S3, return public URL
async function uploadImage(wineId, dataUrl) {
  if (!s3 || !BUCKET) return '';
  const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return '';
  const [, mime, b64] = match;
  const ext = mime.split('/')[1] || 'jpg';
  const key = `wines/${wineId}.${ext}`;
  const body = Buffer.from(b64, 'base64');

  const upload = new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: key, Body: body, ContentType: mime },
  });
  await upload.done();

  // Build public URL (path-style)
  return `${ENDPOINT}/${BUCKET}/${key}`;
}

async function deleteImage(wineId) {
  if (!s3 || !BUCKET) return;
  // try both jpg and jpeg
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `wines/${wineId}.${ext}` }));
    } catch {
      // ignore — object may not exist in that format
    }
  }
}

module.exports = { uploadImage, deleteImage };
