#!/usr/bin/env node
// CI gate: the mobile app's converged design constants must stay in ONE home,
// not get re-inlined. An audit (2026-06) found the over-photo glass fill, the
// hero scrim, and the anchored-menu shadow each hand-rolled 4–8× and drifting
// (e.g. glass alpha 0.42/0.5/0.55). They were converged into lib/layout.ts
// (GLASS_FILL, HERO_SCRIM) + the elevation.menu token; this gate keeps them
// there so the next session reuses the constant instead of pasting a 5th copy.
// See apps/mobile/CLAUDE.md "Component catalog + reuse rule".
//
// A dependency-free static check (greps tracked sources via `git ls-files`),
// matching scripts/check-identity-writes.mjs / check-better-auth-config.mjs.
//
// Run: node scripts/check-mobile-design-tokens.mjs   (exits 1 on violation)

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const SRC_GLOB = 'apps/mobile/src'
// Canonical homes — the ONE place each literal is allowed to be written.
const ALLOW = {
  glass: 'apps/mobile/src/lib/layout.ts', // GLASS_FILL
  scrim: 'apps/mobile/src/lib/layout.ts', // HERO_SCRIM
  shadow: 'apps/mobile/src/theme/vero-tokens.js', // elevation.menu
}

// Scan js/jsx too, not just ts/tsx: the elevation.menu canonical home is a
// .js file (vero-tokens.js, exempted via ALLOW.shadow), and a future .js/.jsx
// source could otherwise re-inline shadowRadius: 24 or the rgba literals
// without this gate seeing it — which would quietly defeat the reuse contract.
const files = execSync(`git ls-files "${SRC_GLOB}"`, { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))

const errors = []

for (const file of files) {
  // Strip line + block comments so a commented example can't trip the check.
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  // 1. Over-photo glass fill — must come from GLASS_FILL, not a raw rgba.
  if (file !== ALLOW.glass && /rgba\(\s*20\s*,\s*18\s*,\s*15\s*,/.test(src)) {
    errors.push(`${file}: raw over-photo glass fill rgba(20,18,15,…) — import GLASS_FILL from @/lib/layout instead.`)
  }
  // 2. Hero scrim gradient — must come from HERO_SCRIM.
  if (file !== ALLOW.scrim && /rgba\(\s*15\s*,\s*12\s*,\s*10\s*,/.test(src)) {
    errors.push(`${file}: raw hero-scrim color rgba(15,12,10,…) — import HERO_SCRIM from @/lib/layout instead.`)
  }
  // 3. Anchored-dropdown shadow — must come from the elevation.menu token.
  //    The signature is shadowRadius 24 (its distinguishing value; sm/md/lg are
  //    3/12/28). Match with optional whitespace so formatting can't evade it.
  if (file !== ALLOW.shadow && /shadowRadius\s*:\s*24\b/.test(src)) {
    errors.push(`${file}: raw dropdown shadow (shadowRadius: 24) — use the elevation.menu token (see AnchoredMenu) instead.`)
  }
}

if (errors.length) {
  console.error('check-mobile-design-tokens: FAILED — re-inlined a converged design constant:\n')
  for (const e of errors) console.error('  • ' + e)
  console.error('\nThese constants live in one home so the same look is not built N ways. Reuse the constant/token.')
  process.exit(1)
}

console.log(`check-mobile-design-tokens: OK — ${files.length} files clean (glass fill, hero scrim, menu shadow all centralized).`)
