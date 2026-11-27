import type { Prisma } from '@prisma/client'
import type { SessionRow } from '@/lib/sessionRecord'
import { seedParticipation } from '@/lib/momentDefaults'

// The durable membership row for a logged-in participant (redis-rehydration
// § 4.4, R2-5), written by /visit, the logged-in /join and the logged-in /rate,
// INSIDE their mutation contract (the advisory lock + the live row FOR UPDATE
// are held; the caller's admission was decided from its fresh grant there).
//
//  - 🔒 The role comes from the RECORD, never from cached roles (r1-3): 'host'
//    iff sessions.host_user_id = me, else 'taster'. A cached coHostIds /
//    providerIds entry becomes a role only at promotion (G3), the one moment
//    Redis is still the authority; afterwards only set-role grants roles.
//  - Create-only: an existing row (its role, its kick state) is never
//    overwritten here — except `clearKick`, the explicit /join, which re-admits
//    a kicked member (docs/dev/kick-ban.md: /visit bounces, /join re-admits).
//  - First creation bumps lifetime_sessions_joined, decided by the INSERT
//    itself (RETURNING), so concurrent entries count once.
//  - Only for a live row: session_members is keyed by code, and a row written
//    for a Redis-only session would attach this user to whichever session
//    later recycles the code (r1-2).
//  - 🔒 An ENTRY writer (Moment Defaults K1, census scripts/check-member-writes.mjs):
//    when participation STARTS here (the row was inserted, or `/join` cleared
//    a kick: kick-keep writes kicked placeholders for any account), the
//    person's defaults are copied (seedParticipation: not over an existing
//    choice, not for someone who already rated in this moment). Never for the
//    strict host: the create seeded them; a host row written later is a legacy
//    host the grant always admitted.
// Returns true when the row was created.
export async function ensureMemberRow(
  tx: Prisma.TransactionClient, row: Pick<SessionRow, 'id' | 'code' | 'hostUserId'>, userId: number, { clearKick = false }: { clearKick?: boolean } = {},
): Promise<boolean> {
  const role = row.hostUserId === userId ? 'host' : 'taster'
  const inserted = await tx.$queryRaw<{ user_id: number }[]>`
    INSERT INTO session_members (user_id, session_code, role) VALUES (${userId}, ${row.code}, ${role})
    ON CONFLICT (user_id, session_code) DO NOTHING
    RETURNING user_id`
  const cleared = clearKick
    ? await tx.$executeRaw`
        UPDATE session_members SET removed_state = NULL
         WHERE user_id = ${userId} AND session_code = ${row.code} AND removed_state = 'kicked'`
    : 0
  if (inserted.length > 0) {
    await tx.$executeRaw`UPDATE users SET lifetime_sessions_joined = lifetime_sessions_joined + 1 WHERE id = ${userId}`
  }
  if ((inserted.length > 0 || cleared > 0) && row.hostUserId !== userId) await seedParticipation(tx, row, [userId])
  return inserted.length > 0
}
