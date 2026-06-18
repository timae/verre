#!/usr/bin/env node
// Partial CI gate for mobile Dynamic Type surfaces.
//
// The mobile app centralizes text caps and container growth in
// apps/mobile/src/lib/layout.ts. This check keeps new screens from bypassing
// the grep-able parts of that policy. JSX tree invariants such as every nested
// capped VText and every possible fixed-height text container still need review
// or a future AST pass; this script deliberately says "partial" in its OK text.

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const SRC_GLOB = 'apps/mobile/src'
const ALLOW = {
  policy: 'apps/mobile/src/lib/layout.ts',
}

const files = execSync(`git ls-files "${SRC_GLOB}"`, { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

const extractSelfClosingTags = (src, tagName) => {
  const tags = []
  const re = new RegExp(`<${tagName}\\b`, 'g')
  let match
  while ((match = re.exec(src)) !== null) {
    let i = match.index
    let quote = null
    while (i < src.length) {
      const ch = src[i]
      const next = src[i + 1]
      if (quote) {
        if (ch === quote && src[i - 1] !== '\\') quote = null
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
      } else if (ch === '/' && next === '>') {
        tags.push(src.slice(match.index, i + 2))
        re.lastIndex = i + 2
        break
      } else if (ch === '>') {
        re.lastIndex = i + 1
        break
      }
      i += 1
    }
  }
  return tags
}

const containsTextChild = (src, openBraceIndex) => {
  const slice = src.slice(openBraceIndex)
  const close = slice.indexOf('</')
  const end = close === -1 ? Math.min(slice.length, 1200) : close
  return /<(?:VText|Text|TextInput|BottomSheetTextInput)\b/.test(slice.slice(0, end))
}

const errors = []

for (const file of files) {
  const raw = readFileSync(file, 'utf8')
  const src = stripComments(raw)
  // Fixed-format single-line controls (e.g. the score numeral) may legitimately
  // pin a lineHeight. An author opts a SPECIFIC input out of the single-line-
  // lineHeight check with a `dynamic-type-ok: fixed-format` comment in that
  // input's prop block; device-verify before adding one. The marker is scoped
  // per-input (checked against the raw, comment-preserving window below) so it
  // can't silence a second, genuinely-buggy input in the same file.

  if (file !== ALLOW.policy && /maxFontSizeMultiplier\s*(?:=|:)/.test(src)) {
    errors.push(`${file}: inline maxFontSizeMultiplier — use VText surface="…" or phone.surface("…").textProps from @/lib/layout.`)
  }

  if (file !== ALLOW.policy && /\bCARD_TEXT_MAX_SCALE\b/.test(src)) {
    errors.push(`${file}: local carousel text cap — use the shared carousel surface instead.`)
  }

  const heightRe = /\bheight\s*:\s*(?:36|44|52|control\.h(?:Sm|Lg)?)\b/g
  let h
  while ((h = heightRe.exec(src)) !== null) {
    if (containsTextChild(src, h.index)) {
      errors.push(`${file}: fixed height wraps scalable text near "${h[0]}" — use a surface minHeight plus scaled padding, or document a fixed-format surface.`)
      break
    }
  }

  const rawInputTags = [
    ...extractSelfClosingTags(src, 'TextInput'),
    ...extractSelfClosingTags(src, 'BottomSheetTextInput'),
  ]
  for (const tag of rawInputTags) {
    if (
      /phone\.text\(\s*['"]body['"]\s*\)|fontSize\s*:\s*phone\.text\(\s*['"]body['"]\s*\)\.fontSize/.test(tag) &&
      !/\{\s*\.\.\.[A-Za-z0-9_]+(?:Surface)?\.textProps\s*\}/.test(tag)
    ) {
      errors.push(`${file}: TextInput uses scalable body text without {...surface.textProps}.`)
      break
    }
  }

  // A SINGLE-LINE input must not carry an explicit lineHeight: iOS biases the
  // glyph down inside a paragraph line box, so the text sits low and descenders
  // clip the bottom edge. Single-line fields auto-center within `height`. The
  // `multiline` prop is the discriminator — multiline fields legitimately set a
  // lineHeight (and textAlignVertical:'top'). The spread form `...phone.text(…)`
  // also carries a lineHeight; a <TextField> `style` override re-introduces one
  // the component dropped.
  //
  // The tag extractor stops on the first `>` (it appears inside `=>` handlers),
  // so it can't bound an input tag with inline arrow props. Instead scan a
  // forward window from each input open-tag for a lineHeight (inline or spread)
  // that isn't gated by a `multiline` prop in the same window.
  //
  // Scan `raw` (NOT `src`): the per-input opt-out marker is a comment, so it
  // must be visible here, and matching on `raw` keeps the marker, multiline,
  // and lineHeight checks in one coordinate space.
  const INPUT_OPEN = /<(TextInput|BottomSheetTextInput|TextField)\b/g
  let m
  while ((m = INPUT_OPEN.exec(raw)) !== null) {
    // Skip the `useRef<TextInput>(null)` type-parameter false match — a real JSX
    // tag is followed by whitespace/`{`/a prop, never `>(`.
    if (/^<TextInput>\s*\(/.test(raw.slice(m.index))) continue
    // Window = from the open tag to the next sibling close-tag-ish boundary.
    // 2200 chars covers even a heavily-styled input's full prop block (the score
    // numeral's is ~1760); a smaller window silently skipped it (false negative).
    const win = raw.slice(m.index, m.index + 2200)
    const propEnd = win.search(/\/>|>\s*</)
    const props = propEnd === -1 ? win : win.slice(0, propEnd + 2)
    if (/\bmultiline\b/.test(props)) continue
    // Per-input opt-out: marker must sit in THIS input's own prop window.
    if (/dynamic-type-ok:\s*fixed-format/.test(props)) continue
    if (/\blineHeight\s*:/.test(props) || /\.\.\.phone\.text\(/.test(props)) {
      errors.push(`${file}: single-line ${m[1]} sets an explicit lineHeight (inline or via ...phone.text(...)) near "${props.slice(0, 40).replace(/\s+/g, ' ')}…" — drop it; iOS auto-centers within height and a line box bottom-clips. Multiline fields are exempt via the multiline prop.`)
      break
    }
  }
}

if (errors.length) {
  console.error('check-mobile-dynamic-type: FAILED — Dynamic Type surface policy was bypassed:\n')
  for (const e of errors) console.error('  • ' + e)
  console.error('\nText caps and container growth must come from the same surface object in @/lib/layout.')
  process.exit(1)
}

console.log(`check-mobile-dynamic-type: OK — ${files.length} files pass partial static checks (inline caps, text-wrapping fixed heights, TextInput surface props). Nested capped VText and other layout intent remain review-backed.`)
