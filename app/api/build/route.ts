import { NextResponse } from 'next/server'

// The commit this instance runs (catalogue model change step 3, for release
// step 8: every serving instance is verified on the cutover build before the
// app build goes out; Codex r1, an old instance accepts a newer app).
// Deplo.io sets DEPLOIO_GIT_REVISION at runtime; anywhere else it reads `dev`.
// Public on purpose: the repository is public, a commit id tells nothing new.
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(
    { build: process.env.DEPLOIO_GIT_REVISION || 'dev' },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
