// Canonical PolarChart / FlavorWheel / RadarChart sizes. Use these
// instead of inline pixel values so the visual size of a flavor wheel
// stays consistent across screens — especially when new screens appear.
//
// Pick the tier that matches the *role* of the chart in the layout, not
// a specific pixel target:
//   DETAIL  — chart as the focus of a modal, card, or feed entry.
//             Most read-only and edit surfaces use this.
//   COMPARE — side-by-side comparison cells where multiple charts share
//             the viewport.
//   HERO    — chart dominates an interactive surface (e.g. the rating
//             screen, where the chart is what the user is shaping).
//   INPUT   — interactive flavour wheel inside a modal. Smaller than
//             HERO so the wheel + its label gutter fit inside the
//             modal's maxWidth (typically 580) on desktop, and so the
//             user's thumb covers a smaller fraction of the wheel on
//             mobile. The number is the SVG viewBox size; the label
//             gutter is budgeted INSIDE the box, so the wheel's outer
//             radius is smaller than size/2 by the gutter width.
//
// Earlier THUMB (180) and EMBED (220) tiers were collapsed into DETAIL —
// the smaller sizes were artificially holding back charts that had
// plenty of room in their parent. Re-add a smaller tier here only if a
// real surface needs sub-DETAIL sizing.

export const CHART_SIZE = {
  DETAIL:  280,
  COMPARE: 460,
  HERO:    560,
  INPUT:   400,
} as const
