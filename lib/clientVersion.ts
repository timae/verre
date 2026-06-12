// Server side of the X-Verre-Client version handshake (proposal 04 §3–3a).
//
// Header shape: `<platform>/<nativeVersion>/<otaUpdateId|embedded>`, e.g.
// `ios/0.1.0/embedded`. Web clients never send the header, so the gate is a
// no-op for every web request. Floor envs (unset ⇒ no enforcement — the launch
// state): NATIVE_MIN_VERSION_IOS / NATIVE_MIN_VERSION_ANDROID; store link for
// the update screen: NATIVE_STORE_URL_IOS / NATIVE_STORE_URL_ANDROID.
//
// Enforced at the native-auth route wrapper (app/api/auth/native/[...all]) —
// the one chokepoint EVERY native session resolution passes through:
// @better-auth/expo's useSession + sliding-refresh hit /get-session over HTTP
// on every app launch/foreground, so a below-floor client lands on the
// blocking update screen at its next session refresh; it cannot sign in past
// the floor either. Verre API routes are deliberately not wired (51 call
// sites): a below-floor client that somehow keeps a live session only retains
// it until the next get-session refresh.

const HEADER = /^(ios|android)\/(\d+(?:\.\d+){0,2})\/\S+$/

function floorFor(platform: string): string | undefined {
  if (platform === 'ios') return process.env.NATIVE_MIN_VERSION_IOS
  if (platform === 'android') return process.env.NATIVE_MIN_VERSION_ANDROID
  return undefined
}

function storeUrlFor(platform: string | null): string | null {
  if (platform === 'ios') return process.env.NATIVE_STORE_URL_IOS ?? null
  if (platform === 'android') return process.env.NATIVE_STORE_URL_ANDROID ?? null
  return null
}

function cmpVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function updateRequired(minVersion: string | null, platform: string | null): Response {
  return Response.json(
    { error: 'update_required', minVersion, storeUrl: storeUrlFor(platform) },
    { status: 426 },
  )
}

// Returns a 426 response when the caller self-identifies as a native client
// below the configured floor, null otherwise (no header / no floor / current).
export function clientVersionGate(req: Request): Response | null {
  const header = req.headers.get('x-verre-client')
  if (!header) return null
  const m = HEADER.exec(header)
  if (!m) {
    // Malformed header from something claiming to be a native client: gate it
    // if ANY floor is configured (fail closed — a client that can't speak the
    // protocol correctly should update, and web never sends the header).
    const anyFloor = process.env.NATIVE_MIN_VERSION_IOS || process.env.NATIVE_MIN_VERSION_ANDROID
    return anyFloor ? updateRequired(null, null) : null
  }
  const [, platform, version] = m
  const floor = floorFor(platform)
  if (!floor || cmpVersions(version, floor) >= 0) return null
  return updateRequired(floor, platform)
}
