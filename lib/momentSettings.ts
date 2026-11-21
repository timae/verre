import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { momentLinksAvailable, momentLinkUrl } from '@/lib/momentLink'

// Moment Visibility and the look-in link, read and written from the RECORD
// (docs/dev/proposals/moment-visibility.md § 5; step-1 plan T7). The seven
// columns are never mirrored into the cached meta: a meta cached before the
// deploy has no such fields and lives up to a year, so "absent" would read as
// "feature off" on exactly the moments that just opened.
//
// 🔒 NULL reads as closed or off (a tombstone's columns are NULL, and so is
// anything a future path forgets to write).
// 🔒 `host_user_id IS NULL` FREEZES a moment: it can be narrowed, never
// widened, and never has a link. A guest-hosted moment therefore stays closed
// (the insert trigger `sessions_guest_hosted_closed` put it at 'members'), and
// a moment whose host deleted their account keeps what it had.

type Db = Prisma.TransactionClient | typeof prisma

// In widening order.
export const VISIBILITIES = ['members', 'friends', 'followers', 'verre'] as const
export type MomentVisibility = typeof VISIBILITIES[number]
const SWITCHES = ['includeGuestCircles', 'showPlace', 'showDetails'] as const

export type MomentSettings = {
  sessionId: number
  createdAt: number | null
  publicId: string
  hostUserId: number | null
  visibility: MomentVisibility
  includeGuestCircles: boolean
  showPlace: boolean
  showDetails: boolean
  linkVersion: number
  linkActive: boolean
  linkSince: Date | null
}

export type VisibilityPatch = Partial<Pick<MomentSettings, 'visibility' | typeof SWITCHES[number]>>
export type LinkAction = 'share' | 'off' | 'reset'

type Row = {
  id: number; created_at: Date | null; public_id: string; host_user_id: number | null; visibility: string | null
  include_guest_circles: boolean | null; show_place: boolean | null; show_details: boolean | null
  link_version: number | null; link_active: boolean | null; link_since: Date | null
}

const isVisibility = (v: unknown): v is MomentVisibility => (VISIBILITIES as readonly unknown[]).includes(v)

function fromRow(r: Row): MomentSettings {
  return {
    sessionId: Number(r.id),
    createdAt: r.created_at ? r.created_at.getTime() : null,
    publicId: r.public_id,
    hostUserId: r.host_user_id === null ? null : Number(r.host_user_id),
    visibility: isVisibility(r.visibility) ? r.visibility : 'members',
    includeGuestCircles: r.include_guest_circles === true,
    showPlace: r.show_place === true,
    showDetails: r.show_details === true,
    linkVersion: r.link_version ?? 0,
    linkActive: r.link_active === true,
    linkSince: r.link_since,
  }
}

const COLUMNS = Prisma.sql`id, created_at, public_id, host_user_id, visibility, include_guest_circles, show_place, show_details,
  link_version, link_active, link_since`

// By code: the GET (no lock). null = no live row (a guest-only moment, or gone).
export async function readMomentSettingsByCode(db: Db, code: string): Promise<MomentSettings | null> {
  const rows = await db.$queryRaw<Row[]>`SELECT ${COLUMNS} FROM sessions WHERE code = ${code} AND deleted_at IS NULL`
  return rows[0] ? fromRow(rows[0]) : null
}

// By id: inside the session mutation contract, on the row it holds FOR UPDATE.
export async function readMomentSettings(db: Db, sessionId: number): Promise<MomentSettings | null> {
  const rows = await db.$queryRaw<Row[]>`SELECT ${COLUMNS} FROM sessions WHERE id = ${sessionId} AND deleted_at IS NULL`
  return rows[0] ? fromRow(rows[0]) : null
}

// The body of the visibility PATCH: any of the four fields; a value outside
// its set, or none of the four, is null (→ 400).
export function parseVisibilityPatch(body: unknown): VisibilityPatch | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const patch: VisibilityPatch = {}
  if (b.visibility !== undefined) {
    if (!isVisibility(b.visibility)) return null
    patch.visibility = b.visibility
  }
  for (const key of SWITCHES) {
    if (b[key] === undefined) continue
    if (typeof b[key] !== 'boolean') return null
    patch[key] = b[key]
  }
  return Object.keys(patch).length > 0 ? patch : null
}

