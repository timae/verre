# Score system — implementation

Scores are decimal `0..5` in `0.25` steps (quarter-stars). `0` means "not rated" — empty state. Anything stored is `> 0`.

## Storage

All scores live in `ratings.score` (`Decimal(3,2)` in Postgres) — in-session AND standalone. `ratings.origin` distinguishes the two (`'session'` vs `'standalone'`); `ratings.sessionId` is set for the former and NULL for the latter. The same value lives transiently in Redis as a JSON number under `s:{CODE}:r:{IDENTITYID}:{WINEID}` while a session is live, then gets archived to the relational column on commit.

## Validation

A value passes if `Number.isFinite(v) && v >= 0 && v <= 5 && Number.isInteger(v * 4)` — the `× 4` integer check accepts dyadic fractions and rejects 0.1, 0.3, 1/3, etc. Apply this at every write boundary: `/api/session/<code>/rate`, `/api/checkins` POST, `/api/checkins/<id>` PATCH. Reject with `400` if it fails; never silently round.

## Wire format

Prisma's runtime `Decimal` (decimal.js) serializes to a JSON **string** (`"4.25"`), not a number. Every API response that surfaces a score must coerce via `Number()` before sending — search for `score: c.score == null ? null : Number(c.score)` or equivalent at the route boundary. Forgetting this ships strings to the client where number arithmetic silently breaks (concatenation instead of addition, `>` comparisons that look right for single digits but fail at 10+).

## Display

Always go through `<StarRating>` or `formatScore(v)` (see `components/CLAUDE.md`) — those encode the locked display rule (`★ 4.0` / `★ 4.5` / `★ 4.25`, no `/5`). Never compose `★ ${v}` inline.

## Input

Always go through `<ScoreSlider>` for write surfaces. Don't reintroduce a 5-button row, a native `<input type="range">`, or any other control — the slider is the single source of touch + keyboard + ARIA correctness.

## Hall of Fame (retired 2026-11-11)

The rate POST used to upsert a `hall_of_fame` row on a 5★. Retired: the public feed handed out moment codes (a code lets anyone join) and rows were written from the raw lineup, so a blind wine's name went public before its reveal. Nothing reads or writes the table now, and its user FK is dropped (`20261111190000_retire_hall_of_fame_fk`), so account deletion needs no tombstone UPDATE; the table itself is dropped by a later migration once this is live (an instance still serving the previous release must never meet it missing). Its three badges (`first_hof`, `hof_3`, `hof_10`) are unearnable; earned ones still show (the badge revamp decides, like the descriptor badges).
