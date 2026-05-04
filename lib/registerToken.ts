import { createHmac, timingSafeEqual } from 'node:crypto'

const MIN_AGE_MS = 800
const MAX_AGE_MS = 30 * 60 * 1000

function getSecret(): string {
  const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET
  if (s) return s
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET (or NEXTAUTH_SECRET / JWT_SECRET) must be set in production')
  }
  if (!warnedDev) { console.warn('[registerToken] no secret in env — using dev-only fallback'); warnedDev = true }
  return 'dev-only-insecure-secret-do-not-use-in-prod'
}
let warnedDev = false

function sign(payload: string): string {
  return createHmac('sha256', getSecret()).update(payload).digest('base64url')
}

export function signRegisterToken(): string {
  const ts = Date.now().toString()
  return `${ts}.${sign(`register:${ts}`)}`
}

export type VerifyResult =
  | { ok: true; ageMs: number }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'too-fast' | 'expired' }

export function verifyRegisterToken(token: unknown): VerifyResult {
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' }
  const dot = token.indexOf('.')
  if (dot < 1) return { ok: false, reason: 'malformed' }
  const ts = token.slice(0, dot)
  const got = token.slice(dot + 1)
  if (!/^\d+$/.test(ts)) return { ok: false, reason: 'malformed' }

  const expected = sign(`register:${ts}`)
  const a = Buffer.from(got)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' }

  const ageMs = Date.now() - Number(ts)
  if (ageMs < MIN_AGE_MS) return { ok: false, reason: 'too-fast' }
  if (ageMs > MAX_AGE_MS) return { ok: false, reason: 'expired' }
  return { ok: true, ageMs }
}
