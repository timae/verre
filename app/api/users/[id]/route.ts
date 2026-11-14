import { NextRequest, NextResponse } from 'next/server'
import { parsePublicIdParam, userIdForPublicId } from '@/lib/publicIds'
import { PROFILE_NO_STORE, serveProfile } from '@/lib/profileRoute'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // FORMAT only before the limiter (an integer is malformed); resolution after
  // it, inside serveProfile, where an unknown id takes the 'gone' path
  // (public-user-ids § 4).
  const publicId = parsePublicIdParam((await params).id)
  if (publicId === null) return NextResponse.json({ error: 'invalid id' }, { status: 400, headers: PROFILE_NO_STORE })
  return serveProfile(req, async () => {
    const id = await userIdForPublicId(publicId)
    return id === null ? null : { id, publicId }
  })
}
