import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

// Mutual follows — people who follow you AND you follow back
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'auth required' }, { status: 401 })
  const userId = Number(session.user.id)

  const friends = await prisma.$queryRaw<{ id: number; name: string }[]>`
    SELECT u.id, u.name
    FROM follows f1
    JOIN follows f2 ON f2.follower_id = f1.following_id AND f2.following_id = f1.follower_id
    JOIN users u ON u.id = f1.following_id
    WHERE f1.follower_id = ${userId}
    ORDER BY u.name ASC
  `

  return NextResponse.json(friends)
}
