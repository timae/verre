// ── Username pins (packages/core/src/username.ts, usernames § 4) ────────────
//
// The validator table, the reserved set with its lookalike and brand rules,
// the read-side normalisers, the share path, and 🔒 the route-word test: the
// first URL segment of every route in `app/` and `apps/mobile/src/app` must be
// reserved, so a new route word can't be forgotten.
//
// Run: npx tsx scripts/tests/username-units.ts

import { readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkUsername, validateUsername, normalizeUsername, usernameFromPath, usernameQuery,
  isReservedUsername, isUsernameFormat, profileSharePath, RESERVED_USERNAMES, USERNAME_STAFF_WORDS,
} from '../../packages/core/src/username'
import { RESERVED_DISPLAY_NAMES } from '../../packages/core/src/displayName'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
}
const reason = (raw: unknown) => { const r = checkUsername(raw); return r.ok ? r.username : r.reason }
const message = (raw: unknown) => { try { return validateUsername(raw) } catch (e) { return (e as Error).message } }

console.log('\n§1 format')
check('3 characters', reason('abc'), 'abc')
check('2 characters', reason('ab'), 'invalid')
check('30 characters', reason('a'.repeat(30)), 'a'.repeat(30))
check('31 characters', reason('a'.repeat(31)), 'invalid')
check('every class', reason('a1._b'), 'a1._b')
check('underscore at both ends', reason('_ab_'), '_ab_')
check('🔒 at least one letter or digit', ['___', '_._', '_____', '_a_', '_1_'].map(reason), ['invalid', 'invalid', 'invalid', '_a_', '_1_'])
check('two dots in a row', reason('a..b'), 'invalid')
check('a dot first', reason('.abc'), 'invalid')
check('a dot last', reason('abc.'), 'invalid')
check('a hyphen', reason('a-b-c'), 'invalid')
check('a space inside', reason('a b c'), 'invalid')
check('an emoji', reason('abc🍷'), 'invalid')
check('not a string', reason(42), 'invalid')
check('empty', reason('  '), 'invalid')
check('digits only', reason('12345'), '12345')
check('looks like a public id (never parsed in the same slot)', reason('abcdefgh1234'), 'abcdefgh1234')

console.log('\n§2 the canonical form')
check('uppercase is stored lowercase', reason('Simon'), 'simon')
check('trimmed, one leading @ dropped', reason('  @Simon.F_1 '), 'simon.f_1')
check('two leading @', reason('@@simon'), 'invalid')
check('🔒 non-ASCII never aliases (ß → SS, ſ → S, Kelvin K → k, fullwidth)', ['straße', 'ſimon', 'Kate', 'ｓｉｍｏｎ'].map(reason), ['invalid', 'invalid', 'invalid', 'invalid'])
check('normalizeUsername: /@Simon opens @simon', normalizeUsername('@Simon'), 'simon')
check('normalizeUsername: malformed', [normalizeUsername('ab'), normalizeUsername('a..b'), normalizeUsername('straße'), normalizeUsername(null)], [null, null, null, null])
check('🔒 normalizeUsername takes a RESERVED name (reads are format-only)', normalizeUsername('verre'), 'verre')
check('usernameFromPath: case folds', usernameFromPath('Simon.F_1'), 'simon.f_1')
check('usernameFromPath: no @, no trim, no aliases', ['@simon', ' simon', 'simon ', 'ab', 'ſimon', 'simon/x'].map(usernameFromPath), [null, null, null, null, null, null])
check('usernameFromPath takes a reserved name', usernameFromPath('admin'), 'admin')

console.log('\n§3 messages (user-facing, no em dash)')
const messages = ['', 'ab', 'a'.repeat(31), 'a b', 'a..b', '.ab', 'admin', 42, undefined, '___'].map(message)
check('each failure has its own line', messages, [
  'username is required',
  'username must be at least 3 characters',
  'username must be at most 30 characters',
  'username can only use letters a to z, numbers, dots and underscores',
  'username cannot have two dots in a row',
  'username cannot start or end with a dot',
  'username is reserved',
  'username must be a string',
  'username is required',
  'username must contain a letter or a number',
])
check('no em dash in any message', messages.some(m => m.includes('—')), false)

