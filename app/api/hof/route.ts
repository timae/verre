import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { decimalToNumber } from '@verre/core'

export async function GET() {
  const entries = await prisma.hallOfFame.findMany({
    orderBy: { ratedAt: 'desc' },
    take: 100,
    include: { user: { select: { name: true } } },
  })

  return NextResponse.json(entries.map(e => ({
    wineName: e.wineName, producer: e.producer, vintage: e.vintage,
    type: e.style, score: decimalToNumber(e.score), rater: e.raterName,
    accountName: e.user?.name, sessionCode: e.sessionCode, at: e.ratedAt,
  })))
}
