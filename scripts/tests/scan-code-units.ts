// ── parseVerreCode pins (apps/mobile/src/lib/scanCode.ts) ───────────────────
//
// What an in-app scan may open: a profile QR (`<WEB_BASE>/u/<public id>`), an
// OLD profile QR (`/u/<digits>`, from before public ids: recognised, shows
// "This code isn’t available.", nothing requested), a moment invite
// (`/join/<code>`), on the exact web origin only.
//
// Run: npx tsx scripts/tests/scan-code-units.ts

import { parseVerreCode } from '../../apps/mobile/src/lib/scanCode'
import { normalizePublicUserId, profilePath } from '../../packages/core/src/publicUserId'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
}

const WEB = 'https://verre.example'
const P = (data: string) => parseVerreCode(data, WEB)

console.log('\n§1 profiles: the public id')
check('canonical', P(`${WEB}/u/K7M2Q9X4B8RT`), { kind: 'profile', id: 'K7M2Q9X4B8RT' })
check('lowercase → canonical uppercase', P(`${WEB}/u/k7m2q9x4b8rt`), { kind: 'profile', id: 'K7M2Q9X4B8RT' })
check('the link the app writes (profilePath, lowercase) reads back', P(`${WEB}${profilePath('K7M2Q9X4B8RT')}`), { kind: 'profile', id: 'K7M2Q9X4B8RT' })
check('trailing slash, query, fragment', P(`${WEB}/u/K7M2Q9X4B8RT/?x=1#y`), { kind: 'profile', id: 'K7M2Q9X4B8RT' })
check('host case-insensitive', P('https://VERRE.example/u/K7M2Q9X4B8RT'), { kind: 'profile', id: 'K7M2Q9X4B8RT' })
check('11 characters', P(`${WEB}/u/K7M2Q9X4B8R`), null)
check('13 characters', P(`${WEB}/u/K7M2Q9X4B8RTA`), null)
check('a digit first', P(`${WEB}/u/7KM2Q9X4B8RT`), null)
check('outside the alphabet (I, L, O, U)', P(`${WEB}/u/KIM2Q9X4B8RT`), null)
check('🔒 non-ASCII spellings never alias an id (ß → SS, ſ → S, ﬀ → FF)', ['aßbcdefghjk', 'ſabcdefghjkm', 'ﬀabcdefghjk'].map(normalizePublicUserId), [null, null, null])
check('a hyphen', P(`${WEB}/u/K7M2Q9-4B8RT`), null)

console.log('\n§2 old profile QRs: recognised, never looked up')
check('/u/42', P(`${WEB}/u/42`), { kind: 'profile-legacy' })
check('/u/2147483647', P(`${WEB}/u/2147483647`), { kind: 'profile-legacy' })
check('a leading zero is no Verre code', P(`${WEB}/u/042`), null)
check('eleven digits is no Verre code', P(`${WEB}/u/12345678901`), null)

console.log('\n§2b shared profile links: /@name')
check('/@simon', P(`${WEB}/@simon`), { kind: 'profile-username', username: 'simon' })
check('every character class', P(`${WEB}/@simon.f_1`), { kind: 'profile-username', username: 'simon.f_1' })
check('uppercase → canonical lowercase', P(`${WEB}/@Simon`), { kind: 'profile-username', username: 'simon' })
check('the encoded form', P(`${WEB}/%40simon`), { kind: 'profile-username', username: 'simon' })
check('trailing slash, query, fragment', P(`${WEB}/@simon/?x=1#y`), { kind: 'profile-username', username: 'simon' })
check('🔒 a RESERVED name still reads (an operator-assigned one opens)', P(`${WEB}/@verre`), { kind: 'profile-username', username: 'verre' })
check('too short', P(`${WEB}/@ab`), null)
check('two dots', P(`${WEB}/@a..b`), null)
check('a dot at the end', P(`${WEB}/@simon.`), null)
check('a second @', P(`${WEB}/@@simon`), null)
check('a deeper path', P(`${WEB}/@simon/x`), null)
check('non-ASCII', P(`${WEB}/@stra\u00dfe`), null)
check('another origin', P('https://evil.example/@simon'), null)

console.log('\n§3 moments')
check('8-character, hyphenated', P(`${WEB}/join/ABCD-1234`), { kind: 'moment', code: 'ABCD1234' })
check('4-character legacy', P(`${WEB}/join/ab12`), { kind: 'moment', code: 'AB12' })
check('bad code', P(`${WEB}/join/ABCDE`), null)

console.log('\n§4 not a Verre code')
check('another origin', P('https://evil.example/u/K7M2Q9X4B8RT'), null)
check('user info in the origin', P('https://verre.example@evil.example/u/K7M2Q9X4B8RT'), null)
check('http vs https', P('http://verre.example/u/K7M2Q9X4B8RT'), null)
check('another path', P(`${WEB}/me`), null)
check('plain text', P('hello'), null)

console.log(failures === 0 ? '\nOK — scan-code pins pass.' : `\nFAILED — ${failures} scan-code pin(s).`)
process.exit(failures === 0 ? 0 : 1)
