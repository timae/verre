import { hkdfSync } from 'node:crypto'

// A per-purpose 32-byte key derived (HKDF-SHA256) from the server secret chain
// lib/registerToken.ts uses (`AUTH_SECRET || NEXTAUTH_SECRET || JWT_SECRET`),
// so every instance agrees and no new env var exists. 🔒 THROWS when none is
// set, in every environment: an empty key would make whatever it seals or
// signs forgeable (lib/betterAuth.ts falls back to '' for its own secret; this
// must not). Keys are cached per purpose.
const cache = new Map<string, Buffer>()

export function derivedKey(purpose: string): Buffer {
  const hit = cache.get(purpose)
  if (hit) return hit
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET
  if (!secret) throw new Error(`[serverSecret] AUTH_SECRET (or NEXTAUTH_SECRET / JWT_SECRET) must be set (${purpose})`)
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `verre:${purpose}`, 32))
  cache.set(purpose, key)
  return key
}
