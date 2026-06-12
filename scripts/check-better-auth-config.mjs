#!/usr/bin/env node
// CI gate: Better Auth's cookieCache MUST stay OFF and the JWT plugin MUST never
// be enabled (proposal §6.3 / §5a). Both cache/embed session data the server
// can't revoke on another device → they re-open exactly the hole Verre's
// never-cache-auth invariant (lib/CLAUDE.md) forbids, and cookieCache was the
// root of a HIGH 2FA-bypass (GHSA-xg6x-h9c9-2m83).
//
// A STATIC check (parse lib/betterAuth.ts source), not a runtime import: the
// config imports lib/redis + lib/prisma, which a bare CI job has no connection
// to. Static parsing fails the build on any flip without needing live infra.
//
// Run: node scripts/check-better-auth-config.mjs   (exits 1 on violation)

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const FILE = 'lib/betterAuth.ts'
const errors = []

if (!existsSync(FILE)) {
  console.error(`check-better-auth-config: ERROR — ${FILE} not found. Run from the repo root.`)
  process.exit(1)
}

// Strip line + block comments so a commented example can't trip or mask the check.
const src = readFileSync(FILE, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

// 1. cookieCache must be explicitly disabled and never enabled.
if (/cookieCache\s*:\s*\{[^}]*enabled\s*:\s*true/.test(src)) {
  errors.push('cookieCache.enabled is set to TRUE — it must be false (never-cache-auth invariant).')
}
if (!/cookieCache\s*:\s*\{[^}]*enabled\s*:\s*false/.test(src)) {
  errors.push('cookieCache.enabled:false not found — it must be explicitly disabled (defense against a future default flip).')
}

// 2. The JWT plugin must never be enabled (self-contained tokens the DB can't revoke).
//    1.6.x exports it from BOTH `better-auth/plugins` and the `better-auth/plugins/jwt`
//    subpath — match either import, so a subpath import can't evade the gate.
if (/from\s+['"]better-auth\/plugins(\/jwt)?['"]/.test(src) && /\bjwt\s*\(/.test(src)) {
  errors.push('the JWT plugin appears to be enabled — never enable it (DB-unrevocable tokens).')
}

// 3. Version floor + exact pin. <1.6.13 reopens the nOAuth account-takeover
//    (GHSA-g38m-r43w-p2q7); a range pin (^/~) lets npm silently move an auth
//    library — upgrades must be deliberate (review changelog, re-run gates).
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const pin = pkg.dependencies?.['better-auth'] ?? ''
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pin)
if (!m) {
  errors.push(`better-auth must be pinned to an exact version (found "${pin}") — no ^/~ ranges on the auth library.`)
} else {
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const atLeast = maj > 1 || (maj === 1 && (min > 6 || (min === 6 && pat >= 13)))
  if (!atLeast) errors.push(`better-auth ${pin} is below the 1.6.13 floor (nOAuth fix GHSA-g38m-r43w-p2q7).`)
}

// 4. lib/betterAuth.ts must be the ONLY betterAuth() instance. Checks 1–3 only
//    parse that one file — a second instance anywhere else (e.g. a test helper
//    with cookieCache on, or the JWT plugin) would escape every check above.
//    `\bbetterAuth\s*\(` matches the call, not the import line or the
//    betterAuthServer.api usages (\b + the paren).
const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean)
const CALL = /\bbetterAuth\s*\(/
for (const f of tracked) {
  if (f === FILE || !(f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mjs') || f.endsWith('.js'))) continue
  if (f === 'scripts/check-better-auth-config.mjs') continue // own error-message string
  const body = readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  if (CALL.test(body)) {
    errors.push(`${f} instantiates betterAuth() — ${FILE} must be the only instance (this gate only audits that file).`)
  }
}

// 5. The disabledPaths scope clamp must contain every endpoint we've deemed
//    live-but-wrong. The catch-all mounts EVERY core BA endpoint; the entire
//    "safe-by-construction" argument rests on this deny-list staying intact, so
//    a future edit / merge that drops an entry (re-arming a dangerous endpoint:
//    a password oracle, an avatar-pipeline bypass, a credential-store divergence
//    primitive, an email-change+session-mint) must FAIL the build, not silently
//    re-open the surface. Static-parse the array literal (comments already
//    stripped from `src`); each entry must appear as a quoted string.
//
//    SCOPE OF THIS GUARANTEE: "the endpoints in REQUIRED_DISABLED stay denied" — NOT
//    "no dangerous BA endpoint is ever live." It can't detect a NEW live-but-
//    wrong endpoint introduced by a future BA upgrade (a new /change-username,
//    a passkey route, …). The compensating control is the EXACT version pin
//    (check #3 above): a BA upgrade is deliberate and MUST re-audit the mounted
//    surface (re-run the endpoint enumeration) before bumping the pin.
const REQUIRED_DISABLED = [
  '/update-user',
  '/verify-password',
  '/reset-password',
  '/request-password-reset',
  '/verify-email',
  '/send-verification-email',
  '/change-email',
  '/unlink-account',
  '/update-session',
  '/list-sessions',
  '/revoke-session',
]
// NOTE: /get-session was deliberately REMOVED from this list with the first
// native client (iOS milestone 1): @better-auth/expo's useSession + sliding-
// refresh fetch it over HTTP (the SDK has no method-call path), so denying it
// broke the SDK's entire session lifecycle. It returns only the caller's OWN
// current token (already held as the cookie); the cross-device token leak is
// /list-sessions, which stays denied.
const dpMatch = /disabledPaths\s*:\s*\[([\s\S]*?)\]/.exec(src)
if (!dpMatch) {
  errors.push('disabledPaths array not found — the scope clamp is missing (every core BA endpoint would be live).')
} else {
  const body = dpMatch[1]
  for (const path of REQUIRED_DISABLED) {
    // match the path as a quoted string element (single or double quotes)
    if (!new RegExp(`['"]${path.replace(/[/]/g, '\\/')}['"]`).test(body)) {
      errors.push(`disabledPaths is missing "${path}" — that endpoint is live-but-wrong and must stay 404 (see lib/betterAuth.ts scope-clamp rationale).`)
    }
  }
}

// 6. Native-client config invariants (iOS milestone 1):
//    a. The expo-origin bridge plugin must stay wired (vendored from
//       @better-auth/expo@1.6.15 — see the plugins comment in lib/betterAuth.ts
//       for why it's not the package import). Without it BA never sees the
//       Expo client's `expo-origin` header and native cookie-bearing requests
//       fail the origin check (a silent native-wide breakage, not a security
//       hole — but config drift on the auth surface must be deliberate).
//    b. The app scheme must stay in trustedOrigins WITH its trailing `://` —
//       custom-scheme entries match by string prefix (trusted-origins.mjs), so
//       a bare 'io.verre.app' would also match 'io.verre.appevil://'.
//    c. No catch-all wildcard origins: '*' / 'http://*' / 'https://*' as a
//       whole entry disables the origin check (BA's documented footgun).
//    ⚠️ 6b/6c parse the RAW source, not `src`: the naive line-comment stripper
//    above eats the `//` INSIDE scheme-string literals ('io.verre.app://' →
//    'io.verre.app:'), so the stripped text can never match. Trade-off: a
//    commented-out scheme entry could satisfy 6b — accepted; 6a still fails if
//    the plugin import goes, and a review that comments out trustedOrigins
//    while keeping the plugin is beyond a static gate.
const rawSrc = readFileSync(FILE, 'utf8')
if (!/['"]expo-origin['"]/.test(rawSrc) || !/headers\.set\(\s*['"]origin['"]/.test(src)) {
  errors.push('the expo-origin → origin bridge plugin is not wired — native requests would fail the origin check.')
}
if (!/['"]io\.verre\.app:\/\/['"]/.test(rawSrc)) {
  errors.push("trustedOrigins is missing 'io.verre.app://' (the trailing :// is load-bearing — prefix matching).")
}
if (/trustedOrigins[\s\S]{0,400}?['"](?:\*|https?:\/\/\*)['"]/.test(rawSrc)) {
  errors.push('trustedOrigins contains a catch-all wildcard entry — that disables the origin check entirely.')
}
//    (6c catches source-literal wildcards only. The runtime env path —
//    SERVER_ACTIONS_ALLOWED_ORIGINS — could still inject one; that env is
//    operator-controlled and documented in docs/dev/deployment.md, beyond a
//    static gate.)

// 7. Native-client version LOCKSTEP: better-auth / @better-auth/expo /
//    @better-auth/core in apps/mobile must equal the root better-auth pin, and
//    the root `overrides` pin for core must too. The client SDK and server are
//    version-coupled (peer ^<pin>); a mobile-only bump silently splits the
//    pair (apps/mobile/CLAUDE.md "version lockstep is mandatory").
const MOBILE_PKG = 'apps/mobile/package.json'
if (existsSync(MOBILE_PKG)) {
  const mobile = JSON.parse(readFileSync(MOBILE_PKG, 'utf8'))
  for (const dep of ['better-auth', '@better-auth/expo', '@better-auth/core']) {
    const v = mobile.dependencies?.[dep]
    if (v !== pin) {
      errors.push(`${MOBILE_PKG}: ${dep} is "${v}" but root better-auth is pinned "${pin}" — BA packages move in lockstep, server included.`)
    }
  }
  const override = pkg.overrides?.['@better-auth/core']
  if (override !== pin) {
    errors.push(`root overrides["@better-auth/core"] is "${override}" but better-auth is pinned "${pin}" — bump them together.`)
  }
}

if (errors.length === 0) {
  console.log(`check-better-auth-config: OK — cookieCache off, no JWT plugin, exact pin >= 1.6.13, single instance, all ${REQUIRED_DISABLED.length} disabledPaths present, expo plugin + scheme origin pinned.`)
  process.exit(0)
}

console.error('check-better-auth-config: FAILED — Better Auth session config violates the never-cache-auth invariant:')
for (const e of errors) console.error(`  - ${e}`)
process.exit(1)
