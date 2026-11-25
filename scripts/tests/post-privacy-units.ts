// ── Moment Visibility step 3, the app's plumbing (step-3 plan § 5) ───────────
//
// Pure modules of apps/mobile, run from the repo root (structural types only):
//   §1 the privacy-write generation: an audience / link answer that left before
//      a newer Only Inside write keeps the page's `me` and asks for one re-read
//   §2 the own-post store: a pinned detail's toggle, then undo, shows each
//      state; a fetch that left after the write wins, one that left before
//      doesn't; cleared with the viewer
//   §3 the `r…` id parse (the impression page's address) and the row → page
//      decision
//   §4 the feed cache patch and the stamp: only your own posts that carry the
//      field; a moment's write patches every post of that moment
//   §5 the menu rows' presence rule (no field, no row)
//   §8 step 3b, "Private Moment": the place line, a blind Impressions row's
//      line, the note under "Who Can See You" in every state and variant
//   §9 Moment Defaults: the alert's words from the preview, Create Moment's
//      Privacy value (lines and whole phrases), the line under a moment's
//      date, the apply time (records of the field dropped, the pinned copy's
//      one re-read, also after you left the page), the create's store
//
// Run: npx tsx scripts/tests/post-privacy-units.ts

import {
  bumpPrivacyWrite, bumpTarget, clearPostPrivacyState, effectivePrivacy, lateAnswerMe, postPrivacyVersion, privacyTarget, privacyWriteGeneration, recordMomentPrivacy, recordPostPrivacy, writeSuperseded,
} from '../../apps/mobile/src/lib/postPrivacyState'
import { postPrivacyOf, stampPrivacy, withPrivacy } from '../../apps/mobile/src/lib/postPrivacyPatch'
import { impressionRouteId, isImpressionRouteId, listRowTarget, parseImpressionRouteId } from '../../apps/mobile/src/lib/impressionRoute'
import { impressionDetail } from '../../apps/mobile/src/lib/impressionDetail'
import { PRIVATE_MOMENT, PRIVATE_MOMENT_INFO_LABEL, PRIVATE_MOMENT_NOTE, audienceSummaryLabel, blindRowLine, momentPlace, outsideNameLabel, ownAudienceBlock, privateMomentNote, shownOrHidden } from '../../apps/mobile/src/lib/momentVisibilityCopy'
import * as copy from '../../apps/mobile/src/lib/momentVisibilityCopy'
import { fieldAppliedAt, needsApplyReread, recordFieldApply } from '../../apps/mobile/src/lib/postPrivacyState'
import { clearCreatePrivacy, getCreatePrivacy, seedCreatePrivacy, setCreatePrivacy } from '../../apps/mobile/src/lib/createPrivacy'
import { nextCheckinDraft } from '../../apps/mobile/src/lib/checkinDraft'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
}

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- loose fixtures
const author = { id: 'HW5R2XKJ94AX', name: 'Ada', xp: 0, imageUrl: null }
const sessionItem = (o: J = {}): J => ({ type: 'session', createdAt: '2026-11-24T10:00:00.000Z', author, session: { id: 11, sessionId: 7, sessionName: 'M', hostName: null, deleted: false, blind: false, wines: [], likeCount: 0, liked: false, ...o } })
const checkinItem = (o: J = {}): J => ({ type: 'checkin', createdAt: '2026-11-24T10:00:00.000Z', author, checkin: { id: 21, wineId: 'w', wineName: 'W', ...o } })

console.log('§1 the privacy-write generation')
{
  const g0 = privacyWriteGeneration()
  check('no write since the request left: the answer\'s me stands, no re-read', lateAnswerMe({ onlyInside: false }, { onlyInside: true }, g0), { me: { onlyInside: false }, reread: false })
  bumpPrivacyWrite() // a post's ⋯ toggle on another tab while the audience save was in flight
  check('🔒 a write since: the page keeps the me it shows and re-reads once', lateAnswerMe({ onlyInside: false }, { onlyInside: true }, g0), { me: { onlyInside: true }, reread: true })
  check('an answer that left after the write stands', lateAnswerMe({ onlyInside: true }, { onlyInside: false }, privacyWriteGeneration()), { me: { onlyInside: true }, reread: false })
  const v0 = postPrivacyVersion()
  bumpPrivacyWrite()
  check('a bump notifies (the hooks re-render)', postPrivacyVersion() > v0, true)
}

