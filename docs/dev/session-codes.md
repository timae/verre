# Session codes — implementation

Two valid lengths coexist: **4-char** (legacy bare form, e.g. `B369`) and **8-char canonical** (hyphenated for display: `XYZW-1234`). Both draw from the **Crockford base32 alphabet** — `0-9 A-Z` minus `I L O U` (32 chars, case-insensitive, profanity-resistant by removing the U). Existing 4-char rows happen to use the hex subset (legacy `genCode`), but the validators accept any Crockford char in either length — `genCode` only emits 8-char today, and any short codes that appear later would draw from the full 32-char alphabet.

## Three forms of the same code

- **Canonical** — what's stored in DB rows, Redis keys, localStorage keys, React Query keys: no hyphen. e.g. `XYZW1234` or `B369`.
- **Display** — what's rendered in JSX, share-dialog text, page headers: `formatCode()` returns 4-char codes bare, 8-char hyphenated.
- **URL** — `/session/<code>` and `/join/<code>` segments: hyphenated for 8-char (`/session/XYZW-1234`), bare for 4-char (`/session/B369`).

Server entry points run `normalizeCode()` which strips hyphens and uppercases, so non-hyphenated URLs (old shared links) still resolve. Same with form input: pasting `xyzw-1234`, `XYZW1234`, or `xyzw 1234` all normalize to the same canonical key.

## Helpers in `lib/sessionCode.ts`

- `genCode()` — produces 8-char Crockford. Caller-side collision retry handles the rare clash.
- `normalizeCode(input): string | null` — server entry-point normalization. Strict; `I/L/O/U` reject (no lenient decode, since a typo could otherwise silently land on the wrong session).
- `validateCodeInput(input)` — discriminated `{empty | invalid-length | invalid-char}` failure for user-facing forms so the UI can show specific errors instead of generic "not found."
- `formatCode(stored)` — display rendering, accepts null/undefined (returns '' so callers can render unconditionally).
- `formatCodeInput(raw)` — live transform for the type-a-code input field. Auto-hyphens past the 4th char.
- `sessionPath(code, sub?)` and `joinPath(code)` — URL builders. **Use these everywhere a session URL is built**; raw `/session/${code}` interpolation creates display drift.

## Storage

`sessions.code`, `session_members.session_code`, `hall_of_fame.session_code` are `VarChar(16)` (widened from `Char(4)`). No data migration was needed since hex codes are valid Crockford.

## Collision check

`POST /api/session` queries both Redis (`s:<code>:meta`) AND Postgres (`sessions.code` unique). Both must be empty before a code is used. Postgres rows can survive Redis TTL expiry, so checking only Redis would let archived codes get re-issued and clobber the unique constraint.
