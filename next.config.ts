import type { NextConfig } from 'next'

// Server Actions check the Origin header for CSRF. localhost:8080 is always
// allowed for local dev; deployed instances add their public hostname via
// SERVER_ACTIONS_ALLOWED_ORIGINS (comma-separated, host:port, no scheme).
const extraOrigins = (process.env.SERVER_ACTIONS_ALLOWED_ORIGINS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)

// App-wide security-header baseline. Applied to every route (the catch-all
// source) so the auth surface — and everything else — carries them. Deliberately
// conservative: these four are safe defaults that don't depend on per-route
// vetting (unlike a Content-Security-Policy, which needs the inline-style/script
// + S3 image-origin inventory and is intentionally NOT included here yet).
//
//   Referrer-Policy: strict-origin-when-cross-origin
//     Defence-in-depth for the credential-in-URL class (see LoginForm's
//     method="post" comment): even if a token ever lands in a URL, the full
//     path+query is never sent in the Referer to a cross-origin destination —
//     only the bare origin. Same value Next/Vercel ship as the modern default.
//   X-Frame-Options: DENY
//     Clickjacking: the login form (and the whole app) cannot be framed. The app
//     embeds nothing of its own in frames, so DENY is safe. (CSP frame-ancestors
//     is the successor; X-Frame-Options is the broadly-honoured floor.)
//   X-Content-Type-Options: nosniff
//     Stops MIME-sniffing a response into an executable type.
//   Strict-Transport-Security
//     Forces HTTPS for a year incl. subdomains. Honoured only over HTTPS (no
//     effect on local http://localhost dev), so it's safe to send everywhere;
//     production is HTTPS-only behind Deplo.io. `preload` is intentionally
//     omitted — it's a hard-to-reverse commitment (browser-baked) and should be
//     a deliberate, separate decision, not bundled into a baseline.
const securityHeaders = [
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
]

const config: NextConfig = {
  output: 'standalone',
  experimental: {
    serverActions: { allowedOrigins: ['localhost:8080', ...extraOrigins] },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default config