console.log('§2 the own-post store')
{
  clearPostPrivacyState()
  // The detail renders a PINNED copy fetched at t=100 (served false).
  const pinnedAt = 100
  check('nothing recorded: the served value', effectivePrivacy(11, 'onlyInside', false, pinnedAt), false)
  recordPostPrivacy(11, 'onlyInside', true, 200)
  check('a toggle from the pinned detail shows at once', effectivePrivacy(11, 'onlyInside', false, pinnedAt), true)
  recordPostPrivacy(11, 'onlyInside', false, 300)
  check('…and the next tap undoes it (the record, not the stale pinned copy)', effectivePrivacy(11, 'onlyInside', false, pinnedAt), false)
  recordPostPrivacy(11, 'onlyInside', true, 400)
  check('🔒 a fetch that LEFT before the write (t=350) does not win', effectivePrivacy(11, 'onlyInside', false, 350), true)
  check('a fetch that left after it (t=450) wins: the server\'s truth', effectivePrivacy(11, 'onlyInside', false, 450), false)
  check('a copy without a stamp (never fetched) reads the record', effectivePrivacy(11, 'onlyInside', false, undefined), true)
  check('the field absent (someone else\'s post, the flag off): nothing, whatever is recorded', effectivePrivacy(11, 'onlyInside', undefined, 0), undefined)
  check('records are per post and per field', [effectivePrivacy(12, 'onlyInside', false, 0), effectivePrivacy(11, 'hiddenFromFeed', false, 0)], [false, false])
  recordPostPrivacy(Number.NaN, 'onlyInside', true, 500)
  check('🔒 a non-finite id is never recorded (NaN keys would collide)', effectivePrivacy(Number.NaN, 'onlyInside', false, 0), false)
  clearPostPrivacyState()
  check('cleared with the viewer: the served value again', effectivePrivacy(11, 'onlyInside', false, pinnedAt), false)
}

