// Shared "last seen" bucketing. The STORED/EXPOSED value is the bucket START,
// not the precise request time, so every session's last-seen snaps to the same
// 5-minute wall-clock edges (00:00, 00:05, …). This collapses timeline-
// correlation signal across an exfiltrated DB: a value of 00:05:00 reveals only
// "active sometime in the 00:05–00:10 window", never "request happened at
// 00:07:43". See proposal §5.
//
// Two consumers must agree on the same edges:
//   - auth.ts writes user_sessions.lastSeenAt bucketed at write time.
//   - app/api/me/devices surfaces NATIVE auth_sessions.updatedAt bucketed at
//     READ time (Better Auth owns that column and stores a precise instant, so
//     the coarsening happens on the way out — the web and native rows in the
//     devices union then expose the same precision).
// Lives in its own module (not auth.ts) so the devices route can reuse it
// without pulling NextAuth/bcrypt into its import graph.
export const LAST_SEEN_BUCKET_MS = 5 * 60 * 1000

export function bucketStart(ms: number): number {
  return Math.floor(ms / LAST_SEEN_BUCKET_MS) * LAST_SEEN_BUCKET_MS
}
