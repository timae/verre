// Hand-rolled User-Agent → short device label parser for the "Connected
// devices" panel. No dependency: a UA-parsing lib would be overkill for a
// "good enough, is-this-me?" label. The RAW User-Agent is NEVER persisted
// (privacy minimisation, proposal §4) — only the derived label below.
//
// Goal output: "Mac · Chrome", "iPhone · Safari", "Android · Chrome",
// "Windows · Firefox". Falls back to "Unknown device" when nothing matches.
// Capped at VarChar(64) by the column; the labels we emit are far shorter.

const MAX_LABEL = 64

function parseOS(ua: string): string | null {
  // Order matters: iPhone/iPad UAs also contain "Mac OS X"-ish tokens, and
  // Android UAs contain "Linux", so check the more specific tokens first.
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  // Every Mac browser sends the same frozen UA: the model is unknowable.
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows'
  if (/CrOS/.test(ua)) return 'Chromebook'
  if (/Linux/.test(ua)) return 'Linux'
  return null
}

function parseBrowser(ua: string): string | null {
  // Order matters: Edge UA contains "Chrome" and "Safari"; Chrome UA contains
  // "Safari". Check the most-specific brand first, generic Safari last.
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\/|Opera/.test(ua)) return 'Opera'
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Chrome\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return null
}

// The native app's own User-Agent (apps/mobile/src/lib/authClient.ts):
// `Verre/<version> (<model>; iOS <version>)`, model from expo-device, e.g.
// "Verre/1.0.0 (iPhone 15 Pro; iOS 26.1)" → "iPhone 15 Pro · Verre App".
// 🔒 Called ONLY from the Better Auth session.create.before hook (a NATIVE
// sign-in), never from the web login, so a browser can't claim "Verre App".
// Strict shape: the model's character class is the scrub (no control, bidi or
// zero-width character can match), and the label stays far under the column's
// 64. Anything else → null, and the caller falls back to parseUserAgent.
const NATIVE_UA = /^Verre\/[0-9][0-9A-Za-z.+-]{0,31} \(([A-Za-z0-9 ,.()-]{1,40}); iOS [0-9][0-9.]{0,15}\)$/
export function parseNativeUserAgent(ua: string | null | undefined): string | null {
  if (!ua || typeof ua !== 'string') return null
  const model = NATIVE_UA.exec(ua)?.[1]?.replace(/\s+/g, ' ').trim()
  return model ? `${model} · Verre App`.slice(0, MAX_LABEL) : null
}

// Returns a short "OS · Browser" label, or a partial label, or
// "Unknown device" if neither token resolves. Never throws.
export function parseUserAgent(ua: string | null | undefined): string {
  if (!ua || typeof ua !== 'string') return 'Unknown device'
  const os = parseOS(ua)
  const browser = parseBrowser(ua)
  if (os && browser) return `${os} · ${browser}`.slice(0, MAX_LABEL)
  if (os) return os.slice(0, MAX_LABEL)
  if (browser) return browser.slice(0, MAX_LABEL)
  return 'Unknown device'
}
