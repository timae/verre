#!/usr/bin/env node
// CI gate: every web auth form that carries a NAMED credential input must set
// method="post" on its <form>.
//
// Why this exists — a real leak we hit (2026-06): the login <form> had no
// `method`, and its inputs were `name="email"` / `name="password"`. The submit
// is JS-controlled (handleSubmit preventDefaults → signIn() POST), so the happy
// path never leaks. BUT a method-less form defaults to method="get", and if the
// JS handler never runs — a hydration race or a ChunkLoadError, both observed —
// the browser does a NATIVE submit and serializes the named inputs into the URL:
//   /login?email=…&password=…
// i.e. the password in cleartext in the address bar, server access logs, browser
// history, and the Referer header. method="post" forces that no-JS fallback into
// the request BODY instead, closing the leak without touching the happy path.
// The `name=` attrs can't simply be removed — they're load-bearing for the
// browser password manager (see components/auth/LoginForm.tsx storeCredential).
// So the invariant we enforce is: named password input ⇒ method="post".
//
// A dependency-free static check (greps tracked sources via `git ls-files`),
// matching scripts/check-identity-writes.mjs / check-mobile-design-tokens.mjs.
//
// Run: node scripts/check-login-form-post.mjs   (exits 1 on violation)

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// Scope: the web auth form components. A password input anywhere here that sits
// in a method-less (or method="get") form is the leak surface.
const SRC_GLOB = 'components/auth'

const files = execSync(`git ls-files "${SRC_GLOB}"`, { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(tsx|jsx)$/.test(f))

const errors = []

for (const file of files) {
  const raw = readFileSync(file, 'utf8')
  // Strip comments so a commented-out example can't trip (or mask) the check.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  // Only forms that actually carry a credential input are in scope. A named
  // password input is the thing that serializes a secret into a GET URL.
  const hasNamedPassword = /<input\b[^>]*\bname=["']password["']/.test(src)
  if (!hasNamedPassword) continue

  // Every <form …> in the file must declare method="post". (Anything other than
  // post — explicit get, or omitted method which DEFAULTS to get — leaks.)
  const formTags = src.match(/<form\b[^>]*>/g) || []
  for (const tag of formTags) {
    if (!/\bmethod=["']post["']/i.test(tag)) {
      errors.push(
        `${file}: a <form> hosting name="password" is missing method="post" — ` +
        `a JS-bypassed (hydration/chunk-load failure) native submit would GET the ` +
        `credentials into the URL. Add method="post".`
      )
    }
  }
}

if (errors.length) {
  console.error('check-login-form-post: FAILED — credential form can leak to the URL on a no-JS fallback:\n')
  for (const e of errors) console.error('  • ' + e)
  console.error('\nSet method="post" so a native (JS-bypassed) submit POSTs the body instead of GETting the query string.')
  process.exit(1)
}

console.log(`check-login-form-post: OK — ${files.length} auth-form files clean (every named-password form is method="post").`)
