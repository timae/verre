#!/usr/bin/env node
// Moment Visibility go-live, the record half (docs/dev/deployment.md § Moment Visibility; release 0.2.0
// runbook 4.18 b). Run once no old instance is left and BEFORE the flags go on. During the rolling switch an
// old instance (it does not know the seven columns) can leave two things the migration fixed at deploy:
//   - a moment it DELETES keeps the seven values on its tombstone (its scrub names only the old columns);
//   - a guest-hosted moment it promotes (belt: the insert trigger already closes it) at the open default.
// This re-runs the migration's own two marked blocks (`@backfill:tombstones`, `@backfill:guest-hosted`,
// 20261115120000_moment_visibility), read from the file, never retyped, and REFUSES unless the file's sha256
// is the checksum the database recorded. Live moments whose host deleted their account ('[deleted]') keep
// their setting (ruled 2026-11-15, again 2026-11-26): only counted, their codes on stderr (a code is a
// join credential: never in the JSON).
//
//   DATABASE_URL=… node scripts/moment-visibility-golive.mjs                                   # dry run (reads)
//   DATABASE_URL=… node scripts/moment-visibility-golive.mjs --apply --expect-db <host>/<db>   # write
//
// One transaction (operatorGuard bounds: lock_timeout 5 s). The blocks' UPDATEs match (lock and rewrite) EVERY
// tombstone and every live hostless moment, so `matched` counts those on every run; `report` (the dry run's) is
// what is wrong, and a second dry run reports 0. A settings PATCH holding one of those rows waits at most 5 s.
// stdout: one JSON object (counts). stderr: the target, the codes. Exit 0 = ran, 1 = refused or error, 2 = usage.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argValue, boundTransaction, checkApplyTarget, errText, targetFromEnv } from './lib/operatorGuard.mjs'

const SCRIPT = 'moment-visibility-golive'
const NAME = '20261115120000_moment_visibility'
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const expectDb = argValue(args, '--expect-db')
if (args.some(a => !new Set(['--apply', '--expect-db', expectDb]).has(a)) || expectDb === null || (apply && !expectDb)) {
  console.error(`usage: ${SCRIPT}.mjs [--apply --expect-db <host>/<database>]`)
  process.exit(2)
}
const target = targetFromEnv(SCRIPT)
if (apply) checkApplyTarget(SCRIPT, target, expectDb)

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations', NAME, 'migration.sql')
const raw = readFileSync(file)
const sha256 = createHash('sha256').update(raw).digest('hex')
// Each block's statements that WRITE: exactly one UPDATE per block (its DO block only raises a NOTICE, counted
// below by our own SELECT). A block of another shape refuses: the file is not the one this script was written for.
function blockUpdate(name) {
  const m = raw.toString('utf8').match(new RegExp(`-- @backfill:${name}\\n([\\s\\S]*?)-- @endbackfill`))
  const updates = m ? [...m[1].matchAll(/^UPDATE "sessions"[\s\S]*?;$/gm)].map(x => x[0]) : []
  if (updates.length !== 1) throw Object.assign(new Error(`block @backfill:${name} not found or not one UPDATE in ${NAME}`), { refused: true })
  return updates[0]
}
const SEVEN = ['visibility', 'include_guest_circles', 'show_place', 'show_details', 'link_version', 'link_active', 'link_since']
const ROLLBACK = Symbol('dry run')
const out = { mode: apply ? 'apply' : 'dry-run', database: null, bounds: null, migration: NAME, report: {}, matched: {} }
let refused = null, codes = []
const { createPrismaClient } = await import('./lib/prismaClient.mjs')
const prisma = createPrismaClient()
try {
  const tombstones = blockUpdate('tombstones'), guestHosted = blockUpdate('guest-hosted')
  await prisma.$transaction(async (tx) => {
    Object.assign(out, await boundTransaction(tx, { apply, expectDb }))
    const rec = await tx.$queryRawUnsafe(
      `SELECT checksum FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, NAME)
    if (rec.length !== 1) throw Object.assign(new Error(`${NAME} is not applied on this database`), { refused: true })
    if (rec[0].checksum !== sha256) throw Object.assign(new Error(`this checkout's ${NAME}/migration.sql is not the file the database applied (sha256 differs): check out the release commit`), { refused: true })
    const [r] = await tx.$queryRawUnsafe(`
      SELECT (SELECT count(*) FROM sessions WHERE host_user_id IS NULL AND deleted_at IS NULL
                AND host_name IS DISTINCT FROM '[deleted]' AND visibility IS DISTINCT FROM 'members')::int AS "hostlessOpen",
             (SELECT count(*) FROM sessions WHERE deleted_at IS NOT NULL
                AND (${SEVEN.map(c => `${c} IS NOT NULL`).join(' OR ')}))::int AS "tombstonesWithValues",
             (SELECT count(*) FROM sessions WHERE host_user_id IS NULL AND deleted_at IS NULL AND host_name = '[deleted]')::int AS "deletedHostLive"`)
    out.report = r
    codes = (await tx.$queryRawUnsafe(`SELECT code FROM sessions WHERE host_user_id IS NULL AND deleted_at IS NULL AND host_name = '[deleted]' ORDER BY code`)).map(x => x.code)
    if (!apply) throw ROLLBACK
    out.matched = { tombstones: await tx.$executeRawUnsafe(tombstones), guestHosted: await tx.$executeRawUnsafe(guestHosted) }
  }, { timeout: 120_000, maxWait: 10_000 })
} catch (e) {
  if (e !== ROLLBACK) { refused = e?.refused ? String(e.message) : `error: ${errText(e)}`; process.exitCode = 1 }
} finally {
  await prisma.$disconnect()
}
if (codes.length) console.error(`${SCRIPT}: live moments whose host deleted their account (keep their setting, ruled): ${codes.join(' ')}`)
if (refused) { console.error(`${SCRIPT}: ${refused} (rolled back: nothing written, unless the error came at COMMIT itself)`); out.refused = refused }
console.log(JSON.stringify(out))
