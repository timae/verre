import { NextRequest, NextResponse } from 'next/server'
import { normalizePublicUserId } from '@verre/core'
import { resolveUser } from '@/lib/resolveUser'
import { checkRates, getClientIp } from '@/lib/rateLimit'
import { momentLookInEnabled } from '@/lib/momentGate'
import { decideMoments } from '@/lib/momentAudience'
import { buildLookIn, buildLookInDetails, lookInJson, lookInLinkValid, lookInNotFound, NO_STORE, parseBottleKeys, readLookInRow } from '@/lib/momentLookIn'

// GET /api/moments/:publicId — look into a moment without its code (Moment
// Visibility, step-1 plan § 4.1; app only). Optional `X-Verre-Link: <32 hex>`:
// present, the LINK decides; absent, the AUDIENCE does (lib/momentAudience.ts).
// Never mixed: a dead link is refused even for a member.
// Order: flag → signed in → limiter (every request, before any lookup) → parse
// → the link's HMAC (computed for an unknown id too) → the row → decide.
// 🔒 ONE refusal (`lookInNotFound`) for everything that is not an answer.
// Answers: `{ member: true }` (the record's rule, as the moment itself) or the
// look-in (lib/momentLookIn.ts). Every answer `private, no-store`.
// `?bottles=<key>,…` (1 to 30 stable bottle keys) asks for the DETAILS read
// instead (step-2 plan § 3.2): the same order, admission, link rule, limiter
// and refusal; a malformed list is the one 404 like a malformed token.
const TOKEN = /^[0-9a-f]{32}$/

export async function GET(req: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  if (!momentLookInEnabled()) return lookInNotFound()
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: NO_STORE })
  const viewerId = Number(session.user.id)
  const rl = await checkRates([
    { key: `rl:lookin:u:${viewerId}:1m`, max: 60, windowSeconds: 60 },
    { key: `rl:lookin:ip:${getClientIp(req)}:1m`, max: 600, windowSeconds: 60 },
  ])
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests', retryAfter: rl.retryAfter }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfter) } })
  }
  const publicId = normalizePublicUserId((await params).publicId)
  const token = req.headers.get('x-verre-link')
  const asked = parseBottleKeys(req.nextUrl.searchParams)
  if (!publicId || (token !== null && !TOKEN.test(token)) || asked === null) return lookInNotFound()
  const row = await readLookInRow(publicId)
  const linked = token !== null && lookInLinkValid(publicId, row, token)
  if (!row || (token !== null && !linked)) return lookInNotFound()
  const d = (await decideMoments(viewerId, [row.id], { everyone: true })).get(row.id)
  if (!d) return lookInNotFound()
  // The record's member first: by-moment answers them by the same rule, a
  // block with the host included (review r1). A banned person is no member.
  if (d.member) return lookInJson({ member: true })
  if (d.refused || (!linked && !d.open)) return lookInNotFound()
  const body = asked === undefined ? await buildLookIn(row, d) : await buildLookInDetails(row, d, asked)
  return body ? lookInJson(body) : lookInNotFound()
}
