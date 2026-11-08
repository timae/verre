import { nanoid } from 'nanoid'
import { WatchError } from 'redis'
import { redis, k } from '@/lib/redis'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { sessionLockKey, LockLost } from '@/lib/sessionLock'
import { withSessionMutation, ContractCold, ContractGone, type Fence } from '@/lib/sessionMutation'
import { readLiveRow, readRecordRoles, metaFromRecord } from '@/lib/sessionRecord'
import { normalizeVintageText } from '@verre/core'
import { uploadImage } from '@/lib/s3'
import { cleanCountry, cleanUrl, scrub } from '@/lib/textSafe'
import { grantStatus, type AuthorizedIdentity } from '@/lib/sessionGrant'
import { userIdentityId } from '@/lib/identity'

// After a FAILED wine write: reclaim this request's own upload only if the live
// lineup does not reference it — a content write that landed in Redis before
// the failure keeps its bytes (a leak at worst, never a dead reference). The
// URL is unique to this request, so "unreferenced now" means never. A Redis
// error keeps the bytes.
export async function reclaimIfUnreferenced(code: string, url: string): Promise<void> {
  // Both stores must PROVE they do not reference it (r5): a lineup key that is
  // absent proves nothing (evicted after another writer mirrored it), and a
  // later list write may have mirrored the published array into Postgres.
  try {
    const raw = await redis.get(k.wines(code))
    if (!raw || (JSON.parse(raw) as WineMeta[]).some(w => w.imageUrl === url)) return
    const { prisma } = await import('@/lib/prisma')
    if ((await prisma.$queryRaw<{ x: number }[]>`SELECT 1 AS x FROM wines WHERE image_url = ${url} LIMIT 1`).length) return
  } catch { return }
  const { reclaimImages } = await import('@/lib/engagementCascade')
  reclaimImages([url])
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
  // Mirrored to Postgres by mirrorLineup (every list write); every wine-edit path
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
  const lookedUp = provenance ? userNameLookup.get(provenance) : undefined
  if (provenance && showProvenance && lookedUp === UNRESOLVED_USER) {
    // The users lookup failed: whether this adder still exists is unknown, so
    // the name is withheld rather than taken from a possibly stale cache.
  } else if (provenance && showProvenance && lookedUp === GONE_USER) {
    // 🔒 A `u:` adder whose users row is gone is never legitimate after account
    // deletion (redis-rehydration § 4.3): the d: migration of the live copy is
    // a post-commit projection that can fail or never run, and then the stale
    // identities entry or the snapshot would render the deleted person's name.
    resolvedName = '[deleted]'
  } else if (provenance && showProvenance) {
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
  // Promotion time (sessions.archived_at), epoch ms: stamped by promotion's
  // fenced projection and by every meta written from the record. Presentation
  // only — nothing gates on it.
  promotedAt?: number
}

// Where each SessionMeta field is durable (redis-rehydration § 4.2 / § 5.2).
// `Record<keyof SessionMeta, …>` is exhaustive: a field added to SessionMeta
// fails `tsc` here until someone decides where it lives — a field nobody
// classified is a field that silently disappears on the first Redis wipe.
//   'column'          — a sessions column, written by sessionMetaToColumns
//   'session_members' — derived from session_members.role (the role mirror)
//   'derived'         — reconstructible from other columns (u:<host_user_id>)
export const SESSION_META_PERSISTENCE: Record<keyof SessionMeta, 'column' | 'session_members' | 'derived'> = {
  host: 'column', name: 'column', createdAt: 'column', hostUserId: 'column',
  hostIdentityId: 'derived', blind: 'column', blindForEveryone: 'column',
  lifespan: 'column', coHostIds: 'session_members', providerIds: 'session_members',
  address: 'column', dateFrom: 'column', dateTo: 'column', timezone: 'column',
  description: 'column', link: 'column', hideLineup: 'column',
  hideLineupMinutesBefore: 'column', showProvenance: 'column',
  coverPhotoUrl: 'column', category: 'column', promotedAt: 'column',
}

// 🔒 The ONE spelling of SessionMeta → sessions columns (R1-11). The logged-in
// create, the promotion create arm (pgUpsertSession) and the settings PATCH
// mirror all write this; they had drifted when each listed columns by hand.
// Absent optional settings map to NULL, which every reader treats as the
// default (48h, lineup shown, provenance shown). The settings mirror omits the
// identity + creation columns: sessionSettingsColumns is the mutable subset.
export function sessionMetaToColumns(meta: SessionMeta) {
  return {
    hostName: meta.host,
    hostUserId: meta.hostUserId,
    createdAt: new Date(meta.createdAt),
    ...sessionSettingsColumns(meta),
  }
}

// The columns a settings save may change. Never the host or creation columns:
// writing those from a request's meta could put back a host that account
// deletion tombstoned in Postgres after the request read Redis.
export function sessionSettingsColumns(meta: SessionMeta) {
  return {
    name: meta.name || null,
    blind: !!meta.blind,
    blindForEveryone: !!meta.blindForEveryone,
    address: meta.address || null,
    dateFrom: meta.dateFrom ? new Date(meta.dateFrom) : null,
    dateTo: meta.dateTo ? new Date(meta.dateTo) : null,
    timezone: meta.timezone || null,
    description: meta.description || null,
    link: meta.link || null,
    coverPhotoUrl: meta.coverPhotoUrl || null,
    category: meta.category || 'wine',
    lifespan: meta.lifespan ?? null,
    hideLineup: meta.hideLineup ?? null,
    hideLineupMinutesBefore: meta.hideLineupMinutesBefore ?? null,
    showProvenance: meta.showProvenance ?? null,
  }
}

export { genCode } from '@/lib/sessionCode'

// No raw meta/lineup getters: session routes open the session with
// openSession / loadLiveWines (lib/sessionRehydrate.ts — absent-aware, never a
// `[]` for an evicted lineup), and list/enrichment reads keep their own raw
// reads and never rebuild (redis-rehydration § 5.3).

// Sentinel a transform returns to abort the write based on the CURRENT
// wines state (e.g. the target wine was deleted by a concurrent request
// between read and write). Distinct from throwing — a reject is an
// expected outcome the caller maps to a 404/400, not an error.
export type MutateReject = { reject: string }
export function isMutateReject(v: unknown): v is MutateReject {
  return typeof v === 'object' && v !== null && 'reject' in v
}

// Atomic read-modify-write of the `s:{CODE}:wines` blob, FENCED by the session
// lock (redis-rehydration § 4.6 / mechanism 1+2): the caller holds
// lock:session:{CODE} inside a mutation contract and passes its fence. On an
// isolated connection: WATCH the lock + wines, check the token, read, transform,
// MULTI SET XX KEEPTTL, EXEC — a holder that lost its lease writes nothing
// (LockLost), and a concurrent change retries with the fresh value.
//
// 🔒 An absent wines key is a REJECT, never a create (ContractCold → the route
// answers through ensureSessionLive: a rebuild then 503, or 404 if the session is
// really gone). A wiped or evicted lineup can never be recreated holding only
// one wine by a writer working from stale state.
//
// The transform MUST be pure (it re-runs on each retry): side effects (S3,
// Postgres, response building) stay in the caller. Return a MutateReject for
// current-state validation (e.g. wine gone → the caller maps it to 404/400).
export async function mutateWines(
  fence: Fence,
  transform: (wines: WineMeta[]) => WineMeta[] | MutateReject,
): Promise<WineMeta[] | MutateReject> {
  const code = fence.code
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fence.client.executeIsolated(async (client) => {
        await client.watch([sessionLockKey(code), k.wines(code)])
        try {
          if ((await client.get(sessionLockKey(code))) !== fence.token) throw new LockLost(code)
          const raw = await client.get(k.wines(code))
          if (raw === null) throw new ContractCold(code)
          // A throwing transform (or malformed JSON) must release the WATCH —
          // the connection returns to the pool.
          const next = transform(JSON.parse(raw))
          if (isMutateReject(next)) {
            await client.unwatch()
            return next
          }
          const res = await client.multi().set(k.wines(code), JSON.stringify(next), { XX: true, KEEPTTL: true }).exec()
          if (res === null) throw new WatchError()
          return next
        } catch (inner) {
          await client.unwatch().catch(() => {})
          throw inner
        }
      })
    } catch (err) {
      if (err instanceof WatchError) continue
      throw err
    }
  }
  throw new Error(`mutateWines: too much contention on ${k.wines(code)}`)
}

