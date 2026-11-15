import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { derivedKey } from '@/lib/serverSecret'

// The Cravings list's page cursor (lists plan D6). 🔒 SEALED like the people
// cursor (lib/peopleCursor.ts), with its OWN key purpose: no timestamp goes on
// the cravings wire, and a plain `(saved_at, id)` cursor would put the exact
// save time back. AES-256-GCM over the last row's sort key and its
// `bookmarks.id` (the integer, never the wine-id `key`):
//   recent: saved_at in epoch MICROSECONDS (timestamptz(6); a JS Date would
//           truncate to ms and skip the rest of that millisecond),
//   score:  the gated score × 4 (quarter steps), or the NULL marker (an
//           unscored row: a tuple compare with a NULL is NULL, so the next
//           page must know which side of the boundary it is on).
// The associated data binds a cursor to (viewer, owner, the sort ACTUALLY
// applied, q): a `score` request served as `recent` (posts hidden) seals as
// `recent`. A tampered or mismatched cursor opens to null (an empty page).
//
// Layout (base64url): version (1) ‖ nonce (12) ‖ ciphertext (14) ‖ tag (16).
// Plaintext: sort (1: 0 recent, 1 score) ‖ null (1) ‖ value (8) ‖ id (4).
const VERSION = 1
const PURPOSE = 'cravings-cursor:v1'
const PLAIN = 14

export type CravingsSort = 'recent' | 'score'
export type CravingsCursor =
  | { sort: 'recent'; atUs: bigint; id: number }
  | { sort: 'score'; quarters: number | null; id: number }
export type CravingsCursorScope = { viewerId: number; ownerId: number; sort: CravingsSort; q: string }

const aad = (s: CravingsCursorScope) => Buffer.from(JSON.stringify(['cravings', s.viewerId, s.ownerId, s.sort, s.q]))

export function sealCravingsCursor(c: CravingsCursor, scope: CravingsCursorScope): string {
  const plain = Buffer.alloc(PLAIN)
  plain.writeUInt8(c.sort === 'recent' ? 0 : 1, 0)
  if (c.sort === 'recent') plain.writeBigInt64BE(c.atUs, 2)
  else if (c.quarters === null) plain.writeUInt8(1, 1)
  else plain.writeBigInt64BE(BigInt(c.quarters), 2)
  plain.writeUInt32BE(c.id, 10)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derivedKey(PURPOSE), nonce)
  cipher.setAAD(aad(scope))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]).toString('base64url')
}

export function openCravingsCursor(raw: string, scope: CravingsCursorScope): CravingsCursor | null {
  if (raw.length > 128) return null
  const buf = Buffer.from(raw, 'base64url')
  if (buf.length !== 1 + 12 + PLAIN + 16 || buf[0] !== VERSION) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', derivedKey(PURPOSE), buf.subarray(1, 13))
    decipher.setAAD(aad(scope))
    decipher.setAuthTag(buf.subarray(13 + PLAIN))
    const plain = Buffer.concat([decipher.update(buf.subarray(13, 13 + PLAIN)), decipher.final()])
    const sort: CravingsSort = plain.readUInt8(0) === 0 ? 'recent' : 'score'
    if (sort !== scope.sort) return null
    const id = plain.readUInt32BE(10)
    if (id < 1) return null
    if (sort === 'recent') return { sort, atUs: plain.readBigInt64BE(2), id }
    const quarters = plain.readUInt8(1) === 1 ? null : Number(plain.readBigInt64BE(2))
    if (quarters !== null && (quarters < 1 || quarters > 20)) return null
    return { sort, quarters, id }
  } catch {
    return null
  }
}
