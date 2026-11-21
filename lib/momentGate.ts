// Moment Visibility's release fence (docs/dev/proposals/moment-visibility.md
// § 11). While it is off, every look-in read, open row, `momentId`, link route
// and the settings routes answer 404 where they would answer the feature
// (never 403: app/api/CLAUDE.md § Status code rules). On a moment route the
// check sits AFTER the entrance gate, so a non-participant still gets that
// gate's answer (401 / 429), as on every other moment route: the flag hides
// the feature, not the fact that a route exists. Read per call, so a suite can
// flip it.
//
// 🔒 No staff bypass (unlike lib/catalogGate.ts): a staff looker would see old
// moments before the go-live image gate has run.
export function momentLookInEnabled(): boolean {
  return process.env.MOMENT_LOOKIN_ENABLED === 'true'
}
