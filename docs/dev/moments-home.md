# Moments-home routing

How the Moments tab (`apps/mobile/src/app/(tabs)/moments/`) decides where each
moment a user belongs to is shown: the **carousel** highlight strip, the
**Upcoming** list, the **Recent moments** list — or several at once. This is the
source of truth for the model; the code carries one-line pointers back here.

**Touched by:**
- `app/api/me/sessions/route.ts` — `GET /api/me/sessions` computes every signal
  below and serializes them. **All the logic lives here** — the client is a
  pure renderer.
- `apps/mobile/src/lib/api/sessions.ts` — `MySessionRow` wire type +
  `isUpcomingSession` / `isPinnedSession` filters + the `CarouselLabel` type.
- `apps/mobile/src/app/(tabs)/moments/index.tsx` — home screen: carousel strip +
  the two list push-rows.
- `apps/mobile/src/app/(tabs)/moments/recents.tsx` — the Upcoming / Recent
  list screens.

Read this before changing the buckets, `pinned`, `carouselLabel`, or either
client filter.

## The two orthogonal axes (+ one label)

A row carries three server-computed fields. The first two are **orthogonal
signals**; the third is a label *for* the second.

### 1. `status: 'live' | 'upcoming' | 'past'` — drives the LISTS

A 3-way bucket. Mutually exclusive: a moment is in exactly one list.

- The **Recent moments** list (a.k.a. the "had-list") shows every `!== 'upcoming'` row.
- The **Upcoming** list shows `=== 'upcoming'`.
- Precedence: `upcoming` (future start) beats `live`; else `live`; else `past`.

### 2. `pinned: boolean` — drives the CAROUSEL alone

**INDEPENDENT of `status`.** The carousel is a promotion layered on top of the
lists, NOT a fourth bucket — so a pinned moment ALSO sits in whichever list its
`status` puts it in. A moment is pinned (and `!hidden`) when ANY of:

- it's **live** (`status === 'live'`), or
- you **touched it `<1h` ago** (`recentlyVisited` — date-less / past / upcoming
  alike), or
- it's **starting soon** (`startsSoon`: a dated, not-yet-started moment whose
  start is within 24h, even if never visited).

The carousel is "moments of interest" — a tense-neutral strip, hence its title
"Moments of interest" rather than a status word.

### 3. `carouselLabel: 'now' | 'soon' | 'visited' | null` — the chip ON the strip card

