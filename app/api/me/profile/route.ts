import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

const FL_KEYS = ['floral','citrus','stone','tropical','herbal','oak','body','tannin','acid','sweet']

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const userId = Number(session.user.id)
  const weightedAvg = FL_KEYS.map(f =>
    `ROUND((SUM((flavors->>'${f}')::numeric * score) / NULLIF(SUM(CASE WHEN (flavors->>'${f}')::numeric > 0 THEN score ELSE 0 END), 0))::numeric, 2) AS ${f}`
  ).join(', ')

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${weightedAvg},
            COUNT(*) AS total_rated,
            ROUND(AVG(score)::numeric, 1) AS avg_score,
            COUNT(CASE WHEN score = 5 THEN 1 END) AS five_star
     FROM ratings WHERE user_id = $1 AND score > 0`,
    userId,
  )

  return NextResponse.json(rows[0] || {})
}
