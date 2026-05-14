# Wine metadata fields

Beyond name/producer/vintage/grape/type, wines carry editorial detail:

- `description` — free-form text (≤1000 chars), markdown-style links auto-link via `renderWithLinks` on the info pane.
- `region` (≤255) + `country` (ISO 3166-1 alpha-2; validated server-side against the static `COUNTRY_CODES` set in `lib/countries.ts`).
- `vinification` (≤1000) — production/aging notes.
- `purchase_url` (≤1000, http(s) only) — vendor link. Validated by `cleanUrl` at the write boundary (`scheme ∈ {http, https}`); rendered with `rel="noopener noreferrer"` and `target="_blank"`. Restricting to http/https prevents `javascript:` / `data:` injection via crafted URLs.

All five fields are nullable and edited via `PATCH /api/session/:code/wines/:wineId`. They're stripped by `redactWine` in blind mode along with name/producer/vintage/grape — anything that identifies a wine.