Computed server-side because it depends on per-user Redis `lastSeen`, which is
**never serialized** (see [Why server-side](#why-the-label-is-server-side)).
`null ⟺ !pinned`.

This is **NOT a third routing axis** — it's the LABEL for axis 2. It is kept
**separate from `pinned`** (rather than collapsed into a single nullable enum)
so the boolean stays a clean membership test (`isPinnedSession`) and so the
list/carousel orthogonality (axes 1 vs 2) isn't re-entangled by overloading one
field to mean both "in carousel" and "what it says". The redundancy
(`pinned ⟺ carouselLabel !== null`) is deliberate — see
[As-built notes](#as-built-notes).

| label | chip (mobile) | when |
|---|---|---|
| `'now'` | ● Happening now | dated, started, still-ongoing |
| `'soon'` | Starting soon (no dot) | pinned but not yet started |
| `'visited'` | ● Just visited | recently opened; date-less-live, or ended-but-revisited |
| `null` | — (card not in strip) | not pinned |

## The cross-product the client must handle

| state | where it shows | `carouselLabel` |
|---|---|---|
| live + pinned | carousel + Recent list | `'now'` (dated+started) / `'visited'` (date-less) |
| upcoming + pinned | carousel + Upcoming list, **at once** | `'soon'` |
| past / not-pinned | list only, no carousel | `null` |

The **upcoming + pinned** overlap (you visited a not-yet-started moment `<1h`
ago, and/or it's starting soon) is the case that makes `pinned` a separate
signal from `status` — one enum can't say "carousel AND Upcoming".

## Invariants

### `status` is PURE TENSE — it must NOT depend on `hidden`

Dismissing a card from the carousel ("Remove from home") affects ONLY `pinned`,
never which LIST a moment lands in. An earlier version gated the upcoming branch
on `!hidden`; dismissing a future moment then fell through to `past` and the
moment jumped out of Upcoming into "Recent moments" — a bug, because an upcoming
moment's list is the Upcoming row, not the had-list. (A live moment's list IS
the had-list, so demoting it there was invisible and masked the issue.) Keep
`hidden` out of the `status` ternary; `!hidden` lives in `pinned` and ONLY there.

### The `dateFuture` guard on `startsSoon` is load-bearing

```
startsSoon = startsAt !== null && dateFuture && startsAt - Date.now() <= SOON_MS
```

Without `dateFuture`, a PAST start also satisfies `<= 24h from now` (the delta is
negative, which is `<= 24h`), and a recently-ended dated moment would wrongly
re-pin forever.

### `carouselLabel` precedence (in order)

1. **NOT-YET-STARTED WINS over everything.** A pinned moment whose start is still
   in the future is `'soon'` even if you opened it minutes ago — a live/recent
   chip would mislead before it has begun. (The real start time rides the card's
   meta line, "Starts …", so the chip stays generic and doesn't duplicate it.)
2. **GENUINELY LIVE WINS over recency.** A dated, started, still-ongoing moment
   is `'now'` even if you opened it `<1h` ago — being in a live tasting must read
   "Happening now", not "Just visited". `hasDate` gates this: a DATE-LESS live
   card can't truthfully claim "ongoing" (we only know you visited it), so it
   falls through to `'visited'`.
3. **RECENCY.** Anything else pinned is here because you touched it `<1h` ago — a
   date-less live card, or a dated one that has already ended but you revisited.
   `'visited'`.

```
carouselLabel =
  !pinned                  ? null
  : dateFuture             ? 'soon'
  : status === 'live' && hasDate ? 'now'
  : recentlyVisited        ? 'visited'
  : 'now'   // unreachable given pinned's definition; safe least-wrong terminal
```

The trailing `'now'` is unreachable: every pinned non-future, non-live-dated row
is `recentlyVisited` (a date-less `status === 'live'` row implies `recentlyVisited`
via `datelessStale`; `startsSoon` implies `dateFuture`). It's a safe terminal if
the pin invariant ever drifts.

## Why the label is server-side

The label keys on whether the user touched the moment within the last hour, read
from per-user Redis `s:{CODE}:lastseen` (bumped on visit + rate). That timestamp
is **deliberately not serialized**: the 1h cutoff stays server-authoritative and
no precise per-user activity time leaks to the client. So the client *cannot*
recompute the label — it renders the enum verbatim.

An earlier design sent a `recentlyVisited` boolean and had the client recombine
it with `status` in a client-side `carouselLabel()` function. That recombination
was an ordering-fragile coupling across the web↔native boundary (the client
re-derived `started` / open-ended date math that had to stay locked to the
server's `datePast` / `dateFuture`). Moving the whole decision server-side
removed it: the client does pure string dispatch. An enum also leaks strictly
*less* than the boolean did — the client can't even infer the cutoff.

## Timing policy constants (`route.ts`, module scope)

Product rulings, NOT tuning knobs. They live at module scope in `route.ts` (the
sole consumer) — **not** in `@verre/core`, whose charter is time-free domain
logic. The client reasons about none of these windows; it renders the
server-computed label/status.

- `ASSUMED_DURATION_MS` (8h) — with only a start time (no `date_to`) we assume a
  duration to know when "live" flips to "past". 8h keeps an evening tasting
  pinned through the night and nothing more. (A stated `date_to` flips to past
  the moment it passes — no grace. "Time over → recent", Simon's ruling.)
- `DATELESS_IDLE_CUTOFF_MS` (1h) — a date-less session can't be claimed
  "ongoing"; keep it pinned (as "Just visited") for 1h since last activity, then
  drop to recents.
- `SOON_MS` (24h) — a dated, not-yet-started moment enters the carousel once its
  start is this close.

## List sort note (`recents.tsx`)

The server sorts the raw payload by **activity** (max of last-visit, start,
created) so the carousel can float "just visited" cards up. That bump is wrong
for the lists — a recently-opened moment shouldn't jump the date order — so both
list filters impose their own date sort: Upcoming sorts soonest-start-first (an
agenda); Recent sorts by effective date (the set `date_from`, else created)
newest-first. The server order is left for the carousel only.

## As-built notes

- **`pinned` / `carouselLabel` redundancy is intentional.** The type permits the
  illegal states `pinned:true, carouselLabel:null` (and vice versa), but the
  invariant is enforced at the single construction point (`!pinned ? null : …`),
  so it's unrepresentable in practice. Collapsing to one nullable enum would
  re-entangle the orthogonal axes at every `r.pinned` read site — the cheaper
  evil is the redundant field. **Resist any push to re-collapse.**
- **`CarouselLabel` is hand-mirrored** in `route.ts` and `sessions.ts`, matching
  the existing web↔native wire-type convention (`MySessionRow`, `WireWine`,
  `SessionRole` are all mirrored the same way). Its eventual home is `@verre/core`
  when the wire-type extraction workstream lands (proposal
  `00-shared-logic-extraction.md` §3) — until then, keep the two in sync.
