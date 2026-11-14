// ── Pins for the app's username UI rules (usernames, UI half) ────────────────
//
// The pure pieces behind the screens: where the profile name sits once the
// `@username` line is under it (apps/mobile/src/components/profile/
// coverGeometry.ts), the on-phone person search (lib/search.ts
// `matchesPerson`, the server's `/api/users/search` rules), what the Username
// field keeps of what you type, and Edit Profile's "quiet until it matters"
// limit line (lib/usernameCopy.ts). No React, no DB.
//
// Run: npx tsx scripts/tests/username-ui-units.ts

import { COVER_SPEC, FONT, NAME_LIFT, PLAIN_SPEC, coverLines, curveLeft, fitProfileName, plainLines } from '../../apps/mobile/src/components/profile/coverGeometry'
import { matchesPerson } from '../../apps/mobile/src/lib/search'
import { changeAgainText, typedUsername, usernameQuotaLine } from '../../apps/mobile/src/lib/usernameCopy'

let failures = 0
const near = (a: number, b: number) => Math.abs(a - b) < 0.01
function check(name: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  ok  ${name}`); return }
  failures++
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
}

console.log('§1 the cover name without a username: as before')
{
  const ring = { nameLeft: 130, photoCx: 66, photo: 104 }
  const base = { fs: 30, lineH: 32, scale: 1, avail: 240, min: 22, ring }
  const one = fitProfileName({ ...base, w: 180, splits: [] })
  check('a short name: one line, full size, no indent', one.lines === 1 && one.fontSize === 30 && one.indent === 0, JSON.stringify(one))
  const two = fitProfileName({ ...base, w: 420, splits: [{ w1: 150, w2: 262 }, { w1: 262, w2: 150 }] })
  check('a long name: two lines, line 1 hugs the ring, line 2 does not', two.lines === 2 && two.indent < 0 && two.indent2 === 0, JSON.stringify(two))
  void NAME_LIFT
}

// The fit as it was on `main` before usernames, frozen here as the reference
// (apps/mobile/src/components/profile/coverGeometry.ts at 10a8bfb..d3d4bec).
type OldFit =
  | { lines: 1; fontSize: number; wrap: boolean }
  | { lines: 2; fontSize: number; indent: number; split: number };

function fitProfileNameBefore(m: {
  fs: number; w: number; splits: { w1: number; w2: number }[]; lineH: number; scale: number;
  avail: number; min: number; ring?: { nameLeft: number; photoCx: number; photo: number };
}): OldFit {
  const { fs, w, splits, lineH, scale, avail, min: MIN, ring } = m;
  if (w <= avail + 1) return { lines: 1, fontSize: fs, wrap: false };
  for (let f = fs - 1; f >= fs - 4; f--) if ((w * f) / fs <= avail + 1) return { lines: 1, fontSize: f, wrap: false };
  if (splits.length === 0) {
    for (let f = fs - 5; f >= MIN; f--) if ((w * f) / fs <= avail + 1) return { lines: 1, fontSize: f, wrap: false };
    return { lines: 1, fontSize: MIN, wrap: true };
  }
  // Line 1's indent at size f: the ring circle (photo radius + 15) at line 1's
  // baseline height, measured from the photo centre (the sheet edge, NAME_LIFT
  // below the name block).
  const indentAt = (f: number) => {
    if (!ring) return 0;
    const { nameLeft, photoCx, photo } = ring;
    const R = photo / 2 + 15;
    const k = f / fs;
    const dy = NAME_LIFT + lineH * k + 0.24 * f * scale;
    const x = dy < R ? photoCx + Math.sqrt(R * R - dy * dy) : photoCx - photo / 2;
    return Math.min(0, x - nameLeft);
  };
  for (let f = fs; f >= MIN; f--) {
    const k = f / fs, indent = indentAt(f);
    for (let i = 0; i < splits.length; i++) {
      if (splits[i].w1 * k <= avail - indent + 1 && splits[i].w2 * k <= avail + 1) return { lines: 2, fontSize: f, indent, split: i };
    }
  }
  // Nothing fits even at `min`: the break with the smallest overflow (the
  // longer line truncates).
  const k = MIN / fs, indent = indentAt(MIN);
  let best = 0, bestOver = Infinity;
  splits.forEach((sp, i) => {
    const over = Math.max(sp.w1 * k - (avail - indent), sp.w2 * k - avail);
    if (over < bestOver) { bestOver = over; best = i; }
  });
  return { lines: 2, fontSize: MIN, indent, split: best };
}

console.log('\n§1b without a username the fit is the old one, over a grid')
{
  let n = 0, diff = 0, first = ''
  for (const ring of [undefined, { nameLeft: 130, photoCx: 66, photo: 104 }, { nameLeft: 151, photoCx: 73, photo: 118 }]) {
    for (const scale of [1, 1.35, 1.9]) for (const avail of [150, 215, 262]) for (const min of [17, 22]) for (const fs of [23, 30, 34]) {
      for (let w = 60; w <= 720; w += 23) {
        for (const splits of [[], [{ w1: w * 0.3, w2: w * 0.68 }], [{ w1: w * 0.22, w2: w * 0.76 }, { w1: w * 0.55, w2: w * 0.43 }, { w1: w * 0.8, w2: w * 0.18 }]]) {
          const m = { fs, w, splits, lineH: Math.round(fs * 1.05 * scale), scale, avail, min, ring }
          const was = fitProfileNameBefore(m), now = fitProfileName(m)
          const same = was.lines === now.lines && was.fontSize === now.fontSize
            && (was.lines === 1 ? now.lines === 1 && was.wrap === now.wrap && now.indent === 0 : now.lines === 2 && was.split === now.split && was.indent === now.indent && now.indent2 === 0)
          n++
          if (!same && diff++ === 0) first = JSON.stringify({ m, was, now })
        }
      }
    }
  }
  check(`${n} inputs: same lines, size, break and indent as before`, diff === 0, `${diff} differ, first: ${first}`)
}

console.log('\n§2 the cover name with a username under it (COVER_SPEC, photo 104)')
{
  const cx = 66, r = 52
  const nameRise = COVER_SPEC.handleAboveEdge + COVER_SPEC.nameToHandle // the name's baseline above the photo's centre
  const nameLeft = cx + r + COVER_SPEC.nameGap
  const ring = { nameLeft, photoCx: cx, photo: 104, gap: COVER_SPEC.nameGap, maxShift: 26 }
  const base = { fs: 30, lineH: 32, scale: 1, avail: 240, min: 22, ring, anchor: { dy: nameRise } }
  const one = fitProfileName({ ...base, w: 180, splits: [] })
  const edgeAt = (dy: number) => cx + Math.sqrt(r * r - dy * dy) // the photo's round edge at a height
  check('one line: its left edge sits 13 from the photo\'s round edge at its baseline (tuned from the spec\'s 11.5)', one.lines === 1 && near(nameLeft + one.indent - edgeAt(nameRise), 13), JSON.stringify(one))
  const handleLeft = curveLeft(cx, r, COVER_SPEC.handleGap, COVER_SPEC.handleAboveEdge + FONT.cap * 13, COVER_SPEC.handleAboveEdge)
  check('the handle sits 12.5 from the edge at ITS baseline, a little right of the name', near(handleLeft - edgeAt(COVER_SPEC.handleAboveEdge), 12.5) && handleLeft > nameLeft + one.indent && handleLeft - (nameLeft + one.indent) < 12, String(handleLeft))
  const wide = fitProfileName({ ...base, w: 240 - one.indent, splits: [] })
  check('the room the shift frees counts toward the fit', wide.lines === 1 && wide.fontSize === 30, JSON.stringify(wide))
  const two = fitProfileName({ ...base, w: 460, splits: [{ w1: 150, w2: 300 }, { w1: 262, w2: 190 }] })
  check('two lines: the lower keeps the same gap, the upper (above the photo\'s top) stops at maxShift', two.lines === 2 && near(two.indent2, one.indent) && two.indent === -26, JSON.stringify(two))
  const small = fitProfileName({ ...base, w: 262, splits: [] })
  check('a shrunk name keeps its baseline, so its edge barely moves', small.lines === 1 && small.fontSize < 30 && near(small.indent, one.indent), JSON.stringify(small))
}

console.log('\n§3 without a cover (PLAIN_SPEC, photo 104): every line follows the circle')
{
  const r = 52, gap = PLAIN_SPEC.gap, fs = Math.round(30 * PLAIN_SPEC.nameSize)
  const nameB = PLAIN_SPEC.capTop + FONT.cap * fs // y of the name's baseline from the photo's top
  const ring = { nameLeft: 104 + gap, photoCx: r, photo: 104, gap, maxShift: 26 }
  const base = { fs, lineH: 30, scale: 1, avail: 220, min: 19, ring, anchor: { dy: r - nameB }, maxLines: 1 as const }
  const one = fitProfileName({ ...base, w: 150, splits: [] })
  check('the name is 26pt and sits 15 from the round edge at its baseline', fs === 26 && one.lines === 1 && near(ring.nameLeft + one.indent - (r + Math.sqrt(r * r - (r - nameB) ** 2)), 15), JSON.stringify(one))
  const long = fitProfileName({ ...base, w: 900, splits: [{ w1: 400, w2: 490 }] })
  check('one line only: a long name shrinks to the floor and is then cut, never wrapped', long.lines === 1 && long.fontSize === 19 && !long.wrap, JSON.stringify(long))
  const handleB = nameB + PLAIN_SPEC.nameToHandle, pillTop = handleB + PLAIN_SPEC.handleToPill, countsTop = pillTop + 24 + PLAIN_SPEC.pillToFriends
  const at = (top: number, bottom: number) => curveLeft(r, r, gap, r - top, r - bottom)
  const [n, h, p, c] = [ring.nameLeft + one.indent, at(handleB - FONT.cap * 13, handleB), at(pillTop, pillTop + 24), at(countsTop, countsTop + 20)]
  check('name < handle (nearer the middle), pill beside the middle, friends line tucked back under the curve', n < h && c < p && c < n && h <= 104 + gap && p <= 104 + gap, JSON.stringify([n, h, p, c]))
  check('the four lines fill the photo\'s height (104) to within a few points', Math.abs(countsTop + 20 - 104) < 6, String(countsTop + 20))
}

console.log('\n§3a the design spec as the components lay it out (coverLines, plainLines)')
{
  const c = coverLines(104, 1)
  check('cover: handle baseline 8.5 above the edge, the pill\'s top 8.5 below it, name 19.3 above the handle', near(c.handleRise, 8.5) && near(c.pillDrop, 8.5) && near(c.nameRise - c.handleRise, 19.3), JSON.stringify(c))
  const big = coverLines(118, 1.5)
  check('cover: it scales with the photo, and the name\'s lead also with the text', near(big.handleRise, 8.5 * 118 / 104) && near(big.pillDrop, big.handleRise) && near(big.nameRise - big.handleRise, 19.3 * (118 / 104) * 1.5), JSON.stringify(big))
  const p = plainLines({ photo: 104, textScale: 1, nameSize: 26, handleSize: 13, pillH: 24, countsH: 20, withStat: true })
  check('no cover: capitals 8 below the photo\'s top', near(p.nameB - FONT.cap * 26, 8), String(p.nameB))
  check('no cover: name → handle 21.3, handle → pill top 11.5, pill → friends line 4', near(p.handleB - p.nameB, 21.3) && near(p.pillTop - p.handleB, 11.5) && near(p.countsTop - (p.pillTop + 24), 4), JSON.stringify(p))
  const edge = (y: number) => 52 + Math.sqrt(52 * 52 - (52 - y) ** 2) // the photo's round edge at a y
  check('no cover: handle and friends line 15 from the round edge at their nearest point, the pill 12.5 (tuned)', near(p.handleLeft - edge(p.handleB), 15) && near(p.pillLeft - edge(p.pillTop), 12.5) && near(p.countsLeft - edge(p.countsTop), 15), JSON.stringify(p))
  const two = plainLines({ photo: 104, textScale: 1, nameSize: 26, handleSize: 13, pillH: 24, countsH: 20, withStat: false })
  check('blocked / private (no pill): the two lines centred on the photo, no taller than it', near((two.nameB - FONT.cap * 26) + two.handleB, 104) && two.height === 104, JSON.stringify(two))
}

console.log('\n§3b curveLeft: the gap to a circle')
{
  check('above the centre: measured at the bottom of the ink (the baseline)', near(curveLeft(0, 50, 10, 40, 30), Math.sqrt(50 * 50 - 30 * 30) + 10))
  check('below the centre: measured at the top of the ink', near(curveLeft(0, 50, 10, -30, -44), Math.sqrt(50 * 50 - 30 * 30) + 10))
  check('across the centre line: the full radius', curveLeft(0, 50, 10, 6, -6) === 60)
  check('clear of the circle: just the gap from its centre', curveLeft(0, 50, 10, 80, 60) === 10)
}

console.log('\n§4 the on-phone person search (the server\'s rules)')
{
  const anna = { name: 'Anna Meier', username: 'simmental' }
  const simon = { name: 'Simon Fehr', username: null }
  check('a name matches', matchesPerson(simon, 'simon'))
  check('a username substring matches', matchesPerson(anna, 'mment'))
  check('case and one leading @ are forgiven', matchesPerson(anna, '@SIM'))
  check('@ matches the username ONLY', !matchesPerson(simon, '@simon'))
  check('@ needs two characters after it, like the server', !matchesPerson(anna, '@s') && matchesPerson(anna, '@si') && matchesPerson(anna, 's'))
  check('@ never falls back to the name', !matchesPerson({ name: 'sim on', username: 'x.y' }, '@sim on'))
  check('a query with a space can only match names', matchesPerson(anna, 'anna m') && !matchesPerson(anna, 'sim mental'))
  check('_ is a plain character, not a wildcard', !matchesPerson({ name: 'Bo', username: 'a.b' }, 'a_b'))
  check('someone without a username never matches by it', !matchesPerson(simon, 'null'))
  check('an empty query keeps everyone', matchesPerson(simon, '  '))
}

console.log('\n§5 what the Username field keeps')
{
  check('capitals are lowercased, not reported', typedUsername('Lena.B') === 'lena.b')
  check('the @ in front is the field\'s, not the name\'s', typedUsername('@lena') === 'lena' && typedUsername('@@lena') === 'lena')
  check('anything else stays for the validator to name', typedUsername('lena b') === 'lena b')
  check('non-ASCII is not case-mapped (ß must not become ss)', typedUsername('Straße') === 'straße')
}

console.log('\n§6 Edit Profile\'s limit line: quiet until the last two')
{
  const s = (changesLeft: number, nextChangeAt: string | null = null, username: string | null = 'lena') => usernameQuotaLine({ username, changesLeft, nextChangeAt }, 'en-GB')
  check('5, 4, 3 left: nothing', [5, 4, 3].every((n) => s(n).text === null && !s(n).locked))
  check('2 left: the count', s(2).text === '2 changes left for now.' && !s(2).locked)
  check('1 left: the last one', s(1).text === 'This is your last change for now.' && !s(1).locked)
  const year = new Date().getFullYear()
  const locked = s(0, `${year}-12-24T10:00:00.000Z`)
  check('none left: locked, with the date', locked.locked && locked.text === 'You can change it again on 24 Dec.', String(locked.text))
  check('another year carries the year', changeAgainText(`${year + 1}-02-12T10:00:00.000Z`, 'en-GB') === `You can change it again on 12 Feb ${year + 1}.`)
  check('no date from the server: still a sentence', s(0).locked && s(0).text === 'You can’t change it again yet.')
  check('no username yet: a first choice is free, nothing shown', s(0, null, null).text === null && !s(0, null, null).locked)
}

console.log(failures === 0 ? '\nOK — username UI pins pass.' : `\nFAILED — ${failures} username UI pin(s).`)
process.exit(failures === 0 ? 0 : 1)
