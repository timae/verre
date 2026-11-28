import { randomBytes, timingSafeEqual } from 'node:crypto'

// The look-in link (docs/dev/proposals/moment-visibility.md § 4): a moment's
// PUBLIC id plus a random code of its own, made when a link is shared after
// being off and at Reset (lib/momentSettings.ts `writeLinkAction`), stored on
// the moment (`sessions.link_code`, 0.2.0 build 2; replaced the HMAC over a
// server secret, so no `MOMENT_LINK_SECRET`).
//
//   code = 16 random bytes, hex
//   link = <base URL>/l/<publicId, lowercase>.<code>
//
// 🔒 Stored AS IS, not hashed (ruled 2026-11-27): "Share Link" on an active
// link and the settings read show the link again, which a hash could not. A
// database reader can then look into a moment with an active link, but the same
// reader already holds every moment's join code (`sessions.code`).
// 🔒 The code never enters meta, any cache, a log line or an error report.

// The app's own address, which the `/l/` page's "Open in Verre" button uses
// (step-2 plan T12). The SAME value as the app's `APP_SCHEME`
// (apps/mobile/src/lib/config.ts), a release placeholder: a change before
// TestFlight changes both. The page builds the button per request, so links
// already shared keep working.
export const APP_LINK_SCHEME = 'io.verre.app'
export const LINK_CODE_RE = /^[0-9a-f]{32}$/
const DUMMY = Buffer.alloc(16)

export const newMomentLinkCode = (): string => randomBytes(16).toString('hex')

// Constant-time. A malformed or missing value on either side is compared as
// zeros, so an unknown moment, a moment without a code and a wrong code cost
// the same; only two well-formed equal codes verify.
export function verifyMomentLinkCode(stored: string | null | undefined, given: string): boolean {
  const s = typeof stored === 'string' && LINK_CODE_RE.test(stored)
  const g = LINK_CODE_RE.test(given)
  const equal = timingSafeEqual(s ? Buffer.from(stored, 'hex') : DUMMY, g ? Buffer.from(given, 'hex') : DUMMY)
  return equal && s && g
}

// The same base-URL chain as lib/betterAuth.ts.
function baseUrl(): string {
  return (process.env.AUTH_URL || process.env.BETTER_AUTH_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/+$/, '')
}

export function momentLinkUrl(publicId: string, code: string | null): string | null {
  return code && LINK_CODE_RE.test(code) ? `${baseUrl()}/l/${publicId.toLowerCase()}.${code}` : null
}
