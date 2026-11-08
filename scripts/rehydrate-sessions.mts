// Release C — the operator script (docs/dev/proposals/redis-rehydration.md § 7;
// release-C plan). Warms or verifies the Redis cache of Postgres-backed
// moments through the app's OWN rebuild (lib/sessionRehydrate.ts
// rehydrateSession — one code path, never a second implementation).
//
//   npx tsx scripts/rehydrate-sessions.mts [--apply] [--force] [--concurrency N]
//       [--per-code-timeout SECONDS] (CODE… | --active-since DAYS)
//
// Dry run by default: the same contract entry as the app's rebuild minus the
// Redis lease (advisory lock, live row FOR UPDATE, meta + incarnation), then
// the publish is PLANNED, never written — no Redis write of any kind, no
// Postgres write. `--apply` runs the app's rebuild. Warm moments are a no-op
// unless `--force`, which runs the reconciling fill over them too (spec § 5.5;
// finishes a deferred account-deletion projection, § 6): content stays NX,
// authorization-shaped state (identities, bans, kicked, role lists, meta from
// the record) is reconciled both ways. Codes without a live row are reported
// and never touched. Never writes Postgres.
//
// stdout: one JSON object per code, then one summary object (codes, counts,
// outcome words and meta FIELD NAMES only — never names, notes, wine labels,
// identity ids or values). stderr: a header and sanitized diagnostics — every
// console method is routed through a filter before any lib module loads.
// Exit: 0 every code warm/absent/redisOnly/planned/applied; 1 some code
// busy/refused/conflict/error (listed under `retry`, never retried here);
// 2 usage or server-side bounds out of range; 3 aborted (watchdog, start-up
// probe, 3 consecutive errors). Safe to Ctrl-C (see the header's bound).
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeCode } from '@verre/core'
import type { RebuildCounts, RehydrateResult } from '../lib/sessionRehydrate.ts'

export type RunOpts = {
  codes?: string[]
  activeSinceDays?: number
  apply: boolean
  force: boolean
  concurrency: number
  perCodeTimeoutMs: number
}
export type Line = Record<string, unknown>

// ── prepare: server-side bounds + the console sanitizer, BEFORE any lib import ─
//
// A client exit does not end a transaction the server cannot see end: under a
// network partition the backend keeps its transaction — and the session's
// advisory lock — until it notices the dead socket. These startup parameters
// make the server end it (plan § 2.2). Prepended to PGOPTIONS so an operator's
// own entry for the same GUC (later) wins; the start-up probe then validates
// what the server ACTUALLY applies. lib/pgSession.mjs appends the UTC pin last.
const BOUNDS = '-c idle_in_transaction_session_timeout=20s -c lock_timeout=5s'
let prepared = false
export function prepare(): void {
  if (prepared) return
  prepared = true
  process.env.PGOPTIONS = [BOUNDS, process.env.PGOPTIONS].filter(Boolean).join(' ')
  if (process.env.DATABASE_STATEMENT_TIMEOUT_MS === undefined) process.env.DATABASE_STATEMENT_TIMEOUT_MS = '15000'
  installSanitizer()
  process.on('uncaughtException', (err) => { diag(`uncaught: ${errInfo(err) ?? typeof err}`); process.exit(3) })
  process.on('unhandledRejection', (err) => { diag(`unhandled rejection: ${errInfo(err) ?? typeof err}`); process.exit(3) })
}

