import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import { WatchError } from 'redis'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { uploadImage } from '@/lib/s3'
import { cleanCountry, cleanUrl, scrub } from '@/lib/textSafe'
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
  // ── Wine-catalog link (phase 2) ──────────────────────────────────────
  //
  // Optional link from this per-session wine INSTANCE to the shared
  // catalog, at two grains because year = null means the NV row
  // exclusively. Valid states: (set, set) | (set, null) | (absent,
  // absent) — vintageId without productId is invalid and is rejected at
  // every write boundary AND by a DB CHECK on the mirrored columns.
  //
  // Set from an EXPLICIT user choice or a freshly-minted provisional,
  // never from a string match (RFC § v1 data model; the sole exception is
  // the phase-5 legacy backfill, which is exact-match-only).
  //
  // 🔒 BLIND REDACTION MUST STRIP BOTH. A catalog id in a blind payload is
  // a lookup oracle for the label — it identifies the wine as precisely as
  // the name does. `redactWine` spreads `...rest` from this type, so a new
  // identifying field added here is exposed BY DEFAULT unless it is
  // explicitly overwritten there. See lib/wineRedaction.ts.
  //
  // Mirrored to Postgres by pgUpsertWine on archival; every wine-edit path
  // must round-trip them (the PATCH route replaces the Redis object
  // wholesale, so omitting them silently drops the link).
  productId?: string | null
  vintageId?: string | null
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
// `showProvenance` (default true) is the "Show who brought each impression"
// session setting. When false the host opted OUT of attribution, so the
// resolved name + userId are forced to null HERE — at the single sanctioned
// wire transform — so EVERY caller (buildWinesView reads AND the four wine
// mutation routes that echo a wire wine back) inherits the strip structurally,
// exactly like redactWine nulls identity in-place. `isMine` is NOT affected:
// it's the caller's own trust flag, never rendered as attribution. Doing this
// here (not post-hoc in one reader) was a review fix — a strip that lived only
// in buildWinesView leaked provenance through the add/edit/reorder/reveal
// responses to the host/cohost/provider caller.
export function wineToWire(
  w: WineMeta,
  callerId: string,
  identities: Record<string, string> = {},
  userNameLookup: Map<string, string> = new Map(),
  showProvenance = true,
): WireWine {
  const { addedByIdentityId: provenance, addedByDisplayName: snapshot, ...rest } = w
  let resolvedName: string | null = null
  let userId: number | null = null
  if (provenance && showProvenance) {
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
    // isMine keys on the raw provenance, independent of showProvenance — the
    // caller's own edit affordance must survive attribution being hidden.
    isMine: !!provenance && provenance === callerId,
    addedByDisplayName: resolvedName,
    addedByUserId: userId,
  }
}

