// Moment Visibility's release fence (docs/dev/proposals/moment-visibility.md
// § 11). While it is off, every look-in read, open row, `momentId`, link route
// and the settings routes answer 404 where they would answer the feature
// (never 403: app/api/CLAUDE.md § Status code rules). On a moment route the
// check sits AFTER the entrance gate, so a non-participant still gets that
// gate's answer (401 / 429), as on every other moment route: the flag hides
// the feature, not the fact that a route exists. Read per call, so a suite can
// flip it.
//
// ON BY DEFAULT since 0.2.0 build 2 (the lib/catalogGate.ts pattern): only the
// exact string 'false' turns it off, the kill switch. No staff bypass.
export function momentLookInEnabled(): boolean {
  return process.env.MOMENT_LOOKIN_ENABLED !== 'false'
}

// Hide from Feed's release fence (Moment Visibility step 3, R9; the
// lib/catalogGate.ts pattern, ON by default since 0.2.0 build 2): only the
// literal 'false' closes its WRITE (`PATCH /api/feed-items/:id/privacy` with `hiddenFromFeed`)
// and the feed's `hiddenFromFeed` field on your own check-ins. 🔒 Its READERS
// are always on (lib/postPrivacy.ts): once anyone has hidden a post, no deploy
// may go below this step, and turning the flag off must not reopen a post.
// Read per call, so a suite can flip it.
export function hideFromFeedEnabled(): boolean {
  return process.env.HIDE_FROM_FEED_ENABLED !== 'false'
}
