// Canonical PolarChart / RadarChart sizes. Use these instead of inline
// pixel values so the visual size of a flavor wheel stays consistent
// across screens — especially when new screens appear.
//
// Pick the tier that matches the *role* of the chart in the layout, not
// a specific pixel target:
//   DETAIL  — chart as the focus of a modal, card, or feed entry.
//             Most read-only and edit surfaces use this.
//   COMPARE — side-by-side comparison cells where multiple charts share
//             the viewport.
//   HERO    — chart dominates an interactive surface (e.g. the rating
//             screen, where the chart is what the user is shaping).
//
// Earlier THUMB (180) and EMBED (220) tiers were collapsed into DETAIL —
// the smaller sizes were artificially holding back charts that had
// plenty of room in their parent. Re-add a smaller tier here only if a
// real surface needs sub-DETAIL sizing.

export const CHART_SIZE = {
  DETAIL:  280,
  COMPARE: 460,
  HERO:    560,
} as const
