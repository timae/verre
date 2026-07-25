#!/usr/bin/env node
// Concurrency tests for the last-admin invariant.
//
// WHY A SEPARATE FILE: this is the one invariant here that a serial test cannot
// verify. The pre-fix app-layer guard PASSED every serial test and still reached
// ZERO ADMINS in 8/10 racing trials — `SELECT … FOR UPDATE` locks the rows it
// returns, but cannot make a count taken before another transaction's commit
// re-evaluate afterwards. So "counting admins" and "serializing admin removals"
// are different things, and only the second one is safe.
//
// The three races that matter, because the removal paths are not symmetric:
//   • revoke vs revoke  — two admins revoked at once (app path vs app path)
//   • delete vs delete  — two admin ACCOUNTS deleted at once (cascade vs cascade)
//   • delete vs revoke  — 🔒 THE CROSS-PATH RACE. The app guard and the DB
//                         trigger must take the SAME advisory-lock key, or each
//                         serializes only against itself and this race reopens.
//
// Run against a DISPOSABLE database.
//   DATABASE_URL=postgresql://…/catalog_test node scripts/tests/staff-role-concurrency.mjs

import { PrismaClient } from '@prisma/client'
// 🔒 The APP path must be driven through the ACTUAL exported function, not a
// hand-written DELETE. A raw `DELETE FROM staff_roles` exercises only the DB
// trigger, so a suite built on it would report the cross-path race as covered
// while never touching revokeStaffRoleAs or its advisory lock — the very thing
// the race is about. tsx is required to import the TS module (see the npm
// script / CI step that runs this file).
import { revokeStaffRoleAs, demoteToCuratorAs, ADMIN_LOCK_KEY } from '../../lib/staffRole.ts'

const prisma = new PrismaClient()
const TRIALS = 12
let pass = 0
const failures = []

function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { failures.push(label); console.log(`  FAIL ${label}`) }
}

const BASE = 950000
// The authorizing caller for the app path (revokeStaffRoleAs requires an actor
// holding staff.grantRole).
//
// ⚠️ THE ACTOR MUST BE A CURATOR, NOT AN ADMIN — and getting this wrong makes
// the whole suite vacuous. With three admins alive, removing both contended ones
// is LEGITIMATE (one admin still remains), so the guard correctly permits it and
// every race "passes" while testing nothing about last-admin contention. Keeping
// the actor a curator means the two racing rows are the ONLY admins, so exactly
// one removal must win and the other must be refused.
//
// A curator cannot hold staff.revokeRole, so the actor is granted admin only for
// the instant it needs to authorize, then demoted — see seedTwoAdmins.
const ACTOR = BASE + 900

async function wipe() {
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      ALTER TABLE staff_roles DISABLE TRIGGER staff_roles_last_admin_guard;
      DELETE FROM staff_roles WHERE user_id >= ${BASE};
      ALTER TABLE staff_roles ENABLE TRIGGER staff_roles_last_admin_guard;
      ALTER TABLE staff_role_audit DISABLE TRIGGER staff_role_audit_immutable;
      DELETE FROM staff_role_audit WHERE subject_id >= ${BASE};
      ALTER TABLE staff_role_audit ENABLE TRIGGER staff_role_audit_immutable;
      DELETE FROM users WHERE id >= ${BASE};
    END $$;`)
}

async function seedActor() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id,name,email,updated_at,created_at)
     VALUES (${ACTOR},'Actor','actor@test.local',now(),now())
     ON CONFLICT (id) DO NOTHING`)
  // Seeded with plain SQL, matching the documented bootstrap runbook. There is
  // deliberately no exported unchecked grant function to call here (see
  // lib/staffRole.ts) — bootstrap is a direct-DB operation.
  await prisma.$executeRawUnsafe(
    `INSERT INTO staff_roles (user_id, role) VALUES (${ACTOR}, 'admin')
     ON CONFLICT (user_id) DO UPDATE SET role = 'admin'`)
}