console.log('§2b a moment\'s record and overtaken answers (Codex 2026-11-25)')
{
  clearPostPrivacyState()
  // An opened post's PINNED copy of your post of moment 7, fetched at t=50, no feed page holds it.
  const pinned = sessionItem({ id: 11, sessionId: 7, hiddenFromFeed: false, privacyAt: 50 })
  recordMomentPrivacy(7, 'hiddenFromFeed', true, 100)
  check('🔒 Moment Privacy\'s write reaches the pinned copy by its moment (no cached item needed)', postPrivacyOf(pinned as never)[0]?.on, true)
  check('…not another moment\'s post, not a check-in', [postPrivacyOf(sessionItem({ id: 12, sessionId: 8, hiddenFromFeed: false, privacyAt: 50 }) as never)[0]?.on, postPrivacyOf(checkinItem({ id: 21, hiddenFromFeed: false, privacyAt: 50 }) as never)[0]?.on], [false, false])
  check('…a copy fetched after the write carries the server\'s value', postPrivacyOf(sessionItem({ id: 11, sessionId: 7, hiddenFromFeed: false, privacyAt: 150 }) as never)[0]?.on, false)
  clearPostPrivacyState()
  // One target: moment 7's Hide from Feed (its page and its post's ⋯ alike); a check-in is its own.
  const M7 = privacyTarget('hiddenFromFeed', 7, 11), C21 = privacyTarget('hiddenFromFeed', null, 21)
  check('targets: a moment post by its moment, a check-in by its post', [M7, C21, privacyTarget('hiddenFromFeed', 7, 99)], ['m7:hiddenFromFeed', 'p21:hiddenFromFeed', 'm7:hiddenFromFeed'])
  // Codex's scenario: the page saves ON (started t=100, its answer delayed); meanwhile the ⋯ turns it on (answer t=200) and off (answer t=300); the page's answer lands overtaken.
  const g = bumpTarget(M7)
  bumpTarget(M7); recordPostPrivacy(11, 'hiddenFromFeed', true, 200)
  bumpTarget(M7); recordPostPrivacy(11, 'hiddenFromFeed', false, 300)
  check('the page\'s answer is overtaken', writeSuperseded(M7, g), true)
  recordMomentPrivacy(7, 'hiddenFromFeed', true, 100) // only as old as its request
  check('🔒 …so the newer ⋯ choice (off) stays what the app shows', postPrivacyOf(pinned as never)[0]?.on, false)
  clearPostPrivacyState()
  // The reverse: the ⋯ tap ON leaves at t=100 (its answer delayed); the page saves OFF and lands first (t=200); the ⋯ answer lands overtaken.
  recordPostPrivacy(11, 'hiddenFromFeed', true, 100)
  const g2 = bumpTarget(M7)
  bumpTarget(M7); recordMomentPrivacy(7, 'hiddenFromFeed', false, 200); bumpTarget(M7)
  check('the ⋯ answer is overtaken', writeSuperseded(M7, g2), true)
  recordPostPrivacy(11, 'hiddenFromFeed', true, 100)
  check('🔒 …so the page\'s newer choice (off) stays', postPrivacyOf(pinned as never)[0]?.on, false)
  // Codex recheck #5: a write of ANOTHER target doesn't overtake this one.
  const g3 = bumpTarget(M7)
  bumpTarget(C21); bumpTarget(privacyTarget('hiddenFromFeed', 8, 12))
  check('🔒 writes of other targets (a check-in, another moment) don\'t overtake it', writeSuperseded(M7, g3), false)
  check('…every target write still moves the page-wide generation (lateAnswerMe)', (() => { const before = privacyWriteGeneration(); bumpTarget(C21); return privacyWriteGeneration() > before })(), true)
  // Codex recheck #6: a record never replaces a newer one.
  recordMomentPrivacy(7, 'hiddenFromFeed', false, 300)
  recordMomentPrivacy(7, 'hiddenFromFeed', true, 100)
  check('🔒 an older record (an overtaken answer) never replaces a newer one', postPrivacyOf(pinned as never)[0]?.on, false)
  recordMomentPrivacy(7, 'hiddenFromFeed', true, 400)
  check('…a newer one does', postPrivacyOf(pinned as never)[0]?.on, true)
  clearPostPrivacyState()
}

console.log('§3 the impression page\'s address and the row → page decision')
{
  check('r12 → 12', parseImpressionRouteId('r12'), 12)
  check('the int4 bound: r2147483647 ok, r2147483648 not', [parseImpressionRouteId('r2147483647'), parseImpressionRouteId('r2147483648')], [2147483647, null])
  check('wrong prefix, zero, leading zeros, a plain number, empty, junk → null',
    ['R12', 'p12', 'r0', 'r012', '12', 'r', '', 'r12 ', 'r1e3', 'r-1', 'r12345678901'].map(parseImpressionRouteId), [null, null, null, null, null, null, null, null, null, null, null])
  check('null / undefined → null', [parseImpressionRouteId(null), parseImpressionRouteId(undefined)], [null, null])
  check('🔒 any r… id is "not a post" (a malformed one included); a post id is not', [isImpressionRouteId('r12'), isImpressionRouteId('r0'), isImpressionRouteId('12'), isImpressionRouteId(undefined)], [true, true, false, false])
  check('the builder round-trips', parseImpressionRouteId(impressionRouteId(345)), 345)
  check('a row with a post opens the post', listRowTarget(9, 4), { kind: 'post', postId: 9 })
  check('without a post you may open: the impression page by its rating', listRowTarget(null, 4), { kind: 'impression', ratingId: 4 })
  check('neither: inert (a Cravings row without a rating)', listRowTarget(null, undefined), { kind: 'inert' })
  check('a bad rating id is inert, never a page', [listRowTarget(null, 0), listRowTarget(null, 1.5), listRowTarget(null, 2147483648)], [{ kind: 'inert' }, { kind: 'inert' }, { kind: 'inert' }])
  const d = impressionDetail({ id: 4, author: { id: 'HW5R2XKJ94AX', name: 'Ada', username: null, xp: 3, imageUrl: null }, name: 'N', vintage: null, producer: null, type: null, colour: 'red', sparkling: false, category: 'wine', abv: null, grape: null, region: null, country: null, imageUrl: null, score: 4, flavors: { body: 3 }, aromas: [], notes: 'n', description: null, vinification: null, purchaseUrl: null, hadAt: '2026-11-24T10:00:00.000Z', blind: true })
  check('the page\'s data: one page keyed by the rating, no moment, no place, a blind row stays blind, no wine id', [d.wines.length, d.wines[0].ratingId, d.place, d.sessionId, d.momentId, d.wines[0]._blind, 'id' in d.wines[0], d.isSession], [1, 4, null, null, null, true, false, false])
}

