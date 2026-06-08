// Server-only session-code carve-outs. The pure exports (normalizeCode,
// validateCodeInput, formatCode, formatCodeInput, ALPHABET, VALID_LENGTHS,
// CANONICAL_LENGTH, CodeValidationResult) moved to @verre/core so the native
// app can share them. What stays here:
//   - genCode: mints a code via node:crypto, which Metro rejects (and the RN
//     app never mints codes).
//   - sessionPath/joinPath: web URL builders RN navigation doesn't use.

import crypto from 'crypto'
import { ALPHABET, CANONICAL_LENGTH, formatCode } from '@verre/core'

export function genCode(): string {
  const buf = crypto.randomBytes(CANONICAL_LENGTH)
  let out = ''
  for (let i = 0; i < CANONICAL_LENGTH; i++) {
    out += ALPHABET[buf[i] % ALPHABET.length]
  }
  return out
}

// URL builders. Codes in URLs use the formatted (hyphenated for 8-char) form
// so share links read cleanly off-app. Server entry points run normalizeCode
// which strips the hyphen — so URLs accept either form, but the rendered form
// is the hyphenated one. Use these helpers everywhere a session URL is built;
// raw `/session/${code}` interpolation creates display drift.
export function sessionPath(code: string, sub?: string): string {
  const base = `/session/${formatCode(code)}`
  return sub ? `${base}/${sub}` : base
}

export function joinPath(code: string): string {
  return `/join/${formatCode(code)}`
}
