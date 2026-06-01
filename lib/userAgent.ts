// Hand-rolled User-Agent → short device label parser for the "Connected
// devices" panel. No dependency: a UA-parsing lib would be overkill for a
// "good enough, is-this-me?" label. The RAW User-Agent is NEVER persisted
// (privacy minimisation, proposal §4) — only the derived label below.
//
// Goal output: "MacBook · Chrome", "iPhone · Safari", "Android · Chrome",
// "Windows · Firefox". Falls back to "Unknown device" when nothing matches.
// Capped at VarChar(64) by the column; the labels we emit are far shorter.

const MAX_LABEL = 64

function parseOS(ua: string): string | null {
  // Order matters: iPhone/iPad UAs also contain "Mac OS X"-ish tokens, and
  // Android UAs contain "Linux", so check the more specific tokens first.
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Macintosh|Mac OS X/.test(ua)) return 'MacBook'
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
