import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { hasKey } from '@/lib/redis'
import { normalizeCode } from '@verre/core'
import { resolveIdentity, participantOrBanned } from '@/lib/identity'
import { openSessionFor } from '@/lib/sessionRoute'
import { checkRate, formatWait } from '@/lib/rateLimit'
import { wireIdentity } from '@/lib/publicIds'

type Ctx = { params: Promise<{ code: string }> }

const noStore = { 'Cache-Control': 'private, no-store' }

// GET /api/session/<code>/removed-state
//
// Used by the /join/<code>?removed=1 bounce screen to determine whether
// the caller was kicked, banned, or is just a stranger. Returns one of:
//   { state: 'banned' }   — in bans Set
//   { state: 'kicked' }   — in kicked Set (kicked-keep variant; ratings
//                           may still exist in their history)
//   { state: 'none' }     — not removed; the bounce was incidental, the
//                           caller should see the normal join form
//
// Authorization: caller must resolve to an identity (auth cookie OR a
// known anon token via x-vr-anon-token). No-identity returns 'none' —
// they're just a visitor who landed here without context.
//
// Rate-limited per-identity so a banned attacker holding their token
// can't poll cheaply. Cheap-enough budget for the legitimate bounce
// flow (one fetch on mount).
export async function GET(req: NextRequest, { params }: Ctx) {
  const { code } = await params
  const c = normalizeCode(code)
  if (!c) return NextResponse.json({ state: 'none' }, { headers: noStore })
  const session = await resolveUser(req)
  // A gone moment answers 'none' (the bounce screen sends the caller to the
  // join form); a spent wrong-code budget a 429 the screen shows as is.
  const opened = await openSessionFor(c, req, session, { absent: () => NextResponse.json({ state: 'none' }, { headers: noStore }) })
  if (opened instanceof NextResponse) return opened
  const identity = await resolveIdentity(c, req, session)
  if (!identity) return NextResponse.json({ state: 'none' }, { headers: noStore })

  const rl = await checkRate(`rl:removed-state:${identity.id}:1m`, 10, 60)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${formatWait(rl.retryAfter)}.` },
      { status: 429, headers: { ...noStore, 'Retry-After': String(rl.retryAfter) } },
    )
  }

  // The same admission as every session route: the record decides for a `u:`
  // caller of a Postgres-backed session (re-seeding a missing Redis entry), the
  // Redis sets for everyone else.
  const p = await participantOrBanned(c, req, session, opened.meta)
  if (p.status === 'banned') {
    return NextResponse.json({ state: 'banned', identityId: await wireIdentity(identity.id) }, { headers: noStore })
  }
  if (p.status === 'kicked') {
    // Did they have any ratings to keep/delete? Surface as a hint so the
    // bounce can skip the prompt when there's nothing actionable.
    const hasRatings = !!p.identity.grant?.author || await hasKey(`s:${c}:r:${identity.id}:*`)
    return NextResponse.json({ state: 'kicked', identityId: await wireIdentity(identity.id), hasRatings }, { headers: noStore })
  }
  return NextResponse.json({ state: 'none' }, { headers: noStore })
}
