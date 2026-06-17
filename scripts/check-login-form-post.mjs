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

// Scope: the web auth form components. A secret input anywhere here that sits in
// a method-less (or method="get") <form> is the leak surface.
//
// Deliberately narrow — and the other password-input sites are out of scope ON
// PURPOSE because they cannot leak this way today: components/me/AccountSettings.tsx
// (per-device/revoke-all/delete re-auth) and components/wine/AddWineModal.tsx (AI
// key) render type="password" inputs with NO name= and NO surrounding <form> (they
// submit via JS only), so a native GET fallback can't serialize them. ⚠️ If any of
// those ever grows a real <form> + name= (e.g. AccountSettings adding Enter-to-submit
// + a password manager name), widen SRC_GLOB to cover it — the named-secret detector
// below keeps the false-positive surface low even over a broader scope.
const SRC_GLOB = 'components/auth'

const files = execSync(`git ls-files "${SRC_GLOB}"`, { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(tsx|jsx)$/.test(f))

// Fail loud if scope is empty — almost certainly run from a subdir (git ls-files
// then returns subdir-relative paths that don't match the glob) or the auth
// folder was renamed/moved. Either way the gate would otherwise pass green while
// guarding nothing — back to safe-by-discipline. CI runs from the repo root.
// (Same idiom as check-identity-writes.mjs.)
if (files.length === 0) {
  console.error('check-login-form-post: ERROR — 0 in-scope files under components/auth. Run from the repo root (or the folder was renamed — update SRC_GLOB).')
  process.exit(1)
}

const errors = []

for (const file of files) {
  const raw = readFileSync(file, 'utf8')
  // Strip comments so a commented-out example can't trip (or mask) the check.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  // Only forms that actually carry a secret input are in scope. The leak class is
  // any named SECRET field — a name= that, on a GET fallback, would serialize a
  // credential into the URL: password (incl. newPassword/confirmPassword/
  // currentPassword), passwd/pwd/pw, plus the 2FA family (otp/totp/pin) and a
  // generic `secret`. We also OR-in a literal type="password" so an oddly-named
  // password input is still caught.
  //
  // Two detection signals because each alone has a hole: (a) NAME match — needed
  // because LoginForm types its field as type={showPw ? 'text' : 'password'} (a
  // show/hide toggle, no literal type="password"), so a type-only match would MISS
  // the very form we protect; (b) literal type="password" — catches a secret field
  // whose name isn't in the vocabulary above. This is a heuristic, not exhaustive:
  // a secret with a novel name AND a dynamic type would slip past — accepted, the
  // common idioms are covered and the cost of a miss is a code-review catch.
  const SECRET_NAME = /\bname=["'][^"']*(?:password|passwd|pwd|pw|secret|otp|totp|pin)[^"']*["']/i
  const LITERAL_PW_TYPE = /<input\b[^>]*\btype=["']password["']/i
  const hasNamedSecret = SECRET_NAME.test(src) || LITERAL_PW_TYPE.test(src)
  if (!hasNamedSecret) continue

  // Every <form …> in the file must declare method="post". (Anything other than
  // post — explicit get, or omitted method which DEFAULTS to get — leaks.)
  const formTags = src.match(/<form\b[^>]*>/g) || []
  for (const tag of formTags) {
    if (!/\bmethod=["']post["']/i.test(tag)) {
      errors.push(
        `${file}: a <form> hosting a named secret input is missing method="post" — ` +
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

console.log(`check-login-form-post: OK — ${files.length} auth-form files clean (every named-secret form is method="post").`)
