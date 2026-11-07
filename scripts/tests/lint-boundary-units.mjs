// Pins the import allowlists in eslint.config.mjs that replace the old Edge-build
// failure (see lib/CLAUDE.md § Per-device sessions, app/CLAUDE.md § instrumentation):
// proxy.ts / auth.config.ts / instrumentation.ts must reject every way of pulling
// runtime code in, and accept the shapes the real files use. Lints source text
// through the real config, so a weakened selector fails here.
// Run: node scripts/tests/lint-boundary-units.mjs   (exits 1 on any mismatch)
import { ESLint } from 'eslint'

const BOUNDARY_RULES = new Set(['no-restricted-syntax', 'no-restricted-globals'])
const reg = (body) => `export async function register() {\n${body}\n}\n`
const guarded = (body) => reg(`  if (process.env.NEXT_RUNTIME === 'nodejs') { ${body} }`)
const BOUNDARY_FILES = ['proxy.ts', 'auth.config.ts', 'instrumentation.ts']
const LOADERS = [
  "const b = require('bcrypt'); export { b }",
  "import b = require('bcrypt'); export { b }",
  "const x = module.require('node:fs'); export { x }",
  "const x = module['require']('bcrypt'); export { x }",
  "const load = require; const x = load('bcrypt'); export { x }",
  "const x = globalThis.require('bcrypt'); export { x }",
  "const x = process.mainModule?.require('bcrypt'); export { x }",
  "const x = typeof require; export { x }",
  "const x = __non_webpack_require__('bcrypt'); export { x }",
]

const CASES = [
  // accepted: the real files' shapes
  ['proxy.ts', false, "import NextAuth from 'next-auth'\nimport { authConfig } from '@/auth.config'\nexport const proxy = NextAuth(authConfig).auth\nexport const config = { matcher: ['/me/:path*'] }\n"],
  ['proxy.ts', false, "import type { NextRequest } from 'next/server'\nexport const x = 1 as unknown as NextRequest\n"],
  ['auth.config.ts', false, "import type { NextAuthConfig } from 'next-auth'\nexport const authConfig: NextAuthConfig = { providers: [] }\n"],
  ['instrumentation.ts', false, guarded("await import('./instrumentation-node').then((m) => m.register())")],
  ['instrumentation.ts', false, guarded("if (Date.now() > 0) { await import('./x') }")],
  ['instrumentation.ts', false, "import type { X } from './x'\nexport async function register(x?: X) { return x }\n"],
  ['lib/other.ts', false, "import { prisma } from '@/lib/prisma'\nexport const p = prisma\n"],
  // proxy.ts: only next-auth + @/auth.config
  ['proxy.ts', true, "import { auth } from '@/auth'\nexport const proxy = auth\n"],
  ['proxy.ts', true, "import { prisma } from '@/lib/prisma'\nexport const p = prisma\n"],
  ['proxy.ts', true, "import x from './auth'\nexport const p = x\n"],
  ['proxy.ts', true, "import 'bcrypt'\n"],
  ['proxy.ts', true, "import { authConfig } from '@/auth.configX'\nexport const p = authConfig\n"],
  ['proxy.ts', true, "export async function proxy() { return import('@/auth') }\n"],
  ['proxy.ts', true, "export { auth as proxy } from '@/auth'\n"],
  ['proxy.ts', true, "export * from '@/auth'\n"],
  // auth.config.ts: import type only
  ['auth.config.ts', true, "import { prisma } from '@/lib/prisma'\nexport const a = prisma\n"],
  ['auth.config.ts', true, "import Credentials from 'next-auth/providers/credentials'\nexport const a = Credentials\n"],
  ['auth.config.ts', true, "export async function f() { return import('bcrypt') }\n"],
  // CommonJS loaders, in every boundary file
  ...BOUNDARY_FILES.flatMap((f) => LOADERS.map((src) => [f, true, src + '\n'])),
  // instrumentation.ts: no static imports; dynamic only in the exact compile-time branch
  ['instrumentation.ts', true, "import { ensureGeoData } from '@/lib/geoData'\n" + guarded('await ensureGeoData()')],
  ['instrumentation.ts', true, reg("  await import('./instrumentation-node')")],
  ['instrumentation.ts', true, reg("  if (process.env.NEXT_RUNTIME === 'edge') { await import('./x') }")],
  ['instrumentation.ts', true, reg("  if (process.env.NEXT_RUNTIME === 'nodejs') { } else { await import('./x') }")],
  ['instrumentation.ts', true, reg("  if (process.env.NEXT_RUNTIME !== 'nodejs') { await import('./x') }")],
  ['instrumentation.ts', true, reg("  if (process.env.NEXT_RUNTIME == 'nodejs') { await import('./x') }")],
  ['instrumentation.ts', true, reg("  if ('nodejs' === process.env.NEXT_RUNTIME) { await import('./x') }")],
  ['instrumentation.ts', true, reg("  const runtime = { NEXT_RUNTIME: 'nodejs' }\n  if (runtime.NEXT_RUNTIME === 'nodejs') { await import('node:fs') }")],
  ['instrumentation.ts', true, reg("  const env = process.env\n  if (env.NEXT_RUNTIME === 'nodejs') { await import('node:fs') }")],
  ['instrumentation.ts', true, reg("  if (process['env'].NEXT_RUNTIME === 'nodejs') { await import('node:fs') }")],
  ['instrumentation.ts', true, reg("  if (process.env['NEXT_RUNTIME'] === 'nodejs') { await import('node:fs') }")],
  ['instrumentation.ts', true, reg("  if (globalThis.process.env.NEXT_RUNTIME === 'nodejs') { await import('node:fs') }")],
  ['instrumentation.ts', true, reg("  if (process.env.NEXT_RUNTIME === `nodejs`) { await import('node:fs') }")],
  ['instrumentation.ts', true, reg("  const process = { env: { NEXT_RUNTIME: 'nodejs' } }\n  if (process.env.NEXT_RUNTIME === 'nodejs') { await import('node:fs') }")],
  ['instrumentation.ts', true, "export async function register(process = { env: { NEXT_RUNTIME: 'nodejs' } }) {\n  if (process.env.NEXT_RUNTIME === 'nodejs') { await import('node:fs') }\n}\n"],
  ['instrumentation.ts', true, reg("  const p = process\n  if (p.env.NEXT_RUNTIME === 'nodejs') { await import('node:fs') }")],
]

const eslint = new ESLint()
let failures = 0
for (const [filePath, shouldFlag, code] of CASES) {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: true })
  const fatal = result.messages.filter((m) => m.fatal)
  // A rejection must be an ERROR: check-lint.yml lets warnings through, so a
  // boundary rule downgraded to warn would stop blocking while still "flagging".
  const boundary = result.messages.filter((m) => BOUNDARY_RULES.has(m.ruleId))
  const ok = fatal.length === 0 && (shouldFlag ? boundary.some((m) => m.severity === 2) : boundary.length === 0)
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${filePath} ${shouldFlag ? 'rejects' : 'accepts'}: ${code.replace(/\s+/g, ' ').slice(0, 80)}${fatal.length ? ` — PARSE: ${fatal[0].message}` : ''}`)
}
console.log(failures === 0 ? `\nOK — ${CASES.length} lint-boundary pins pass.` : `\nFAILED — ${failures} of ${CASES.length} lint-boundary pins.`)
process.exit(failures === 0 ? 0 : 1)
