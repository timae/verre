import { cleanUrl } from '@/lib/session'
import { scrub } from '@/lib/textSafe'

// Shared application of the optional session detail fields, used by BOTH
// POST /api/session (create, milestone 4 native 02a) and the settings PATCH
// — one home so the validators can't drift. Mutates `meta` in place (the
// PATCH's existing contract). Deliberately NOT here: the pro-gated fields
// (blind, lifespan) and the cover photo — their gating differs between
// create and settings and stays in the routes.

type SessionFieldsTarget = {
  name?: string
  address?: string
  dateFrom?: string | null
  dateTo?: string | null
  timezone?: string
  description?: string
  link?: string
  hideLineup?: boolean
  hideLineupMinutesBefore?: number
}

// Returns an error message for a rejectable payload (callers map it to 400),
// or null on success. Mutation only happens field-by-field as checks pass —
// a returned error may leave earlier fields applied, which is fine because
// every caller bails out of the request without persisting `meta`.
export function applySessionFields(meta: SessionFieldsTarget, body: Record<string, unknown>): string | null {
  // Dates must PARSE, not just be strings: `new Date('garbage')` is an
  // Invalid Date that throws inside prisma.session.create AFTER the Redis
  // writes — a 500 + a live Redis session with no archive row.
  const date = (v: unknown, label: string): { value: string | null } | { error: string } => {
    if (v === undefined || v === null || v === '') return { value: null }
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return { error: `invalid ${label}` }
    return { value: v }
  }
  if (body.dateFrom !== undefined) {
    const d = date(body.dateFrom, 'dateFrom')
    if ('error' in d) return d.error
    meta.dateFrom = d.value
  }
  if (body.dateTo !== undefined) {
    const d = date(body.dateTo, 'dateTo')
    if ('error' in d) return d.error
    meta.dateTo = d.value
  }
  // scrub() on every free-text field (lib/CLAUDE.md): strips C0 controls,
  // bidi overrides, and zero-width chars before they reach Redis/Postgres.
  // (The settings PATCH historically omitted it — fixed here for both.)
  // scrub returns null for non-strings/empty — coalesce back to ''.
  if (body.name !== undefined)        meta.name        = (scrub(String(body.name        || '')) ?? '').slice(0, 80)
  if (body.address !== undefined)     meta.address     = (scrub(String(body.address     || '')) ?? '').slice(0, 255)
  if (body.timezone !== undefined)    meta.timezone    = String(body.timezone || '').trim().slice(0, 64)
  if (body.description !== undefined) meta.description = (scrub(String(body.description || '')) ?? '').slice(0, 1000)
  // cleanUrl enforces http(s)-only — without it a host could store a
  // `javascript:`/`data:` URL that renders as a clickable scheme-injection
  // link to every participant. Same guard wine purchaseUrl uses.
  if (body.link !== undefined)        meta.link        = cleanUrl(body.link).slice(0, 512)
  if (body.hideLineup !== undefined)  meta.hideLineup  = !!body.hideLineup
  // Clamped to a sane day-bounded window — an extreme/negative value would
  // skew the reveal-countdown math on every client.
  if (body.hideLineupMinutesBefore !== undefined) {
    meta.hideLineupMinutesBefore = Math.max(0, Math.min(1440, Math.floor(Number(body.hideLineupMinutesBefore) || 0)))
  }
  return null
}
