import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { SessionMeta } from '@/lib/session'

// The Postgres record of a session (redis-rehydration § 3: for a Postgres-backed
// session the record is the truth and Redis a rebuildable cache). One read of
// the live row and the ONE mapping record → `SessionMeta` (§ 5.2), shared by
// the rebuild and by every meta rewrite of a Postgres-backed session (plan
// § 1.5 / D4): meta is always written FROM the record, never as a delta on
// cached meta, so a refused or lost projection is repaired by the next meta
// write of any kind. The inverse mapping is sessionMetaToColumns (lib/session.ts).

type Db = Prisma.TransactionClient | typeof prisma

export type SessionRow = {
  id: number
  code: string
  hostUserId: number | null
  hostName: string | null
  name: string | null
  blind: boolean | null
  blindForEveryone: boolean | null
  createdAt: Date | null
  archivedAt: Date | null
  address: string | null
  dateFrom: Date | null
  dateTo: Date | null
  timezone: string | null
  description: string | null
  link: string | null
  coverPhotoUrl: string | null
  category: string | null
  lifespan: string | null
  hideLineup: boolean | null
  hideLineupMinutesBefore: number | null
  showProvenance: boolean | null
}

const COLUMNS = Prisma.sql`id, code, host_user_id AS "hostUserId", host_name AS "hostName", name, blind,
  blind_for_everyone AS "blindForEveryone", created_at AS "createdAt", archived_at AS "archivedAt", address,
  date_from AS "dateFrom", date_to AS "dateTo", timezone, description, link, cover_photo_url AS "coverPhotoUrl",
  category, lifespan, hide_lineup AS "hideLineup", hide_lineup_minutes_before AS "hideLineupMinutesBefore",
  show_provenance AS "showProvenance"`

// The live (not soft-deleted) row for a code, or null. `lock` adds the row lock
// a writer needs for a decision that depends on the row existing.
export async function readLiveRow(db: Db, code: string, lock: 'update' | 'key share' | null = null): Promise<SessionRow | null> {
  const clause = lock === 'update' ? Prisma.sql`FOR UPDATE` : lock === 'key share' ? Prisma.sql`FOR KEY SHARE` : Prisma.empty
  const rows = await db.$queryRaw<SessionRow[]>`
    SELECT ${COLUMNS} FROM sessions WHERE code = ${code} AND deleted_at IS NULL ${clause}`
  const r = rows[0]
  return r ? { ...r, id: Number(r.id), hostUserId: r.hostUserId === null ? null : Number(r.hostUserId) } : null
}

export type RecordRoles = { coHostIds: string[]; providerIds: string[] }

// Cohosts and providers of the record, as `u:<id>`, filtered by eligibility
// (a kicked or banned member, or one whose user is gone, holds no role).
export async function readRecordRoles(db: Db, code: string): Promise<RecordRoles> {
  const rows = await db.$queryRaw<{ user_id: number; role: string }[]>`
    SELECT m.user_id, m.role FROM session_members m
      JOIN users u ON u.id = m.user_id
     WHERE m.session_code = ${code} AND m.role IN ('co_host', 'provider')
       AND m.removed_state IS DISTINCT FROM 'kicked'
       AND NOT EXISTS (SELECT 1 FROM session_bans b WHERE b.session_code = m.session_code AND b.identity_id = 'u:' || m.user_id)
     ORDER BY m.joined_at, m.user_id`
  return {
    coHostIds: rows.filter(r => r.role === 'co_host').map(r => `u:${r.user_id}`),
    providerIds: rows.filter(r => r.role === 'provider').map(r => `u:${r.user_id}`),
  }
}

// record → SessionMeta (§ 5.2). `cache` contributes ONLY what the record cannot
// hold (ruling 3 — anonymous identities have no record): an `a:` hostIdentityId
// when the record has no host user, and the `a:` entries of the role lists.
// Optional settings that are NULL stay absent (readers treat absent as the
// default: 48h, lineup shown, provenance shown).
export function metaFromRecord(row: SessionRow, roles: RecordRoles, cache: SessionMeta | null = null): SessionMeta {
  const anonHost = row.hostUserId === null && cache?.hostIdentityId?.startsWith('a:') ? cache.hostIdentityId : undefined
  const anonOnly = (ids: string[] | undefined) => (ids ?? []).filter(id => id.startsWith('a:'))
  const meta: SessionMeta = {
    host: row.hostName ?? '',
    name: row.name ?? '',
    createdAt: row.createdAt ? row.createdAt.getTime() : 0,
    hostUserId: row.hostUserId,
    blind: !!row.blind,
    blindForEveryone: !!row.blindForEveryone,
    category: row.category ?? 'wine',
    coHostIds: [...roles.coHostIds, ...anonOnly(cache?.coHostIds)],
    providerIds: [...roles.providerIds, ...anonOnly(cache?.providerIds)],
  }
  if (row.hostUserId !== null) meta.hostIdentityId = `u:${row.hostUserId}`
  else if (anonHost) meta.hostIdentityId = anonHost
  if (row.archivedAt) meta.promotedAt = row.archivedAt.getTime()
  if (row.address) meta.address = row.address
  if (row.dateFrom) meta.dateFrom = row.dateFrom.toISOString()
  if (row.dateTo) meta.dateTo = row.dateTo.toISOString()
  if (row.timezone) meta.timezone = row.timezone
  if (row.description) meta.description = row.description
  if (row.link) meta.link = row.link
  if (row.coverPhotoUrl) meta.coverPhotoUrl = row.coverPhotoUrl
  if (row.lifespan) meta.lifespan = row.lifespan
  if (row.hideLineup !== null) meta.hideLineup = row.hideLineup
  if (row.hideLineupMinutesBefore !== null) meta.hideLineupMinutesBefore = row.hideLineupMinutesBefore
  if (row.showProvenance !== null) meta.showProvenance = row.showProvenance
  return meta
}