console.log('\n§4 reserved')
check('the display-name set is reused, not copied', [...RESERVED_DISPLAY_NAMES].filter(w => !RESERVED_USERNAMES.has(w)), [])
check('route words, brand, staff', ['api', 'join', 'me', 'u', 'feed', 'you', 'place', 'producer', 'verre', 'gastro', 'everyone', 'settings'].map(isReservedUsername), Array(12).fill(true))
check('file-like names', ['robots.txt', 'favicon.ico', 'index.html'].map(isReservedUsername), [true, true, true])
check('lookalikes (D3): dots and underscores removed', ['v.e.r.r.e', '_admin_', 'support_', 'a_p_i', 'm.e', 'robotstxt', 'sign_in'].map(isReservedUsername), Array(7).fill(true))
check('the brand rule: ONLY `verre` and staff words', ['verre_official', 'teamverre', 'verre.support', 'verre_hq', 'verre_app', 'verremod', 'verre.support.hq', 'official_verre_team', 'verre_verre'].map(isReservedUsername), Array(9).fill(true))
check('verre is the French word for glass', ['unverredevin', 'verre.a.pied', 'verre_lover', 'verres', 'leverre'].map(isReservedUsername), Array(5).fill(false))
check('🔒 a staff word INSIDE another word is not the brand rule (narrowed 2026-11-14)', ['happyverre', 'apple_verre', 'verremodern', 'modeverre', 'verre.appellation', 'the_verre_app'].map(isReservedUsername), Array(6).fill(false))
check('…any other word lets a name through (accepted: watched and blocked by hand)', ['verre_official_ch', 'verre_support_team2', 'teamverre1'].map(isReservedUsername), [false, false, false])
check('🔒 names made ONLY of staff words are reserved too (ruled 2026-11-14)', ['official_support', 'admin.team', 'support_team', 'help.staff', 'teamsupport', 'hq_mod'].map(isReservedUsername), Array(6).fill(true))
check('…and the single words app, admins, administrators, moderators, mods', ['app', 'admins', 'administrators', 'moderators', 'mods', 'a_p_p'].map(isReservedUsername), Array(6).fill(true))
check('…a staff word with any other word passes', ['teamwork', 'apple', 'support_simon', 'security_team', 'help_desk', 'sysadmin', 'appetite'].map(isReservedUsername), Array(7).fill(false))
check('ordinary names', ['simon', 'mara.k', 'wine_lover', 'apiary', 'homer', 'teamwork'].map(isReservedUsername), Array(6).fill(false))
check('every staff word is covered', USERNAME_STAFF_WORDS.map(w => isReservedUsername(`verre_${w}`)), USERNAME_STAFF_WORDS.map(() => true))
check('reserved → its own reason', reason('Verre_Official'), 'reserved')

console.log('\n§5 search query')
check('partial and 2 characters pass', [usernameQuery('si'), usernameQuery('@Sim'), usernameQuery('a_b.')], ['si', 'sim', 'a_b.'])
check('a character no username holds → null', [usernameQuery('sim on'), usernameQuery('simön'), usernameQuery('a-b'), usernameQuery(''), usernameQuery('@'), usernameQuery(7)], [null, null, null, null, null, null])

console.log('\n§6 share path')
check('with a username', profileSharePath({ id: 'K7M2Q9X4B8RT', username: 'simon' }), '/@simon')
check('without one: the public-id path', [profileSharePath({ id: 'K7M2Q9X4B8RT', username: null }), profileSharePath({ id: 'K7M2Q9X4B8RT' })], ['/u/k7m2q9x4b8rt', '/u/k7m2q9x4b8rt'])
check('a reserved name shares like any other', profileSharePath({ id: 'K7M2Q9X4B8RT', username: 'verre' }), '/@verre')

console.log('\n§7 🔒 every route word is reserved')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The first URL segment of every route: `(group)` folders are descended, route
// FILES count like folders, `_layout`, `+not-found`, and dynamic segments
// don't, hyphens are dropped (a username can't hold one).
function firstSegments(dir: string, pageFiles: boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const isDir = statSync(full).isDirectory()
    const name = isDir ? entry : entry.replace(/\.(tsx?|jsx?)$/, '')
    if (isDir && /^\(.+\)$/.test(name)) { out.push(...firstSegments(full, pageFiles)); continue }
    if (name.startsWith('_') || name.startsWith('+') || name.startsWith('[')) continue
    if (!isDir && (!pageFiles || name === entry || name === 'index')) continue
    if (!isDir && !/\.(tsx?|jsx?)$/.test(entry)) continue
    out.push(name.replace(/-/g, '').toLowerCase())
  }
  return out
}
// Next: only folders are segments (page.tsx / layout.tsx / route.ts are not).
const web = firstSegments(join(ROOT, 'app'), false)
// Expo Router: a route FILE is a segment too.
const app = firstSegments(join(ROOT, 'apps/mobile/src/app'), true)
check('the walk finds the known routes (web)', ['api', 'join', 'legal', 'login', 'register', 'me', 'session', 'u'].filter(w => !web.includes(w)), [])
check('the walk finds the known routes (app)', ['about', 'attributions', 'feed', 'moments', 'you', 'soon', 'signin', 'signup'].filter(w => !app.includes(w)), [])
check('none is free to register', [...new Set([...web, ...app])].filter(w => !isReservedUsername(w)), [])
check('a reserved word is still well-formed where it can be', isUsernameFormat('api'), true)

console.log(failures === 0 ? '\nOK — username pins pass.' : `\nFAILED — ${failures} username pin(s).`)
process.exit(failures === 0 ? 0 : 1)
