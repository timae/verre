// Your own posts' privacy switches, as this process last wrote them (Moment
// Visibility step 3, § 5; Codex r2). Pure module state: no React Native, so the
// root units can import it (scripts/tests/post-privacy-units.ts). Cleared with
// the viewer cache (lib/query.tsx `clearViewerCache`).
//
// 1. THE PRIVACY-WRITE GENERATION: every privacy write (the Moment Privacy
//    page, a post's ⋯ on any tab) bumps it when it starts and when it lands;
//    a write's own answer overtaken by another is `writeSuperseded`. An audience / link answer whose
//    request started before the latest bump carries an older `me`: the page
//    keeps its own `me` and re-reads once (`lateAnswerMe`).
// 2. THE OWN-POST STORE: each successful write records (post, field, value,
//    the time). The opened post renders a PINNED copy (`feed/[id]/index.tsx`)
//    that the feed cache patch can't reach, so the ⋯ check and the status line
//    read `effectivePrivacy`: the recorded value, unless the post's data came
//    from a fetch that STARTED after the write (`privacyAt`, stamped by
//    lib/api/feed.ts `getFeed` when the request leaves).

export type PrivacyField = 'onlyInside' | 'hiddenFromFeed';

let generation = 0;
export const privacyWriteGeneration = (): number => generation;
export function bumpPrivacyWrite(): number {
  generation += 1;
  notify();
  return generation;
}

type Rec = { value: boolean; at: number };
const records = new Map<string, Rec>();
const keyOf = (postId: number, field: PrivacyField) => `${postId}:${field}`;
// A moment's choice from its Moment Privacy page (Codex 2026-11-25): it reaches
// every copy of YOUR post of that moment, an opened post's pinned copy too,
// whether or not a feed page still holds the post.
const momentKeyOf = (sessionId: number, field: PrivacyField) => `m${sessionId}:${field}`;

const listeners = new Set<() => void>();
let version = 0;
function notify() {
  version += 1;
  listeners.forEach((l) => l());
}
export function subscribePostPrivacy(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const postPrivacyVersion = (): number => version;

// A record never replaces a NEWER one (an overtaken answer is recorded at its
// request's start, which can be older than what is stored: Codex recheck).
function record(key: string, value: boolean, at: number): void {
  const prev = records.get(key);
  if (prev && prev.at > at) return;
  records.set(key, { value, at });
  notify();
}
export function recordPostPrivacy(postId: number, field: PrivacyField, value: boolean, at: number): void {
  if (Number.isFinite(postId)) record(keyOf(postId, field), value, at);
}
export function recordMomentPrivacy(sessionId: number, field: PrivacyField, value: boolean, at: number): void {
  if (Number.isFinite(sessionId)) record(momentKeyOf(sessionId, field), value, at);
}

// What the ⋯ row and the status line show. `served` absent = the field is not
// on this post (someone else's, or its flag is off): no row, no line. The
// NEWEST record wins (the post's own, or its moment's for a moment post), and
// only while it is newer than the copy's fetch.
export function effectivePrivacy(postId: number, field: PrivacyField, served: boolean | undefined, servedAt: number | undefined, sessionId?: number | null): boolean | undefined {
  if (served === undefined || !Number.isFinite(postId)) return served;
  let best: Rec | undefined;
  for (const r of [records.get(keyOf(postId, field)), sessionId != null && Number.isFinite(sessionId) ? records.get(momentKeyOf(sessionId, field)) : undefined]) {
    if (r && (servedAt === undefined || r.at > servedAt) && (!best || r.at > best.at)) best = r;
  }
  return best ? best.value : served;
}

// 🔒 PER TARGET (Codex 2026-11-25 + recheck): a write's answer is OVERTAKEN
// when another write of the SAME target started or landed while it was in
// flight: a check-in's field, or a moment's field (its Moment Privacy page and
// its post's ⋯ share it). It may be older than what the app shows, so it is
// recorded only as old as its own request (`startedAt`), never as news, and
// the copies are re-read. Writes of other targets don't count. Every write also
// bumps the page-wide generation (`lateAnswerMe`).
const targets = new Map<string, number>();
export const privacyTarget = (field: PrivacyField, sessionId: number | null | undefined, postId: number): string =>
  sessionId != null ? `m${sessionId}:${field}` : `p${postId}:${field}`;
export function bumpTarget(target: string): number {
  const n = (targets.get(target) ?? 0) + 1;
  targets.set(target, n);
  bumpPrivacyWrite();
  return n;
}
export const writeSuperseded = (target: string, startedGen: number): boolean => (targets.get(target) ?? 0) !== startedGen;

// An audience / link answer of Moment Privacy: its `me` stands only while no
// Only Inside write happened since the request left (`startedGen`); else the
// page keeps the `me` it shows and asks for one re-read.
export function lateAnswerMe<M>(answerMe: M, shownMe: M, startedGen: number): { me: M; reread: boolean } {
  return generation === startedGen ? { me: answerMe, reread: false } : { me: shownMe, reread: true };
}

// 3. MOMENT DEFAULTS' APPLY (the defaults page's "All N …"): it changes the
//    field on many posts at once, so every record of that field is dropped
//    (each may now be wrong) and the field's APPLY TIME is kept: an opened
//    post's pinned copy fetched before it re-reads (`needsApplyReread`) when
//    its screen regains focus and when the time moves while it is focused.
const appliedAt = new Map<PrivacyField, number>();
export function recordFieldApply(field: PrivacyField, at: number): void {
  for (const k of [...records.keys()]) if (k.endsWith(`:${field}`)) records.delete(k);
  appliedAt.set(field, Math.max(appliedAt.get(field) ?? 0, at));
  notify();
}
export const fieldAppliedAt = (field: PrivacyField): number | undefined => appliedAt.get(field);
// Re-read a pinned copy once per apply that came after its fetch (`servedAt`),
// and never twice for the same apply (`rereadFor`: the apply time it last
// re-read for). An unstamped copy (no field of yours on it) never re-reads.
export function needsApplyReread(field: PrivacyField, servedAt: number | undefined, rereadFor: number | undefined): boolean {
  const at = appliedAt.get(field);
  return at !== undefined && servedAt !== undefined && servedAt < at && rereadFor !== at;
}

export function clearPostPrivacyState(): void {
  records.clear();
  appliedAt.clear();
  notify();
}
