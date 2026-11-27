import { uploadImage } from '@/lib/s3'
import { reclaimImagesNow } from '@/lib/engagementCascade'

// The occurrence photo's storage calls (the image call, model change § 8a),
// behind one object so the suite can stand in for S3
// (scripts/tests/occurrence-persistence.mts § 6): upload under a fresh key,
// reclaim by URL (awaited). Nothing else uses this seam.
export const occurrenceImageIO: {
  upload: (keyBase: string, dataUrl: string) => Promise<string>
  reclaim: (urls: string[]) => Promise<void> | void
} = {
  upload: uploadImage,
  reclaim: reclaimImagesNow,
}
