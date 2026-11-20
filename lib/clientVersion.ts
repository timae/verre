// Server side of the X-Verre-Client version handshake (proposal 04 §3–3a).
//
// Header shape: `<platform>/<nativeVersion>/<otaUpdateId|embedded>`, e.g.
// `ios/0.1.0/embedded`. Web clients never send the header, so the gate is a
// no-op for every web request. Floor envs: NATIVE_MIN_VERSION_IOS /
// NATIVE_MIN_VERSION_ANDROID; store link for the update screen:
// NATIVE_STORE_URL_IOS / NATIVE_STORE_URL_ANDROID.
//
// 🔒 A FLOOR IN CODE: iOS is gated at max(env, CODE_FLOOR_IOS). Public user
// ids (public-user-ids § 6, D1) are one cutover with no dual-accept window, so
// the floor ships in the same release as the wire change; an env var loads at
// boot, and setting it after the deploy would be a second rolling release.
// Raise CODE_FLOOR_IOS only with a breaking wire change, in that change.
//
// Enforced on EVERY API call: proxy.ts runs this gate for /api/* (an old app
// left in the foreground polls the moment screen without re-running
// get-session), and the native-auth route wrapper (app/api/auth/native/[...all])
// keeps it as the belt for sign-in / sign-up / get-session.
//
// 🔒 IMPORT-FREE: this module sits in the proxy's graph (eslint.config.mjs).

export const CODE_FLOOR_IOS = '0.1.5'

// The web's wire generation, sent as `X-Verre-Web` on every /api/session call
// (lib/sessionFetch.ts webApiFetch). proxy.ts bounces a signed-in moment call
// without it (an old tab), and refuses every moment WRITE without it (409); a
// future breaking wire change bumps it. Lives here because this module is the
// one both the proxy and the client may import.
// 3: client occurrence ids + the separate image call (catalogue model change
// step 3).
export const WEB_WIRE_GENERATION = '3'

const HEADER = /^(ios|android)\/(\d+(?:\.\d+){0,2})\/\S+$/

function floorFor(platform: string): string | undefined {
  if (platform === 'ios') {
    const env = process.env.NATIVE_MIN_VERSION_IOS
    return env && cmpVersions(env, CODE_FLOOR_IOS) > 0 ? env : CODE_FLOOR_IOS
  }
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
    // (iOS always has a floor now, so this always gates.)
    return updateRequired(null, null)
  }
  const [, platform, version] = m
  const floor = floorFor(platform)
  if (!floor || cmpVersions(version, floor) >= 0) return null
  return updateRequired(floor, platform)
}