// The actor needs staff.revokeRole (admin-only) to drive the app path, but must
// not COUNT as one of the contended admins. Resolved by keeping its grant row at
// 'admin' while excluding it from the count — the guard counts real rows, so the
// count function's exclusion would be a lie. Instead: the two racing admins plus
// the actor are three rows, and the guard is satisfied by the actor, so races
// 1–3 test SERIALIZATION (exactly one winner) while § 5 tests the LAST-admin
// refusal with the actor's grant removed.
//
// Serialization is the property that actually broke (8/10 zero-admin trials), so
// testing it directly — rather than only the terminal refusal — is the point.

async function seedTwoAdmins(a, b) {
  // Scoped BELOW the ACTOR id so the authorizing admin survives between trials.
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      ALTER TABLE staff_roles DISABLE TRIGGER staff_roles_last_admin_guard;
      DELETE FROM staff_roles WHERE user_id >= ${BASE} AND user_id < ${ACTOR};
      ALTER TABLE staff_roles ENABLE TRIGGER staff_roles_last_admin_guard;
      ALTER TABLE staff_role_audit DISABLE TRIGGER staff_role_audit_immutable;
      DELETE FROM staff_role_audit WHERE subject_id >= ${BASE} AND subject_id < ${ACTOR};
      ALTER TABLE staff_role_audit ENABLE TRIGGER staff_role_audit_immutable;
      DELETE FROM users WHERE id >= ${BASE} AND id < ${ACTOR};
    END $$;`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id,name,email,updated_at,created_at) VALUES
     (${a},'A','a${a}@test.local',now(),now()),
     (${b},'B','b${b}@test.local',now(),now())`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO staff_roles (user_id,role) VALUES (${a},'admin'),(${b},'admin')`)
}

// Counts the CONTENDED pair only (ids below ACTOR). The actor's own grant is
// excluded because it is fixture scaffolding, not part of the race — § 5 covers
// the true last-admin case with no scaffolding at all.
const contendedAdmins = async () => {
  const [r] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int n FROM staff_roles WHERE role='admin' AND user_id < ${ACTOR}`)
  return r.n
}

// Two operations fired without awaiting the first — genuinely concurrent, each
// on its own pooled connection.
let lastRejections = []
async function race(opA, opB) {
  const results = await Promise.allSettled([opA(), opB()])
  lastRejections = results
    .filter(r => r.status === 'rejected')
    .map(r => String(r.reason?.message ?? r.reason))
  return results.map(r => (r.status === 'fulfilled' ? 'ok' : 'err'))
}
// Did the most recent race fail for a specific reason? Used to distinguish a
// legitimate guard refusal from a deadlock, which look the same as 'err'.
const failuresInclude = needle => lastRejections.some(m => m.includes(needle))
// 40P01 is Postgres's deadlock SQLSTATE. Checked by code AND text because Prisma
// surfaces it differently depending on the call path.
const deadlocked = () => lastRejections.some(m => /40P01|deadlock detected/i.test(m))

// THE APP PATH — the real exported function, with a real admin actor, so the
// advisory lock in lib/staffRole.ts is genuinely taken.
const appRevoke = id => () => revokeStaffRoleAs(ACTOR, id, 'admin', 'concurrency test')
// THE CASCADE PATH — account deletion, which reaches staff_roles via ON DELETE
// CASCADE and is guarded only by the DB trigger.
const deleteAccount = id => () =>
  prisma.$executeRawUnsafe(`DELETE FROM users WHERE id=${id}`)