// ── Privilege helpers (redis-rehydration § 4.7) ─────────────────────────────
//
// 🔒 They take an AuthorizedIdentity (lib/sessionGrant.ts), never a raw
// resolveIdentity() result: for a `u:` caller of a Postgres-backed session the
// answer comes from `identity.grant` — the COMMITTED record — and the cached
// role lists in meta are presentation only (a stale cohost/provider entry
// grants nothing), and a role grants nothing while its holder is kicked or banned
// (grantStatus must be 'ok' — r2 N1). Without a grant (anonymous caller, Redis-only session) Redis
// meta is the authority, as before. Inside a contract, pass ctx.caller (fresh
// grant), never the pre-lock identity.

// Strict host OR cohost — host-equivalent actions (wines, settings, reveals,
// kick/ban of tasters). Strict-host-only actions use isStrictHost.
export function isHostByIdentity(meta: SessionMeta, identity: AuthorizedIdentity | null): boolean {
  if (!identity || identity.denied) return false
  if (identity.grant) return grantStatus(identity.grant) === 'ok' && (identity.grant.strictHost || identity.grant.role === 'co_host')
  return isStrictHost(meta, identity) || !!meta.coHostIds?.includes(identity.id)
}

// The original session host only — cohost role assignment, session delete,
// banning a cohost.
export function isStrictHost(meta: SessionMeta, identity: AuthorizedIdentity | null): boolean {
  if (!identity || identity.denied) return false
  if (identity.grant) return grantStatus(identity.grant) === 'ok' && identity.grant.strictHost
  if (meta.hostIdentityId && identity.id === meta.hostIdentityId) return true
  if (meta.hostUserId && identity.id === userIdentityId(meta.hostUserId)) return true
  return false
}

