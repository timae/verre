// Moment Visibility, step 2: the look-in link's web page (`/l/<id>.<token>`,
// step-2 plan § 5 + § 7.1) against the BUILT server: the headers come from
// next.config.ts (a later `headers()` entry overriding the site-wide one), which
// no route-module test can see.
//   § 1 flag on, a well-formed link: 200, Referrer-Policy no-referrer, a
//       Cache-Control with no-store, X-Robots-Tag noindex, the button's href
//       exactly `io.verre.app://l/<link>`, no other-origin URL in the HTML, no
//       Set-Cookie for a signed-out request
//   § 2 malformed: "This link doesn't work", no button, no `io.verre.app`
//   § 3 flag off: 404
//
// Needs a production build (`npm run build`) and a throwaway Postgres + Redis
// (the root layout runs auth(); the page itself reads neither):
//
//   DATABASE_URL=postgres://…/<throwaway> REDIS_URL=redis://…:<throwaway> \
//   AUTH_SECRET=… npx tsx scripts/tests/moment-link-web.mts [--next-start]
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB = process.env.DATABASE_URL ?? ''
if (!DB || /\/verre(\?|$)/.test(DB)) throw new Error('refusing to run: DATABASE_URL must point at a THROWAWAY database (never the dev db `verre`)')
if (!process.env.REDIS_URL) throw new Error('refusing to run: REDIS_URL must be set explicitly to a THROWAWAY Redis')
if (!process.env.AUTH_SECRET) throw new Error('AUTH_SECRET is required')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const useNextStart = process.argv.includes('--next-start')
const standalone = join(ROOT, '.next', 'standalone', 'server.js')
if (!existsSync(join(ROOT, '.next', 'BUILD_ID'))) throw new Error('no production build: run `npm run build` first')
if (!useNextStart && !existsSync(standalone)) throw new Error('no .next/standalone/server.js: run `npm run build` (output: standalone), or pass --next-start')

let pass = 0
let failed = 0
function check(label: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) })
})

