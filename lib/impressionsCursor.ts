// The Impressions list's page cursor: the sort it was made for, the last row's
// score in HUNDREDTHS (score sorts only; `-` = unrated; exact for the
// Decimal(3,2) column, so a value off the quarter grid still pages), and its plain
// keyset cursor (lib/keyCursor.ts: the post time as µs text + the rating id).
// Plain, not sealed like the Cravings cursor: the score and the date are on
// the row anyway. A cursor made for another sort opens to null (an empty
// page), like a malformed one.
import { encodeKeyCursor, parseKeyCursor } from '@/lib/keyCursor'

export type ImpressionSort = 'newest' | 'oldest' | 'highest' | 'lowest'
export type ImpressionsCursor = { key: string; id: number; cents: number | null }

const TAG: Record<ImpressionSort, string> = { newest: 'n', oldest: 'o', highest: 'h', lowest: 'l' }
export const isScoreSort = (s: ImpressionSort) => s === 'highest' || s === 'lowest'

export function parseImpressionSort(v: string | null): ImpressionSort {
  return v === 'oldest' || v === 'highest' || v === 'lowest' ? v : 'newest'
}

export function encodeImpressionsCursor(sort: ImpressionSort, c: ImpressionsCursor): string {
  const q = isScoreSort(sort) && c.cents !== null ? String(c.cents) : '-'
  return Buffer.from(`${TAG[sort]}.${q}.${encodeKeyCursor(c.key, c.id)}`).toString('base64url')
}

export function parseImpressionsCursor(raw: string, sort: ImpressionSort): ImpressionsCursor | null {
  if (raw.length > 256) return null
  const m = /^([nohl])\.(-|[1-9]\d{0,2})\.([A-Za-z0-9_-]+)$/.exec(Buffer.from(raw, 'base64url').toString('utf8'))
  if (!m || m[1] !== TAG[sort]) return null
  if (!isScoreSort(sort) && m[2] !== '-') return null
  const inner = parseKeyCursor(m[3])
  return inner ? { ...inner, cents: m[2] === '-' ? null : Number(m[2]) } : null
}
