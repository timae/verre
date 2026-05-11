import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { uploadImage } from '@/lib/s3'
import { scrub } from '@/lib/textSafe'
import type { Identity } from '@/lib/identity'
import { userIdentityId } from '@/lib/identity'

// Inlined S3 reclaim — see app/api/checkins/[id]/route.ts for the same
// helper and the bundler-bug rationale.
const _S3_ENDPOINT = process.env.S3_ENDPOINT
const _S3_BUCKET = process.env.S3_BUCKET
const _s3 = _S3_ENDPOINT
  ? new S3Client({
      endpoint: _S3_ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
      forcePathStyle: true,
    })
  : null
async function reclaimImage(url: string | null | undefined) {
  if (!_s3 || !_S3_BUCKET || !url || !_S3_ENDPOINT) return
  const prefix = `${_S3_ENDPOINT}/${_S3_BUCKET}/`
  if (!url.startsWith(prefix)) return
  const key = url.slice(prefix.length)
  if (!key) return
  try {
    await _s3.send(new DeleteObjectCommand({ Bucket: _S3_BUCKET, Key: key }))
  } catch (err) {
    console.warn('[s3] reclaimImage failed:', { key, err })
  }
}

export type WineMeta = {
  id: string
  name: string
  producer: string
  vintage: string
  grape: string
  type: string
  image: string
  imageUrl: string
  revealedAt?: string | null
  // Identity-id of the participant who added this wine. Used by two
  // independent flows: (1) kick/ban to identify which wines a host can
  // choose to orphan; (2) the provider role, which can edit/delete only
  // wines they added (matched via this field). Optional for backward
  // compat with pre-feature wine rows — those NULL rows never match a
  // ban-target filter and a provider's own-wine check rejects them
  // because `undefined !== provider.id`. The provenance anchor is
  // independent of the role grant: a former provider who got demoted
  // still has `addedByIdentityId` on their wines, but loses edit power
  // until re-promoted.
  //
  // Server-only — the wines GET wire payload strips this field and
  // replaces it with a per-caller `isMine` boolean so anon-id
  // correlation across multiple wines stays server-internal.
  addedByIdentityId?: string
}

// Wire shape produced by `wineToWire` — same as `WineMeta` minus
// the server-only `addedByIdentityId` field, plus two wire-only flags:
// `isMine: boolean` (synthesized per-caller at response time) and
// `_blind?: boolean` (set by the blind-redaction path in the wines GET
// when a wine is hidden from the caller). Neither lives on
// `WineMeta`: they're never stored in Redis or Postgres, only emitted
// on the wire, so keeping them off the storage type prevents
// accidental reads that would always be undefined.
export type WireWine = Omit<WineMeta, 'addedByIdentityId'> & {
  isMine: boolean
  _blind?: boolean
}

// Project a `WineMeta` to its wire shape: strip `addedByIdentityId`
// and synthesize `isMine` for the caller. This is the SINGLE
// sanctioned transform — every endpoint that returns wines must
// route through here. Skipping it leaks anon-id correlation across
// wines from the same adder, which the wire-strip is specifically
// designed to prevent.
//
// `callerId` is the caller's identity-id (`u:<userId>` or `a:<uuid>`).
// For server actions where the caller is by definition the adder
// (e.g. wine POST), pass the same id — `isMine` resolves to true.
export function wineToWire(w: WineMeta, callerId: string): WireWine {
  const { addedByIdentityId: provenance, ...rest } = w
  return { ...rest, isMine: !!provenance && provenance === callerId }
}

export type RatingMeta = {
  score: number
  flavors: Record<string, number>
  notes: string
  at: number
}

export type SessionMeta = {
  host: string
  name: string
  createdAt: number
  hostUserId: number | null
  // Identity id of the host. `u:<userId>` for logged-in hosts (redundant with
  // hostUserId), `a:<uuid>` for anonymous hosts (the only stable handle).
  hostIdentityId?: string
  blind?: boolean
  lifespan?: string
  coHostIds?: string[]
  // Provider role: can add wines and edit/delete the wines they added,
  // but has no other host powers (no settings, no reorder, no reveal,
  // no moderation). Mutually exclusive with cohost. Trust anchor lives
  // here in Redis; mirrored to session_members.role on Postgres.
  providerIds?: string[]
  address?: string
  dateFrom?: string | null
  dateTo?: string | null
  timezone?: string
  description?: string
  link?: string
  hideLineup?: boolean
  hideLineupMinutesBefore?: number
}

export { genCode } from '@/lib/sessionCode'

export async function getSessionMeta(code: string): Promise<SessionMeta | null> {
  const raw = await redis.get(k.meta(code))
  return raw ? JSON.parse(raw) : null
}

export async function getWines(code: string): Promise<WineMeta[]> {
  const raw = await redis.get(k.wines(code))
  return raw ? JSON.parse(raw) : []
}

// Host check by stable identity id. Returns true for the strict host AND
// for any cohost — both are allowed to do host-equivalent actions like
// editing wines and settings. Strict-host-only actions (cohost role
// assignment, session delete, banning a cohost) check via `isStrictHost`.
export function isHostByIdentity(meta: SessionMeta, identity: Identity | null): boolean {
  if (!identity) return false
  if (meta.hostIdentityId && identity.id === meta.hostIdentityId) return true
  if (meta.hostUserId && identity.id === userIdentityId(meta.hostUserId)) return true
  if (meta.coHostIds?.includes(identity.id)) return true
  return false
}

