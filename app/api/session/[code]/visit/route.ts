import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getSessionMeta, pgUpsertSession } from '@/lib/session'
import { prisma } from '@/lib/prisma'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const c = code.toUpperCase()
  const session = await auth()
  if (!session?.user) return NextResponse.json({ ok: true })

  const meta = await getSessionMeta(c)
  if (!meta) return NextResponse.json({ error: 'session not found' }, { status: 404 })

  try {
    await pgUpsertSession(c, meta)
    await prisma.sessionMember.upsert({
      where: { userId_sessionCode: { userId: Number(session.user.id), sessionCode: c } },
      create: { userId: Number(session.user.id), sessionCode: c },
      update: {},
    })
  } catch (err) {
    console.error('visit error:', err)
  }
  return NextResponse.json({ ok: true })
}
