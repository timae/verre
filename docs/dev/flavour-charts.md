# Flavour chart system

> **⚠️ The rated axes are STRUCTURE intensities, not flavour descriptors.**
> The model is the **structure wheel** — `resolveAxes(category, style)` +
> `perRatingAxes` from `@verre/core` (re-exported via `lib/flavours.ts`). The old
> type-specific *descriptor* sets (`FL_RED`/`FL_WHITE`/…, `detectFL`,
> `detectLegacyDescriptorFL`) were the Expand-window dual-read fallback and were
> **deleted in the structure-wheel Contract PR** once the data migration had run
> and prod was verified descriptor-free. Chart work keys on the structure axes,
> not descriptors. Full design: `docs/dev/proposals/structure-wheel.md`.

Two chart types coexist:

- **Polar chart** (`<PolarChart flavors fl size>`) — arc segments per axis. Single-wine detail, compare cards, user profile. The `fl` axis array is built at the CALL SITE: a read surface uses `perRatingAxes(row, resolveAxesColoured(cat, style))` (only the axes present in the rating, present-and-0 drawn at centre, §6d); an input surface hands the full `resolveAxesColoured` set. Renderer unchanged by the structure wheel.
- **Radar** (`<RadarChart series fl size>`) — polygon overlay for multi-taster compare. Each taster's polygon spans only its rated axes (open path, §10 #1); frame = union of present axes in registry order.

## The structure axes (active model)

Per-`(category, style)` from `resolveAxes` (`@verre/core`). Wine base (red/white/rose) = **sweetness, acidity, body, finish, aroma, flavour, tannin** (0–5 intensities); **spark** appends **bubbles**. No per-type pruning — an absent axis sits at None. Colour is per-platform (web `WEB_PALETTE` + `withColours`; native resolves from theme), not in core. The four carried-over keys (`body`/`acid`/`tannin`/`sweet`) are byte-identical to the legacy keys, so migrated data renders unchanged.

The **profile aggregate** (`lib/profileFlavor.ts`) derives its key list from `resolveAxes('wine','red')` (the base 7) — one source of truth with the wheel.

## Legacy descriptor dimensions (removed)

The pre-redesign type-specific descriptor sets (`FL_RED`/`FL_WHITE`/`FL_SPARK`/`FL_ROSE`/generic `FL`, plus `getFL`/`detectFL`/`detectLegacyDescriptorFL` and the 16-key DUMP set) were deleted in the Contract PR. They existed only to keep historical descriptor ratings rendering during the Expand window between deploy and the data migration; the migration stripped all descriptor keys from `ratings.flavors` (prod verified at 0 remaining), so the dual-read had no rows left to serve. The write-boundary normaliser `gateAndFillFlavors` (in `lib/flavours.ts`) keeps descriptor keys from being re-introduced (a non-zero unknown key → 400) and zero-fills the kept set so the stored shape is filled-or-empty for every writer. For the historical keysets + detection rules, see `docs/dev/proposals/structure-wheel.md` §4/§8 and the git history of `lib/flavours.ts`.

## Sizes

See `components/CLAUDE.md` for the `CHART_SIZE` primitive (`THUMB` / `EMBED` / `DETAIL` / `COMPARE` / `HERO`). Pick the tier that matches the chart's *role* in the layout.
