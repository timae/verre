# Flavour chart system

> **⚠️ The rated axes are now STRUCTURE intensities, not flavour descriptors.**
> The active model is the **structure wheel** — `resolveAxes(category, style)` +
> `perRatingAxes` from `@verre/core` (re-exported via `lib/flavours.ts`). The
> type-specific *descriptor* sets below (`FL_RED`/`FL_WHITE`/…, `detectFL`) are
> **LEGACY** — kept only for the Expand-window dual-read fallback and deleted in
> the structure-wheel Contract PR. New chart work keys on the structure axes, not
> descriptors. Full design: `docs/dev/proposals/structure-wheel.md`.

Two chart types coexist:

- **Polar chart** (`<PolarChart flavors fl size>`) — arc segments per axis. Single-wine detail, compare cards, user profile. The `fl` axis array is built at the CALL SITE: a read surface uses `detectLegacyDescriptorFL(row) ?? perRatingAxes(row, resolveAxesColoured(cat, style))` (legacy descriptor row → legacy wheel; structure row → only its present axes, §6d); an input surface hands the full `resolveAxesColoured` set. Renderer unchanged by the structure wheel.
- **Radar** (`<RadarChart series fl size>`) — polygon overlay for multi-taster compare. Each taster's polygon spans only its rated axes (open path, §10 #1); frame = union of present axes in registry order.

## The structure axes (active model)

Per-`(category, style)` from `resolveAxes` (`@verre/core`). Wine base (red/white/rose) = **sweetness, acidity, body, finish, aroma, flavour, tannin** (0–5 intensities); **spark** appends **bubbles**. No per-type pruning — an absent axis sits at None. Colour is per-platform (web `WEB_PALETTE` + `withColours`; native resolves from theme), not in core. The four carried-over keys (`body`/`acid`/`tannin`/`sweet`) are byte-identical to the legacy keys, so migrated data renders unchanged.

The **profile aggregate** (`lib/profileFlavor.ts`) derives its key list from `resolveAxes('wine','red')` (the base 7) — one source of truth with the wheel.

## Legacy descriptor dimensions (Expand-window only — deleted in the Contract PR)

Old type-specific descriptor sets, still in `lib/flavours.ts` for the dual-read fallback:

- `FL_RED`: dark_fruit, red_fruit, earth, spice, oak, tannin, body, acid, herbal, floral
- `FL_WHITE`: citrus, tropical, stone, floral, herbal, mineral, oak, body, acid, sweet
- `FL_SPARK`: floral_herb, citrus, tree_fruit, red_fruit, dried_fruit, earth, creamy, oak, nutty, acid
- `FL_ROSE`: red_fruit, citrus, floral, stone, herbal, mineral, body, acid, sweet, tropical
- Legacy `FL` (generic 10 keys)

`detectLegacyDescriptorFL(flavors)` returns the legacy set when a row carries ≥1 of the 16 dropped descriptor keys (the DUMP set), else null (a pure-structure row). `detectFL` (the old key-presence inferer) is retained only as its label-set picker. Existing descriptor ratings keep their stored keys until the data migration runs.

## Sizes

See `components/CLAUDE.md` for the `CHART_SIZE` primitive (`THUMB` / `EMBED` / `DETAIL` / `COMPARE` / `HERO`). Pick the tier that matches the chart's *role* in the layout.