export type RatingMeta = {
  score: number
  flavors: Record<string, number>
  // Aroma selections ({a: nodeId, m: modifierId|null, p?: true} against the
  // @verre/core taxonomy; the node may sit at any tier — leaf/subfamily/
  // family; `p` = pronounced, present only when true). Optional: ratings
  // written before the aromas field lack the key.
  aromas?: { a: string; m: string | null; p?: boolean }[]
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
  // "Blind for all" — stacks on top of meta.blind. When true, the host,
  // cohosts, providers, and wine-adders ALL see redacted wines (same as
  // tasters). Lets a host run a tasting where nobody — including
  // themselves — knows the lineup. Toggleable mid-session by any
  // host/cohost; the toggle is per-session (not per-cohost). Composes
  // with reveal: revealed wines un-redact for everyone regardless.
  // No-op when meta.blind is false.
  blindForEveryone?: boolean
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
  // Whether the "Brought by" attribution (who added each impression) is shown
  // to viewers. DEFAULT ON: absent or true → shown; false → the host opted out
  // and the read path (buildWinesView) nulls addedByDisplayName +
  // addedByUserId off the wire so NO surface — impression detail, web callout,
  // feed cards — can render it. PRO-gated at the settings write, but reading it
  // never gates on pro (a moment set private stays private for everyone).
  // Independent of blind: blind hides the impression's IDENTITY, this hides its
  // PROVENANCE. On existing moments the field is absent → attribution unchanged.
  showProvenance?: boolean
  // Host-chosen cover photo (S3 URL). Deliberately NOT blind-redacted — it
  // brands the moment, not a wine. S3 bytes reclaimed in every deletion path.
  coverPhotoUrl?: string
  // Session category ('wine' for now) — the future contract for what
  // impressions can be added + the category vocabulary. Mirrors
  // sessions.category.
  category?: string
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

// Sentinel a transform returns to abort the write based on the CURRENT
// wines state (e.g. the target wine was deleted by a concurrent request
// between read and write). Distinct from throwing — a reject is an
// expected outcome the caller maps to a 404/400, not an error.
export type MutateReject = { reject: string }
export function isMutateReject(v: unknown): v is MutateReject {
  return typeof v === 'object' && v !== null && 'reject' in v
}

// Atomic read-modify-write of the `s:{CODE}:wines` blob: the whole wine list
// is one Redis string, so an un-guarded read→edit→write-back lets two
// concurrent writers clobber each other (one's edit silently lost). WATCH +
// MULTI makes the write conditional on the value being unchanged since the
// read, retrying on conflict.
//
// WATCH is connection-scoped, so this MUST run on an isolated connection
// (`executeIsolated`) — a command on the shared `redis` singleton would void
// the WATCH. The transform MUST be pure (it re-runs on each retry): keep side
// effects (S3, Postgres, response building) in the caller, after the commit.
//
// `transform` returns the new array to commit, or a MutateReject for
// current-state validation (e.g. wine gone). KEEPTTL preserves the session's
// lifespan per the TTL rule in lib/CLAUDE.md.
export async function mutateWines(
  code: string,
  transform: (wines: WineMeta[]) => WineMeta[] | MutateReject,
): Promise<WineMeta[] | MutateReject> {
  const key = k.wines(code)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await redis.executeIsolated(async (client) => {
        await client.watch(key)
        let next: WineMeta[] | MutateReject
        try {
          const raw = await client.get(key)
          // A throwing transform (or malformed JSON) must release the WATCH —
          // the connection returns to the pool, and a leaked WATCH would
          // poison the next borrower's transaction.
          next = transform(raw ? JSON.parse(raw) : [])
          if (isMutateReject(next)) {
            await client.unwatch()
            return next
          }
          // Don't materialise an empty wines key that didn't exist — a bare
          // SET with KEEPTTL on an absent key creates it with NO expiry.
          if (raw === null && next.length === 0) {
            await client.unwatch()
            return next
          }
        } catch (inner) {
          await client.unwatch()
          throw inner
        }
        await client.multi().set(key, JSON.stringify(next), { KEEPTTL: true }).exec()
        return next
      })
      return result
    } catch (err) {
      // node-redis throws WatchError when a WATCHed key changed before EXEC
      // (the optimistic-lock conflict) — retry with the fresh value. Any
      // other error propagates.
      if (err instanceof WatchError) continue
      throw err
    }
  }
  throw new Error(`mutateWines: too much contention on ${key}`)
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