// Only a leading TAG and each Error's class + code survive (plan § 5.3): a
// Prisma or Postgres message can quote a value, a JSON.parse message quotes its
// input. Every console method goes to STDERR (Prisma logs errors through
// console.log, which would otherwise corrupt the JSON lines). lib's
// `[rehydrate]` line is dropped — the stdout report carries the same counts.
const ANSI = /\x1b\[[0-9;]*m/g
const TAG = /^(\[[A-Za-z][\w:.-]{0,39}\]|prisma:(?:error|warn|info|query)|redis err:)/
const CODE = /^[A-Za-z0-9_]{1,32}$/
function errInfo(e: unknown): string | null {
  if (!(e instanceof Error)) return null
  const x = e as Error & { code?: unknown; meta?: { code?: unknown }; cause?: { code?: unknown } }
  const codes = [x.code, x.meta?.code, x.cause?.code].filter((c): c is string => typeof c === 'string' && CODE.test(c))
  const name = /^[A-Za-z_$][\w$]{0,60}$/.test(e.constructor?.name ?? '') ? e.constructor.name : 'Error'
  return codes.length ? `${name}(${[...new Set(codes)].join(',')})` : name
}
const printed = new Map<string, number>()
function diag(line: string): void {
  const n = (printed.get(line) ?? 0) + 1
  printed.set(line, n)
  if (n <= 3) process.stderr.write(`${line}\n`)
  else if (n === 4) process.stderr.write(`${line} (further identical lines suppressed)\n`)
}
function installSanitizer(): void {
  const sanitize = (...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? args[0].replace(ANSI, '').trimStart() : ''
    const tag = first.match(TAG)?.[1] ?? '(diagnostic)'
    if (tag === '[rehydrate]') return
    const errs = args.flatMap((a) => {
      const d = errInfo(a)
      if (d) return [d]
      if (a && typeof a === 'object' && !Array.isArray(a)) return Object.values(a).map(errInfo).filter((v): v is string => !!v)
      return []
    })
    diag([tag, ...errs].join(' '))
  }
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) console[m] = sanitize
}

// ── lib, loaded only after prepare() ──────────────────────────────────────────
type Lib = {
  prisma: typeof import('../lib/prisma.ts')['prisma']
  redis: typeof import('../lib/redis.ts')['redis']
  rehydrateSession: typeof import('../lib/sessionRehydrate.ts')['rehydrateSession']
  confirmedEffects: typeof import('../lib/sessionRehydrate.ts')['confirmedEffects']
  // The meta field names a line may print: SessionMeta's own + the legacy ones a
  // rewrite drops. Any other key of a cached meta prints as `<other>` (r1-1).
  metaFieldNames: Set<string>
}
let lib: Lib | null = null
async function loadLib(): Promise<Lib> {
  if (lib) return lib
  const [{ prisma }, { redis }, r] = await Promise.all([
    import('../lib/prisma.ts'), import('../lib/redis.ts'), import('../lib/sessionRehydrate.ts'),
  ])
  lib = {
    prisma, redis, rehydrateSession: r.rehydrateSession, confirmedEffects: r.confirmedEffects,
    metaFieldNames: new Set([...Object.keys(r.SESSION_META_FIELDS), ...LEGACY_META_FIELDS]),
  }
  return lib
}

class Timeout extends Error {}
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Timeout(what)), ms) })]).finally(() => clearTimeout(t))
}

// ── Selection (plan § 4) — outside every lock: it only OFFERS codes ──────────
// "Activity" = the three DURABLE events in the window: a member joined, a wine
// was created, a rating was written. Visits live only in Redis — a moment kept
// warm only by visits is not selected (named gap).
async function selectActive(days: number): Promise<string[]> {
  const { prisma } = await loadLib()
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await prisma.$queryRaw<{ code: string }[]>`
    SELECT s.code FROM sessions s
     WHERE s.deleted_at IS NULL AND s.code IS NOT NULL AND (
           EXISTS (SELECT 1 FROM session_members m WHERE m.session_code = s.code AND m.joined_at >= ${since})
        OR EXISTS (SELECT 1 FROM wines w WHERE w.session_id = s.id AND w.created_at >= ${since})
        OR EXISTS (SELECT 1 FROM ratings r WHERE r.session_id = s.id AND greatest(r.rated_at, r.mirror_at) >= ${since}))
     ORDER BY s.code`
  return rows.map(r => r.code)
}

// Informational: ≥ 2 wines and no recorded position → the rebuild orders them by created_at.
async function lineupOrderLost(code: string): Promise<boolean> {
  const { prisma } = await loadLib()
  const [r] = await prisma.$queryRaw<{ n: bigint; p: bigint }[]>`
    SELECT count(*) AS n, count(w.position) AS p FROM wines w
      JOIN sessions s ON s.id = w.session_id WHERE s.code = ${code} AND s.deleted_at IS NULL`
  return Number(r?.n ?? 0) >= 2 && Number(r?.p ?? 0) === 0
}

const LEGACY_META_FIELDS = ['coHosts']
const safeCounts = (c: RebuildCounts, known: Set<string>): RebuildCounts => ({
  rebuilt: c.rebuilt, reconciled: { ...c.reconciled, metaFields: c.reconciled.metaFields.map(f => known.has(f) ? f : '<other>') },
})

