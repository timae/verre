# Per-device session tracking + revocation

**Status**: SHIPPED. This file stays as the design rationale-of-record; the as-built behaviour is the code (`auth.ts`, `app/api/me/devices/*`, `lib/verifyPassword.ts`, `lib/revocationNotice.ts`). Cross-cutting invariants live in `lib/CLAUDE.md` ("never cache `auth()`", `lastSeenAt` self-only).

**As-built deviations from this proposal** (the proposal text below is the original plan, not the shipped shape):
- **Legacy tokens are hard-stripped, not soft-rolled.** §5/§6/§9 describe legacy tokens (no `userSessionId`) continuing to work ~30 days. Shipped behaviour: the `jwt()` gate treats any token without a `userSessionId` as invalid → logged out on the next request. The app has two users; a one-time re-login is a non-issue, and it keeps the gate single-path (a valid session always has a live `user_sessions` row). The `currentSessionTracked` field (§6) and the §9 legacy-branch are therefore absent — they'd be dead code under hard-strip.
- **`revocationReason` added** (not in the proposal): each revoke tags `'password_change' | 'manual' | 'revoke_all' | 'logout'`. The login page shows a tailored notice for `password_change`, a "session expired" notice for a present-but-undecodable cookie, nothing otherwise. See `lib/revocationNotice.ts`.
- **geo is country-only** (RIR-derivable, no licensing) and ships as a null stub (`lib/geo.ts`); the 90-day revoked-row cleanup is deferred.

This adds a "Connected devices" panel in account settings, per-device sign-out, and proper password-change session revocation, while staying on NextAuth's JWT strategy.

## 1. The problem today

Verre's auth is JWT-only via NextAuth (`auth.ts:113`, `session: { strategy: 'jwt' }`). Every JWT is self-contained — signed with `AUTH_SECRET`, contains `{id, tokenVersion}`, valid until its `exp` claim (NextAuth default 30 days).

The `tokenVersion` field on `users` was added as a revocation mechanism: the `jwt()` callback (`auth.ts:83-90`) re-reads it on every authenticated request and strips identity from the token on mismatch. The mechanism works in code, but **no write path increments it anywhere** (verified by grep — 5 read sites, zero writes). Effects:

- **Password change** does not invalidate existing sessions on other devices. Cookie stolen via XSS or a laptop left at a café stays valid for ~30 days regardless of password rotation.
- **No "log out other devices" affordance.** A user who suspects compromise has no recourse short of waiting out the JWT TTL.
- **No "Connected devices" list.** A user has no way to see where their account is logged in.

Account deletion is the one exception that closes the gap correctly: the user row disappears, the `jwt()` callback's `findUnique` returns null, the token gets stripped on the next request.

## 2. The fix in one paragraph

Add a `user_sessions` table — one row per active login. The JWT carries an opaque `userSessionId` (uuid v4) in addition to the existing `id`. The existing `jwt()` callback already does a DB lookup on every authenticated request; change *what* it looks up from `users.tokenVersion` to `user_sessions.revokedAt`. Active devices become a query, per-device sign-out becomes a row update, password change revokes every row except the current one. NextAuth still signs and mints the JWT exactly as today; we just change the claims it carries and what the revalidation gate checks.

## 3. Why JWT + `user_sessions`-gate, not full NextAuth DB sessions

