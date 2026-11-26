// ── afterCommit coalescing pins (lib/afterCommit.ts) ──────────────────────
//
// The rate POST and the Reset start their post-COMMIT steps (touchWithMeta,
// last-seen, carousel unhide, badges) in the background. Auto-save sends up to
// a save a second per rater, so the steps are COALESCED per key: at most one
// run in flight plus one trailing run, the trailing one with the latest
// function. These pins drive the real module with deferred runs. No DB, no
// Redis, no network. § 7: a run that never settles is left behind at its
// deadline, so it cannot hold its key.
//
// Run: npx tsx scripts/tests/after-commit-units.ts

import { afterCommit, settleAfterCommit, afterCommitLimits } from '../../lib/afterCommit'

let failures = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`)
  else { failures++; console.log(`  ✗ ${name}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`) }
}
const tick = () => new Promise<void>(r => setImmediate(r))
function deferred() {
  let resolve!: () => void, reject!: (e: unknown) => void
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

async function main() {
  console.log('§ 1 the answer goes out first')
  {
    let ran = 0
    afterCommit('t', 'first', 'k', async () => { ran++ })
    check('nothing runs inside the caller\'s own tick', ran === 0, ran)
    await settleAfterCommit()
    check('it runs once, after', ran === 1, ran)
  }

  console.log('§ 2 one running + one trailing per key, the latest function')
  {
    const gates = [deferred(), deferred()]
    const log: string[] = []
    let live = 0, maxLive = 0
    const step = (name: string, i: number) => async () => {
      live++; maxLive = Math.max(maxLive, live); log.push(name)
      await gates[i].promise
      live--
    }
    afterCommit('t', 'burst', 'k', step('a', 0))
    await tick()
    check('the first run started', log.join() === 'a', log)
    for (const n of ['b', 'c', 'd', 'e']) afterCommit('t', 'burst', 'k', step(n, 1))
    await tick()
    check('no second run while the first is in flight', log.join() === 'a', log)
    gates[0].resolve()
    await tick()
    check('ONE trailing run, with the latest function', log.join() === 'a,e', log)
    gates[1].resolve()
    await settleAfterCommit()
    check('two runs for five requests', log.length === 2, log)
    check('never two at once on one key', maxLive === 1, maxLive)
  }

  console.log('§ 3 a request during the trailing run trails it')
  {
    const gates = [deferred(), deferred(), deferred()]
    const log: number[] = []
    let n = 0
    const step = () => { const i = n++; return async () => { log.push(i); await gates[i].promise } }
    afterCommit('t', 'chain', 'k', step())
    await tick()
    afterCommit('t', 'chain', 'k', step())
    gates[0].resolve()
    await tick()
    afterCommit('t', 'chain', 'k', step())
    gates[1].resolve()
    await tick()
    gates[2].resolve()
    await settleAfterCommit()
    check('every request that came in during a run is covered by a later run', log.join() === '0,1,2', log)
  }

  console.log('§ 4 keys are independent')
  {
    const gate = deferred()
    const log: string[] = []
    afterCommit('t', 'keys', 'A', async () => { log.push('A'); await gate.promise })
    afterCommit('t', 'keys', 'B', async () => { log.push('B') })
    afterCommit('t', 'other', 'A', async () => { log.push('other:A') })
    afterCommit('u', 'keys', 'A', async () => { log.push('u:A') })
    await tick()
    check('another key, label or scope runs at once beside an in-flight run', ['A', 'B', 'other:A', 'u:A'].every(x => log.includes(x)), log)
    gate.resolve()
    await settleAfterCommit()
  }

  console.log('§ 5 a failure is logged and does not stop the trailing run')
  {
    const errors: unknown[][] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    const gate = deferred()
    let trailing = 0
    try {
      afterCommit('t', 'fail', 'k', async () => { await gate.promise; throw new Error('boom') })
      await tick()
      afterCommit('t', 'fail', 'k', async () => { trailing++ })
      gate.resolve()
      await settleAfterCommit()
    } finally { console.error = orig }
    check('the failure is logged with its scope and label', errors.length === 1 && String(errors[0][0]).includes('[t] fail failed after commit'), errors.map(e => String(e[0])))
    check('the trailing run still ran', trailing === 1, trailing)
    let again = 0
    afterCommit('t', 'fail', 'k', async () => { again++ })
    await settleAfterCommit()
    check('the key is free again after a failure', again === 1, again)
  }

  console.log('§ 6 settleAfterCommit waits for trailing runs')
  {
    const gate = deferred()
    let done = 0
    afterCommit('t', 'settle', 'k', async () => { await gate.promise })
    await tick()
    afterCommit('t', 'settle', 'k', async () => { await tick(); done++ })
    setTimeout(() => gate.resolve(), 5)
    await settleAfterCommit()
    check('settled only after the trailing run finished', done === 1, done)
  }

  console.log('§ 7 a run that never settles is left behind at the deadline')
  {
    const errors: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errors.push(String(args[0])) }
    const saved = afterCommitLimits.deadlineMs
    afterCommitLimits.deadlineMs = 50
    let trailing = 0, after = 0
    try {
      afterCommit('t', 'stuck', 'k', () => new Promise<void>(() => {}))
      await tick()
      afterCommit('t', 'stuck', 'k', async () => { trailing++ })
      const t0 = Date.now()
      // Bounded, so a missing deadline fails here instead of hanging the job.
      await Promise.race([settleAfterCommit(), new Promise(r => setTimeout(r, 3000))])
      const waited = Date.now() - t0
      check('the stuck run is logged at its deadline', errors.some(e => e.includes('[t] stuck did not settle within 50 ms')), errors)
      check('…and the trailing run starts after it (the key is not held)', trailing === 1 && waited >= 40 && waited < 2000, { trailing, waited })
      afterCommit('t', 'stuck', 'k', async () => { after++ })
      await Promise.race([settleAfterCommit(), new Promise(r => setTimeout(r, 3000))])
      check('…and the key takes new runs', after === 1, after)
    } finally { console.error = orig; afterCommitLimits.deadlineMs = saved }
  }
}

main().then(() => {
  console.log(failures === 0 ? '\nOK: afterCommit coalescing pins all pass.' : `\nFAILED: ${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}, err => { console.error(err); process.exit(1) })
