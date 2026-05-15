import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { uploadImage } from '@/lib/s3'
import { scrub } from '@/lib/textSafe'
import type { Identity } from '@/lib/identity'
import { userIdentityId } from '@/lib/identity'
import { COUNTRY_CODES } from '@/lib/countries'

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
  description?: string
  region?: string
  country?: string
  vinification?: string
  purchaseUrl?: string
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
  // Snapshot of the adder's display name at create time, used as a
  // fallback when the live identities map no longer has them (kicked
  // anon adder is the canonical case). Frozen forever — edits never
  // refresh it. The wire resolution at read time prefers the live map
  // first, falls back to users.name for logged-in adders, then to this
  // snapshot. Unlike addedByIdentityId, this is safe to surface on the
  // wire — display names are already public via the identities map.
  addedByDisplayName?: string
}

// Wire shape produced by `wineToWire` — same as `WineMeta` minus
// the server-only `addedByIdentityId` field, plus two wire-only flags:
// `isMine: boolean` (synthesized per-caller at response time) and
// `_blind?: boolean` (set by the blind-redaction path in the wines GET
// when a wine is hidden from the caller). The `addedByDisplayName`
// field is widened from optional-string-snapshot on `WineMeta` to
// resolved-string-or-null on the wire (live map → users.name →
// snapshot → null). Neither isMine nor _blind lives on `WineMeta`:
// they're never stored in Redis or Postgres, only emitted on the
// wire, so keeping them off the storage type prevents accidental
// reads that would always be undefined.
export type WireWine = Omit<WineMeta, 'addedByIdentityId' | 'addedByDisplayName'> & {
  isMine: boolean
  addedByDisplayName: string | null
  // Public userId for logged-in adders ONLY (null for anon adders and
  // pre-feature wines). Lets the brought-by surface render as a
  // clickable profile link without re-exposing the raw addedByIdentityId.
  addedByUserId: number | null
  _blind?: boolean
}

