// The operator's username tool (docs/dev/proposals/usernames.md § 8). For
// stragglers who never chose one, the brand's own account, and a moderation
// rename. Run from a checkout, like scripts/rehydrate-sessions.mts.
//
//   npx tsx scripts/set-username.mts <email> <username> [--apply] [--allow-reserved] [--block-old]
//   npx tsx scripts/set-username.mts --release-hold <username> [--apply]
//
// DRY RUN by default: it reads, reports what would happen, and writes
// nothing. `--apply` writes.
//
//  - Set / rename: through the app's own writer (lib/username.ts
//    changeUsername, `skipQuota`), so it spends none of the person's 5
//    changes and adds no change row. The FORMAT is always checked; a RESERVED
//    name (`verre`, `support`, …) only with `--allow-reserved`. A taken or
//    HELD name can never be assigned: the database refuses (the hold
//    triggers), whatever this script thinks. A rename holds the old name for
//    its owner for 14 days, like any rename: THEY CAN SWITCH BACK TO IT.
//  - `--block-old` (a moderation rename): the old name is taken away for good.
//    It is blocked for everyone, its former owner included, with no end date,
//    stored as a hash only. Only `--release-hold` frees it again.
//  - `--release-hold`: frees a held or blocked name at once (a renamed-away
//    or deleted account's name inside its 14 days, or a moderation block),
//    whoever held it. Blocked names are stored as hashes: keep your own note
//    of what you blocked, the table can't list them.
//
// stdout: one JSON object. Exit 0 done (or a clean dry run); 1 refused
// (unknown email, taken, held); 2 usage or an invalid name.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkUsername } from '@verre/core'

export type Result = { exit: 0 | 1 | 2; out: Record<string, unknown> }

const USAGE = 'usage: set-username.mts <email> <username> [--apply] [--allow-reserved] [--block-old] | --release-hold <username> [--apply]'

// `hooks.beforeWrite` is a test seam: it runs between this script's read of
// the account and its write, the gap a concurrent rename can land in.
export async function run(argv: string[], hooks: { beforeWrite?: () => Promise<void> } = {}): Promise<Result> {
  const flags = new Set(argv.filter(a => a.startsWith('--')))
  const args = argv.filter(a => !a.startsWith('--'))
  const apply = flags.has('--apply')
  const blockOld = flags.has('--block-old')
  const unknown = [...flags].filter(f => !['--apply', '--allow-reserved', '--release-hold', '--block-old'].includes(f))
  if (unknown.length) return { exit: 2, out: { error: `unknown flag ${unknown[0]}`, usage: USAGE } }

  const { prisma } = await import('../lib/prisma.ts')
  const { changeUsername, releaseUsernameHold, usernameTaken } = await import('../lib/username.ts')

  if (flags.has('--release-hold')) {
    if (args.length !== 1) return { exit: 2, out: { error: 'one username expected', usage: USAGE } }
    const checked = checkUsername(args[0])
    if (!checked.ok && checked.reason === 'invalid') return { exit: 2, out: { error: checked.message } }
    const username = checked.ok ? checked.username : args[0].trim().replace(/^@/, '').toLowerCase()
    const held = await prisma.$queryRaw<{ held: boolean }[]>`SELECT username_is_held(${username}, NULL::int) AS held`
    if (!apply) return { exit: 0, out: { mode: 'dry-run', action: 'release-hold', username, held: held[0].held } }
    return { exit: 0, out: { mode: 'apply', action: 'release-hold', username, released: await releaseUsernameHold(username) } }
  }

  if (args.length !== 2) return { exit: 2, out: { error: 'an email and a username expected', usage: USAGE } }
  const [email, raw] = args
  const checked = checkUsername(raw)
  if (!checked.ok && checked.reason === 'invalid') return { exit: 2, out: { error: checked.message } }
  if (!checked.ok && !flags.has('--allow-reserved')) return { exit: 2, out: { error: `${checked.message} (pass --allow-reserved to assign it anyway)` } }
  // A reserved name passed the format check above (only its reason differs).
  const username = checked.ok ? checked.username : raw.trim().replace(/^@/, '').toLowerCase()

  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true, username: true } })
  if (!user) return { exit: 1, out: { error: 'no account with that email' } }
  const base = { action: 'set', from: user.username, to: username, reserved: !checked.ok, ...(blockOld ? { oldName: user.username === null ? 'none to block' : `${apply ? 'blocked' : 'would be blocked'} for everyone until --release-hold` } : {}) }
  if (user.username === username) return { exit: 0, out: { ...base, mode: apply ? 'apply' : 'dry-run', result: 'unchanged' } }
  if (!apply) {
    const taken = await usernameTaken(username, user.id)
    return { exit: taken ? 1 : 0, out: { ...base, mode: 'dry-run', result: taken ? 'taken or held: would be refused' : 'would be set' } }
  }
  await hooks.beforeWrite?.()
  // 🔒 Bound to the name read above: if the person renamed meanwhile, nothing
  // is written and nothing is reported as blocked (run it again).
  const result = await changeUsername(user.id, username, { skipQuota: true, blockOld, expectedCurrent: user.username })
  if (result.status === 'ok') return { exit: 0, out: { ...base, mode: 'apply', result: 'set' } }
  if (result.status === 'moved') {
    return { exit: 1, out: { action: 'set', from: user.username, to: username, mode: 'apply', result: 'refused: the username changed while this ran; nothing written, nothing blocked. Run it again.', now: result.current } }
  }
  return { exit: 1, out: { ...base, mode: 'apply', result: result.status === 'taken' ? 'taken or held: refused by the database' : result.status } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { exit, out } = await run(process.argv.slice(2))
  console.log(JSON.stringify(out))
  const { prisma } = await import('../lib/prisma.ts')
  await prisma.$disconnect()
  process.exit(exit)
}
