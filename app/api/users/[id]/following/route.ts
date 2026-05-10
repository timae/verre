import { NextRequest } from 'next/server'
import { listProfilePeople } from '@/lib/profilePeople'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return listProfilePeople(req, params, 'following')
}