| Aspect | JWT + `user_sessions` gate | NextAuth `strategy: 'database'` |
|---|---|---|
| Per-request DB cost | 1 lookup (today's behaviour) | 1 lookup (NextAuth handles) |
| Per-device revocation | ✅ | ✅ |
| Active-devices list | ✅ | ✅ |
| Revoke-on-password-change | ✅ | ✅ |
| NextAuth strategy migration | None (still `jwt`) | Required (adapter + schema migration to NextAuth's canonical tables) |
| Lines of code changed | ~200 across schema + auth + UI + API | More: adapter wiring, schema renaming, callback semantics change, every `auth()` caller revisited |
| Footgun surface | Custom revocation gate — could write a bug into it | NextAuth owns the lookup; less custom code to get wrong |

The fundamental observation: **the DB roundtrip is already happening** on every authenticated request (`auth.ts:84`). Switching from "look up `users.tokenVersion`" to "look up `user_sessions.revokedAt`" is a strictly more featureful query at the same cost. Migrating to NextAuth's database strategy buys us nothing performance-wise and forces a larger refactor.

The "DB sessions are more secure" framing doesn't survive scrutiny: stolen-cookie revocation latency is identical (next-request-after-revoke) in both models. The real differentiator is engineering effort.

## 4. Schema

```prisma
model UserSession {
  id           String    @id @default(uuid()) @db.Uuid
  userId       Int       @map("user_id")
  deviceLabel  String?   @map("device_label") @db.VarChar(64)
  geoLabel     String?   @map("geo_label")    @db.VarChar(64)
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  lastSeenAt   DateTime  @default(now()) @map("last_seen_at") @db.Timestamptz(6)
  revokedAt    DateTime? @map("revoked_at") @db.Timestamptz(6)
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, revokedAt])
  @@map("user_sessions")
}
```

**`id` is uuid v4 (NOT v7).** The id is baked into the signed JWT. v4 carries 122 bits of randomness — unguessable in practice. v7 leaks creation time in the high 48 bits and has only ~74 bits of randomness in the tail; combined with a hypothetical `AUTH_SECRET` leak, that's enough to weaken the bounded-blast-radius argument materially. If future code needs time-ordering, add a btree on `created_at` — never use v7. Postgres `gen_random_uuid()` is v4 by default and is what `@default(uuid())` resolves to.

**No raw User-Agent or IP stored.** The original drafts persisted `userAgent VARCHAR(512)` and `ip VARCHAR(64)` and parsed/redacted at render time. Privacy review (and the codebase's "store less than you need" posture) push the parsing to write time, persisting only the derived labels:
- `deviceLabel` — parsed from User-Agent at `authorize()` time, ~30-line hand-rolled regex helper (`lib/userAgent.ts`). Example values: `"MacBook · Chrome 142"`, `"iPhone · Safari"`. Falls back to `"Unknown device"` on parse failure.
- `geoLabel` — parsed from the IP (last octet zeroed for IPv4, /48 for IPv6) at `authorize()` time, looked up against a coarse geo source. Example values: `"Zurich, CH"`. Falls back to `null` if no source available; renders as `"Unknown location"`.
- **Raw IP and raw UA never persisted.** If geo infra isn't available in v1, ship with `geoLabel = null` and revisit geo separately — the label string is forward-compatible.

This is a stricter posture than the standard "store raw + parse on display" pattern. Justification: Verre's privacy model (`docs/dev/profile-visibility.md`, the `viewerBlocksOut`-never-logged rule, the bilateral-block scrubbing) tilts toward minimisation. A user reading the devices list cares about "is this me?" — that's the label, not the underlying data. Whatever pre-aggregation we do at write time is fine; what we never collect can't leak.

**Tradeoff acknowledged**: labels can't be re-derived later if `parseUserAgent` improves. Existing rows age out within ~30 days via JWT TTL and natural sign-in churn, so labels refresh naturally; we accept the inability to retroactively re-parse historic rows.

**Cascade on user delete.** Account deletion drops all user_sessions rows. Their cookies still validate signature-wise but the lookup returns no row → `jwt()` strips identity → 401 on the next request.

**Index on `(userId, revokedAt)`.** Both "list my active sessions" and "revoke all but current" hit this index.

## 5. `auth.ts` changes

The `authorize()` function (currently `auth.ts:21-66`) returns `{id, name, email, tokenVersion}`. Change to insert a session row and return its id; drop `tokenVersion` from the return (see §7 — column becomes vestigial):

```ts
async authorize(credentials, request) {
  // ... existing bcrypt + rate-limit logic unchanged ...
  if (!user || !valid) return null

  const userAgent = request?.headers?.get?.('user-agent') ?? null
  // Geo is best-effort, NEVER blocking. resolveGeoLabel() must internally
  // try/catch every failure path and resolve to null on any throw OR after
  // a hard timeout (200ms). Login never fails because geo is slow or down.
  // See lib/geo.ts contract notes.
  const geoLabel = await resolveGeoLabel(ip).catch(() => null)
  const session = await prisma.userSession.create({
    data: {
      userId: user.id,
      deviceLabel: parseUserAgent(userAgent),  // lib/userAgent.ts
      geoLabel,                                // lib/geo.ts; null on miss/timeout/error
    },
    select: { id: true },
  })
  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    userSessionId: session.id,
  }
}
```

The `jwt()` callback splits into "initial sign-in" and "revalidation" branches. Both change:

```ts
async jwt({ token, user }) {
  // Initial sign-in: persist id + userSessionId from authorize().
  // We MUST set token.id here so the immediately-following session()
  // callback can resolve the user. The revalidation branch below also
  // re-derives token.id from the session row — that's intentional
  // belt-and-suspenders, not a contradiction.
  if (user) {
    token.id = user.id
    token.userSessionId = (user as { userSessionId?: string }).userSessionId
    return token
  }
  // Revalidation: gate on user_sessions.revokedAt.
  if (token.userSessionId) {
    const sess = await prisma.userSession.findUnique({
      where: { id: token.userSessionId as string },
      select: { revokedAt: true, userId: true },
    })
    if (!sess || sess.revokedAt) return {} as typeof token
    // Re-derive userId from the session row. Never trust a pre-existing
    // token.id on revalidation — a tampered claim would already fail
    // signature verification, but defence-in-depth.
    token.id = String(sess.userId)
    // Bump last-seen at coarse granularity. Buckets are WALL-CLOCK aligned
    // (00:00, 00:05, 00:10, …) — sliding-window buckets ("5 min since last
    // write") would leak "request happened within X minutes of now" too
    // precisely. With wall-clock buckets, every user's lastSeenAt aligns
    // to the same edges, collapsing timeline-correlation signal across an
    // exfiltrated DB. Skip the write when current bucket == sess.lastSeenAt
    // bucket; only one write per session per 5-minute window.
    //
    // Applies ONLY to lastSeenAt. createdAt stays precise (it's a one-shot
    // value at session creation and useful for audit if anything goes wrong).
    bumpLastSeenIfNewBucket(token.userSessionId as string, sess).catch(err =>
      console.warn('[user-session] lastSeenAt failed', err)
    )
  }
  return token
}
```

For legacy tokens issued before this ships, `token.userSessionId` is undefined → revalidation branch is skipped → token returns as-is → `session()` resolves via `token.id` as today. Legacy tokens keep working until they expire (~30 days), at which point everyone is on the new model.

**Critical invariant**: never short-circuit the lookup. Tempting "cache for N seconds" optimisations create a window where revocation doesn't take effect — that window is the security gap. **Specifically: never wrap `auth()` in `unstable_cache`, React `cache`, or a `revalidate`-tagged fetch.** The DB lookup must hit Postgres on every authenticated request, same as today.

**`session()` callback** (`auth.ts:94-111`) needs a small extension: surface `session.user.userSessionId` so callers (specifically the password-change handler in §9) can read the current session id from `auth()`'s return rather than re-parsing the JWT. Existing field surface (`id/name/role/pro`) is unchanged.

The `types/next-auth.d.ts` augmentation needs `userSessionId` added to both `User`, `Session.user`, and `JWT`.

## 6. Token rollover for existing sessions

Per §5 above: legacy tokens have `{id, tokenVersion}` and no `userSessionId`. The new `jwt()` callback's revalidation branch is gated on `if (token.userSessionId)` — legacy tokens skip it, return as-is, `session()` looks up the user by `token.id` exactly as today. Effect:

- **Legacy tokens keep working until they expire.** ~30-day rolloff window.
- **Per-device revocation does not apply to legacy tokens** (they have no row to revoke). Acceptable because the worst case is bounded by JWT `exp`.
- **Account-deletion still works for legacy tokens**: the `session()` callback's `findUnique(users)` returns null → `session.user` becomes undefined → callers see logged-out.

No data migration needed. No forced re-login.

### Legacy-token UX gaps (must be handled in v1 UI + API)

Two user-visible gaps that the rollover window creates. Both are short-lived (≤30 days post-ship) but actively misleading if unhandled:

1. **Empty devices list for legacy users.** A logged-in user on a legacy token opens "Connected devices" and sees no rows — the query is `WHERE userId = $me AND revokedAt IS NULL` against `user_sessions`, and no row exists for them. UI must distinguish "I have no other devices" (current row visible, no others) from "my current session pre-dates this feature" (no rows at all).
   - **`GET /api/me/devices` must surface this state.** Response shape gains a `currentSessionTracked: boolean` field; when `session.user.userSessionId` is undefined (legacy), set it to `false` and return an empty list.
   - **UI copy when `currentSessionTracked === false`**: a single explanatory chip — "Your current sign-in pre-dates this feature. Sign out and back in to see your devices listed." No alarmist framing; the user is not at risk, they just have no UI signal yet.

2. **Misleading password-change toast.** The §9 password-change handler computes `revoked.count` from the `UPDATE user_sessions WHERE userId AND id != currentSessionId`. For a legacy-token user, `currentSessionId` is undefined; the safest version of the WHERE clause matches zero rows, so the toast says "Signed out of 0 other devices" — while their legacy token on other devices is still valid for up to ~30 days.
   - **§9 handler must branch**: if `session.user.userSessionId` is undefined, do NOT report a count. Toast becomes neutral ("Password updated.") with an extra explanatory line ("Other devices using older sessions will sign out automatically within 30 days.").
   - **Alternative considered**: increment a global `users.tokenVersion` for the legacy case, forcing all of that user's legacy tokens to invalidate. Rejected because (a) it re-introduces the dead column we're killing in v1.1, and (b) it bypasses the per-device model for a tiny rolloff window that resolves itself.

## 7. `users.tokenVersion` — vestigial, drop in a follow-up migration

Today's column is read 5 times in `auth.ts` and never written. The new revalidation gate doesn't check it. Keeping the column to "support a future kill switch" is dead-invariant theatre — the strictly better kill switch is `UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $u`, which is the same SQL we already need for "log out everywhere."

**v1 scope**: drop the reads from `auth.ts` (the proposed `jwt()` and `session()` callbacks no longer reference it); leave the column in the schema.

**v1.1 follow-up**: a small additive migration drops `users.token_version` along with the `User.tokenVersion` field. Mechanical change; no app-code impact since v1 already stopped reading.

## 8. New endpoints

**`/api/me/sessions` already exists** and returns the user's wine-tasting sessions (`app/api/me/sessions/route.ts:1-60`). To avoid collision, the device-session endpoints live under `/api/me/devices`:

### `GET /api/me/devices`

```ts
import { isSameOrigin } from '@/lib/csrf'  // GETs don't need this but consistent
import { auth } from '@/auth'

export async function GET() {
  const session = await auth()
  if (!session?.user) return new Response('unauthorized', { status: 401 })
  const userId = Number(session.user.id)
  const currentSessionId = session.user.userSessionId

  const rows = await prisma.userSession.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      id: true, deviceLabel: true, geoLabel: true,
      createdAt: true, lastSeenAt: true,
    },
  })
  const body = rows.map(r => ({ ...r, isCurrent: r.id === currentSessionId }))
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
```

Per `app/api/CLAUDE.md`: viewer-dependent responses MUST set `Cache-Control: private, no-store`.

### `DELETE /api/me/devices/[id]`

Revoke a specific device. Path id parsed via a new `parsePathUuid` helper in `lib/parsePathId.ts` — same strict regex posture (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`, no uppercase, no surrounding whitespace), same canonicalisation-attack resistance.

```ts
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isSameOrigin(req)) return new Response('forbidden', { status: 403 })  // FIRST guard
  const session = await auth()
  if (!session?.user) return new Response('unauthorized', { status: 401 })
  const userId = Number(session.user.id)
  const currentSessionId = session.user.userSessionId
  const targetId = parsePathUuid((await params).id)
  if (!targetId) return new Response('not found', { status: 404 })

  // Rate limit: 30/h/user on per-id DELETE
  const rate = await checkRate(`rl:devices:user:${userId}:1h`, 30, 3600)
  if (!rate.allowed) return new Response(`Try again in ${formatWait(rate.retryAfter)}`, { status: 429 })

  // Cross-device revoke (i.e. not revoking the caller's current session)
  // requires password re-auth, same shape as /api/me/account PATCH+DELETE.
  if (targetId !== currentSessionId) {
    const body = await req.json().catch(() => ({}))
    const password = typeof body?.password === 'string' ? body.password : ''
    const user = await prisma.user.findUnique({
      where: { id: userId }, select: { passwordHash: true },
    })
    const ok = user && await bcrypt.compare(password, user.passwordHash)
    if (!ok) return new Response('forbidden', { status: 403 })
  }

  // Idempotent revoke. 404 on missing-or-wrong-owner (no enumeration oracle).
  // The codebase has two prior patterns: /api/checkins/[id] returns 403 after
  // existence check; /api/me/blocks/[id] only deals with self by construction.
  // For uuid-keyed self-owned resources, 404 is strictly better (no leak
  // about which uuids exist for other users).
  const result = await prisma.$executeRaw`
    UPDATE user_sessions
    SET revoked_at = NOW()
    WHERE id = ${targetId}::uuid
      AND user_id = ${userId}
      AND revoked_at IS NULL
  `
  if (result === 0) return new Response('not found', { status: 404 })
  return NextResponse.json({ revoked: true })
}
```

### `DELETE /api/me/devices` (no id — revoke all other devices)

A single endpoint for the "sign out of all other devices" UI button. One password re-auth check, one SQL UPDATE — better than fan-out to N per-id DELETEs (which would risk hitting the 30/h rate limit during incident response).

```ts
export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) return new Response('forbidden', { status: 403 })
  const session = await auth()
  if (!session?.user) return new Response('unauthorized', { status: 401 })
  const userId = Number(session.user.id)
  const currentSessionId = session.user.userSessionId

  // Rate limit: 10/h/user on revoke-all
  const rate = await checkRate(`rl:devices-all:user:${userId}:1h`, 10, 3600)
  if (!rate.allowed) return new Response(`Try again in ${formatWait(rate.retryAfter)}`, { status: 429 })

  // Password re-auth required for the destructive action.
  const body = await req.json().catch(() => ({}))
  const password = typeof body?.password === 'string' ? body.password : ''
  const user = await prisma.user.findUnique({
    where: { id: userId }, select: { passwordHash: true },
  })
  const ok = user && await bcrypt.compare(password, user.passwordHash)
  if (!ok) return new Response('forbidden', { status: 403 })

  const revoked = await prisma.userSession.updateMany({
    where: { userId, id: { not: currentSessionId }, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return NextResponse.json({ revoked: revoked.count })
}
```

### Rate limits

Add to `app/api/rate-limits.md`:

- `/api/me/devices` GET — 60/min/user
- `/api/me/devices/[id]` DELETE — 30/h/user
- `/api/me/devices` DELETE (revoke-all) — 10/h/user

Per-id and revoke-all are separate counters because their semantics differ: per-id is "one user clicking through their list," revoke-all is "one panic event." A 30/h cap on per-id is fine for normal use; the revoke-all endpoint exists precisely to make incident response a single call.

## 9. Password change behaviour

**Authenticated settings flow** (today's `/api/me/account` PATCH with `oldPassword` re-auth): after the password update commits, revoke all sessions except the current one.

```ts
// In app/api/me/account/route.ts PATCH handler, after the password update commits:
// `session.user.userSessionId` is the JWT-resident current-session id —
// NEVER read from request body or header.
if (passwordChanged && session.user.userSessionId) {
  const revoked = await prisma.userSession.updateMany({
    where: {
      userId: Number(session.user.id),
      id: { not: session.user.userSessionId },
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  })
  responseBody.otherDevicesSignedOut = revoked.count
}
```

UI toast: "Signed out of N other devices."

**`$currentSessionId` always comes from the JWT** (via `auth()`'s `session.user.userSessionId`), never from the request body or a header. The signed payload is the trust anchor; anything client-controlled is not.

**Recovery flow** (forgot-password — does not exist today, but forward-compatible): when implemented, the recovery flow's password-set step should revoke ALL sessions including the current one, then issue a fresh `user_sessions` row + JWT. The user proves email control via the recovery link, which is independent of any active session — so any active session at that point could be the attacker's.

**Why the split.** A password change initiated from authenticated settings was triggered by someone who already proved control of an active session (the re-auth). Bouncing them to the login page is annoying UX with no security gain. A password change initiated from a recovery link, by contrast, was triggered by someone who proved email control — the active sessions might be the attacker. Standard pattern (GitHub, Google, Slack default to this split).

**Threat note**: the social-engineering attack where someone IN the current session convinces the victim to change their password (preserving the attacker's session, killing the victim's other sessions) is real. v1 mitigation is the response-body field telling the user "we signed out N other devices" — gives them a chance to notice. Email-notification-on-password-change is the proper countermeasure and is forward-compatible (separate feature; not in this proposal's scope).

## 10. Settings UI

New section in `components/me/AccountSettings.tsx` — slots in next to `<ProfileVisibilitySection />`, `<BlockedUsersSection />`, `<DangerZone />` (lines 194-196 of that file today).

Section: `<ConnectedDevicesSection />`.

- Heading "Connected devices."
- One row per device, newest first. Each row: device label, location label, "Last seen …" relative-time, "Disconnect" button.
- **"Last seen" rendering matches the bucketed truth.** Bucket size is 5 min (§5), so the UI must round to the bucket boundary — copy is "Last seen <5 min ago" / "Last seen 15 min ago" / "Last seen 2 h ago," never "Last seen 3 minutes ago" (which would imply finer precision than the stored value carries).
- Current session is marked with a badge "This device" and its Disconnect button is the regular logout (no password re-auth — logging yourself out is frictionless).
- Below the list: "Sign out of all other devices" button. Click → modal → password re-auth → call the no-id `DELETE /api/me/devices`. Toast on success: "Signed out of N devices."
- **Multi-tab note**: a user logged in via two tabs in the same browser gets two `user_sessions` rows. The devices list shows both (with same device label, different `createdAt`). User can revoke whichever they want. Matches GitHub / Google behaviour. If two rows look identical, the timestamps disambiguate.
- **Empty-state for legacy-token users** (per §6 rollover): when the `GET /api/me/devices` response carries `currentSessionTracked: false`, render a single explanatory chip in place of the list — "Your current sign-in pre-dates this feature. Sign out and back in to see your devices listed." Hide the "Sign out of all other devices" button in this state (no rows to revoke).

User-agent parsing lives in `lib/userAgent.ts` — hand-rolled, ~30 lines, no dependency. Goal is "good enough" device labels (`"MacBook · Chrome"`, `"iPhone · Safari"`, `"Android · Chrome"`); revisit if labels feel inaccurate.

**`lastSeenAt` is self-only.** Add to the schema doc and to `lib/CLAUDE.md`: this field is queryable only via `WHERE userId = $self` paths. No analytics surface, no other-user surface, no aggregate query. The 5-minute bucketing in §5 is belt-and-suspenders against exfiltrated-DB timeline analysis.

## 11. Audit log — dropped from v1

The earlier draft proposed a `user_session_log` audit table mirroring `ProfileVisibilityLog`. Privacy review concluded the precedent doesn't transfer: tier flips are legal-defensibility events with retention rationale; login/revoke events are operational telemetry that, kept forever, become a per-user activity log more sensitive than the live data. The "optional, low cost" framing didn't survive scrutiny.

**v1 ships without an audit log.** If incident-response signal is needed later, a bounded-retention design (90-day cleanup, no IP, only the userSessionId reference) can be added as its own proposal. The behavioural code path is unchanged with or without an audit log.

## 12. Security review (the threats we considered)

1. **Stolen cookie via XSS or device theft.** Cookie remains valid until `user_sessions.revokedAt` is set OR the JWT `exp` passes. The new "Connected devices" panel gives the victim a way to *see* the unfamiliar device and revoke it — primary security improvement. Revocation latency is bounded by "next time the attacker uses the cookie they hit the gate," same as today and same as DB-sessions.

2. **`auth()` wrapping in caches.** The revalidation gate must hit Postgres on every authenticated request. **Never wrap `auth()` in `unstable_cache`, React `cache`, or a `revalidate`-tagged fetch.** Codified at the top of §5; flagged here for visibility.

3. **JWT-claim tampering.** The `userSessionId` is inside the signed payload; tampering invalidates the signature and NextAuth rejects the cookie. Safe by construction.

4. **`userId` derivation.** The revalidation branch re-derives `token.id` from `user_sessions.userId`, not from any pre-existing claim. A malformed or tampered claim cannot escalate to another user.

5. **uuid v4 only.** v7's time-leakage + reduced randomness would weaken the bounded-blast-radius story if `AUTH_SECRET` ever leaked.

6. **TOCTOU on revoke.** Postgres is read-committed. An attacker's request in-flight when "sign out" UPDATEs may read pre-UPDATE state — worst case one more authenticated response after the UPDATE commits. Bounded and acceptable.

7. **`lastSeenAt` write errors are logged, not silenced.** `.catch(err => console.warn(...))` surfaces Prisma connection-pool exhaustion or DB-outage signals to ops. Silent `.catch(() => {})` would have masked them.

8. **Password-change keeps current session — defensible tradeoff.** §9 documents the social-engineering risk; mitigation is the response-body "N devices signed out" field. Email notification (forward-compatible) is the proper countermeasure.

9. **Cross-device disconnect requires password re-auth.** Prevents a cookie-thief from locking the legitimate owner out before they notice. Disconnecting your own current session does not require re-auth (it's just signing yourself out).

10. **Status-code choice (404 on wrong-owner).** Codebase has two prior patterns for owner-only resources: 403-after-existence (`/api/checkins/[id]`) and self-only-by-construction (`/api/me/blocks/[id]`). The new endpoints adopt 404-on-missing-or-wrong-owner because (a) uuid keys already block enumeration, so the choice is harmless, and (b) it's strictly better at preventing leaks about which session ids exist for other users.

11. **Origin guard on every state-changing route.** `isSameOrigin(req)` is the first line of every DELETE handler in §8, per the `app/api/CLAUDE.md` rule. CSRF-via-cookie attack is closed.

12. **Anon flow is unchanged.** Anon identities are resolved via Redis (`lib/identity.ts:resolveIdentity`); they never enter NextAuth's `authorize()` and never get a `user_sessions` row. The two trust models stay disjoint by construction.

13. **Session id in response body is a handle, not a credential.** The `GET /api/me/devices` response returns session ids so the UI can target DELETEs at specific rows. An attacker with only the id (no `AUTH_SECRET`) cannot mint a JWT, cannot impersonate the session, cannot query other-user surfaces. The id must never be reused as an authenticator (e.g. future "share device" features); documented here so we don't forget.

## 13. Forward-compatibility with OAuth account linking

This proposal does not block, and is not blocked by, a future "connect Google / Apple to my account" feature. That work would introduce a separate `user_oauth_links` table; sessions originating from an OAuth login still get a `user_sessions` row the same way. The two tables are orthogonal.

OAuth account linking is deferred. The current proposal's schema commits to nothing that would need to change.

**Forward-compat note for OAuth implementers**: §5's `authorize()` callback runs only for the Credentials provider. OAuth-originated logins fire different NextAuth callbacks (`signIn` event or the `jwt()` initial branch with `account` set). When OAuth lands, extract the "create a `user_sessions` row + populate `deviceLabel` + `geoLabel`" logic from `authorize()` into a shared helper (`lib/userSession.ts` → `createUserSession(userId, request)`), then call it from both flows. The proposal's v1 keeps the logic inlined in `authorize()` because there's only one caller; the extraction is mechanical when needed.

## 14. Open questions

- **Geo lookup source.** v1 can ship with `geoLabel = null` if no source is wired; the field is forward-compatible. When geo matters, the source decision has its own axes — not pre-decided here:
  - **File-based DB vs API service.** File-based (e.g. MaxMind GeoLite2) is fast (sub-ms lookup, no network) but requires periodic refresh; API service (e.g. ipapi, ipinfo) is always-current but adds network latency to the login path and a third-party dependency.
  - **EULA / licensing.** GeoLite2 requires EULA acceptance + account-credentialed download. Whoever wires it picks the legal acceptor.
  - **Attribution.** Most free tiers require visible attribution somewhere in the product. Decide placement.
  - **Refresh cadence.** Stale DB → labels drift. Decide weekly / monthly auto-pull, who owns the cron.
  - **Failure mode.** Locked in by §5: `geoLabel` resolves to `null` on any failure path. Login never blocks on geo.
- **Email notification on password change / new-device login.** Out of scope; forward-compatible. Separate feature surface (email pipeline) plus a per-user "notify me on new device" preference. Worth doing for the social-engineering scenario in §9.
- **Cleanup of old revoked rows.** Forward-compatible. A periodic `DELETE WHERE revoked_at < NOW() - INTERVAL '90 days'` is the simplest cleanup. Not a v1 concern; the rows are small and the table never gets large at Tim+Simon scale.
- **`userSessionId` on the legacy-token rollover.** Confirmed: legacy tokens (issued before this ships) skip the revalidation branch and keep working until their JWT `exp`. ~30-day rolloff. No forced re-login.

## 15. Estimated diff

- Migration: one file, additive (new `user_sessions` table only; `users.token_version` stays in v1, dropped in v1.1).
- `auth.ts`: ~40 lines (authorize() + jwt() + session() changes).
- `types/next-auth.d.ts`: add `userSessionId` to `User`, `Session.user`, and `JWT`.
- `lib/parsePathId.ts`: new `parsePathUuid` helper (~5 lines).
- `lib/userAgent.ts`: new (~30 lines, hand-rolled regex).
- `lib/geo.ts`: new stub (~10 lines; returns null in v1 unless geo source is wired).
- `/api/me/devices/route.ts` (GET + DELETE-all): ~60 lines.
- `/api/me/devices/[id]/route.ts` (DELETE): ~50 lines.
- `/api/me/account/route.ts` PATCH: ~10 lines added for the session-revoke after password update.
- `components/me/ConnectedDevicesSection.tsx`: ~120 lines (list + revoke buttons + password-confirm modal).
- `app/api/rate-limits.md`: 3 new rows.
- `lib/CLAUDE.md`: 2-3 lines documenting the `lastSeenAt` self-only invariant + the no-caching rule for `auth()`.
- `docs/dev/auth-sessions.md` (impl doc, written when this ships): ~150 lines.

Single PR, single review pass. Comparable in size to the rewire's smaller phases.

## 16. Out of scope (revisit later)

- OAuth provider linking (Google, Apple) — separate proposal when it lands.
- Email notifications on new-device login or password change.
- IP geolocation lookup integration (`lib/geo.ts` ships as a stub in v1).
- Admin "force-logout user X" tool — no admin tier exists in the codebase today (per `prisma/CLAUDE.md`'s "no admin tier" rule), so this would also need an admin tier.
- Recovery flow ("forgot password") — orthogonal feature; the recovery flow's interaction with session revocation is documented in §9 but the flow itself is its own work.
- Per-user "notify me on new device" preference — forward-compatible with the email-notification feature above.
- Session-creation audit log — dropped from v1 per privacy review (§11); revisit if incident-response signal needs it.