console.log('§4 the feed cache patch and the stamp')
{
  const own = sessionItem({ onlyInside: false })
  const theirs = sessionItem({ id: 12 })
  check('a moment post that carries the field: patched, stamped', (withPrivacy(own as never, { postId: 11 }, 'onlyInside', true, 9) as J).session, { ...own.session, onlyInside: true, privacyAt: 9 })
  check('someone else\'s (no field): the same object', withPrivacy(theirs as never, { postId: 12 }, 'onlyInside', true, 9) === theirs, true)
  check('another post: the same object', withPrivacy(own as never, { postId: 99 }, 'onlyInside', true, 9) === own, true)
  check('the moment\'s write patches every post of that moment', [withPrivacy(own as never, { sessionId: 7 }, 'onlyInside', true, 9) !== own, withPrivacy(sessionItem({ onlyInside: false, sessionId: 8 }) as never, { sessionId: 7 }, 'onlyInside', true, 9) === withPrivacy(sessionItem({ onlyInside: false, sessionId: 8 }) as never, { sessionId: 7 }, 'onlyInside', true, 9)], [true, false])
  const ci = checkinItem({ hiddenFromFeed: false })
  check('a check-in: Hide from Feed by its post id only', [(withPrivacy(ci as never, { postId: 21 }, 'hiddenFromFeed', true, 9) as J).checkin.hiddenFromFeed, withPrivacy(ci as never, { sessionId: 7 }, 'hiddenFromFeed', true, 9) === ci], [true, true])
  check('Incognito never lands on a check-in; a moment post without the Hide from Feed field is left alone', [withPrivacy(ci as never, { postId: 21 }, 'onlyInside', true, 9) === ci, withPrivacy(own as never, { postId: 11 }, 'hiddenFromFeed', true, 9) === own], [true, true])
  const ownBoth = sessionItem({ onlyInside: false, hiddenFromFeed: false })
  check('R12: Hide from Feed on your moment post (by post, and by moment), the other switch untouched', [(withPrivacy(ownBoth as never, { postId: 11 }, 'hiddenFromFeed', true, 9) as J).session, (withPrivacy(ownBoth as never, { sessionId: 7 }, 'hiddenFromFeed', true, 9) as J).session.hiddenFromFeed],
    [{ ...ownBoth.session, hiddenFromFeed: true, privacyAt: 9 }, true])
  const page = stampPrivacy({ items: [own, theirs, ci, checkinItem({ id: 22 }), sessionItem({ id: 13, hiddenFromFeed: false })] as never, nextCursor: null }, 77)
  check('the stamp: only posts that carry a field (either of a moment post\'s two)', (page.items as J[]).map(i => (i.session ?? i.checkin).privacyAt ?? null), [77, null, 77, null, 77])
}

