#!/usr/bin/env node
// CI gate: lib/identityStore.ts is the ONLY code allowed to WRITE
// users.password_hash and user_sessions.revokedAt (the WEB credential + session
// stores) AND auth_accounts (the NATIVE credential store). This enforces the
// safe-by-construction credential/revocation chokepoint (proposal §3, root
// CLAUDE.md) so that the Better Auth dual-store fan-out has exactly one home and
// drift between the two stores is impossible — the native half (auth_accounts)
// is guarded too, otherwise the gate would protect only one side of the very
// dual-store consistency the chokepoint promises.
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
//    `: true` (a select) and `: null` INSIDE a single-line `where: {…}` filter,
//    which we exclude. The where-exclusion requires the `where:` visibly on the
//    SAME line — a bare `revokedAt: null` (e.g. `data: { revokedAt: null }`, an
//    UN-revoke, which is just as much a revocation-state write) flags. Convention
//    this imposes: keep `revokedAt: null` where-filters on one line with their
//    `where:` (a multi-line where would false-positive — acceptable; today every
//    such filter is single-line). Property READS (`user.passwordHash`,
//    `sess.revokedAt`) are dot-preceded, so the `(^|[^.\w])` lookbehind skips
//    them. (The only bare `passwordHash: <type>` annotation lives in
//    identityStore's own signature — the excluded file.)
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
const WHERE_NULL = /\bwhere\s*:\s*\{[^}]*revokedAt\s*:\s*null\b/
const RAW_SQL = /\bSET\s+(password_hash|revoked_at)\b/i

// Native stores (auth_accounts = credential, auth_sessions = session). We can't
// match the COLUMN here the way we do passwordHash/revokedAt — the Prisma fields
// (`password`, `token`) appear in dozens of legitimate read/hash sites. So match
// the WRITE OPERATION on the table instead: any prisma.<model>.{create,
// createMany,update,updateMany,upsert,delete,deleteMany}, or a raw
// INSERT/UPDATE/DELETE on the table. Stronger than a column match — blind to how
// `data` is shaped. Write-methods only, so .findMany/.findFirst/.count READS
// (devices route reads both tables) don't false-flag; a local var named
// `authSession` accessed as `authSession.user` (lib/identity.ts) also won't
// match — the method name must follow the dot.
//
// 🔒 auth_sessions is the HIGHEST-VALUE guard: a raw prisma.authSession.delete
// does NOT revoke (the Redis copy authenticates Redis-first until TTL — root
// CLAUDE.md, lib/betterAuth.ts), so a dev who writes one believing it revokes
// gets a green build and a live ghost session. Every auth_sessions write must
// go through Better Auth (identityStore's internalAdapter legs). The only writes
// to either table today are the chokepoint sites in the excluded ALLOWED file.
//
// SAME KNOWN-LIMITS as the column matchers above: this is a line-grep, not a
// type system. The native-table matchers see only the literal `authSession.`/
// `authAccount.<method>` dot-call and `<VERB> auth_sessions`/`auth_accounts`
// literals — so an ALIASED write (`prisma['authSession'].delete(...)`,
// `const t = prisma.authSession; t.delete(...)`) or a `$executeRawUnsafe` with a
// dynamically-built table name would EVADE the gate, exactly as the Prisma-data-
// shape evasions do for the column matchers. Keep native writes in the literal
// `prisma.authSession.<method>` form (and out of $executeRawUnsafe) so the gate
// sees them. Defense-in-depth, not the primary control — the primary control is
// that every writer imports from identityStore.
const AUTH_ACCOUNT_WRITE = /\bauthAccount\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/
const AUTH_ACCOUNT_RAW = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+auth_accounts\b/i
const AUTH_SESSION_WRITE = /\bauthSession\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/
const AUTH_SESSION_RAW = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+auth_sessions\b/i

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
    const nativeWrite =
      AUTH_ACCOUNT_WRITE.test(code) || AUTH_ACCOUNT_RAW.test(code) ||
      AUTH_SESSION_WRITE.test(code) || AUTH_SESSION_RAW.test(code)
    if (prismaWrite || RAW_SQL.test(code) || nativeWrite) {
      violations.push({ file, line: i + 1, text: line.trim() })
    }
  })
}

if (violations.length === 0) {
  console.log(`check-identity-writes: OK — no password_hash/revokedAt writes outside ${ALLOWED} (${files.length} files scanned)`)
  process.exit(0)
}

console.error('check-identity-writes: FAILED — credential/revocation writes (web users.password_hash +')
console.error('user_sessions.revokedAt AND native auth_accounts + auth_sessions) must go through lib/identityStore.ts')
console.error('(syncCredential / backfillNativeCredential / revokeAllSessions / revokeAllWebSessions /')
console.error(' revokeAllForNativeCaller / revokeOneSession / revokeOneNativeSession / deleteAllNativeSessions).')
console.error('See proposal §3.\n')
for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`)
process.exit(1)
