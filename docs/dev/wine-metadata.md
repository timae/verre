# Wine metadata fields

Beyond name/producer/vintage/grape/type, wines carry editorial detail:

- `description` — free-form text (≤1000 chars), markdown-style links auto-link via `renderWithLinks` on the info pane.
- `region` (≤255) + `country` (ISO 3166-1 alpha-2; validated server-side against the static `COUNTRY_CODES` set in `lib/countries.ts`).
- `vinification` (≤1000) — production/aging notes.
- `purchase_url` (≤1000, http(s) only) — vendor link. Validated by `cleanUrl` at the write boundary: bare domains (`example.com/wine`) auto-prepend `https://` so paste-without-scheme submissions don't silently drop; the result is parsed via `new URL()` and the protocol allow-list (`http:` / `https:` only) is enforced. Non-http schemes (`javascript:`, `data:`, `ftp:`, etc.) and unparseable input collapse to `''`. Output is canonicalised via `url.toString()`. Rendered with `rel="noopener noreferrer"` and `target="_blank"`.

All five fields are nullable and edited via `PATCH /api/session/:code/wines/:wineId`. They're stripped by `redactWine` in blind mode along with name/producer/vintage/grape — anything that identifies a wine.

**Standalone check-ins** (`POST /api/checkins`) accept the same five fields onto the minted wine row (body names `wineRegion`/`wineCountry`/`vinification`/`description`/`purchaseUrl` — the wine-prefix keeps origin distinct from the venue `country`), with the same write-boundary rules (`cleanCountry` allow-list, `cleanUrl`). The check-in **PATCH does not** — a stray edit keeps the wine metadata untouched; extend it if a check-in edit surface ever needs to change these.