async function processCode(code: string, o: RunOpts): Promise<Line> {
  try {
    const { rehydrateSession, confirmedEffects, metaFieldNames } = await loadLib()
    const r: RehydrateResult = await rehydrateSession(code, { force: o.force, dryRun: !o.apply, reseedRedisOnly: false })
    const line: Line = { code, outcome: r.outcome, ...(r.state ? { state: r.state } : {}), force: o.force }
    if (!r.plan) return line
    const planned = safeCounts(r.plan.counts, metaFieldNames)
    const meta: Record<string, unknown> = { ...r.plan.metaWrite }
    line.planned = planned
    if (r.published) {
      const c = confirmedEffects(r.plan, r.published)
      line.confirmed = safeCounts(c.counts, metaFieldNames)
      meta.acked = c.metaAcked
      line.drift = JSON.stringify(line.confirmed) !== JSON.stringify(planned) || (r.plan.metaWrite.expect !== 'noop' && !c.metaAcked)
    }
    line.meta = meta
    line.info = { ...r.plan.info, lineupOrderLost: await lineupOrderLost(code), ttlSeconds: r.plan.ttl }
    return line
  } catch (err) {
    return { code, outcome: 'error', error: errInfo(err) ?? typeof err }
  }
}

// ── The run ──────────────────────────────────────────────────────────────────
const OK = new Set(['warm', 'absent', 'redisOnly', 'planned', 'applied'])
const zero = (): Record<string, number> => ({})
function addCounts(acc: Record<string, number>, c: RebuildCounts) {
  for (const [group, o] of Object.entries(c)) {
    for (const [key, v] of Object.entries(o as Record<string, unknown>)) {
      const n = Array.isArray(v) ? v.length : typeof v === 'boolean' ? Number(v) : Number(v)
      acc[`${group}.${key}`] = (acc[`${group}.${key}`] ?? 0) + n
    }
  }
}