console.log('§5 the menu rows\' presence rule')
{
  clearPostPrivacyState()
  check('🔒 your moment post: Hide from Feed only, never Incognito (R13), whatever Incognito is; it carries its moment (the target)', postPrivacyOf(sessionItem({ onlyInside: true, hiddenFromFeed: false }) as never), [{ field: 'hiddenFromFeed', on: false, postId: 11, sessionId: 7 }])
  check('…no row without the Hide from Feed field (Incognito alone: none)', postPrivacyOf(sessionItem({ onlyInside: true }) as never), [])
  recordPostPrivacy(11, 'onlyInside', true, Date.now())
  check('…a recorded Incognito never makes a row', postPrivacyOf(sessionItem({ onlyInside: false, hiddenFromFeed: true }) as never), [{ field: 'hiddenFromFeed', on: true, postId: 11, sessionId: 7 }])
  check('your check-in: Hide from Feed (no moment)', postPrivacyOf(checkinItem({ hiddenFromFeed: false }) as never), [{ field: 'hiddenFromFeed', on: false, postId: 21, sessionId: null }])
  check('🔒 someone else\'s posts (no field): no row', [postPrivacyOf(sessionItem() as never), postPrivacyOf(checkinItem() as never), postPrivacyOf(null)], [[], [], []])
  recordPostPrivacy(21, 'hiddenFromFeed', true, Date.now())
  check('the row reads the own-post store', postPrivacyOf(checkinItem({ hiddenFromFeed: false, privacyAt: 1 }) as never)[0]?.on, true)
  clearPostPrivacyState()
}

console.log('§6 a taster\'s summary of who can see the moment (R14)')
{
  check('the circle by who it is: people in it with the switch on, the host\'s alone with it off; the others unchanged',
    [audienceSummaryLabel('friends', true), audienceSummaryLabel('followers', true), audienceSummaryLabel('friends', false), audienceSummaryLabel('followers', false), audienceSummaryLabel('verre', true), audienceSummaryLabel('members', true)],
    ['Friends of People Who Joined', 'Followers of People Who Joined', 'Host’s Friends', 'Host’s Followers', 'Verre Users', 'Only People Who Joined'])
  check('shown / hidden', [shownOrHidden(true), shownOrHidden(false)], ['Shown', 'Hidden'])
}

console.log('§7 who outside sees you by name: your own account privacy (R15)')
{
  const v = (visibility: string, fofEnabled: boolean, checkinVisibility: string | null) => ({ visibility, fofEnabled, checkinVisibility }) as never
  check('posts follow the account: its audience, the extended circle with it',
    [outsideNameLabel(v('public-mutual', false, null)), outsideNameLabel(v('public-mutual', true, null)), outsideNameLabel(v('public-followers', true, null)), outsideNameLabel(v('public-users', true, null)), outsideNameLabel(v('public-internet', false, null))],
    ['Your Friends', 'Your Friends and Their Friends', 'Your Followers and Their Followers', 'Verre Users', 'Everyone'])
  check('an explicit posts choice narrower than the account: that choice, never the circle', [outsideNameLabel(v('public-users', false, 'public-followers')), outsideNameLabel(v('public-mutual', true, 'public-mutual'))], ['Your Followers', 'Your Friends'])
  check('🔒 a posts choice wider than the account never reads as MORE private than the truth: the account\'s audience (with its circle)',
    [outsideNameLabel(v('public-mutual', false, 'public-users')), outsideNameLabel(v('public-mutual', true, 'public-followers'))], ['Your Friends', 'Your Friends and Their Friends'])
  check('the block: the lead + your setting (Incognito off)', ownAudienceBlock(v('public-mutual', true, null), false),
    { lead: 'Your account privacy settings limit who can see your participation without joining:', value: 'Your Friends and Their Friends' })
  check('…Incognito on: no one, whatever the setting', ownAudienceBlock(v('public-internet', false, null), true), { lead: 'Who can see your participation without joining:', value: 'No one (Incognito)' })
  check('…posts Only Me: its own lead and the note', ownAudienceBlock(v('public-users', false, 'only-me'), false),
    { lead: 'Your posts are set to:', value: 'Only Me', note: 'Only people who joined this moment can see your participation.' })
}

