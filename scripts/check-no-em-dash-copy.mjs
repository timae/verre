#!/usr/bin/env node
// CI gate: no em dash (U+2014) in the mobile app's user-facing copy (root
// CLAUDE.md § Coding style: "that is ai and it should not look like ai").
// app/, components/ and packages/core/src carry the same rule in ESLint
// (eslint.config.mjs); apps/mobile has no ESLint config, so this is its twin.
//
// Same semantics as the ESLint rule: U+2014 in a string literal, template text
// or JSX text. A LONE dash (an empty-value placeholder) passes only when it is
// the whole value: the whole literal, or the only child of a JSX element; a
// fragment between substitutions or JSX expressions is prose. Exempt: comments
// (never parsed as strings), console.* arguments, tagged templates, and the
// attributions data file (its notes are parity-pinned with lib/attributions.ts;
// the licence statements are a licence obligation).
//
// Run: node scripts/check-no-em-dash-copy.mjs   (exits 1 on violation)

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import ts from 'typescript'

const SRC = 'apps/mobile/src'
const EXEMPT_FILES = new Set(['apps/mobile/src/lib/api/legal.ts'])
const DASH = '—'
const LONE = /^\s*—\s*$/

export function scan(src, fileName) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, /x$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const exempt = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isTaggedTemplateExpression(p)) return true
      if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ts.isIdentifier(p.expression.expression) && p.expression.expression.text === 'console') return true
    }
    return false
  }
  // The whole value: a literal by itself, or a JSX text that is its element's
  // only non-whitespace child. Template parts with substitutions never are.
  const whole = (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    || (ts.isJsxText(node) && ts.isJsxElement(node.parent)
      && node.parent.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces)).length === 1)
  const hits = []
  const visit = (node) => {
    const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node) ? node.text : null
    if (text !== null && text.includes(DASH) && !(LONE.test(text) && whole(node)) && !exempt(node)) {
      hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.trim().replace(/\s+/g, ' ').slice(0, 100) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

// Pins for the matcher itself: a weakened scan would still pass the real tree.
const D = DASH
const PINS = [
  [true, 'a.ts', `export const a = 'Saved ${D} nice'`],
  [true, 'a.ts', `export const a = 'x${D}y'`],
  [true, 'a.tsx', `export const C = () => <Text>Saved ${D} nice</Text>`],
  [true, 'a.tsx', `export const C = () => <Text accessibilityLabel='a ${D} b' />`],
  [true, 'a.ts', 'export const f = (n: number) => `Filters ' + D + ' ${n} active`'],
  [true, 'a.ts', 'export const f = (n: string) => `${n} ' + D + ' tap twice`'],
  [true, 'a.ts', 'export const f = (a: string, b: string) => `${a} ' + D + ' ${b}`'],
  [true, 'a.tsx', `export const C = ({ a, b }: { a: string; b: string }) => <Text>{a} ${D} {b}</Text>`],
  [false, 'a.tsx', `export const a = '${D}'\nexport const C = () => <Text>${D}</Text>`],
  [false, 'a.tsx', 'export const a = ` ' + D + ' `\nexport const C = () => <Text>\n  ' + D + '\n</Text>'],
  [false, 'a.ts', `// a comment ${D} fine\nexport const a = 1 /* and ${D} here */`],
  [false, 'a.ts', `export const f = (e: unknown) => console.warn('[x] failed ${D} retrying', e)`],
  [false, 'a.ts', 'declare const sql: (s: TemplateStringsArray) => string\nexport const q = sql`-- a ' + D + ' b`'],
  [false, 'a.ts', 'export const f = (a: string, b: string) => `${a} – ${b}`'],
]
const broken = PINS.filter(([flag, name, src]) => (scan(src, name).length > 0) !== flag)
if (broken.length) {
  console.error(`check-no-em-dash-copy: matcher pins FAILED (${broken.length}/${PINS.length}):`)
  for (const [flag, , src] of broken) console.error(`  expected ${flag ? 'flagged' : 'clean'}: ${src}`)
  process.exit(1)
}

const files = execSync(`git ls-files -- ${SRC}`, { encoding: 'utf8' }).split('\n')
  .filter((f) => /\.(tsx?|jsx?|mjs)$/.test(f) && !EXEMPT_FILES.has(f))
const violations = files.flatMap((f) => scan(readFileSync(f, 'utf8'), f).map((h) => `${f}:${h.line}  ${h.text}`))
if (violations.length) {
  console.error('check-no-em-dash-copy: em dash in user-facing copy (use a full stop, comma, colon or parentheses; root CLAUDE.md § Coding style):')
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}
console.log(`check-no-em-dash-copy: OK, ${files.length} mobile files clean, ${PINS.length} matcher pins pass.`)