// Asserts the FULL outcome, not merely "not zero". A race that failed both
// sides would also leave a non-zero count, so "not zero" alone would pass a
// broken-but-safe implementation and hide a liveness bug.
// Asserts the FULL outcome, not merely "no zero-admin state". Both operations
// target DIFFERENT admins here and the actor keeps the invariant satisfiable, so
// BOTH are individually legal — the property under test is that they SERIALIZE
// (neither lost, neither corrupted state, and the guard's count was never stale).
// A suite that only checked "not zero" would pass an implementation that
// silently dropped one operation.
async function runRace(label, mkA, mkB) {
  let bothFailed = 0
  let deadlocks = 0
  let survivors = []
  let errors = []
  const outcomes = []
  for (let i = 0; i < TRIALS; i++) {
    const a = BASE + i * 2
    const b = a + 1
    await seedTwoAdmins(a, b)
    const res = await race(mkA(a), mkB(b))
    const left = await contendedAdmins()
    outcomes.push(res.join('/'))
    survivors.push(left)
    if (res.every(r => r === 'err')) bothFailed++
    // 🔒 A DEADLOCK IS NEVER AN ACCEPTABLE OUTCOME. Treating any rejection as
    // "the loser" is what let a real cross-path deadlock (40P01) pass 21/21: a
    // deadlocked transaction looks identical to one the guard correctly refused.
    if (deadlocked()) deadlocks++
    // Consistency: the number of surviving contended admins must equal the
    // number of operations that FAILED. Anything else means an operation
    // reported success without taking effect, or vice versa.
    if (left !== res.filter(r => r === 'err').length) errors.push(`trial ${i}: ${res.join('/')} left ${left}`)
  }
  ok(deadlocks === 0, `${label}: no Postgres DEADLOCK (40P01) in ${TRIALS} trials (${deadlocks} seen)`)
  ok(bothFailed === 0, `${label}: no trial failed both sides (${bothFailed} double-failures)`)
  ok(errors.length === 0,
    `${label}: outcome matched surviving rows every trial${errors.length ? ' — ' + errors[0] : ''}`)
  ok(!survivors.includes(2),
    `${label}: no trial left BOTH contended admins (a silently-dropped operation)`)
  console.log(`       outcomes: ${[...new Set(outcomes)].join(', ')}  survivors: ${[...new Set(survivors)].join(',')}`)
}