// Provider: its own tier, NOT a superset of host — may add wines and edit/
// delete only the wines it added. Ownership itself (wines.added_by_identity_id)
// is checked by the caller, from the record for a `u:` caller with a grant
// (plan § 2, G2).
export function isProvider(meta: SessionMeta, identity: AuthorizedIdentity | null): boolean {
  if (!identity || identity.denied) return false
  if (identity.grant) return grantStatus(identity.grant) === 'ok' && identity.grant.role === 'provider'
  return !!meta.providerIds?.includes(identity.id)
}

// Session-wide "no host identity at all" (§ 4.5): ruling 4 lets cohosts delete a
// host-less moment. Never a display-name branch.
export function isHostless(meta: SessionMeta, identity: AuthorizedIdentity | null): boolean {
  if (identity?.grant) return identity.grant.hostless && !meta.hostIdentityId
  return !meta.hostIdentityId && !meta.hostUserId
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

// Sentinel values in the name lookup: this `u:` adder's account is gone; or
// the lookup failed, so whether it is gone is unknown.
export const GONE_USER = '\u0000gone'
export const UNRESOLVED_USER = '\u0000unresolved'

// Batch-lookup the `u:<id>` adders of these wines: display names for those
// no longer in the session's identities map (kicked / banned logged-in
// users), and GONE_USER for those whose users row no longer exists (deleted
// accounts — wineToWire then renders '[deleted]' whatever the identities map
// or snapshot still say). One Prisma query per request; no `u:` adder
// short-circuits. Anonymous adders (`a:<uuid>`) have no users row and are
// excluded.
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
  const userIds = new Set<number>()
  for (const w of wines) {
    const id = w.addedByIdentityId
    if (!id || !id.startsWith('u:')) continue
    const n = Number(id.slice(2))
    if (Number.isInteger(n) && n > 0) userIds.add(n)
  }
  if (userIds.size === 0) return new Map()
  const out = new Map<string, string>()
  try {
    const rows = await prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, name: true },
    })
    const found = new Map(rows.map(r => [`u:${r.id}`, r.name]))
    for (const n of userIds) {
      const id = `u:${n}`
      const name = found.get(id)
      if (name === undefined) out.set(id, GONE_USER)
      else if (!identities[id]) out.set(id, name)
    }
  } catch (err) {
    // Fail closed on names: a deleted adder's stale identities entry or
    // snapshot must not render because Postgres was briefly unreachable.
    console.error('[wines] buildKickedUserNameLookup failed — withholding u: adder names:', err)
    for (const n of userIds) out.set(`u:${n}`, UNRESOLVED_USER)
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
  // 🔒 No S3 delete here (r3 P1): this runs BEFORE the route's contract, which
  // may still refuse the edit (a provider editing a wine it does not own). The
  // route reclaims the replaced bytes only after an AUTHORIZED commit, and
  // reclaims this call's own upload when the write is refused.
  if (existing && body.image === null) {
    imageUrl = ''
    image = ''
  }

  // Upload to S3 if new base64 image provided. uploadImage keys by wine id,
  // so a same-extension replace overwrites in place. If the new image has
  // a different extension the old key would be orphaned — handle that by
  // deleting the previous URL only after the new upload succeeds. This
  // upload-first-then-cleanup ordering is failure-safe: if the new upload
  // throws or returns empty, the old image stays referenced and accessible.
  // A UNIQUE key per upload — never the live object's key, so an upload whose
  // write is then refused cannot overwrite the bytes the wine references.
  // Only an EXPLICIT image input uploads (r5): a metadata-only edit must not
  // upload inline image data its stale snapshot carries (a failed earlier
  // upload) and so replace a photo committed meanwhile.
  if (body.image !== undefined && image && image.startsWith('data:image/')) {
    try {
      const url = await uploadImage(`wines/${id}_${nanoid(8)}`, image)
      if (url) {
        imageUrl = url
        image = ''
      }
    } catch {}
  }

  return {
    id,
    name,
    producer: clean(body.producer),
    // 🔒 Canonicalize, don't truncate. A direct client can send 'N.V.',
    // 'non-vintage', a partial year or 'NV Selection'; `.slice(0,4)` would have
    // stored 'N.V.', '2' or 'NV S' verbatim. The server is the authority — the
    // clients normalize for UX, not for correctness.
    // 🔒 `applyIdentityEditRule` (lib/catalogWrite.ts) MIRRORS this rule so its
    // "compare what will actually be stored" comparison stays honest. Change
    // one, change the other.
    vintage: normalizeVintageText(clean(body.vintage)),
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

// ── Postgres side of a session (redis-rehydration § 4.4 / § 4.6) ─────────────
//
// 🔒 Mode is decided by whether the live `sessions` row exists, never by the
// caller's login state — and that decision is made INSIDE the writer's mutation
// contract (ctx.row, read FOR UPDATE under the advisory lock), so it stays true
// until COMMIT. Both soft-delete paths take the same locks.

// Promotion (Redis-only → Postgres-backed), the create arm of the old
// pgUpsertSession, now ONE unit of work inside the contract (§ 4.4): under the
// Redis lock + advisory lock, with the incarnation checked against the caller's
// meta and the delete registry checked so a stale caller cannot promote what a
// committed delete removed; the snapshot (meta, lineup, bans, roster) is read
// INSIDE. Writes the row, the lineup (positions), the bans and a member row for
// EVERY registered `u:` (G3 — roles from the fresh meta, the one moment Redis is
// still the authority; kicked-set entries as removed_state 'kicked'; joined
// counters on insert). Projection: meta rewritten from the record (promotedAt).
// The trigger stays "a logged-in caller acted" (the callers decide that), and it
// runs BEFORE the caller's own contract — the locks are not re-entrant.
// Returns the live sessions.id.
export async function ensurePromoted(code: string, meta: SessionMeta): Promise<number> {
  const live = await prisma.session.findFirst({ where: { code, deletedAt: null }, select: { id: true } })
  if (live) return live.id
  return withSessionMutation(code, { label: 'promote', redisLock: { waitMs: 8000 }, expectedCreatedAt: meta.createdAt },
    async (tx, ctx) => {
      if (ctx.row) return ctx.row.id
      const fresh = ctx.meta!
      const dead = await tx.$queryRaw<{ x: number }[]>`
        SELECT 1 AS x FROM session_tombstones WHERE code = ${code} AND created_at = ${new Date(fresh.createdAt)}`
      if (dead[0]) throw new ContractGone(code)
      const winesRaw = await redis.get(k.wines(code))
      if (winesRaw === null) throw new ContractCold(code)
      const [bans, identities, kicked] = await Promise.all([
        redis.sMembers(k.bans(code)), redis.hGetAll(k.identities(code)), redis.sMembers(k.kicked(code)),
      ])
      const row = await tx.session.create({ data: { code, ...sessionMetaToColumns(fresh) }, select: { id: true } })
      // Belt: member rows are only ever for codes with a live row (r1-2).
      await tx.$executeRaw`DELETE FROM session_members WHERE session_code = ${code}`
      await upsertLineup(tx, row.id, JSON.parse(winesRaw) as WineMeta[])
      if (bans.length > 0) {
        await tx.$executeRaw`
          INSERT INTO session_bans (session_code, identity_id) SELECT ${code}, unnest(${bans}::text[]) ON CONFLICT DO NOTHING`
      }
      const userIds = (ids: string[]) => ids.filter(id => /^u:\d{1,18}$/.test(id) && !bans.includes(id)).map(id => Number(id.slice(2)))
      const candidates = [...new Set([...userIds(Object.keys(identities)), ...userIds(kicked)])]
      const users = candidates.length
        ? await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ANY(${candidates}::bigint[]) FOR KEY SHARE`
        : []
      for (const { id } of users) {
        const uid = `u:${id}`
        const role = fresh.hostUserId === Number(id) || fresh.hostIdentityId === uid ? 'host'
          : fresh.coHostIds?.includes(uid) ? 'co_host'
          : fresh.providerIds?.includes(uid) ? 'provider'
          : 'taster'
        const removed = kicked.includes(uid) && !(uid in identities) ? 'kicked' : null
        const inserted = await tx.$queryRaw<{ user_id: number }[]>`
          INSERT INTO session_members (user_id, session_code, role, removed_state) VALUES (${Number(id)}, ${code}, ${role}, ${removed})
          ON CONFLICT (user_id, session_code) DO NOTHING RETURNING user_id`
        if (inserted[0]) await tx.$executeRaw`UPDATE users SET lifetime_sessions_joined = lifetime_sessions_joined + 1 WHERE id = ${Number(id)}`
      }
      return row.id
    },
    async (ctx) => { await projectMetaFromRecord(ctx.fence!, ctx.meta) })
}

// Rewrite a Postgres-backed session's meta FROM THE RECORD (plan § 1.5 / D4) ⊕
// the cache-only `a:` bits of `cache`, XX KEEPTTL, fenced. Every meta write of a
// session with a live row goes through here (after COMMIT for grant-direction
// changes), so a refused or lost projection is repaired by the next one.
export async function projectMetaFromRecord(fence: Fence, cache: SessionMeta | null, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<SessionMeta | null> {
  const row = await readLiveRow(db, fence.code)
  if (!row) return null
  const meta = metaFromRecord(row, await readRecordRoles(db, fence.code), cache)
  await fence.exec(m => { m.set(k.meta(fence.code), JSON.stringify(meta), { XX: true, KEEPTTL: true }) })
  return meta
}

// Writes the given wines of a session, in array order (position = index), in
// ONE statement. Content, reveal state, catalog link and position follow the
// array; provenance is set on INSERT only (the original adder is the anchor —
// only the reassignment path moves it). The update arm skips a row whose
// session_id differs (an orphaned wine is never re-attached or re-positioned
// from a stale array) and a row that would not change (no dead tuples on the
// hot rate path).
//
// 🔒 A `u:` adder whose users row is gone is written as no adder + '[deleted]'
// (on INSERT — the only arm that writes provenance). A wine added just before
// its adder's account deletion can get its FIRST mirror after that deletion
// committed (it waited on the session row lock), and its Redis copy still
// names the person; written verbatim it would restore the deleted identity and
// name, and every later mirror would freeze them. The adders are read FOR KEY
// SHARE, which conflicts with account deletion's FOR UPDATE on the users row,
// so a mirror either commits before the deletion (whose in-transaction re-read
// then rewrites the row) or sees the user gone.
async function upsertLineup(tx: Prisma.TransactionClient, sessionId: number, wines: WineMeta[]) {
  if (wines.length === 0) return
  const adderIds = [...new Set(wines.map(w => w.addedByIdentityId).filter((id): id is string => !!id && /^u:\d{1,18}$/.test(id)).map(id => Number(id.slice(2))))]
  const liveAdders = new Set<string>()
  if (adderIds.length > 0) {
    const live = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ANY(${adderIds}::bigint[]) FOR KEY SHARE`
    for (const r of live) liveAdders.add(`u:${r.id}`)
  }
  const provenance = (w: WineMeta): [string | null, string | null] =>
    w.addedByIdentityId?.startsWith('u:') && !liveAdders.has(w.addedByIdentityId)
      ? [null, '[deleted]']
      : [w.addedByIdentityId ?? null, w.addedByDisplayName?.slice(0, 64) ?? null]
  // Clamped to the column widths: one statement writes the whole lineup, so a
  // single over-long field (the add path does not cap name / producer / grape)
  // must not fail the mirror for every wine of the session.
  const cut = (v: string | undefined, n: number) => (v ? v.slice(0, n) : null)
  const rows = wines.map((w, i) => Prisma.sql`(
    ${w.id}, ${sessionId}, ${w.name.slice(0, 255)}, ${cut(w.producer, 255)}, ${cut(w.vintage, 4)}, ${cut(w.grape, 255)},
    ${cut(w.type, 64)}, ${w.imageUrl || null}, ${cut(w.description, 1000)}, ${cut(w.region, 255)},
    ${cut(w.country, 2)}, ${cut(w.vinification, 1000)}, ${cut(w.purchaseUrl, 1000)},
    ${w.revealedAt ? new Date(w.revealedAt) : null}::timestamptz,
    ${provenance(w)[0]}, ${provenance(w)[1]},
    ${w.productId || null}, ${w.vintageId || null}, ${i}::int)`)
  await tx.$executeRaw`
    INSERT INTO wines (id, session_id, name, producer, vintage, grape, style, image_url, description, region,
                       country, vinification, purchase_url, revealed_at, added_by_identity_id,
                       added_by_display_name, product_id, vintage_id, position)
    VALUES ${Prisma.join(rows)}
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, producer = EXCLUDED.producer, vintage = EXCLUDED.vintage,
      grape = EXCLUDED.grape, style = EXCLUDED.style, image_url = EXCLUDED.image_url,
      description = EXCLUDED.description, region = EXCLUDED.region, country = EXCLUDED.country,
      vinification = EXCLUDED.vinification, purchase_url = EXCLUDED.purchase_url,
      revealed_at = EXCLUDED.revealed_at, product_id = EXCLUDED.product_id,
      vintage_id = EXCLUDED.vintage_id, position = EXCLUDED.position
    WHERE wines.session_id = EXCLUDED.session_id
      AND (wines.name, wines.producer, wines.vintage, wines.grape, wines.style, wines.image_url,
           wines.description, wines.region, wines.country, wines.vinification, wines.purchase_url,
           wines.revealed_at, wines.product_id, wines.vintage_id, wines.position)
          IS DISTINCT FROM
          (EXCLUDED.name, EXCLUDED.producer, EXCLUDED.vintage, EXCLUDED.grape, EXCLUDED.style,
           EXCLUDED.image_url, EXCLUDED.description, EXCLUDED.region, EXCLUDED.country,
           EXCLUDED.vinification, EXCLUDED.purchase_url, EXCLUDED.revealed_at, EXCLUDED.product_id,
           EXCLUDED.vintage_id, EXCLUDED.position)`
}

// The wine-list mirror, run INSIDE the caller's contract after EVERY wine-list
// mutation (add, edit, delete, reorder, reveal/hide, ban-wipe) by EVERY caller —
// anonymous adds included — with `wines` = the array the fenced mutateWines just
// committed to Redis (content is Redis-first by design, § 3) and `sessionId` =
// ctx.row.id (null for a Redis-only session: nothing to mirror). Projects the
// WHOLE array (content + positions renormalized); the advisory lock orders the
// mirrors, so the last committer projected the newest array. `deletedId` removes
// that wine's row in the same transaction (the wine DELETE route).
//
// Rows of this session the array no longer lists (a wine DELETE whose mirror
// failed before release B) are positioned AFTER the array, so positions stay
// unique and all set. They are deliberately not removed (owner ruling: the
// catalog model change reshapes per-event wines).
export async function mirrorLineup(tx: Prisma.TransactionClient, sessionId: number | null, wines: WineMeta[], opts: { deletedId?: string } = {}): Promise<void> {
  if (sessionId === null) return
  if (opts.deletedId) await tx.$executeRaw`DELETE FROM wines WHERE id = ${opts.deletedId} AND session_id = ${sessionId}`
  await upsertLineup(tx, sessionId, wines)
  await tx.$executeRaw`
    UPDATE wines w SET position = ${wines.length}::int + o.rank - 1
      FROM (SELECT id, row_number() OVER (ORDER BY position NULLS LAST, created_at, id) AS rank
              FROM wines WHERE session_id = ${sessionId} AND NOT (id = ANY(${wines.map(x => x.id)}::text[]))) o
     WHERE w.id = o.id AND w.position IS DISTINCT FROM ${wines.length}::int + o.rank - 1`
}

// A "Brought by" REASSIGNMENT, RECORD-FIRST (plan D2): inside the reassign's
// contract, the lineup is projected from the current array (inserting the row
// if it was missing), then provenance is FORCED on the row (the list mirror
// freezes it on update). The Redis provenance is the projection after COMMIT —
// ownership decides provider edit rights, so the cache must never name an owner
// the record does not. A `u:` target must still have a users row (FOR KEY
// SHARE — account deletion holds it FOR UPDATE). Throws on any refusal; nothing
// commits.
export async function reassignProvenance(tx: Prisma.TransactionClient, sessionId: number, wines: WineMeta[], wine: WineMeta): Promise<void> {
  const owner = wine.addedByIdentityId ?? null
  if (owner?.startsWith('u:')) {
    const users = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM users WHERE id = ${Number(owner.slice(2))} FOR KEY SHARE`
    if (!users[0]) throw new Error('reassign: target user is gone')
  }
  await mirrorLineup(tx, sessionId, wines)
  // Zero rows = the wine's row is not this session's (orphaned by a ban-wipe):
  // the owner change would not persist — refuse.
  const n = await tx.$executeRaw`
    UPDATE wines SET added_by_identity_id = ${owner}, added_by_display_name = ${wine.addedByDisplayName ?? null}
     WHERE id = ${wine.id} AND session_id = ${sessionId}`
  if (n !== 1) throw new Error('reassign: the wine row is not part of this session')
}
