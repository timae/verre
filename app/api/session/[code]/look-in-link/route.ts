import { NextRequest } from 'next/server'
import { refuse } from '@/lib/sessionMutation'
import { linkAvailable, parseLinkAction, writeLinkAction } from '@/lib/momentSettings'
import { momentSettingsWrite } from '@/lib/momentSettingsRoute'

// The look-in link: `{ action: 'share' | 'off' | 'reset' }`, host and cohosts,
// the same contract, checks and limiter as the visibility PATCH. Replies with
// the visibility GET's shape (the link's status and, while active, its URL).
// The link is independent of Moment Visibility: it works on 'members' too.
// 🔒 A moment with no signed-in host never has a link (lib/momentLink.ts).
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  return momentSettingsWrite(req, code, 'look-in-link', parseLinkAction, async (tx, current, action) => {
    if (!linkAvailable(current)) throw refuse(403, 'This moment can\'t have a link')
    return writeLinkAction(tx, current, action)
  })
}
