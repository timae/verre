// Fixture helper (public-user-ids § 9): the redis-rehydration suites reason in
// INTERNAL ids (`u:<int>`, the integer user id), while the routes speak WIRE ids
// since public user ids (`u:<publicId>`, `hostUserId` / `addedByUserId` as the
// public id). The suites' `call()` translates request bodies + identity path
// params on the way in and response bodies on the way out, so their assertions
// stay about rehydration. The wire shape itself (and "the integer never
// leaves") is pinned by scripts/tests/you-profile-integration.mts § 18.
const PID = /^[A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]{11}$/
const UNKNOWN = 'ZZZZZZZZZZZZ' // well-formed, never minted in a test (letters only)
const toPid = new Map<number, string>()
const toInt = new Map<string, number>()

async function db() { return (await import('../../../lib/prisma.ts')).prisma }

async function pidOf(n: number): Promise<string> {
  const hit = toPid.get(n)
  if (hit) return hit
  const rows = await (await db()).$queryRaw<{ public_id: string }[]>`SELECT public_id FROM users WHERE id = ${n}`
  const pid = rows[0]?.public_id ?? UNKNOWN
  if (rows[0]) { toPid.set(n, pid); toInt.set(pid, n) }
  return pid
}
async function intOf(pid: string): Promise<number | null> {
  const hit = toInt.get(pid)
  if (hit !== undefined) return hit
  const rows = await (await db()).$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE public_id = ${pid}`
  if (!rows[0]) return null
  toInt.set(pid, rows[0].id); toPid.set(rows[0].id, pid)
  return rows[0].id
}

export async function toWire(v: unknown): Promise<unknown> {
  if (typeof v === 'string') { const m = /^u:(\d+)$/.exec(v); return m ? `u:${await pidOf(Number(m[1]))}` : v }
  if (Array.isArray(v)) return Promise.all(v.map(toWire))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = await toWire(x)
    return out
  }
  return v
}

const USER_ID_FIELDS = new Set(['hostUserId', 'addedByUserId', 'userId'])
export async function fromWire(v: unknown, field?: string): Promise<unknown> {
  if (typeof v === 'string') {
    if (v.startsWith('u:') && PID.test(v.slice(2))) { const n = await intOf(v.slice(2)); return n === null ? v : `u:${n}` }
    if (field && USER_ID_FIELDS.has(field) && PID.test(v)) return (await intOf(v)) ?? v
    return v
  }
  if (Array.isArray(v)) return Promise.all(v.map(x => fromWire(x)))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[(await fromWire(k)) as string] = await fromWire(x, k)
    return out
  }
  return v
}

export async function wireParams(params: Record<string, string>): Promise<Record<string, string>> {
  if (!params.identityId) return params
  return { ...params, identityId: encodeURIComponent((await toWire(decodeURIComponent(params.identityId))) as string) }
}
