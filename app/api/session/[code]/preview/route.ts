import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { redis, k } from '@/lib/redis'
import { checkRates, getClientIp, formatWait } from '@/lib/rateLimit'
import { authorBlocksViewer, viewerBlocksAuthor } from '@/lib/userBlock'
import { participantOrBanned, authUnavailable } from '@/lib/identity'
import { openSessionFor } from '@/lib/sessionRoute'
import { normalizeCode } from '@verre/core'
import { publicIdFor } from '@/lib/publicIds'
import { prisma } from '@/lib/prisma'

// What a scanned moment code shows in the app before you join (Add Friends →
// Scan): cover, name, when, the host, the place, and where you stand. A code
// is a join credential, so its holder may see what joining would show them;
// the web invite page (`/join/<code>`) already shows the name and the host.
// A block pair never stops a preview (a block never stops a join), but the host
// then shows as a plain name, no link (the in-session rule for a block pair,
// docs/dev/block.md); a ban does stop it, and the caller learns only what the
// join would tell them (403 'banned').
//
// 🔒 `hostUsername` is the ONE username a moment route answers with (ruled
// 2026-11-14; every other moment answer carries none, app/api/CLAUDE.md
// § Usernames). The preview is the step BEFORE the moment: it already hands
// out the host's public id, and with that id the profile shows the username
// to anyone, a private account included, so this tells its reader nothing
// new. Read from the users row, never from the moment's cache, and only
// where `hostUserId` is sent (no block pair, a registered host).
//
// Code guessing: the preview keeps its OWN budgets, charged on every lookup and
// never reset (review 2026-11-12: unlike a join a preview leaves no trace in
// the moment), per user plus a per-IP backstop (free accounts multiply per
// address), like the People lists. They run BEFORE the entrance gate
// (lib/sessionRoute.ts openSessionFor), which they can do because they are the
// same for every code; the gate then charges a wrong code the shared budget.
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const noStore = { 'Cache-Control': 'private, no-store' }
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: noStore })

  const viewerId = Number(session.user.id)
  // Its own budgets first: charged on EVERY lookup, right or wrong code, so
  // the refusal is the same for every code (no oracle) and a hit buys nothing.
  const rl = await checkRates([
    { key: `rl:moment-preview:u:${viewerId}:1h`, max: 60, windowSeconds: 3600 },
    { key: `rl:moment-preview:ip:${getClientIp(req)}:1h`, max: 300, windowSeconds: 3600 },
  ])
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many codes looked up. Try again in ${formatWait(rl.retryAfter)}.`, retryAfter: rl.retryAfter },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ error: 'session not found' }, { status: 404, headers: noStore })
  // Then the entrance gate (leak-fixes F2): a wrong code also pays the
  // wrong-code budget shared with every moment surface, so the preview and
  // the join can't stack N+N; a spent caller who isn't a member gets the same
  // 429 for every code.
  const opened = await openSessionFor(c, req, session, { notFound: 'session not found' })
  if (opened instanceof NextResponse) return opened
  const { meta } = opened

  // 'ok' = already in it (Open, no join); 'kicked' may rejoin by code
  // (kick-ban.md), so it reads as a guest; 'invalid' = not a participant.
  const p = await participantOrBanned(c, req, session, meta)
  if (p.status === 'unavailable') return authUnavailable()
  if (p.status === 'banned') return NextResponse.json({ error: 'banned' }, { status: 403, headers: noStore })

  // The host's current name: the live identities hash first (a rename only
  // writes there), the create-time snapshot as the fallback (app/api/me/sessions).
  const hostId = meta.hostIdentityId ?? (meta.hostUserId != null ? `u:${meta.hostUserId}` : null)
  const host = (hostId ? await redis.hGet(k.identities(c), hostId) : null) || meta.host || null
  const hostUserId = meta.hostUserId ?? null
  const blockPair = hostUserId != null && hostUserId !== viewerId
    && (await Promise.all([viewerBlocksAuthor(viewerId, hostUserId), authorBlocksViewer(viewerId, hostUserId)])).some(Boolean)

  const linked = hostUserId != null && !blockPair
  const [hostPublicId, hostRow] = linked
    ? await Promise.all([publicIdFor(hostUserId), prisma.user.findUnique({ where: { id: hostUserId }, select: { username: true } })])
    : [null, null]

  return NextResponse.json({
    code: c,
    name: meta.name || null,
    host,
    hostUserId: hostPublicId,
    // Only beside a `hostUserId` (a dropped public id drops it too).
    hostUsername: hostPublicId ? hostRow?.username ?? null : null,
    dateFrom: meta.dateFrom ?? null,
    dateTo: meta.dateTo ?? null,
    address: meta.address || null,
    coverPhotoUrl: meta.coverPhotoUrl || null,
    joined: p.status === 'ok',
  }, { headers: noStore })
}
