# Flavour chart system

Two chart types coexist:

- **Polar chart** (`drawPolarChart(id, flavors, sz, fl)`) — arc segments per dimension. Used for single-wine detail, compare cards, and user profile. Takes an optional `fl` array; if omitted, `detectFL(flavors)` infers the right one from stored key names.
- **Radar** (`drawRadar(...)`) — polygon overlay. Used only for multi-wine compare overlays where shapes need to be compared visually.

## Type-specific dimensions

Flavour dimensions are **type-specific**:

- `FL_RED`: dark_fruit, red_fruit, earth, spice, oak, tannin, body, acid, herbal, floral
- `FL_WHITE`: citrus, tropical, stone, floral, herbal, mineral, oak, body, acid, sweet
- `FL_SPARK`: floral_herb, citrus, tree_fruit, red_fruit, dried_fruit, earth, creamy, oak, nutty, acid
- `FL_ROSE`: red_fruit, citrus, floral, stone, herbal, mineral, body, acid, sweet, tropical
- Legacy `FL` (generic 10 keys): used for old ratings and profile aggregation

## Detection

`detectFL(flavors)` identifies which array applies by checking key names. Existing ratings always keep their stored keys — switching wine type never migrates old flavor data.

## Sizes

See `components/CLAUDE.md` for the `CHART_SIZE` primitive (`THUMB` / `EMBED` / `DETAIL` / `COMPARE` / `HERO`). Pick the tier that matches the chart's *role* in the layout.
