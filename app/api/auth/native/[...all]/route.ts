import type { NextRequest } from 'next/server'
import { toNextJsHandler } from 'better-auth/next-js'
import { isPublicUserId } from '@verre/core'
import { betterAuthServer } from '@/lib/betterAuth'
import { clientVersionGate } from '@/lib/clientVersion'
import { publicIdsFor } from '@/lib/publicIds'
import { prisma } from '@/lib/prisma'

// Better Auth's catch-all, mounted under /api/auth/native so it never collides
// with NextAuth's [...nextauth] catch-all (Next.js forbids two catch-alls at one
// path level). betterAuthServer pulls node:* + bcrypt, so this route is pinned to
// the Node runtime — never Edge (proposal §6.9; the proxy's /api branch never
// runs NextAuth, so the proxy's NextAuth instance won't run here either).
export const runtime = 'nodejs'

const handlers = toNextJsHandler(betterAuthServer)

// 🔒 PUBLIC IDS on the way out (public-user-ids § 5). Better Auth's own `user.id`
// / `session.userId` are the internal integer (generateId: 'serial'); the app
// needs its OWN id in the public form, and nothing else of the integer. The
// rewrite lives HERE, on the parsed JSON after the handler returns, never in a
// BA hook or customSession: server-side getSessionFromCtx would then see a
// non-integer id, and the change-password `rl:account` charge and the revoke
// hooks key on the integer.
//
// - Exactly `user.id` (the public id: `user.publicId`, a declared returned
//   field, else one lookup for a Redis session copy written before the deploy)
//   and `session.userId`; `user.image` is DELETED (BA's Redis copy snapshots
//   the user at sign-in, so its `image` is a stale avatar URL for up to a year;
//   the app never reads it).
// - `user.username` is written FRESH from one primary-key read on every
//   response that carries a user (usernames § 10): BA's Redis session copy
//   snapshots the user at sign-in, so its own value would stay null for up to
//   a year after the person chose (that copy still HOLDS the sign-in-time
//   name at rest; nothing reads it for the wire). `null` = not chosen yet:
//   the app shows its "choose your username" screen.
// - Every JSON body is re-serialized UNCONDITIONALLY (always write `id` and
//   `username`, always delete `image`).
// - Every other header is kept (the heartbeat's Set-Cookie is the device's only
//   record of the extended expiry); Content-Length goes.
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

async function toWire(body: unknown): Promise<unknown> {
  if (!isObj(body)) return body
  const user = isObj(body.user) ? body.user : null
  const session = isObj(body.session) ? body.session : null
  const ints: number[] = []
  const intOf = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
  if (user && !isPublicUserId(user.publicId) && !isPublicUserId(user.id)) { const n = intOf(user.id); if (n) ints.push(n) }
  if (session) { const n = intOf(session.userId); if (n) ints.push(n) }
  const pids = ints.length ? await publicIdsFor(ints) : new Map<number, string>()
  const pidOf = (v: unknown, fallback: unknown) =>
    isPublicUserId(fallback) ? fallback : isPublicUserId(v) ? v : pids.get(intOf(v) ?? 0) ?? null
  if (user) {
    const userInt = intOf(user.id)
    const pid = pidOf(user.id, user.publicId)
    const row = userInt != null
      ? await prisma.user.findUnique({ where: { id: userInt }, select: { username: true } })
      : isPublicUserId(pid) ? await prisma.user.findUnique({ where: { publicId: pid }, select: { username: true } }) : null
    user.id = pid
    user.username = row?.username ?? null
    delete user.image
    if (session) session.userId = intOf(session.userId) === userInt ? pid : pidOf(session.userId, null)
  } else if (session) {
    session.userId = pidOf(session.userId, null)
  }
  return body
}

async function rewrite(res: Response): Promise<Response> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return res
  const text = await res.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers }) }
  const headers = new Headers()
  res.headers.forEach((v, k) => { if (k !== 'set-cookie' && k !== 'content-length') headers.append(k, v) })
  for (const c of res.headers.getSetCookie()) headers.append('set-cookie', c)
  return new Response(JSON.stringify(await toWire(body)), { status: res.status, statusText: res.statusText, headers })
}

// X-Verre-Client min-version gate (proposal 04, lib/clientVersion.ts). Runs
// BEFORE Better Auth so a stale client can't sign in past the floor. The proxy
// (proxy.ts) runs the same gate on every /api call; this one stays as the
// belt for the auth chokepoint.
export const GET = async (req: NextRequest) => clientVersionGate(req) ?? rewrite(await handlers.GET(req))
export const POST = async (req: NextRequest) => clientVersionGate(req) ?? rewrite(await handlers.POST(req))