// cleanUrl/cleanCountry moved to lib/textSafe.ts (pure, no Redis side effect
// — /api/checkins uses them without touching this module). Re-exported so
// existing `@/lib/session` importers (sessionFields, settings route) stay
// unchanged; addWineToSession below keeps using them.
export { cleanCountry, cleanUrl }

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
  body: Partial<WineMeta> & { image?: string | null },
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
  if (existing && body.image === null) {
    if (existing.imageUrl) reclaimImage(existing.imageUrl)
    imageUrl = ''
    image = ''
  }

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
    // Preserve reveal state on edit. The PATCH route replaces the Redis wine
    // object wholesale, so omitting this would silently re-hide revealed wines.
    revealedAt: existing?.revealedAt ?? null,
    // Preserve on edit; populate on create. Edits never overwrite the
    // original adder — `existing.addedByIdentityId` wins.
    addedByIdentityId: existing?.addedByIdentityId ?? addedByIdentityId,
    // Frozen snapshot, same rule as the id above. Set once at create
    // time from the live identities map by the caller. Existing rows
    // from before this field landed have `addedByDisplayName=undefined`;
    // the wire-time resolver handles that by falling through to null.
    addedByDisplayName: existing?.addedByDisplayName ?? addedByDisplayName,
    // Catalog link. The caller (route) has already validated these through
    // `resolveCatalogLink` and applied the identity-changing-edit rule, so
    // whatever arrives in `body` here is authoritative for this write.
    //
    // ⚠️ THE ROUND-TRIP IS THE TRAP. The PATCH route replaces the Redis
    // wine object WHOLESALE with this return value, so a field that is not
    // named here is DROPPED — silently, on every edit. `body.productId
    // === undefined` therefore means "the caller didn't mention it, keep
    // what's stored", which is why this is an explicit undefined check and
    // not `body.productId ?? existing?.productId` (that spelling would
    // also swallow a deliberate null, making the link impossible to
    // clear).
    productId: body.productId === undefined ? (existing?.productId ?? null) : body.productId,
    vintageId: body.vintageId === undefined ? (existing?.vintageId ?? null) : body.vintageId,
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
      // `blind` must round-trip to Postgres for the SessionFeedCard
      // redaction predicate (lib/sessionFeedWines.ts). Pre-rewire the
      // column existed but was never written, so every Postgres-side
      // read of `blind` came back NULL and redaction silently no-op'd
      // on the feed / profile surfaces. Live session route reads from
      // Redis where blind WAS set — that's why the bug stayed dormant.
      blind: !!meta.blind,
      // `blindForEveryone` mirrors what's in Redis at create time so a
      // hypothetical future create-path that seeds it (today's create
      // endpoint doesn't — settings PATCH is the only writer) survives
      // to Postgres. Same rationale as `blind`: the SessionFeedCard
      // redaction predicate reads this column.
      blindForEveryone: !!meta.blindForEveryone,
      createdAt: new Date(meta.createdAt),
      // Cover, category, and the scheduled-moment detail fields all mirror
      // what's in Redis at archive time. This is the delayed-archive path for
      // an ANON-created session (reached when a logged-in user later visits /
      // rates / adds a wine / bookmarks); the logged-in create writes the same
      // set directly. They MUST match the create route's field set —
      // /api/me/sessions reads date_from/date_to (and the rest) from Postgres,
      // so dropping them here would make an anon-created scheduled moment look
      // date-less and detail-less to a logged-in participant and break the
      // upcoming/live/recent routing. Like blind, NOT in the update path — the
      // settings PATCH's updateMany is the writer for changes.
      coverPhotoUrl: meta.coverPhotoUrl || null,
      category: meta.category || 'wine',
      address:     meta.address     || null,
      dateFrom:    meta.dateFrom    ? new Date(meta.dateFrom) : null,
      dateTo:      meta.dateTo      ? new Date(meta.dateTo)   : null,
      timezone:    meta.timezone    || null,
      description: meta.description || null,
      link:        meta.link        || null,
    },
    // Note: `blind` and `blindForEveryone` are intentionally NOT in the
    // update path. Settings changes route through a separate
    // `prisma.session.updateMany` in `app/api/session/[code]/settings/
    // route.ts` that writes both. Leaving them out of this update path
    // avoids accidentally flipping them if a future meta-update code
    // path forgets to carry the values.
    update: { name: meta.name || undefined },
    select: { id: true },
  })
  return row.id
}

// Mirror a "Brought by" REASSIGNMENT to Postgres. UPSERTS the wine row (from the
// current Redis `wine`) with provenance FORCED on BOTH the create and update
// paths — unlike `pgUpsertWine`, which freezes provenance on update.
//
// Why an upsert (not a provenance-only updateMany): if the PG row doesn't exist
// yet (anon session pre-archival), a provenance-only update would no-op, and a
// CONCURRENT rating/bookmark could then CREATE the row from a Redis snapshot
// captured before the reassign — permanently archiving the OLD owner even though
// every op "succeeded" (Codex P2). By upserting here, a PG row with the NEW owner
// always exists after the reassign; any later `pgUpsertWine` from a stale-snapshot
// archival write hits its UPDATE path, which FREEZES provenance, so it keeps the
// new owner. And because THIS forces provenance on its own update path, it also
// wins if a stale archival create beat it to the row. Net: reassign's owner is
// the durable last-writer regardless of interleaving with archival writes.
//
// Runs under the ban lock in the caller; the caller compensates (restores prior
// Redis provenance) if this throws. Best-effort within the Redis→PG contract —
// see docs/dev/proposals/reassign-brought-by.md.
// True iff a live (non-soft-deleted) Postgres session row exists for this code.
// The reassign handler gates on this BEFORE any write: v1 reassignment is
// limited to already-archived sessions (Simon, 2026-07-20). A pure Redis-only
// anon moment (root CLAUDE.md: anon sessions stay Redis-only) has no PG row, so
// a reassign there is rejected — NOT force-archived (that would break the anon
// lifecycle contract) and NOT allowed as a Redis-only ownership change (that
// would reintroduce the first-archival provenance race when a logged-in user
// later archives). See docs/dev/proposals/reassign-brought-by.md.
export async function pgSessionExists(sessionCode: string): Promise<boolean> {
  const row = await prisma.session.findFirst({
    where: { code: sessionCode, deletedAt: null },
    select: { id: true },
  })
  return !!row
}

