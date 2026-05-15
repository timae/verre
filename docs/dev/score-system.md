# Score system — implementation

Scores are decimal `0..5` in `0.25` steps (quarter-stars). `0` means "not rated" — empty state. Anything stored is `> 0`.

## Storage

Post-rewire, all scores live in `ratings.score` (`Decimal(3,2)` in Postgres) — in-session AND standalone. `ratings.origin` distinguishes the two (`'session'` vs `'standalone'`); `ratings.sessionId` is set for the former and NULL for the latter. The same value lives transiently in Redis as a JSON number under `s:{CODE}:r:{IDENTITYID}:{WINEID}` while a session is live, then gets archived to the relational column on commit. The legacy `checkins.score` column exists until phase 4 drops the table but is no longer written (slice 3 of the rewire stopped writes).

## Validation

A value passes if `Number.isFinite(v) && v >= 0 && v <= 5 && Number.isInteger(v * 4)` — the `× 4` integer check accepts dyadic fractions and rejects 0.1, 0.3, 1/3, etc. Apply this at every write boundary: `/api/session/<code>/rate`, `/api/checkins` POST, `/api/checkins/<id>` PATCH. Reject with `400` if it fails; never silently round.

## Wire format

Prisma's runtime `Decimal` (decimal.js) serializes to a JSON **string** (`"4.25"`), not a number. Every API response that surfaces a score must coerce via `Number()` before sending — search for `score: c.score == null ? null : Number(c.score)` or equivalent at the route boundary. Forgetting this ships strings to the client where number arithmetic silently breaks (concatenation instead of addition, `>` comparisons that look right for single digits but fail at 10+).

## Display

Always go through `<StarRating>` or `formatScore(v)` (see `components/CLAUDE.md`) — those encode the locked display rule (`★ 4.0` / `★ 4.5` / `★ 4.25`, no `/5`). Never compose `★ ${v}` inline.

## Input

Always go through `<ScoreSlider>` for write surfaces. Don't reintroduce a 5-button row, a native `<input type="range">`, or any other control — the slider is the single source of touch + keyboard + ARIA correctness.

## Hall of Fame trigger

A row is created when `score >= 5` on commit (the only way to hit it post-decimal is exactly `5`, since the snap caps there). The check is on the canonical numeric value, not on a string compare — relevant if you touch the rate POST handler.
