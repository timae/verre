import type { AromaSelection } from '@verre/core';
import type { CreateCheckinBody } from './api/feed';

// "Had It Too" (08-feed § 5a), the pure half of its screen
// (`app/(tabs)/feed/had-it-too/[id].tsx`): the POST body and what a refusal
// says. Pure (no React Native), so the drive against the dev server imports it
// as it is (.local/had-it-too/drive.mts).

// The server's one refusal for a copy (app/api/checkins/route.ts COPY_ERROR):
// the source is no longer copyable for you (its visibility, Hide from Feed, a
// follow that ended, your own or a moment's post) or its photo couldn't be
// copied. Matched on the text: the route sends no code for it.
export const COPY_REFUSED = 'This check-in cannot be copied right now.';

// The photo the copy will carry: the source's (copied on the server), your
// own (sent with the check-in's PATCH after the post), or none.
export type HadItTooPhoto = { kind: 'source' } | { kind: 'own'; dataUrl: string; previewUri: string } | { kind: 'none' };

export const HAD_IT_TOO_COPY = {
  // A source with nothing linkable left (its catalogue entry purged or
  // rejected): the server's `link-required`, whose own text asks for a pick
  // this screen doesn't have.
  linkRequired: 'This bottle isn’t in the catalogue any more. You can still check it in yourself.',
  refused: 'This check-in can’t be copied right now. You can still check it in yourself.',
  failed: 'Couldn’t post it. Check your connection and try again.',
  unconfirmed: 'We couldn’t confirm it was posted. Try again.',
} as const;

// "Where You Had It" starts from the source's place (ruled 2026-11-26: "where
// you had it will be taken over, but you can edit it"; this field's one
// exception to "optional fields start empty"). 🔒 ONLY the place the viewer is
// SHOWN on that post: the feed / detail payload's `venueName` / `city`, which
// already went through the author's Show My Locations (`postPlace`, server
// side). Never read the source's place any other way: no place shown, the
// field starts empty.
export function hadItTooPlace(shown: { venueName: string | null; city: string | null }): { venue: string; city: string } {
  return { venue: shown.venueName ?? '', city: shown.city ?? '' };
}

// 🔒 The source carries the bottle: the body has no link and no bottle fields
// (the server copies the source's link, the same wine and year). The photo is
// copied unless it was replaced or removed (`copyPhoto: false`). The place is
// the field as it stands, sent like Check In's (`venueName` / `city`, each
// only when not empty: a cleared field sends no place). `flavors` already
// filled-or-empty (fillFlavourZeros); `hidden` undefined = never shown (the
// server applies your check-in default).
export function hadItTooBody(a: {
  occurrenceId: string;
  sourceId: number;
  photo: HadItTooPhoto;
  venue: string;
  city: string;
  score: number;
  flavors: Record<string, number>;
  aromas: AromaSelection[];
  notes: string;
  hidden: boolean | undefined;
}): CreateCheckinBody {
  const notes = a.notes.trim();
  const venue = a.venue.trim();
  const city = a.city.trim();
  return {
    occurrenceId: a.occurrenceId,
    copyFromCheckinId: a.sourceId,
    ...(a.photo.kind !== 'source' ? { copyPhoto: false } : {}),
    ...(venue ? { venueName: venue } : {}),
    ...(city ? { city } : {}),
    score: a.score,
    flavors: a.flavors,
    ...(a.aromas.length ? { aromas: a.aromas } : {}),
    ...(notes ? { notes } : {}),
    ...(a.hidden !== undefined ? { hiddenFromFeed: a.hidden } : {}),
  };
}

// 🔒 A refusal that PROVES this check-in was never stored: the copy refusal
// and `link-required` are both answered AFTER the route's replay check
// (app/api/checkins/route.ts: an id already stored answers the stored check-in,
// 200, before any source work), so a retry that gets one may unfreeze its
// choices. Any other 400 proves nothing (body validation runs BEFORE that
// check), and the screen stays as frozen as it was.
export function hadItTooRefusalStoredNothing(e: { status: number; message: string; errorCode?: string } | null): boolean {
  return !!e && e.status === 400 && (e.errorCode === 'link-required' || e.message === COPY_REFUSED);
}

// What a DEFINITE refusal of the post says (a 4xx; an unknown outcome is the
// caller's `unconfirmed`). The two copy refusals get the app's own words; any
// other answered 4xx its server message, as Check In's rate stage does.
export function hadItTooRefusal(e: { status: number; message: string; errorCode?: string } | null): string {
  if (e && e.status === 400 && e.errorCode === 'link-required') return HAD_IT_TOO_COPY.linkRequired;
  if (e && e.status === 400 && e.message === COPY_REFUSED) return HAD_IT_TOO_COPY.refused;
  const msg = e && e.status > 0 && e.status < 500 ? e.message : null;
  return msg && msg !== 'http' ? msg : HAD_IT_TOO_COPY.failed;
}
