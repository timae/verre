// The shared preamble of GET /api/users/:id/impressions | moments | cravings
// (lists plan D10 / D11): 401 → the public id's FORMAT (400) → the limiter
// (after the 401, per user + a per-IP backstop, the three routes share it) →
// resolve (an unknown id takes the 'gone' path) → the gate: anything but 'ok'
// (gone, shell, blocked-by-me) is 404. Every return path carries `private,
// no-store` (the 404 varies by viewer).
import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/lib/resolveUser'
import { checkRates, getClientIp } from '@/lib/rateLimit'
import { resolveProfileViewer, type ProfileGateOk } from '@/lib/profileVisibility'
import { parsePublicIdParam, userIdForPublicId } from '@/lib/publicIds'

export const NO_STORE = { 'Cache-Control': 'private, no-store' }

export type OpenedProfileList = { viewerId: number; ownerId: number; gate: ProfileGateOk }

export async function openProfileList(req: NextRequest, params: Promise<{ id: string }>): Promise<OpenedProfileList | NextResponse> {
  const session = await resolveUser(req)
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401, headers: NO_STORE })
  const viewerId = Number(session.user.id)
  const { id } = await params
  const publicId = parsePublicIdParam(id)
  if (publicId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400, headers: NO_STORE })
  const rl = await checkRates([
    { key: `rl:profile-lists:u:${viewerId}:1m`, max: 60, windowSeconds: 60 },
    { key: `rl:profile-lists:ip:${getClientIp(req)}:1m`, max: 300, windowSeconds: 60 },
  ])
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: NO_STORE })
  const ownerId = await userIdForPublicId(publicId)
  const gate = ownerId === null ? null : await resolveProfileViewer(ownerId, viewerId)
  if (ownerId === null || !gate || gate.status !== 'ok') return NextResponse.json({ error: 'not found' }, { status: 404, headers: NO_STORE })
  return { viewerId, ownerId, gate }
}
