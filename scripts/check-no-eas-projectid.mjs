#!/usr/bin/env node
// CI gate: the EAS projectId must NOT be committed to apps/mobile/app.json.
//
// Why this exists — the projectId is an infra identifier linking this repo to a
// specific EAS account/project. `eas build` writes it into app.json LOCALLY on
// first run; harmless on disk, but this is a PUBLIC repo and the line shouldn't
// land in git. The committer here is usually an AI agent: it runs a build, sees
// app.json modified, and sweeps it into a commit with no judgment about what the
// line is — exactly how the staging-URL leak got ADDED earlier (2026-06). "Just
// don't commit it" is a habit, and agents don't have habits, so this gate makes
// it safe-by-construction: a PR that adds the projectId goes red and can't merge.
//
// Blocking it costs nothing functionally — app.json already carries "slug", so
// EAS resolves the project from slug + the logged-in account WITHOUT the id. The
// right handling is: let EAS add it on your machine, never commit that change.
// See apps/mobile/CLAUDE.md "Release placeholders".
//
// A dependency-free static check (reads the tracked file via `git ls-files`),
// matching scripts/check-mobile-design-tokens.mjs / check-identity-writes.mjs.
//
// Run: node scripts/check-no-eas-projectid.mjs   (exits 1 on violation)

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const TARGET = 'apps/mobile/app.json'

// Fail loud if the file isn't tracked — almost certainly run from a subdir (so
// `git ls-files` returns nothing for this path) or the app was moved/renamed.
// Either way the gate would otherwise pass green while guarding nothing — back
// to safe-by-discipline. CI runs from the repo root. (Same idiom as the other
// check-*.mjs gates' empty-scope guard.)
const tracked = execSync(`git ls-files "${TARGET}"`, { encoding: 'utf8' }).trim()
if (!tracked) {
  console.error(`check-no-eas-projectid: ERROR — ${TARGET} is not tracked here. Run from the repo root (or the app was moved — update TARGET).`)
  process.exit(1)
}

// Strip block + line comments so a commented example can't trip (or mask) it.
// app.json is JSON (no comments normally), but stay consistent with the family.
const src = readFileSync(TARGET, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

// EAS writes `extra.eas.projectId`. Match the key in any quoting/spacing so a
// reformat can't evade it. A bare `projectId` anywhere in app.json is the leak.
if (/["']projectId["']\s*:/.test(src)) {
  console.error('check-no-eas-projectid: FAILED — apps/mobile/app.json contains an EAS projectId.\n')
  console.error('  • The EAS projectId is an infra identifier and must NOT be committed to this public repo.')
  console.error('  • `eas build` adds it to app.json LOCALLY — discard that change, do not commit it.')
  console.error('  • EAS resolves the project from app.json "slug" + your logged-in account without it.')
  console.error('\nRemove the "extra.eas" block (or the projectId line) from app.json.')
  process.exit(1)
}

console.log('check-no-eas-projectid: OK — apps/mobile/app.json carries no committed EAS projectId.')
