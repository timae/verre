// Canonical PolarChart / RadarChart sizes. Use these instead of inline
// pixel values so the visual size of a flavor wheel stays consistent
// across screens — especially when new screens appear.
//
// Pick the tier that matches the *role* of the chart in the layout, not
// a specific pixel target:
//   THUMB   — small glance inside a feed/list card.
//   EMBED   — chart embedded alongside form controls (sliders, fields).
//   DETAIL  — chart as the focus of a modal or detail page.
//   COMPARE — side-by-side comparison cells where multiple charts share
//             the viewport.
//   HERO    — chart dominates an interactive surface (e.g. the rating
//             screen, where the chart is what the user is shaping).

export const CHART_SIZE = {
  THUMB:   180,
  EMBED:   220,
  DETAIL:  280,
  COMPARE: 460,
  HERO:    560,
} as const
