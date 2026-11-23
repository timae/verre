import { createHmac, timingSafeEqual } from 'node:crypto'
import { normalizePublicUserId } from '@verre/core'
import { momentLookInEnabled } from '@/lib/momentGate'

// The look-in link (docs/dev/proposals/moment-visibility.md § 4): a moment's
// PUBLIC id plus a token derived from a server secret and the row's
// `link_version`. Nothing secret is stored: Reset and "Share on a link that is
// off" raise the version (lib/momentSettings.ts), which changes the token.
//
//   token = first 16 bytes of
//           HMAC-SHA256(secret, "verre-moment-link-v1" ‖ 0x00 ‖ PUBLICID ‖ 0x00 ‖ version), hex
//   link  = <base URL>/l/<publicId, lowercase>.<token>
//
// 🔒 The secret fails CLOSED: absent or shorter than 32 characters → links are
// off (no fallback, never AUTH_SECRET). It must be identical on every instance;
// rotating it kills every link (docs/dev/deployment.md § MOMENT_LINK_SECRET).
// 🔒 The token never enters meta, any cache, a log line or an error report.

const CONTEXT = 'verre-moment-link-v1'

// The app's own address, which the `/l/` page's "Open in Verre" button uses
// (step-2 plan T12). The SAME value as the app's `APP_SCHEME`
// (apps/mobile/src/lib/config.ts), a release placeholder: a change before
// TestFlight changes both. The page builds the button per request, so links
// already shared keep working.
export const APP_LINK_SCHEME = 'io.verre.app'
const TOKEN_RE = /^[0-9a-f]{32}$/

function secret(): string | null {
  const s = process.env.MOMENT_LINK_SECRET
  return s && s.length >= 32 ? s : null
}

export function momentLinksAvailable(): boolean {
  return secret() !== null
}

// null = no link: the secret is unusable, the id is not a public id (the same
// format check as a user's; it keeps the 0x00 framing unambiguous whatever a
// caller passes in), or the version is not a whole number from 1 up (a link
// only exists after a Share, which raises the version to 1; a NULL read as 0
// can never verify).
export function momentLinkToken(publicId: string, version: number): string | null {
  const key = secret()
  const id = normalizePublicUserId(publicId)
  if (!key || !id || !Number.isSafeInteger(version) || version < 1) return null
  return createHmac('sha256', key)
    .update(`${CONTEXT}\0${id}\0${version}`)
    .digest().subarray(0, 16).toString('hex')
}

// Constant-time. The HMAC is computed whatever the token looks like, so a
// malformed token costs what a wrong one costs.
export function verifyMomentLinkToken(publicId: string, version: number, token: string): boolean {
  const expected = momentLinkToken(publicId, version)
  if (!expected) return false
  const given = TOKEN_RE.test(token) ? token : '0'.repeat(32)
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex')) && given === token
}

// The same base-URL chain as lib/betterAuth.ts.
function baseUrl(): string {
  return (process.env.AUTH_URL || process.env.BETTER_AUTH_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/+$/, '')
}

export function momentLinkUrl(publicId: string, version: number): string | null {
  const token = momentLinkToken(publicId, version)
  return token ? `${baseUrl()}/l/${publicId.toLowerCase()}.${token}` : null
}

// One line at boot (instrumentation-node.ts): the feature is on and no link can work.
export function warnIfMomentLinksOff(): void {
  if (momentLookInEnabled() && !momentLinksAvailable()) {
    console.error('[moment-link] MOMENT_LOOKIN_ENABLED is on but MOMENT_LINK_SECRET is absent or shorter than 32 characters: look-in links are off')
  }
}