// Strict-host check: only the original session host, never a cohost.
// Used for actions that mutate role/membership semantics — cohost
// promote/demote, session delete, banning a cohost.
export function isStrictHost(meta: SessionMeta, identity: Identity | null): boolean {
  if (!identity) return false
  if (meta.hostIdentityId && identity.id === meta.hostIdentityId) return true
  if (meta.hostUserId && identity.id === userIdentityId(meta.hostUserId)) return true
  return false
}

// Check whether a session-scoped identity-id refers to a cohost. Used
// by ban/kick targeting rules to enforce "cohosts can't ban cohosts."
export function isCohostId(meta: SessionMeta, identityId: string): boolean {
  return !!meta.coHostIds?.includes(identityId)
}

// Provider check by stable identity id. NOT a superset of host/cohost —
// providers are their own tier with narrowly scoped wine-CRUD powers
// limited to wines they added themselves (matched via the wine's
// `addedByIdentityId` field). Note: the provenance anchor
// `wines.addedByIdentityId` is independent of role grant — a user who
// added wines as a provider and later got demoted to taster keeps the
// provenance, but loses edit power until re-promoted.
//
// Signature mirrors isCohostId — takes an identityId string for use at
// any call site where the full Identity object isn't on hand.
export function isProviderById(meta: SessionMeta, identityId: string): boolean {
  return !!meta.providerIds?.includes(identityId)
}

export function sanitizeImage(value: unknown): string {
  if (!value || typeof value !== 'string') return ''
  if (!value.startsWith('data:image/')) return ''
  if (value.length > 1_500_000) return ''
  return value
}

// `scrub()` handles control chars + bidi/zero-width spoofing. It
// returns null for empty input; we coerce back to '' here so the
// existing wine-name truthy check still works the same way.
function clean(v: unknown): string {
  return scrub(v) ?? ''
}

export async function addWineToSession(
  code: string,
  body: Partial<WineMeta>,
  existing?: WineMeta,
  addedByIdentityId?: string,
): Promise<WineMeta | { error: string }> {
  const name = clean(body.name)
  const type = String(body.type || '').trim()
  if (!name) return { error: 'name required' }
  if (!['red', 'white', 'spark', 'rose', 'nonalc'].includes(type)) return { error: 'valid type required' }

  let imageUrl = existing?.imageUrl || ''
  let image = body.image === undefined
    ? (existing?.image || '')
    : sanitizeImage(body.image)

  // Upload to S3 if new base64 image provided. uploadImage keys by wine id,
  // so a same-extension replace overwrites in place. If the new image has
  // a different extension the old key would be orphaned — handle that by
  // deleting the previous URL only after the new upload succeeds. This
  // upload-first-then-cleanup ordering is failure-safe: if the new upload
  // throws or returns empty, the old image stays referenced and accessible.
  if (image && image.startsWith('data:image/')) {
    try {
      const id = existing?.id || Date.now().toString()
      const url = await uploadImage(`wines/${id}`, image)
      if (url) {
        if (existing?.imageUrl && existing.imageUrl !== url) {
          reclaimImage(existing.imageUrl)
        }
        imageUrl = url
        image = ''
      }
    } catch {}
  }

  return {
    id: existing?.id || Date.now().toString(),
    name,
    producer: clean(body.producer),
    vintage: clean(body.vintage).slice(0, 4),
    grape: clean(body.grape),
    type,
    image,
    imageUrl,
    // Preserve on edit; populate on create. Edits never overwrite the
    // original adder — `existing.addedByIdentityId` wins.
    addedByIdentityId: existing?.addedByIdentityId ?? addedByIdentityId,
  }
}

export async function pgUpsertSession(code: string, meta: SessionMeta) {
  await prisma.session.upsert({
    where: { code },
    create: {
      code,
      hostName: meta.host,
      hostUserId: meta.hostUserId,
      name: meta.name || null,
      createdAt: new Date(meta.createdAt),
    },
    update: { name: meta.name || undefined },
  })
}

export async function pgUpsertWine(sessionCode: string, wine: WineMeta) {
  const session = await prisma.session.findUnique({ where: { code: sessionCode } })
  if (!session) return
  await prisma.wine.upsert({
    where: { id: wine.id },
    create: {
      id: wine.id,
      sessionId: session.id,
      name: wine.name,
      producer: wine.producer || null,
      vintage: wine.vintage || null,
      grape: wine.grape || null,
      style: wine.type || null,
      imageUrl: wine.imageUrl || null,
      addedByIdentityId: wine.addedByIdentityId ?? null,
    },
    update: {
      name: wine.name,
      producer: wine.producer || null,
      vintage: wine.vintage || null,
      grape: wine.grape || null,
      style: wine.type || null,
      imageUrl: wine.imageUrl || undefined,
      // Don't overwrite provenance on edit — the original adder is the
      // authoritative anchor. If the row was created pre-feature with
      // addedByIdentityId=NULL we leave it NULL (no way to back-attribute).
    },
  })
}