export async function runRehydration(o: RunOpts, emit: (line: Line) => void): Promise<Line> {
  const selection = o.codes ? 'codes' : 'active-since'
  let codes: string[]
  try {
    codes = o.codes ? [...new Set(o.codes)].sort() : await within(selectActive(o.activeSinceDays!), o.perCodeTimeoutMs, 'selection')
  } catch (err) {
    const summary = { summary: { mode: o.apply ? 'apply' : 'dry-run', force: o.force, selection, selected: 0, outcomes: {}, converged: false, retry: [], aborted: `selection: ${errInfo(err)}` } }
    emit(summary)
    return summary
  }
  const queue = [...codes]
  const started = new Set<string>(), finished = new Set<string>()
  const outcomes: Record<string, number> = {}
  const planned = zero(), confirmed = zero()
  const retry: string[] = []
  let drift = 0, consecutiveErrors = 0
  let aborted: string | null = null
  let wake!: () => void
  const abortSignal = new Promise<void>(r => { wake = r })
  const abort = (why: string) => { if (!aborted) { aborted = why; wake() } }

  const worker = async () => {
    while (!aborted && queue.length) {
      const code = queue.shift()!
      started.add(code)
      let line: Line
      try {
        line = await within(processCode(code, o), o.perCodeTimeoutMs, code)
      } catch {
        abort(`watchdog: a code exceeded ${o.perCodeTimeoutMs / 1000}s`)
        return
      }
      if (aborted) return
      finished.add(code)
      emit(line)
      const outcome = String(line.outcome)
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
      if (!OK.has(outcome)) retry.push(code)
      if (line.planned) addCounts(planned, line.planned as RebuildCounts)
      if (line.confirmed) addCounts(confirmed, line.confirmed as RebuildCounts)
      if (line.drift) drift++
      if (outcome === 'error') { if (++consecutiveErrors >= 3) abort('3 consecutive errors') } else consecutiveErrors = 0
    }
  }
  await Promise.race([Promise.all(Array.from({ length: Math.min(o.concurrency, Math.max(codes.length, 1)) }, worker)), abortSignal])
  if (aborted) {
    for (const code of [...started].filter(c => !finished.has(c)).sort()) {
      emit({ code, outcome: 'unknown' })
      outcomes.unknown = (outcomes.unknown ?? 0) + 1
      retry.push(code)
    }
    retry.push(...queue)
  }
  const flags = [o.apply ? '--apply' : '', o.force ? '--force' : ''].filter(Boolean).join(' ')
  const sortedRetry = [...new Set(retry)].sort()
  // Converged (r1-2): every selected code ran to completion (no retry, no abort),
  // nothing drifted, and every actionable count is 0. null when no code was
  // planned or applied at all (warm without --force, absent): nothing verified.
  const verified = (outcomes.planned ?? 0) + (outcomes.applied ?? 0)
  const zeroSums = Object.values(planned).every(n => n === 0) && Object.values(confirmed).every(n => n === 0)
  const converged = aborted || sortedRetry.length || drift ? false : verified === 0 ? null : zeroSums
  const summary = {
    summary: {
      mode: o.apply ? 'apply' : 'dry-run', force: o.force, selection, ...(o.activeSinceDays !== undefined ? { activeSinceDays: o.activeSinceDays } : {}),
      selected: codes.length, outcomes,
      actionable: { planned, ...(o.apply ? { confirmed } : {}) },
      verified, converged,
      ...(o.apply ? { drift } : {}),
      ...(aborted ? { notStarted: queue.length } : {}),
      retry: sortedRetry,
      ...(sortedRetry.length ? { retryCommand: `npx tsx scripts/rehydrate-sessions.mts ${flags ? `${flags} ` : ''}${sortedRetry.join(' ')}` } : {}),
      aborted,
    },
  }
  emit(summary)
  return summary
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const USAGE = 'usage: npx tsx scripts/rehydrate-sessions.mts [--apply] [--force] [--concurrency N(1-8)] [--per-code-timeout SECONDS] (CODE… | --active-since DAYS)'
class Usage extends Error {}
export function parseArgs(argv: string[]): RunOpts {
  const o: RunOpts = { apply: false, force: false, concurrency: 2, perCodeTimeoutMs: 30_000 }
  const codes: string[] = []
  const num = (v: string | undefined, what: string) => {
    if (v === undefined || !/^\d+(\.\d+)?$/.test(v)) throw new Usage(`${what} needs a number`)
    return Number(v)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') o.apply = true
    else if (a === '--force') o.force = true
    else if (a === '--concurrency') {
      const n = num(argv[++i], '--concurrency')
      if (!Number.isInteger(n) || n < 1 || n > 8) throw new Usage('--concurrency must be an integer 1–8')
      o.concurrency = n
    } else if (a === '--per-code-timeout') {
      const n = num(argv[++i], '--per-code-timeout')
      if (n < 1 || n > 600) throw new Usage('--per-code-timeout must be 1–600 seconds')
      o.perCodeTimeoutMs = n * 1000
    } else if (a === '--active-since') {
      const n = num(argv[++i], '--active-since')
      if (!(n > 0) || n > 3650) throw new Usage('--active-since must be a number of days in (0, 3650]')
      o.activeSinceDays = n
    } else if (a.startsWith('-')) throw new Usage(`unknown option ${a.slice(0, 40)}`)
    else {
      const c = normalizeCode(a)
      if (!c) throw new Usage('invalid session code (4 or 8 Crockford characters)')
      codes.push(c)
    }
  }
  if (codes.length && o.activeSinceDays !== undefined) throw new Usage('codes and --active-since are mutually exclusive')
  if (!codes.length && o.activeSinceDays === undefined) throw new Usage('give session codes or --active-since DAYS')
  if (codes.length) o.codes = codes
  return o
}

// host:port/db only — never credentials or query parameters.
const target = (raw: string | undefined, fallback: string, defaultDb: string) => {
  try { const u = new URL(raw || fallback); return `${u.hostname}:${u.port || '(default)'}/${u.pathname.slice(1) || defaultDb}` } catch { return '(unparseable URL)' }
}
const fmtMs = (ms: number) => ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`

// The start-up probe (plan § 2.3) + the effective server-side bounds (§ 2.2):
// read from the pooled session, validated, refused (exit 2) out of range.
async function probe(o: RunOpts): Promise<number | null> {
  const { prisma, redis } = await loadLib()
  let dbsize: number, rtt: number
  try {
    await within(redis.ping(), 5000, 'redis')
    const t0 = performance.now()
    await within(redis.ping(), 5000, 'redis')
    rtt = performance.now() - t0
    dbsize = Number(await within(redis.dbSize(), 5000, 'redis'))
  } catch (err) {
    diag(`aborted: Redis unreachable (allow-list? URL?) — ${errInfo(err)}`)
    return 3
  }
  let settings: Record<string, string>
  try {
    await within(prisma.$queryRaw`SELECT 1`, 5000, 'postgres')
    const rows = await within(prisma.$queryRaw<{ name: string; setting: string }[]>`
      SELECT name, setting FROM pg_settings WHERE name IN ('idle_in_transaction_session_timeout', 'lock_timeout', 'statement_timeout', 'TimeZone')`, 5000, 'postgres')
    settings = Object.fromEntries(rows.map(r => [r.name, r.setting]))
  } catch (err) {
    diag(`aborted: Postgres unreachable (allow-list? URL? CA?) — ${errInfo(err)}`)
    return 3
  }
  const idle = Number(settings.idle_in_transaction_session_timeout), lock = Number(settings.lock_timeout), stmt = Number(settings.statement_timeout)
  process.stderr.write([
    `rehydrate-sessions: ${o.apply ? 'APPLY' : 'dry run'}${o.force ? ' --force' : ''}, concurrency ${o.concurrency}, per-code timeout ${o.perCodeTimeoutMs / 1000}s`,
    `  postgres ${target(process.env.DATABASE_URL, '', '(default)')}   redis ${target(process.env.REDIS_URL, 'redis://localhost:6379', '0')}`,
    `  redis DBSIZE ${dbsize}, RTT ${rtt.toFixed(1)} ms — SCAN s:{C}:* ≈ ${Math.ceil(dbsize / 100)} round trips per code`,
    `  server-side bounds: idle_in_transaction_session_timeout ${fmtMs(idle)}, lock_timeout ${fmtMs(lock)}, statement_timeout ${fmtMs(stmt)}, TimeZone ${settings.TimeZone}`,
    `  after a partition, a session's advisory lock is released within statement_timeout + idle_in_transaction_session_timeout (${fmtMs(stmt + idle)}); its Redis lease within 15s`,
    '',
  ].join('\n'))
  const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi
  if (!inRange(idle, 1000, 300_000) || !inRange(lock, 1000, 60_000) || !inRange(stmt, 1000, 300_000) || settings.TimeZone !== 'UTC') {
    diag('refused: server-side bounds out of range (want idle-in-transaction 1–300s, lock 1–60s, statement 1–300s, TimeZone UTC) — check PGOPTIONS / DATABASE_STATEMENT_TIMEOUT_MS')
    return 2
  }
  return null
}