// One server per flag value (the flag is read per request from the server's env).
async function withServer(flag: boolean, run: (base: string) => Promise<void>) {
  const port = await freePort()
  const BASE = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production', AUTH_URL: BASE, AUTH_TRUST_HOST: 'true' }
  if (flag) env.MOMENT_LOOKIN_ENABLED = 'true'
  else delete env.MOMENT_LOOKIN_ENABLED
  let server: ChildProcess | null = null
  let log = ''
  try {
    server = useNextStart
      ? spawn('npx', ['next', 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('node', [standalone], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout?.on('data', d => { log += String(d) })
    server.stderr?.on('data', d => { log += String(d) })
    let up = false
    for (let i = 0; i < 120 && !up; i++) {
      if (server.exitCode !== null) throw new Error(`the server exited (${server.exitCode}):\n${log.slice(-2000)}`)
      up = await fetch(`${BASE}/login`, { redirect: 'manual', signal: AbortSignal.timeout(5000) }).then(r => r.status < 500, () => false)
      if (!up) await sleep(500)
    }
    if (!up) throw new Error(`the server did not come up:\n${log.slice(-2000)}`)
    console.log(`\nserver: ${useNextStart ? 'next start' : 'node .next/standalone/server.js'} on ${BASE}, MOMENT_LOOKIN_ENABLED ${flag ? 'on' : 'off'}`)
    await run(BASE)
  } finally {
    // Gone before the next server starts (they share .next).
    if (server && server.exitCode === null) {
      const exited = new Promise<void>(r => server!.once('exit', () => r()))
      server.kill('SIGTERM')
      await Promise.race([exited, sleep(5000).then(() => { server!.kill('SIGKILL') })])
    }
  }
}

const get = async (base: string, path: string) => {
  const r = await fetch(`${base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(20000) })
  return { status: r.status, headers: r.headers, text: await r.text() }
}
// A link shaped like lib/momentLink.ts writes it: the public id lowercase, 32 hex.
const LINK = 'h7k2m9p4q8r3.0123456789abcdef0123456789abcdef'
const HREF = `io.verre.app://l/${LINK}`
const noStore = (v: string | null) => (v ?? '').split(',').map(x => x.trim().toLowerCase()).includes('no-store')
// Every absolute URL in the HTML (attributes, inline scripts, the RSC payload)
// other than the page's own origin. The button's own `io.verre.app://` link is
// the app's address, not a resource: taken out before the scan.
const foreignUrls = (html: string, base: string) =>
  [...html.replaceAll(/io\.verre\.app:\/\/l\/[0-9a-z.]+/gi, '').matchAll(/(?:https?:)?\/\/[a-z0-9.-]+(?::\d+)?[^\s"'<>\\)]*/gi)].map(m => m[0])
    .filter(u => !u.startsWith(base) && !u.startsWith(base.replace('http:', '')) && !/^\/\/(www\.)?w3\.org\//.test(u.replace(/^https?:/, '')))

try {
  await withServer(true, async base => {
    console.log('\n§ 1 a well-formed link')
    const r = await get(base, `/l/${LINK}`)
    check('200', r.status === 200, r.status)
    check('🔒 Referrer-Policy: no-referrer (the later entry overrides the site-wide strict-origin-when-cross-origin)', r.headers.get('referrer-policy') === 'no-referrer', r.headers.get('referrer-policy'))
    check('🔒 Cache-Control carries no-store', noStore(r.headers.get('cache-control')), r.headers.get('cache-control'))
    check('X-Robots-Tag: noindex', (r.headers.get('x-robots-tag') ?? '').includes('noindex'), r.headers.get('x-robots-tag'))
    check('…and the robots meta noindex', /<meta name="robots" content="noindex/.test(r.text))
    check('the site-wide headers still apply (X-Frame-Options)', r.headers.get('x-frame-options') === 'DENY')
    const hrefs = [...r.text.matchAll(/href="([^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&'))
    check('🔒 the button\'s href is exactly io.verre.app://l/<link>', hrefs.includes(HREF) && hrefs.filter(h => h.startsWith('io.verre.app')).length === 1, hrefs.filter(h => h.startsWith('io.')))
    check('the ruled copy: "Before you continue", "You\'ll need a phone with the app installed.", "Open in Verre"',
      r.text.includes('Before you continue') && /You(&#x27;|&apos;|')ll need a phone with the app installed\./.test(r.text) && r.text.includes('Open in Verre'))
    const foreign = foreignUrls(r.text, base)
    check('🔒 no other-origin URL anywhere in the HTML (no third-party resource)', foreign.length === 0, foreign.slice(0, 5))
    check('🔒 a signed-out request gets no Set-Cookie', r.headers.get('set-cookie') === null, r.headers.get('set-cookie'))
    const upper = await get(base, `/l/${LINK.toUpperCase()}`)
    check('an upper-cased link: the same button, its href lower-cased (rebuilt, never echoed)', upper.status === 200 && upper.text.includes(`href="${HREF}"`))

    console.log('\n§ 2 malformed')
    const bad = ['h7k2m9p4q8r3', `h7k2m9p4q8r3.${'0'.repeat(31)}`, `h7k2m9p4q8r3.${'g'.repeat(32)}`, `h7k2m9p4q8r.${'0'.repeat(32)}`, `i7k2m9p4q8r3.${'0'.repeat(32)}`,
      `h7k2m9p4q8r3.${'0'.repeat(32)}.x`, `h7k2m9p4q8r3.${'0'.repeat(32)}%22onclick%3D`, '%3Cscript%3E']
    for (const b of bad) {
      const m = await get(base, `/l/${b}`)
      check(`"${decodeURIComponent(b).slice(0, 48)}": "This link doesn't work", no button, no io.verre.app`,
        m.status === 200 && /This link doesn(&#x27;|&apos;|')t work/.test(m.text) && !m.text.includes('io.verre.app') && !m.text.includes('Open in Verre') && m.headers.get('referrer-policy') === 'no-referrer',
        { status: m.status })
    }
    const deeper = await get(base, `/l/${LINK}/x`)
    check('a deeper path: 404', deeper.status === 404, deeper.status)
  })
  await withServer(false, async base => {
    console.log('\n§ 3 the flag off')
    const r = await get(base, `/l/${LINK}`)
    check('🔒 404, no button', r.status === 404 && !r.text.includes('io.verre.app'), r.status)
  })
} catch (err) {
  failed++
  console.log(`  ❌ the suite crashed: ${err instanceof Error ? err.stack : String(err)}`)
}
console.log(`\n${pass} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
