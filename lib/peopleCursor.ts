import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { derivedKey } from '@/lib/serverSecret'
import { isPublicUserId } from '@verre/core'

// The People lists' page cursor (public-user-ids § 4, D3 newest follow first).
// 🔒 SEALED: AES-256-GCM over the last row's exact follow time (epoch
// MICROSECONDS: follows.created_at is timestamptz(6) and a JS Date would
// truncate to ms and skip the rest of that millisecond) and its public id. The
// client never sees a time (follow dates are never shown), and the server
// never looks up an edge the caller names (that would probe edges blockScrub
// hides, docs/dev/block.md).
//
// The associated data binds a cursor to (viewer, profile, tab, mutual, known,
// q): unbound, a cursor minted at a known moment on your own list would replay
// on anyone's list and date their follow edges. A tampered or mismatched
// cursor opens to null (the route answers an empty page).
//
// Layout (base64url): version (1) ‖ nonce (12) ‖ ciphertext (8 + 12) ‖ tag (16).
const VERSION = 1
const PURPOSE = 'people-cursor:v1'

export type PeopleCursor = { atUs: bigint; publicId: string }
export type PeopleCursorScope = {
  viewerId: number; profileId: number; tab: 'followers' | 'following'
  mutual: string | null; known: boolean; q: string
}

const aad = (s: PeopleCursorScope) =>
  Buffer.from(JSON.stringify(['people', s.viewerId, s.profileId, s.tab, s.mutual ?? '', s.known ? 1 : 0, s.q]))

export function sealPeopleCursor(c: PeopleCursor, scope: PeopleCursorScope): string {
  const plain = Buffer.alloc(8 + 12)
  plain.writeBigInt64BE(c.atUs, 0)
  plain.write(c.publicId, 8, 'ascii')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derivedKey(PURPOSE), nonce)
  cipher.setAAD(aad(scope))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]).toString('base64url')
}

export function openPeopleCursor(raw: string, scope: PeopleCursorScope): PeopleCursor | null {
  if (raw.length > 128) return null
  const buf = Buffer.from(raw, 'base64url')
  if (buf.length !== 1 + 12 + 20 + 16 || buf[0] !== VERSION) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', derivedKey(PURPOSE), buf.subarray(1, 13))
    decipher.setAAD(aad(scope))
    decipher.setAuthTag(buf.subarray(33))
    const plain = Buffer.concat([decipher.update(buf.subarray(13, 33)), decipher.final()])
    const publicId = plain.subarray(8).toString('ascii')
    if (!isPublicUserId(publicId)) return null
    return { atUs: plain.readBigInt64BE(0), publicId }
  } catch {
    return null
  }
}
