// Best-effort work AFTER a committed write, in the background (docs/dev/rating-saves.md
// § After COMMIT): the rate POST and the Reset answer the committed outcome at
// once and start `touchWithMeta`, `bumpLastSeen`, the carousel unhide and badge
// evaluation here, each caught and logged on its own. They can throw
// (lib/redis.ts) or STALL (the shared client queues commands while
// disconnected); awaited, a committed save would report failure.
//
// 🔒 COALESCED per key (`scope:label:<code or user>`): auto-save sends up to a
// save a second per rater, and each of these steps is a keyspace SCAN + EVAL
// or about ten statements. While a key's run is in flight, a new request only
// marks it to run ONCE MORE after (with the latest function); so at most one
// run plus one trailing run exist per key, however many saves arrive. The
// trailing run covers every save that came in meanwhile (each step re-reads
// its state). Pinned by scripts/tests/after-commit-units.ts and the
// rating-saves suite § 5.
//
// 🔒 Each run is raced against a DEADLINE (30 s): a step that never settles
// (a Redis command queued forever on a dead connection) is logged and left
// behind, and the loop goes on, so it cannot hold its key for the life of the
// process. The abandoned run may still finish later; every step is idempotent.
export const afterCommitLimits = { deadlineMs: 30_000 }   // a suite may lower it

type Slot = { done: Promise<void>; again: (() => Promise<unknown>) | null }
const slots = new Map<string, Slot>()

export function afterCommit(scope: string, label: string, key: string | number, run: () => Promise<unknown>): void {
  const id = `${scope}:${label}:${key}`
  const busy = slots.get(id)
  if (busy) { busy.again = run; return }
  const slot: Slot = { done: Promise.resolve(), again: null }
  slots.set(id, slot)
  slot.done = (async () => {
    // Never inside the caller's own tick: the answer goes out first.
    await Promise.resolve()
    let next: (() => Promise<unknown>) | null = run
    while (next) {
      slot.again = null
      try { await withDeadline(next(), scope, label, key) } catch (err) { console.error(`[${scope}] ${label} failed after commit`, { key, err }) }
      next = slot.again
    }
    slots.delete(id)
  })()
}

function withDeadline(run: Promise<unknown>, scope: string, label: string, key: string | number): Promise<unknown> {
  const ms = afterCommitLimits.deadlineMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => { console.error(`[${scope}] ${label} did not settle within ${ms} ms after commit; left behind`, { key }); resolve() }, ms)
  })
  return Promise.race([run, expired]).finally(() => clearTimeout(timer))
}

// Test seam (scripts/tests): resolves once every step started so far has
// settled, trailing runs included, so a suite that watches Redis (MONITOR) or
// reads TTLs right after a write is not confounded by the write's own
// background refresh.
export async function settleAfterCommit(): Promise<void> {
  while (slots.size) await Promise.allSettled([...slots.values()].map(s => s.done))
}
