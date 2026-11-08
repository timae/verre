import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { k, touchWithMeta } from '@/lib/redis'
import { isHostByIdentity } from '@/lib/session'
import { normalizeCode } from '@verre/core'
import { isSameOrigin } from '@/lib/csrf'
import { withSessionMutation, admitted, refuse } from '@/lib/sessionMutation'
import { readLiveRow, readRecordRoles, metaFromRecord } from '@/lib/sessionRecord'
import { contractFailure } from '@/lib/sessionRehydrate'
import { openAsParticipant } from '@/lib/sessionRoute'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const session = await resolveUser(req)
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const op = await openAsParticipant(c, req, session, 'identity required')
  if (op instanceof NextResponse) return op
  const { meta, identity } = op
  if (!isHostByIdentity(meta, identity)) {
    return NextResponse.json({ error: 'only the host can rename this session' }, { status: 403 })
  }

  // A moment name is REQUIRED (Simon, 2026-07-06) — this rename path is a 4th
  // name-write surface beside create + the settings PATCH; it must enforce the
  // same invariant or a host could blank the name here.
  const name = String(body.name || '').trim().slice(0, 80)
  if (!name) return NextResponse.json({ error: 'Please name your moment.' }, { status: 400 })
  // Inside the session mutation contract: the power from the caller's fresh
  // grant; for a Postgres-backed session the record first (sessions.name) and
  // meta rewritten from the record as the projection; for a Redis-only session
  // the fenced meta write is the change (XX KEEPTTL — never a recreate, never a
  // TTL downgrade).
  try {
    await withSessionMutation(c, { label: 'rename', redisLock: { waitMs: 3000 }, caller: identity }, async (tx, ctx) => {
      if (!isHostByIdentity(ctx.meta!, admitted(ctx))) throw refuse(403, 'only the host can rename this session')
      if (ctx.row) {
        await tx.$executeRaw`UPDATE sessions SET name = ${name} WHERE id = ${ctx.row.id}`
        return metaFromRecord((await readLiveRow(tx, c))!, await readRecordRoles(tx, c), ctx.meta)
      }
      await ctx.fence!.exec(m => { m.set(k.meta(c), JSON.stringify({ ...ctx.meta!, name }), { XX: true, KEEPTTL: true }) })
      return null
    }, async (ctx, next) => {
      if (next) await ctx.fence!.exec(m => { m.set(k.meta(c), JSON.stringify(next), { XX: true, KEEPTTL: true }) })
    })
  } catch (err) {
    return contractFailure(err, c, { label: 'rename' })
  }
  await touchWithMeta(c)
  return NextResponse.json({ ok: true, name })
}
