// Fixture usernames, GENERATED PER RUN (docs/dev/proposals/usernames.md § 12).
// The suites clean up with `DELETE FROM users` and are re-run against a
// persistent local database, and the delete trigger HOLDS a deleted account's
// name for 14 days: a fixed fixture name would be refused from the second run
// on. 30 characters or fewer, `[a-z0-9_]` only (a run TAG like `yp-<ms>` has a
// hyphen and can't be used). The stamp is this process's start in base 36 plus
// a random tail, so two suites started in the same millisecond don't collide.
// A RESERVED name that is still unique per run (an operator assigns it in the
// suites): the brand rule ignores dots and underscores, so `verrehq` with 0 to
// 3 underscores in each of its six gaps is always reserved (4096 spellings, at
// most 25 characters). Callers release a leftover hold on it first.
export function reservedFixtureUsername() {
  const letters = 'verrehq'.split('')
  return letters.map((ch, i) => (i === letters.length - 1 ? ch : ch + '_'.repeat(Math.floor(Math.random() * 4)))).join('')
}

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
let seq = 0
export function fixtureUsername(prefix = 'fx') {
  const name = `${prefix}_${RUN}_${(++seq).toString(36)}`
  if (!/^[a-z0-9._]{3,30}$/.test(name)) throw new Error(`fixtureUsername: "${name}" is not a valid username (shorten the prefix)`)
  return name
}