// The SINGLE sanctioned wire transform — every endpoint that returns
// wines must route through here. Skipping it leaks `addedByIdentityId`,
// which would let a viewer correlate which wines came from the same anon
// adder across a session.
//
// Resolution priority for `addedByDisplayName`:
//   1. identities[addedByIdentityId]      (live participant name)
//   2. userNameLookup[addedByIdentityId]  (kicked logged-in adder)
//   3. snapshot on the wine                (kicked anon adder; pre-feature has no snapshot)
//   4. null
//
// `addedByUserId` exposes ONLY logged-in adders' public userId so the
// UI can render the brought-by name as a clickable profile link.
// Anonymous adders' `a:<uuid>` is never surfaced (prevents anon-id
// correlation across wines from the same adder, same rationale as the
// `addedByIdentityId` strip). `/u/<id>` URLs are already public, so a
// numeric userId carries no new privacy surface.
export function wineToWire(
  w: WineMeta,
  callerId: string,
  identities: Record<string, string> = {},
  userNameLookup: Map<string, string> = new Map(),
): WireWine {
  const { addedByIdentityId: provenance, addedByDisplayName: snapshot, ...rest } = w
  let resolvedName: string | null = null
  let userId: number | null = null
  if (provenance) {
    if (identities[provenance]) resolvedName = identities[provenance]
    else if (provenance.startsWith('u:') && userNameLookup.has(provenance)) {
      resolvedName = userNameLookup.get(provenance)!
    }
    else if (snapshot) resolvedName = snapshot
    if (provenance.startsWith('u:')) {
      const n = Number(provenance.slice(2))
      if (Number.isInteger(n) && n > 0) userId = n
    }
  }
  return {
    ...rest,
    isMine: !!provenance && provenance === callerId,
    addedByDisplayName: resolvedName,
    addedByUserId: userId,
  }
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

// Defang URL inputs at the write boundary: only allow http(s) schemes
// through with no embedded whitespace (\n, \t, etc. that `scrub` permits
// elsewhere). Everything else — `javascript:`, `data:`, `vbscript:`,
// URLs with embedded newlines — collapses to `''`. Empty input stays
// empty. This protects any future render path (or third-party consumer
// like /api/me/bookmarks which already surfaces purchase_url) from
// being tricked into clickable scheme-injection links.
function cleanUrl(v: unknown): string {
  const s = clean(v)
  if (!s) return ''
  return /^https?:\/\/\S+$/i.test(s) ? s : ''
}

// ISO 3166-1 alpha-2 allow-list. Normalize and validate at the write
// boundary so garbage codes (`XX`, `12`, single chars from typos) never
// reach Postgres. Invalid input collapses to `''`. The dropdown picker
// in the UI only offers valid codes, so this is defense-in-depth.
//
// Requires the cleaned input to be exactly 2 chars before lookup, so a
// 3-char typo like `'usa'` doesn't silently truncate to `'US'` and pass.
function cleanCountry(v: unknown): string {
  const s = clean(v).toUpperCase()
  if (s.length !== 2) return ''
  return COUNTRY_CODES.has(s) ? s : ''
}

// Batch-lookup display names for `u:<id>` adders whose identity is no
// longer in the session's identities map (kicked / banned logged-in
// users). One Prisma query per request — empty input short-circuits.
// Anonymous adders (`a:<uuid>`) have no users row to fall back to and
// are excluded from the input here.
//
// Used by the wines GET / reorder / POST / PATCH / reveal routes when
// they build the wire response. Postgres failures collapse to an empty
// map so the live wines polling endpoint keeps working through a DB
// hiccup — the wire resolver still has the live-identities and
// snapshot fallback paths.
export async function buildKickedUserNameLookup(
  wines: WineMeta[],
  identities: Record<string, string>,
): Promise<Map<string, string>> {
  const missingUserIds = new Set<number>()
  for (const w of wines) {
    const id = w.addedByIdentityId
    if (!id || !id.startsWith('u:')) continue
    if (identities[id]) continue  // covered by the live map
    const n = Number(id.slice(2))
    if (Number.isInteger(n) && n > 0) missingUserIds.add(n)
  }
  if (missingUserIds.size === 0) return new Map()
  const out = new Map<string, string>()
  try {
    const rows = await prisma.user.findMany({
      where: { id: { in: [...missingUserIds] } },
      select: { id: true, name: true },
    })
    for (const r of rows) out.set(`u:${r.id}`, r.name)
  } catch (err) {
    console.error('[wines] buildKickedUserNameLookup failed, falling back:', err)
  }
  return out
}

export async function addWineToSession(
  code: string,
  body: Partial<WineMeta>,
  existing?: WineMeta,
  addedByIdentityId?: string,
  addedByDisplayName?: string,
): Promise<WineMeta | { error: string }> {
  const name = clean(body.name)
  const type = String(body.type || '').trim()
  if (!name) return { error: 'name required' }
  if (!['red', 'white', 'spark', 'rose', 'nonalc'].includes(type)) return { error: 'valid type required' }

  // Mint the wine id once and reuse it for both the S3 upload key and
  // the returned WineMeta. With nanoid the two strings would otherwise
  // be completely uncorrelated, so a single mint is load-bearing.
  // (The previous code had a latent bug: the two `Date.now().toString()`
  // calls were separated by `await uploadImage(...)` — an S3 PUT that
  // takes 50–500ms — so the image got keyed by one timestamp and the
  // wine row stored a different one, leaking the S3 object whenever the
  // wine was later deleted via deleteImage(wineId).)
  const id = existing?.id || nanoid()

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
    id,
    name,
    producer: clean(body.producer),
    vintage: clean(body.vintage).slice(0, 4),
    grape: clean(body.grape),
    type,
    image,
    imageUrl,
    description: clean(body.description).slice(0, 1000),
    region: clean(body.region).slice(0, 255),
    // ISO 3166-1 alpha-2 allow-listed via `cleanCountry`. Invalid codes
    // (typos, garbage) collapse to `''`.
    country: cleanCountry(body.country),
    vinification: clean(body.vinification).slice(0, 1000),
    purchaseUrl: cleanUrl(body.purchaseUrl).slice(0, 1000),
    // Preserve on edit; populate on create. Edits never overwrite the
    // original adder — `existing.addedByIdentityId` wins.
    addedByIdentityId: existing?.addedByIdentityId ?? addedByIdentityId,
    // Frozen snapshot, same rule as the id above. Set once at create
    // time from the live identities map by the caller. Existing rows
    // from before this field landed have `addedByDisplayName=undefined`;
    // the wire-time resolver handles that by falling through to null.
    addedByDisplayName: existing?.addedByDisplayName ?? addedByDisplayName,
  }
}

export async function pgUpsertSession(code: string, meta: SessionMeta): Promise<number> {
  const row = await prisma.session.upsert({
    where: { code },
    create: {
      code,
      hostName: meta.host,
      hostUserId: meta.hostUserId,
      name: meta.name || null,
      createdAt: new Date(meta.createdAt),
    },
    update: { name: meta.name || undefined },
    select: { id: true },
  })
  return row.id
}

export async function pgUpsertWine(sessionCode: string, wine: WineMeta) {
  // Skip soft-deleted sessions (code = NULL after the §8 scrub naturally
  // misses, but the explicit filter documents intent and survives any
  // future scrub-set change).
  const session = await prisma.session.findFirst({
    where: { code: sessionCode, deletedAt: null },
    select: { id: true },
  })
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
      description: wine.description || null,
      region: wine.region || null,
      country: wine.country || null,
      vinification: wine.vinification || null,
      purchaseUrl: wine.purchaseUrl || null,
      addedByIdentityId: wine.addedByIdentityId ?? null,
      addedByDisplayName: wine.addedByDisplayName ?? null,
    },
    update: {
      name: wine.name,
      producer: wine.producer || null,
      vintage: wine.vintage || null,
      grape: wine.grape || null,
      style: wine.type || null,
      imageUrl: wine.imageUrl || undefined,
      description: wine.description || null,
      region: wine.region || null,
      country: wine.country || null,
      vinification: wine.vinification || null,
      purchaseUrl: wine.purchaseUrl || null,
      // Don't overwrite provenance on edit — the original adder is the
      // authoritative anchor. If the row was created pre-feature with
      // addedByIdentityId=NULL we leave it NULL (no way to back-attribute).
      // addedByDisplayName is the same frozen-on-create story; omit
      // from update so an edit doesn't refresh it.
    },
  })
}