console.log('§8 "Private Moment" (step 3b, R16–R19)')
{
  check('the label (R18)', PRIVATE_MOMENT, 'Private Moment')
  check('the place line: deleted wins, then private, then the name; a nameless named moment has none',
    [momentPlace({ deleted: true, sessionName: null }), momentPlace({ deleted: true, privateMoment: true, sessionName: null }), momentPlace({ deleted: false, privateMoment: true, sessionName: null }), momentPlace({ deleted: false, sessionName: 'Jura Night' }), momentPlace({ deleted: false, sessionName: null }), momentPlace({ deleted: false, sessionName: '' })],
    ['[deleted moment]', '[deleted moment]', 'Private Moment', 'Jura Night', null, null])
  check('a blind Impressions row\'s line: the name, else the label, else nothing',
    [blindRowLine({ momentName: 'Jura Night' }), blindRowLine({ privateMoment: true }), blindRowLine({})], ['Jura Night', 'Private Moment', null])
  check('the two notes, verbatim (R19)', PRIVATE_MOMENT_NOTE, {
    members: 'Your post stays visible to people in this audience who haven’t joined, as ‘Private Moment’ instead of the moment’s name.',
    other: 'Your post stays visible to this audience, as ‘Private Moment’ for anyone who can’t open this moment.',
  })
  check('no em dash in either note', Object.values(PRIVATE_MOMENT_NOTE).some(t => t.includes('\u2014')), false)
  check('the ⓘ the note sits behind, named for VoiceOver', PRIVATE_MOMENT_INFO_LABEL, 'How people who haven’t joined see your post')
  const base = { signedIn: true, onlyInside: false, hiddenFromFeed: false, postsOnlyMe: false, visibility: 'friends' as const }
  check('which note, by the served Visible To: Only People in It → the first; Friends, Followers, Verre Users → the second',
    (['members', 'friends', 'followers', 'verre'] as const).map(visibility => privateMomentNote({ ...base, visibility })),
    [PRIVATE_MOMENT_NOTE.members, PRIVATE_MOMENT_NOTE.other, PRIVATE_MOMENT_NOTE.other, PRIVATE_MOMENT_NOTE.other])
  check('…an unknown Visible To → the first (a frozen moment reads by its Visible To: it can still be opened)', privateMomentNote({ ...base, visibility: null }), PRIVATE_MOMENT_NOTE.members)
  check('no note: a guest, Incognito on, Hide from Feed on, posts Only Me',
    [privateMomentNote({ ...base, signedIn: false }), privateMomentNote({ ...base, onlyInside: true }), privateMomentNote({ ...base, hiddenFromFeed: true }), privateMomentNote({ ...base, postsOnlyMe: true })],
    [null, null, null, null])
  check('…Hide from Feed absent (its flag off) reads as off: the note shows', privateMomentNote({ ...base, hiddenFromFeed: undefined }), PRIVATE_MOMENT_NOTE.other)
}