export function parseLinkAction(body: unknown): LinkAction | null {
  const a = body && typeof body === 'object' ? (body as Record<string, unknown>).action : undefined
  return a === 'share' || a === 'off' || a === 'reset' ? a : null
}

// Does the patch open any of the four wider than it is? Sending the current
// value is never a change; a switch going on is wider.
export function widens(current: MomentSettings, patch: VisibilityPatch): boolean {
  if (patch.visibility !== undefined && VISIBILITIES.indexOf(patch.visibility) > VISIBILITIES.indexOf(current.visibility)) return true
  return SWITCHES.some(key => patch[key] === true && !current[key])
}

export const frozen = (s: MomentSettings): boolean => s.hostUserId === null
export const linkAvailable = (s: MomentSettings): boolean => s.hostUserId !== null && momentLinksAvailable()

// Writes all four, not only the patched ones: `current` is the row as READ
// (NULL = closed / off), so an unpatched column that somehow held NULL is
// stored as the closed value it already read as. Deliberate (fail closed).
export async function writeVisibility(tx: Prisma.TransactionClient, current: MomentSettings, patch: VisibilityPatch): Promise<MomentSettings> {
  const next = { ...current, ...patch }
  await tx.$executeRaw`
    UPDATE sessions
       SET visibility = ${next.visibility}, include_guest_circles = ${next.includeGuestCircles},
           show_place = ${next.showPlace}, show_details = ${next.showDetails}
     WHERE id = ${current.sessionId}`
  return next
}

// 🔒 The version only ever goes up. Share on an active link changes nothing (a
// second device, a cohost: the same link); on a link that is off it raises the
// version FIRST, so turning a link back on never revives an earlier one. Off
// never touches the version. Reset raises it and keeps `active` as it is.
export async function writeLinkAction(tx: Prisma.TransactionClient, current: MomentSettings, action: LinkAction): Promise<MomentSettings> {
  if (action === 'share' && current.linkActive) return current
  if (action === 'off') {
    await tx.$executeRaw`UPDATE sessions SET link_active = false WHERE id = ${current.sessionId}`
  } else if (action === 'share') {
    await tx.$executeRaw`
      UPDATE sessions SET link_version = COALESCE(link_version, 0) + 1, link_active = true, link_since = now() WHERE id = ${current.sessionId}`
  } else {
    await tx.$executeRaw`
      UPDATE sessions SET link_version = COALESCE(link_version, 0) + 1, link_since = now() WHERE id = ${current.sessionId}`
  }
  return (await readMomentSettings(tx, current.sessionId))!
}

export type MomentVisibilityView = {
  visibility: MomentVisibility
  includeGuestCircles: boolean
  showPlace: boolean
  showDetails: boolean
  // No signed-in host: can only be narrowed.
  frozen: boolean
  // Host or cohost, signed in, by the record.
  canEdit: boolean
  // Host and cohosts only. `url` and `since` only while the link is active.
  link?: { available: boolean; active: boolean; url: string | null; since: string | null }
}

// The one wire shape of the three handlers. `settings` null = no record (a
// guest-only moment): closed, frozen, nothing to edit.
export function momentVisibilityView(settings: MomentSettings | null, canEdit: boolean): MomentVisibilityView {
  if (!settings) return { visibility: 'members', includeGuestCircles: false, showPlace: false, showDetails: false, frozen: true, canEdit: false }
  const view: MomentVisibilityView = {
    visibility: settings.visibility,
    includeGuestCircles: settings.includeGuestCircles,
    showPlace: settings.showPlace,
    showDetails: settings.showDetails,
    frozen: frozen(settings),
    canEdit,
  }
  if (!canEdit) return view
  const available = linkAvailable(settings)
  const active = available && settings.linkActive
  view.link = {
    available,
    active,
    url: active ? momentLinkUrl(settings.publicId, settings.linkVersion) : null,
    since: active && settings.linkSince ? settings.linkSince.toISOString() : null,
  }
  return view
}