export async function pgReassignWineProvenance(sessionCode: string, wine: WineMeta): Promise<void> {
  const session = await prisma.session.findFirst({
    where: { code: sessionCode, deletedAt: null },
    select: { id: true },
  })
  // The caller gated on pgSessionExists before mutating Redis, but session
  // deletion / account cleanup do NOT take the ban lock — so the row CAN vanish
  // (TOCTOU) between that gate and here, AFTER Redis was already changed. That's
  // a mirror FAILURE, not a no-op: returning silently would leave Redis=new /
  // PG=gone and the route would 200. THROW so the caller's Redis compensation
  // runs and the request 500s (Codex catch). (A genuinely absent row for a
  // never-archived session can't reach here — the caller's 409 gate stops it.)
  if (!session) throw new Error('reassign mirror: session row disappeared')
  const cols = {
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
    // 🔒 The catalog link rides the CREATE arm. This function's whole reason
    // for being an upsert (see the note above) is that the wines row may not
    // exist yet — and a row minted here without the link would look exactly
    // like a legacy unlinked row, which phase 5's exact-match backfill would
    // then re-derive from STRINGS. That would reintroduce string-derived
    // linking on a wine whose link came from an explicit user choice. The RFC
    // names this path directly: "every path that writes a `wines` row from
    // Redis state — rate/visit archival, wine edits, BROUGHT-BY REASSIGNMENT,
    // session archive — carries both fields verbatim."
    //
    // ⚠️ Deliberately NOT added to the `update` arm below: that arm exists to
    // force provenance and nothing else, and widening it would let a reassign
    // built from a stale Redis snapshot overwrite a link the edit path had
    // already corrected.
    productId: wine.productId || null,
    vintageId: wine.vintageId || null,
  }
  await prisma.wine.upsert({
    where: { id: wine.id },
    create: { id: wine.id, sessionId: session.id, ...cols },  // category defaults to 'wine' (schema default), matching pgUpsertWine
    // FORCE provenance on update (the whole point) — a stale archival create
    // that beat us to the row is corrected here.
    update: { addedByIdentityId: cols.addedByIdentityId, addedByDisplayName: cols.addedByDisplayName },
  })
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
      // Catalog link mirrored from Redis. `|| null` rather than `?? null`
      // is deliberate here for the same reason it is on the fields above:
      // the empty string must collapse to NULL, or the wines link-state
      // CHECK sees a set-but-meaningless product_id.
      productId: wine.productId || null,
      vintageId: wine.vintageId || null,
    },
    update: {
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
      // 🔒 IN THE UPDATE ARM TOO, unlike provenance. Provenance is frozen
      // on create because the original adder is the authoritative anchor;
      // the catalog link is the opposite — it stays MUTABLE on the wine
      // instance by design (RFC § v1 data model), so that a later
      // re-link, or the identity-changing-edit rule CLEARING the link,
      // actually reaches Postgres. Omitting it here would archive the
      // first-seen link forever and silently ignore every correction.
      productId: wine.productId || null,
      vintageId: wine.vintageId || null,
      // Don't overwrite provenance on edit — the original adder is the
      // authoritative anchor. If the row was created pre-feature with
      // addedByIdentityId=NULL we leave it NULL (no way to back-attribute).
      // addedByDisplayName is the same frozen-on-create story; omit
      // from update so an edit doesn't refresh it.
    },
  })
}