export async function main(argv: string[]): Promise<number> {
  prepare()
  let o: RunOpts
  try { o = parseArgs(argv) } catch (err) {
    if (!(err instanceof Usage)) throw err
    process.stderr.write(`${err.message}\n${USAGE}\n`)
    return 2
  }
  const refused = await probe(o)
  if (refused !== null) return refused
  const emit = (line: Line) => { process.stdout.write(`${JSON.stringify(line)}\n`) }
  const s = (await runRehydration(o, emit)).summary as { aborted: string | null; retry: string[] }
  if (s.aborted) { diag(`aborted: ${s.aborted}`); return 3 }
  return s.retry.length ? 1 : 0
}

// Exit only after stdout/stderr drained (pipes are asynchronous on macOS). An
// aborted run does not wait for its in-flight contract: process exit closes the
// sockets — the backend rolls back, the Redis lease self-expires.
// A stdout that cannot drain within 10 s does not keep the process alive.
function exitAfterFlush(code: number): void {
  process.exitCode = code
  setTimeout(() => process.exit(code), 10_000).unref()
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

// The CLI: prepare, run, close the stores, exit. Also what the suite's worker
// bootstrap calls (scripts/tests/stubs/rehydrate-sessions-worker.mts).
export function cli(argv: string[]): void {
  prepare()
  main(argv).then(async (code) => {
    // Graceful close, bounded (r1-3): a Redis that stops answering after the
    // summary must not hold the process (QUIT waits for its reply).
    if (code !== 3 && lib) {
      const stores = Promise.allSettled([lib.redis.quit(), lib.prisma.$disconnect()])
      await Promise.race([stores, new Promise(r => setTimeout(r, 3000).unref())])
    }
    exitAfterFlush(code)
  }, (err) => { diag(`failed: ${errInfo(err) ?? typeof err}`); exitAfterFlush(3) })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli(process.argv.slice(2))
