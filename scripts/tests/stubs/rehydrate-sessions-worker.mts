// Child-process bootstrap for the cutover suite's operatorScript checks
// (release-C plan § 7, r2-3). Imports NOTHING from lib statically: the script
// module first (it loads no lib at import time), then prepare() — the same
// env bounds + console sanitizer the CLI installs — and only then lib, to
// install the requested hook. Then the script's own CLI path.
//
//   REHYDRATE_WORKER='{"at":"locked","label":"rebuild","notify":"sig","holdMs":500}' \
//     node --import tsx scripts/tests/stubs/rehydrate-sessions-worker.mts <script args…>
//
// cfg: at/label — the hook point (+ label) to act at; notify — NOTIFY
// test_worker with this payload there; holdMs — then wait; hang — then never
// return. prismaError / redisError / rejectWith — drive a sentinel through
// Prisma's error log / the Redis client's 'error' listener / an unhandled
// rejection; importFail — make lib/redis.ts throw at import; hangQuit — the
// Redis client's QUIT never answers (a Redis that stops replying after the run).
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Cfg = {
  at?: string; label?: string; notify?: string; holdMs?: number; hang?: boolean
  prismaError?: string; redisError?: string; rejectWith?: string; importFail?: boolean; hangQuit?: boolean
}
const HERE = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(process.env.REHYDRATE_WORKER ?? '{}') as Cfg
if (cfg.importFail) {
  registerHooks({
    resolve(specifier, context, next) {
      const r = next(specifier, context)
      if (r.url.endsWith('/lib/redis.ts')) return { url: pathToFileURL(join(HERE, 'throwing-module.mts')).href, shortCircuit: true }
      return r
    },
  })
}
const script = await import('../../rehydrate-sessions.mts')
script.prepare()
if (cfg.hangQuit) {
  const { redis } = await import('../../../lib/redis.ts')
  redis.quit = (() => new Promise(() => {})) as typeof redis.quit
}
if (cfg.at || cfg.prismaError || cfg.redisError) {
  const { prisma } = await import('../../../lib/prisma.ts')
  if (cfg.prismaError) await prisma.$queryRawUnsafe(`SELECT '${cfg.prismaError.replace(/'/g, '')}'::int`).catch(() => {})
  if (cfg.redisError) (await import('../../../lib/redis.ts')).redis.emit('error', new Error(cfg.redisError))
  if (cfg.at) {
    const { mutationHooks } = await import('../../../lib/sessionMutation.ts')
    mutationHooks.at = async (point, _code, label) => {
      if (point !== cfg.at || (cfg.label && label !== cfg.label)) return
      if (cfg.notify) await prisma.$executeRawUnsafe(`NOTIFY test_worker, '${cfg.notify.replace(/'/g, '')}'`)
      if (cfg.holdMs) await new Promise(r => setTimeout(r, cfg.holdMs))
      if (cfg.hang) await new Promise(() => {})
    }
  }
}
if (cfg.rejectWith) void Promise.reject(new Error(cfg.rejectWith))
script.cli(process.argv.slice(2))