console.log('\n§9 Moment Defaults')
{
  const { applyDefaultAlert, createPrivacyLines, phraseLine, momentStatusLine } = copy
  check('mixed: the count, then both directions on a second line', applyDefaultAlert({ field: 'visibility', count: 7, wider: 5, narrower: 2 }),
    { title: 'Apply to Existing Moments?', message: '7 moments have a different setting.\n5 would open wider and 2 would narrow.', keep: 'New Moments Only', all: 'All 7 Moments' })
  check('one way, wider / narrower, plural and singular', [
    applyDefaultAlert({ field: 'showPlace', count: 7, wider: 7, narrower: 0 }).message, applyDefaultAlert({ field: 'onlyInside', count: 7, wider: 0, narrower: 7 }).message,
    applyDefaultAlert({ field: 'showPlace', count: 1, wider: 1, narrower: 0 }).message, applyDefaultAlert({ field: 'onlyInside', count: 1, wider: 0, narrower: 1 }).message,
  ], ['This would increase visibility for 7 moments.', 'This would reduce visibility for 7 moments.', 'This would increase visibility for 1 moment.', 'This would reduce visibility for 1 moment.'])
  check('one item: "Include Existing Moment" / "Include Existing Check-In" (picked 2026-11-25), never "All 1 …"',
    [applyDefaultAlert({ field: 'onlyInside', count: 1, wider: 0, narrower: 1 }).all, applyDefaultAlert({ field: 'checkinHiddenFromFeed', count: 1, wider: 0, narrower: 1 }).all], ['Include Existing Moment', 'Include Existing Check-In'])
  check('check-ins: their own title and buttons, hidden / shown', [applyDefaultAlert({ field: 'checkinHiddenFromFeed', count: 12, wider: 0, narrower: 12 }), applyDefaultAlert({ field: 'checkinHiddenFromFeed', count: 1, wider: 1, narrower: 0 }).message],
    [{ title: 'Apply to Existing Check-Ins?', message: '12 check-ins would be hidden.', keep: 'New Check-Ins Only', all: 'All 12 Check-Ins' }, '1 check-in would be shown.'])
  const base = { visibility: 'friends' as const, includeGuestCircles: true, showPlace: false, showDetails: false, onlyInside: false, hiddenFromFeed: false }
  const line = (p: typeof base | Record<string, unknown>) => { const l = createPrivacyLines(p as typeof base); return [l.first, l.phrases.length ? phraseLine(l.phrases) : null] }
  check('Codex\'s examples: the audience + circle; the details shown; your own choices', [
    line(base), line({ ...base, includeGuestCircles: false }), line({ ...base, visibility: 'verre', showPlace: true, showDetails: true }),
    line({ ...base, visibility: 'followers', onlyInside: true, hiddenFromFeed: true }),
  ], [['Your Friends + tasters’ friends', null], ['Your Friends', null], ['Verre Users', 'Location, description and link shown'], ['Your Followers + tasters’ followers', 'Incognito on · hidden from feeds']])
  check('Only People Who Joined: no circle, and nothing is "shown" to anyone outside; "Incognito on" only while on (Simon 2026-11-25)', line({ ...base, visibility: 'members', showPlace: true, onlyInside: true }), ['Only People Who Joined', 'Incognito on'])
  check('a circle that does not apply (Verre Users) is never named', line({ ...base, visibility: 'verre' }), ['Verre Users', null])
  check('whole phrases: keep 1 of 3 ends with an ellipsis; keep never below 1', [phraseLine(['location shown', 'Incognito', 'hidden from feeds'], 1), phraseLine(['description and link shown', 'Incognito'], 0)],
    ['Location shown …', 'Description and link shown …'])
  check('the line under the date (D1): each state, none when both off / no record', [
    momentStatusLine({ onlyInside: true }), momentStatusLine({ onlyInside: false, hiddenFromFeed: true }), momentStatusLine({ onlyInside: true, hiddenFromFeed: true }),
    momentStatusLine({ onlyInside: false, hiddenFromFeed: false }), momentStatusLine({ onlyInside: false }), momentStatusLine(null),
  ], ['Incognito', 'Hidden from feeds', 'Incognito · hidden from feeds', null, null, null])
  const strings = [copy.MOMENTS_AREA_TITLE, copy.WHO_CAN_SEE_THIS_MOMENT, copy.CHECKIN_HIDE_FROM_FEED_TITLE, copy.CHECKIN_HIDE_FROM_FEED_HELPER, copy.MOMENT_POSTS_HIDE_FROM_FEED_TITLE, copy.MOMENT_POSTS_HIDE_FROM_FEED_HELPER, copy.RATE_HIDE_FROM_FEED_HELPER, ...Object.values(copy.MOMENT_DEFAULTS_SECTIONS)]
  check('no em dash in the new strings', strings.some(t => t.includes('\u2014')), false)
  check('the split\'s words (Simon 2026-11-25): no "tasting", "Create" not "Host", no "New"', [copy.MOMENTS_AREA_TITLE, copy.MOMENT_DEFAULTS_SECTIONS.host, copy.MOMENT_DEFAULTS_SECTIONS.join, copy.CHECKIN_HIDE_FROM_FEED_TITLE],
    ['Moments & Check-Ins', 'Who Can See Moments You Create', 'Joining or Creating Moments', 'Hide Check-Ins from Feed'])
  check('the two posts helpers name YOUR posts of each kind and stay short (≤ 90 characters)',
    [copy.CHECKIN_HIDE_FROM_FEED_HELPER.includes('your check-in posts'), copy.MOMENT_POSTS_HIDE_FROM_FEED_HELPER.includes('your moment posts'), copy.CHECKIN_HIDE_FROM_FEED_HELPER.length <= 90, copy.MOMENT_POSTS_HIDE_FROM_FEED_HELPER.length <= 90], [true, true, true, true])
  // The apply time.
  clearPostPrivacyState()
  recordPostPrivacy(41, 'hiddenFromFeed', true, 1_000)
  recordMomentPrivacy(7, 'hiddenFromFeed', true, 1_000)
  recordPostPrivacy(41, 'onlyInside', true, 1_000)
  recordFieldApply('hiddenFromFeed', 2_000)
  check('an apply drops every record of ITS field (posts and moments), keeps the others', [effectivePrivacy(41, 'hiddenFromFeed', false, 500), effectivePrivacy(41, 'hiddenFromFeed', false, 500, 7), effectivePrivacy(41, 'onlyInside', false, 500)], [false, false, true])
  check('a pinned copy fetched before the apply re-reads; one fetched after does not; an unstamped copy never', [needsApplyReread('hiddenFromFeed', 1_500, undefined), needsApplyReread('hiddenFromFeed', 2_500, undefined), needsApplyReread('hiddenFromFeed', undefined, undefined)], [true, false, false])
  check('…once per apply; a newer apply asks again', [needsApplyReread('hiddenFromFeed', 1_500, fieldAppliedAt('hiddenFromFeed')), (recordFieldApply('hiddenFromFeed', 3_000), needsApplyReread('hiddenFromFeed', 1_500, 2_000))], [false, true])
  check('an apply never moves back in time; no apply → nothing to re-read', [(recordFieldApply('hiddenFromFeed', 2_500), fieldAppliedAt('hiddenFromFeed')), needsApplyReread('onlyInside', 1, undefined)], [3_000, false])
  // Leaving the page before the apply answered: the answer still records the
  // apply (afterDefaultsApply runs whatever is mounted), so the post re-reads.
  recordFieldApply('onlyInside', 4_000)
  check('…an apply answering after you left Settings still marks the pinned post for its re-read', needsApplyReread('onlyInside', 3_900, undefined), true)
  clearPostPrivacyState()
  check('cleared with the viewer', fieldAppliedAt('hiddenFromFeed'), undefined)
  // Stage 1's draft rebuild keeps the rate stage's fields (review r1 P2).
  const det = { choice: { label: { name: 'W' } } as never, photo: null, vinification: 'v', description: 'd', purchaseUrl: '', venue: 'Bar', city: '' }
  const prev = { ...det, occurrenceId: 'occ-1', frozen: true, photoTried: true, score: 4, flavors: { body: 3 }, aromas: [], notes: 'n', hiddenFromFeed: true, privacyLocked: true, posting: true, choice: { label: { name: 'Frozen' } } as never }
  const next = nextCheckinDraft(prev, { ...det, venue: 'Other bar' }, 'occ-2')
  check('a back-swipe to stage 1 keeps Hide from Feed, its lock and a POST in flight, the rating, the id, the freeze and a frozen wine; takes the new details',
    [next.hiddenFromFeed, next.privacyLocked, next.posting, next.score, next.notes, next.occurrenceId, next.frozen, next.photoTried, (next.choice as { label: { name: string } }).label.name, next.venue], [true, true, true, 4, 'n', 'occ-1', true, true, 'Frozen', 'Other bar'])
  check('…a first visit: nothing shown yet (undefined = the server applies the default)', nextCheckinDraft(null, det, 'occ-3').hiddenFromFeed, undefined)
  // The create's store.
  const v1 = { ...base }
  seedCreatePrivacy('k1', v1)
  seedCreatePrivacy('k1', { ...base, visibility: 'verre' })
  check('the create store: seeded once (a later defaults read never overwrites a change)', getCreatePrivacy('k1')?.visibility, 'friends')
  setCreatePrivacy('k1', 'onlyInside', true)
  setCreatePrivacy('k2', 'onlyInside', true)
  check('…a change lands on its own key only; an unknown key stays empty', [getCreatePrivacy('k1')?.onlyInside, getCreatePrivacy('k2')], [true, null])
  clearCreatePrivacy('k1')
  check('…cleared with its create screen', getCreatePrivacy('k1'), null)
}

if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\npost-privacy-units: all ok')
