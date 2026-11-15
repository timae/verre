// Pins the app's in-moment block look (apps/mobile/src/lib/blockLook.ts) to
// the web's locked matrix (components/session/SessionPanel.tsx,
// components/wine/WineModal.tsx resolveProvenanceMode; docs/dev/block.md):
// someone who blocked you (one way or mutual) is drawn as a guest, someone you
// blocked one way carries the "Blocked" marker, a guest / deleted account is a
// guest, yourself is yourself. And who a tap opens the person preview for
// (`opensPreview`, 2026-11-15): never a guest look, never yourself. Pure, no
// DB / Redis / network.
// Run: npx tsx scripts/tests/block-look-units.ts   (exits 1 on any mismatch)
import { blockLook, opensPreview, type BlockLook } from '../../apps/mobile/src/lib/blockLook'

const ME = 'u:MEPUBLICID00'
const A = 'u:APUBLICID000'
const GUEST = 'a:0f0e0d0c-0b0a-4908-8706-050403020100'
const TOMB = 'd:0f0e0d0c-0b0a-4908-8706-050403020100'

// [label, id, myId, blocksOut, blocksIn, expected]
const CASES: [string, string, string, string[] | null | undefined, string[] | null | undefined, BlockLook][] = [
  ['no block pair', A, ME, [], [], 'normal'],
  ['no lists at all (an older server)', A, ME, undefined, null, 'normal'],
  ['you blocked them, one way', A, ME, [A], [], 'blocked-by-me'],
  ['they blocked you, one way → a guest', A, ME, [], [A], 'guest'],
  ['mutual block → a guest (D2b, the web rule)', A, ME, [A], [A], 'guest'],
  ['a guest identity', GUEST, ME, [], [], 'guest'],
  ['a guest identity, even if listed', GUEST, ME, [GUEST], [GUEST], 'guest'],
  ['a deleted account (d:)', TOMB, ME, [], [], 'guest'],
  ['yourself', ME, ME, [], [], 'self'],
  ['yourself, even if a stale list names you', ME, ME, [ME], [ME], 'self'],
  ['someone else is never self when myId is empty', A, '', [], [], 'normal'],
  ['an empty myId never matches an empty id', '', '', [], [], 'guest'],
]

let failures = 0
for (const [label, id, myId, out, inn, want] of CASES) {
  const got = blockLook(id, myId, out, inn)
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${label}: ${got}${ok ? '' : ` (want ${want})`}`)
}
// The preview opens for exactly the registered and the blocked-by-me looks:
// someone who blocked you (any direction) must tap exactly like a real guest.
const PREVIEW: [BlockLook, boolean][] = [['normal', true], ['blocked-by-me', true], ['guest', false], ['self', false]]
for (const [look, want] of PREVIEW) {
  const got = opensPreview(look)
  if (got !== want) failures++
  console.log(`${got === want ? '✓' : '✗'} preview on '${look}': ${got}${got === want ? '' : ` (want ${want})`}`)
}
const blocker = opensPreview(blockLook(A, ME, [], [A]))
const guest = opensPreview(blockLook(GUEST, ME, [], []))
const mutual = opensPreview(blockLook(A, ME, [A], [A]))
const same = blocker === guest && mutual === guest && guest === false
if (!same) failures++
console.log(`${same ? '✓' : '✗'} a blocker (one way or mutual) taps exactly like a guest`)
const total = CASES.length + PREVIEW.length + 1
console.log(failures === 0 ? `\nOK — ${total} block-look pins pass.` : `\nFAILED — ${failures} of ${total} block-look pins.`)
process.exit(failures === 0 ? 0 : 1)