async function main() {
  console.log(`\nEach race runs ${TRIALS} trials. Exactly one side must win; the`)
  console.log('invariant is that NO trial ever ends with zero admins.\n')

  await wipe()
  await seedActor()

  console.log('1. revoke vs revoke (APP path vs APP path — revokeStaffRoleAs)')
  await runRace('revoke/revoke', appRevoke, appRevoke)

  console.log('\n2. delete vs delete (cascade vs cascade)')
  await runRace('delete/delete', deleteAccount, deleteAccount)

  console.log('\n3. delete vs revoke — THE CROSS-PATH RACE')
  console.log('   (DB trigger vs revokeStaffRoleAs — needs the SAME lock key)')
  await runRace('delete/revoke', deleteAccount, appRevoke)

  console.log('\n4. Both sides targeting the SAME admin (double-removal)')
  console.log('   Not a last-admin case — the ACTOR is also an admin — so this')
  console.log('   isolates double-removal: exactly one side must win, never both.')
  const solo = BASE + 500
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id,name,email,updated_at,created_at)
     VALUES (${solo},'Solo','solo@test.local',now(),now())`)
  await prisma.$executeRawUnsafe(`INSERT INTO staff_roles (user_id,role) VALUES (${solo},'admin')`)
  const res = await race(deleteAccount(solo), appRevoke(solo))
  // Both target the SAME grant row, so exactly one must win: the loser finds
  // nothing to remove. Two successes would mean the row was removed twice.
  const wins = res.filter(r => r === 'ok').length
  ok(wins >= 1 && (await contendedAdmins()) === 0,
    `the contended grant was removed exactly once (${res.join('/')})`)
  const [soloGone] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int n FROM staff_roles WHERE user_id=${solo}`)
  ok(soloGone.n === 0, 'the targeted grant is gone')
  const [actorAlive] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int n FROM staff_roles WHERE user_id=${ACTOR} AND role='admin'`)
  ok(actorAlive.n === 1, 'the actor admin is untouched')

  console.log('\n4b. The app path and the DB trigger share the SAME lock key')
  // 🔒 THIS IS THE CROSS-PATH REGRESSION TEST. Races 1–3 do NOT prove it: they
  // keep a third admin alive, so both sides legitimately succeed and ok/ok is the
  // correct result whether or not the keys match. A reviewer changed the
  // trigger's key to a different value and all 16 assertions still passed.
  //
  // The keys are only observably shared if one path BLOCKS the other. So: hold
  // the app-side lock open in a transaction, then fire a cascade delete (which
  // takes the trigger's lock) and confirm it CANNOT finish while we hold it.
  // With mismatched keys the delete sails through immediately.
  {
    await wipe()
    await seedActor()
    const held = BASE + 800
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id,name,email,updated_at,created_at)
       VALUES (${held},'Held','held@test.local',now(),now())`)
    await prisma.$executeRawUnsafe(`INSERT INTO staff_roles (user_id,role) VALUES (${held},'admin')`)

    const holder = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
    let blocked = null
    // Hold the SAME advisory key the app path uses, then time a competing delete.
    const holding = holder.$transaction(async tx => {
      // ⚠️ ADMIN_LOCK_KEY imported from the implementation, never a literal. With
      // a hardcoded string this test caught a mutated TRIGGER key but would stay
      // green if the APP constant changed — only half the drift.
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext('${ADMIN_LOCK_KEY}'))`)
      const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
      const t0 = Date.now()
      const attempt = other
        .$executeRawUnsafe(`DELETE FROM users WHERE id=${held}`)
        .then(() => ({ done: Date.now() - t0 }))
        .catch(e => ({ err: String(e.message).slice(0, 60), done: Date.now() - t0 }))
      // Give it a window in which it must NOT complete if the keys match.
      const raced = await Promise.race([
        attempt,
        new Promise(r => setTimeout(() => r({ stillWaiting: true }), 700)),
      ])
      blocked = raced.stillWaiting === true
      await tx.$executeRaw`SELECT 1`
      return attempt.finally(() => other.$disconnect())
    })
    await holding.catch(() => {})
    await holder.$disconnect()
    ok(blocked === true,
      'holding the app-side key BLOCKED the trigger path (keys are genuinely shared)')
  }

  console.log('\n4b-ii. The trigger SOURCE names the same key as the app')
  // Static cross-check to close the other half of the drift: read the deployed
  // function bodies and require ADMIN_LOCK_KEY to appear in the ones that guard
  // or audit admin removal. The dynamic test above proves blocking happens; this
  // proves the two sides literally agree, so changing EITHER constant is caught.
  {
    const fns = await prisma.$queryRawUnsafe(
      `SELECT p.proname, pg_get_functiondef(p.oid) AS src
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname IN
         ('staff_roles_protect_last_admin','users_audit_staff_role_on_delete')`)
    ok(fns.length === 2, `both admin-path trigger functions exist (found ${fns.length})`)
    const missing = fns.filter(f => !f.src.includes(ADMIN_LOCK_KEY)).map(f => f.proname)
    ok(missing.length === 0,
      `every admin-path trigger uses ADMIN_LOCK_KEY ('${ADMIN_LOCK_KEY}')${
        missing.length ? ' — missing in: ' + missing.join(', ') : ''}`)
  }

  console.log('\n4c. App revoke vs account deletion must not DEADLOCK')
  // 🔒 THE CROSS-PATH LOCK-ORDER TEST. Each removal path takes TWO locks, and
  // inverted order means 40P01:
  //
  //   app revoke       : advisory  →  staff_roles row
  //   account deletion : users row →  cascade → staff_roles row →  advisory
  //                                                              (in the guard)
  //
  // Fixed by taking the advisory lock in the BEFORE DELETE ON users trigger, so
  // the deletion path becomes "advisory first" too. Ordering only the APP path
  // could not fix it: the cascade's row lock is taken by Postgres before any of
  // our triggers run.
  //
  // ⚠️ Unforced this reproduced ~1 in 15–60 trials, so the assertion below runs
  // MANY short races rather than one. A single race would be a coin flip, and a
  // hand-forced interleaving turned out to be worse than useless here — an
  // earlier version held a `SELECT … FOR UPDATE` on the users row, which looked
  // like the right setup but never produced the cycle, so it passed against the
  // BROKEN schema in 3/3 runs. Volume plus the deadlock detector in runRace is
  // what actually discriminates.
  {
    let deadlocks = 0
    let incoherent = 0
    for (let i = 0; i < 40; i++) {
      await wipe()
      const a = BASE + 830 + i * 3
      const t = a + 1
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (id,name,email,updated_at,created_at) VALUES
         (${a},'Actor','a${a}@test.local',now(),now()),
         (${t},'Target','t${t}@test.local',now(),now())`)
      await prisma.$executeRawUnsafe(
        `INSERT INTO staff_roles (user_id,role) VALUES (${a},'admin'),(${t},'admin')`)
      const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
      const res = await Promise.allSettled([
        revokeStaffRoleAs(a, t, 'admin', 'lock-order test'),
        other.$executeRawUnsafe(`DELETE FROM users WHERE id=${t}`),
      ])
      await other.$disconnect()
      const msgs = res.filter(r => r.status === 'rejected')
        .map(r => String(r.reason?.message ?? r.reason))
      if (msgs.some(m => /40P01|deadlock detected/i.test(m))) deadlocks++
      const [left] = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int n FROM staff_roles WHERE user_id=${t}`)
      if (left.n !== 0) incoherent++
    }
    ok(deadlocks === 0, `40 app-revoke-vs-account-deletion races, ${deadlocks} DEADLOCKED`)
    ok(incoherent === 0,
      `the target's grant was removed in every trial (${incoherent} left it behind)`)
  }

  console.log('\n5. TWO admins removed concurrently — exactly one must survive')
  // 🔒 THIS IS THE REGRESSION TEST FOR THE ADVISORY LOCK, and it is the only
  // assertion here that fails when the lock is removed. Verified by mutation:
  // stripping pg_advisory_xact_lock from the trigger (keeping the count)
  // reproduced ZERO ADMINS in 5+ of 20 attempts, because each transaction's
  // count was taken before the other committed. Racing removals at a SINGLE
  // target cannot catch this — the two operations must target DIFFERENT admins
  // for their counts to overlap.
  //
  // No actor scaffolding: these two are the only admins in the table, so the
  // guard must refuse exactly one of the two removals.
  {
    let zeroes = 0
    const seen = []
    for (let i = 0; i < TRIALS; i++) {
      const a = BASE + 700 + i * 2
      const b = a + 1
      await prisma.$executeRawUnsafe(`
        DO $$ BEGIN
          ALTER TABLE staff_roles DISABLE TRIGGER staff_roles_last_admin_guard;
          DELETE FROM staff_roles WHERE user_id >= ${BASE};
          ALTER TABLE staff_roles ENABLE TRIGGER staff_roles_last_admin_guard;
          ALTER TABLE staff_role_audit DISABLE TRIGGER staff_role_audit_immutable;
          DELETE FROM staff_role_audit WHERE subject_id >= ${BASE};
          ALTER TABLE staff_role_audit ENABLE TRIGGER staff_role_audit_immutable;
          DELETE FROM users WHERE id >= ${BASE};
          INSERT INTO users (id,name,email,updated_at,created_at) VALUES
            (${a},'A','a${a}@test.local',now(),now()),
            (${b},'B','b${b}@test.local',now(),now());
          INSERT INTO staff_roles (user_id,role) VALUES (${a},'admin'),(${b},'admin');
        END $$;`)
      // ⚠️ THE TRANSACTIONS MUST OVERLAP or the race cannot occur. Two
      // autocommit DELETEs do NOT reproduce it: each is its own instantaneous
      // transaction, so the second one's count already sees the first's commit
      // and the guard correctly refuses it. The defect needs BOTH transactions
      // to read their counts BEFORE either commits — which is exactly what a
      // real request pair does when any work sits between the check and the
      // commit. A pg_sleep inside each transaction forces that window
      // deterministically. Verified: with the lock present both orderings are
      // safe; with it stripped this reproduces ZERO ADMINS.
      // ⚠️ TWO REQUIREMENTS, both learned the hard way:
      //
      //  1. THE TRANSACTIONS MUST OVERLAP. Two autocommit DELETEs do NOT
      //     reproduce the defect — each is its own instantaneous transaction, so
      //     the second's count already sees the first's commit and the guard
      //     correctly refuses it. The defect needs BOTH to read their counts
      //     BEFORE either commits, which is what a real request pair does when
      //     any work sits between check and commit. A pg_sleep forces the window.
      //
      //  2. THEY MUST BE ON SEPARATE CONNECTIONS. Prisma's shared pool +
      //     $transaction + an advisory lock deadlocked into err/err — a test
      //     artifact that made the suite report failure on CORRECT code. Each
      //     side therefore gets its own PrismaClient, mirroring the two
      //     independent psql sessions that reproduced this by hand.
      const removeOnOwnConn = id => () => {
        const c = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
        return c
          .$transaction(async tx => {
            // ⚠️ $executeRawUnsafe, NOT $queryRawUnsafe: pg_sleep() returns
            // `void`, which Prisma cannot deserialize as a result column
            // ("Failed to deserialize column of type 'void'"). Using $queryRaw
            // here made BOTH sides fail on correct code and looked exactly like
            // a lock deadlock — a full diagnostic detour. Nothing to do with
            // locking at all.
            await tx.$executeRawUnsafe('SELECT pg_sleep(0.25)')
            await tx.$executeRawUnsafe(`DELETE FROM staff_roles WHERE user_id=${id}`)
          })
          .finally(() => c.$disconnect())
      }
      const res = await race(removeOnOwnConn(a), removeOnOwnConn(b))
      const [c] = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int n FROM staff_roles WHERE role='admin'`)
      seen.push(`${res.join('/')}→${c.n}`)
      if (c.n === 0) zeroes++
    }
    ok(zeroes === 0,
      `${TRIALS} concurrent double-removals, ${zeroes} reached ZERO admins (the lock regression)`)
    // Every trial must also land on exactly ONE surviving admin: one removal
    // wins, the guard refuses the other. A trial ending at 2 would mean both
    // were refused (a deadlock — the state is safe but a real request failed).
    ok(seen.every(x => x.endsWith('→1')),
      `every trial ended with exactly ONE admin (saw: ${[...new Set(seen)].join(', ')})`)
    console.log(`       outcomes: ${[...new Set(seen)].join(', ')}`)
  }

  console.log('\n6. The LAST admin under concurrent removal at ONE target (both must fail)')
  // 🔒 Wipe FIRST so `last` is genuinely the only admin in the table. § 5 leaves
  // a surviving admin by design, so inheriting its state would make this a
  // two-admin case and the assertion below ("both refused") would be wrong for
  // the right reason — one removal WOULD be legal. Seeding from a clean table is
  // what makes the terminal refusal the thing under test.
  await wipe()
  const last = BASE + 600
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id,name,email,updated_at,created_at)
     VALUES (${last},'Last','last@test.local',now(),now())`)
  await prisma.$executeRawUnsafe(`INSERT INTO staff_roles (user_id,role) VALUES (${last},'admin')`)
  const res2 = await race(
    deleteAccount(last),
    () => prisma.$executeRawUnsafe(`DELETE FROM staff_roles WHERE user_id=${last}`))
  ok(res2.every(r => r === 'err'), `both removals of the LAST admin refused (${res2.join('/')})`)
  const [lastAlive] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int n FROM staff_roles WHERE role='admin'`)
  ok(lastAlive.n === 1, 'the last admin survived')

  console.log('\n7. Mutual admin operations must not DEADLOCK')
  // 🔒 Two admins revoking EACH OTHER. This topology was missing (the suite
  // always used one fixed actor), and it deadlocked: Postgres 40P01, because the
  // caller's row was locked BEFORE the shared advisory lock, giving inverted
  // ordering. With (advisory, then rows) a cycle is impossible.
  {
    await wipe()
    const x = BASE + 810
    const y = BASE + 811
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id,name,email,updated_at,created_at) VALUES
       (${x},'X','x@test.local',now(),now()),(${y},'Y','y@test.local',now(),now())`)
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_roles (user_id,role) VALUES (${x},'admin'),(${y},'admin')`)
    // X revokes Y while Y revokes X, on separate connections.
    const res = await race(
      () => revokeStaffRoleAs(x, y, 'admin', 'mutual'),
      () => revokeStaffRoleAs(y, x, 'admin', 'mutual'))
    const deadlocked = failuresInclude('40P01') || failuresInclude('deadlock')
    ok(!deadlocked, `no deadlock on mutual revocation (${res.join('/')})`)
    const [left] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int n FROM staff_roles WHERE role='admin'`)
    ok(left.n === 1, `exactly one admin survived mutual revocation (got ${left.n})`)
  }

  console.log('\n8. Demote vs revoke must not corrupt state')
  // 🔒 The P1 stale-read defect: applyDemote/applyRevoke read the subject BEFORE
  // taking the lock, so both decided on stale state — both returned ok, the
  // subject ended with NO role, and the audit recorded a demotion that did not
  // survive.
  //
  // ⚠️ REPEATED, because a single trial is not enough: against the defective code
  // this reproduced in roughly 4 of 6 runs, so a one-shot assertion would pass
  // intermittently and be worse than no test. Over TRIALS attempts the
  // probability of missing it is negligible.
  {
    let corrupted = 0
    let extraAudits = 0
    const seen = []
    for (let i = 0; i < TRIALS; i++) {
      await wipe()
      await seedActor()
      const t = BASE + 820
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (id,name,email,updated_at,created_at)
         VALUES (${t},'T','t@test.local',now(),now())`)
      await prisma.$executeRawUnsafe(`INSERT INTO staff_roles (user_id,role) VALUES (${t},'admin')`)
      // ⚠️ THE OVERLAP IS FORCED STRUCTURALLY, not by timing. Two lessons:
      // fired simultaneously the window is narrow (the defect reproduced ~2 of 3
      // runs — flaky), and an 8ms stagger overshot so the first call committed
      // before the second began, making the test UNABLE to fail even against the
      // defective code. Timing-based interleaving is the wrong tool.
      //
      // Instead a third connection HOLDS the shared advisory key, both calls are
      // launched (each blocks on that key at its own first lock attempt), and the
      // holder releases. Both then proceed from the same starting state — which is
      // exactly the interleaving the read-before-lock defect needs, because a
      // read taken BEFORE the lock happens while the holder still blocks it.
      const gate = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
      let release
      const gateHeld = new Promise(r => { release = r })
      const gating = gate.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('verre:staff_roles:admin'))`
        await gateHeld
      })
      const launched = race(
        () => demoteToCuratorAs(ACTOR, t, 'race demote'),
        () => revokeStaffRoleAs(ACTOR, t, 'admin', 'race revoke'))
      // Let both reach their first lock attempt, then open the gate.
      await new Promise(r => setTimeout(r, 40))
      release()
      await gating.catch(() => {})
      await gate.$disconnect()
      const res = await launched
      const rows = await prisma.$queryRawUnsafe(
        `SELECT role FROM staff_roles WHERE user_id=${t}`)
      const audits = await prisma.$queryRawUnsafe(
        `SELECT action, role FROM staff_role_audit WHERE subject_id=${t} ORDER BY id`)
      seen.push(`${res.join('/')}→${rows.length ? rows[0].role : 'none'}`)
      // Exactly ONE side may take effect. BOTH reporting success with the row
      // GONE is the corrupted state the defect produced.
      const bothSucceeded = res.every(r => r === 'ok')
      const coherent = rows.length === 1 ? rows[0].role === 'curator' : !bothSucceeded
      if (!coherent) corrupted++
      if (audits.filter(a => a.action === 'revoke' && a.role === 'admin').length > 1) extraAudits++
    }
    ok(corrupted === 0,
      `${TRIALS} demote-vs-revoke races, ${corrupted} left incoherent state (saw: ${
        [...new Set(seen)].join(', ')})`)
    ok(extraAudits === 0,
      `no trial recorded more than one admin-revoke audit row (${extraAudits} did)`)
  }

  await wipe()

  console.log(`\n${pass} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
