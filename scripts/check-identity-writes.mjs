#!/usr/bin/env node
// CI gate: lib/identityStore.ts is the ONLY code allowed to WRITE
// users.password_hash and user_sessions.revokedAt. This enforces the
// safe-by-construction credential/revocation chokepoint (proposal §3, root
// CLAUDE.md) so that when Better Auth's dual-store fan-out lands (step 4), it
// has exactly one home and drift between the two stores is impossible.
//
// Reads are fine (where/select clauses, null-guards, bcrypt.compare). Only
// WRITES are forbidden outside the chokepoint. We match the write idioms — both
// the Prisma camelCase form AND raw-SQL snake_case — so reads don't false-flag.
//
// KNOWN LIMITS (a grep gate, not a type system) — idioms that EVADE it:
//  - A variable-built `data` object (`data: updates` where `updates.passwordHash`
//    is set elsewhere via the dot-form) or a computed key (`data: {[k]: v}`).
//  - ES property shorthand `data: { passwordHash }` (key, no colon) — only the
//    explicit `passwordHash: <value>` colon-form is matched.
//    → Keep credential/revoke writes in the literal colon-form so the gate sees them.
//  And one ACCEPTABLE false-positive:
//  - The bare key `passwordHash:` / `revokedAt:` can't be told apart from a TS
//    type annotation (`passwordHash: string` in a signature) by a line regex, so
//    a function param/interface field named `passwordHash`/`revokedAt` OUTSIDE
//    identityStore will trip the gate — which is fine: a new function taking a raw
//    password hash or revoke timestamp is exactly what should get a human's eyes.
//    The repo has zero such lines today.
//
// Run: node scripts/check-identity-writes.mjs   (exits 1 on any violation)

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ALLOWED = 'lib/identityStore.ts'

// Which tracked files to scan: every .ts/.tsx under app/ or lib/, plus the two
// root auth files. We let `git ls-files` enumerate ALL tracked files and filter
// here — a hand-written `lib/**/*.ts` pathspec silently matches ZERO files (git
// `**`-between-slashes needs an intermediate dir; lib/ is flat), which would
// leave the entire lib/ tree — the natural home for a future credential helper —
// unguarded. Filtering in-script avoids that whole class of glob foot-gun.
const inScope = (f) =>
  f === 'auth.ts' ||
  f === 'auth.config.ts' ||
  ((f.startsWith('app/') || f.startsWith('lib/')) && (f.endsWith('.ts') || f.endsWith('.tsx')))

// Write idioms (both flagged):
//  - Prisma:  `revokedAt:` / `passwordHash:` as an object key whose value is NOT
//    a read marker. The only legitimate non-write key-forms in this codebase are
//    `: true` (a select) and `: null` (a where), which we exclude. Property READS
//    (`user.passwordHash`, `sess.revokedAt`) are dot-preceded, so the
//    `(^|[^.\w])` lookbehind skips them. (The only bare `passwordHash: <type>`
//    annotation lives in identityStore's own signature — the excluded file.)
//    We deliberately do NOT add a "type annotation" exclusion: `: <Word>` would
//    also swallow the real write `revokedAt: new Date()` (the `new`), blinding
//    the gate to the exact idiom it must catch.
//  - Raw SQL: `SET password_hash` / `SET revoked_at`. No code writes these
//    columns via $executeRaw today, but the repo DOES use $executeRaw for other
//    user/session writes (e.g. lib/accountDelete.ts deletes the user row), so a
//    future raw UPDATE of these columns is plausible and would otherwise be
//    invisible to a Prisma-only matcher. Defense-in-depth.
const PRISMA_KEY = /(^|[^.\w])(passwordHash|revokedAt)\s*:/
const READ_SELECT = /(passwordHash|revokedAt)\s*:\s*true\b/
const WHERE_NULL = /revokedAt\s*:\s*null\b/
const RAW_SQL = /\bSET\s+(password_hash|revoked_at)\b/i

const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter(inScope)
  .filter((f) => f !== ALLOWED)

// Fail loud if scope is empty — almost certainly run from a subdir (git ls-files
// then returns subdir-relative paths that fail the app/|lib/ prefix), which would
// otherwise pass green while guarding nothing. CI runs from repo root.
if (files.length === 0) {
  console.error('check-identity-writes: ERROR — 0 in-scope files. Run from the repo root.')
  process.exit(1)
}

const violations = []
for (const file of files) {
  if (!existsSync(file)) continue // tracked-but-deleted (mid-rename / staged delete)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '') // drop line comments (block comments / strings are a known limit)
    const prismaWrite =
      PRISMA_KEY.test(code) && !READ_SELECT.test(code) && !WHERE_NULL.test(code)
    if (prismaWrite || RAW_SQL.test(code)) {
      violations.push({ file, line: i + 1, text: line.trim() })
    }
  })
}

if (violations.length === 0) {
  console.log(`check-identity-writes: OK — no password_hash/revokedAt writes outside ${ALLOWED} (${files.length} files scanned)`)
  process.exit(0)
}

console.error('check-identity-writes: FAILED — credential/revocation writes must go through lib/identityStore.ts')
console.error('(syncCredential / revokeAllSessions / revokeOneSession). See proposal §3.\n')
for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`)
process.exit(1)
