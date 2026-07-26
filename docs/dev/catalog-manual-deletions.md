# Catalog manual-deletion ledger

**This file is the ONLY durable carrier for a catalog row deleted outside the
application write path.** It is append-only. Entries are never removed, only
advanced through their states.

## Why it exists

`CATALOG_PUBLIC_ENABLED` opens with the model-change phase, so users can link
wines — which permanently forbids truncate + reload. The import/pull endpoint
arrives in phase 4, two phases later. Between those two points a seed defect has
no designed correction channel, and that window is an explicitly accepted gap
(see `docs/dev/proposals/wine-catalog.md` § Seed + the truncate fence).

A manual fix bypasses the application write path, so **no change-journal event
fires** — the journal appends in the same transaction as the domain change, and
hand-written SQL is outside that transaction by construction. For an `UPDATE` or
a re-point that is harmless: the first pull is a consistent baseline and carries
the corrected value regardless. **For a `DELETE` it is not.** A missing row and a
not-yet-pulled row are indistinguishable by design — deletion is never inferred
from absence, because inferring it is how merged entities resurrect. So a
deleted entity would be believed to exist, permanently, with nothing to
contradict it.

⚠️ The database will not always stop this. Eight of the nine forward FKs into
catalog tables are `NoAction`, so deleting a referenced **producer** or
**vintage** fails loudly. But `product_producers.product_id` is an intentional
`Cascade`: a **product** whose only remaining references are its own join rows
**deletes successfully and cascades them**. That is precisely the case this
ledger has to catch.

## 🔒 Ordering — the ledger entry is committed BEFORE the destructive SQL

A Git document and a database deletion cannot be made atomic. Therefore:

1. **Append the entry with `state: planned` and commit it.** Push before
   proceeding.
2. **Run the destructive SQL.**
3. **Amend the entry to `state: applied`** with the timestamp, and commit.

Committing first is the load-bearing part. If the SQL runs and the Git update is
then forgotten or fails, the deletion is invisible forever — the exact problem
this ledger exists to prevent. A `planned` entry whose deletion never happened is
harmless noise; an unrecorded deletion is unrecoverable. When in doubt, record
first.

An entry that is `planned` but whose row still exists should be closed out as
`abandoned` rather than deleted from the file.

## Consumption — phase 4 seeds the purge ledger before accepting anything

🔒 **Before the phase-4 import path accepts any session, and before it
establishes its initial baseline/fence**, it must:

1. Idempotently seed every `applied`, unreconciled entry below into the
   persistent purge ledger (phase 4's own structure, which emits deletion events
   and rejects resurrection).
2. Let that ledger emit the deletion.
3. Reject any subsequent import carrying a seeded id.
4. Mark the entry `reconciled` here **only after** the durable seed succeeds.

⚠️ **Sending the id to a deletion feed is NOT sufficient.** An import arriving
first could recreate the row. The seed must precede the first accepted session,
which is why this is a precondition on baseline creation rather than a
post-import cleanup step.

## Ledger

States: `planned` → `applied` → `reconciled`; or `planned` → `abandoned`.

| Entity type | Entity ID | State | Planned (UTC) | Applied (UTC) | Reconciled (UTC) | Reason |
|---|---|---|---|---|---|---|
| _(none yet)_ | | | | | | |

### Template

```
| producer | AbC123dEf456GhI789jKl | planned | 2026-07-26T14:00Z | — | — | short reason |
```

`Entity type` is one of `producer`, `product`, `vintage`, `product_producer`,
`product_ean`. `Entity ID` depends on the type — it is **not** always a nanoid:

| Entity type | ID form |
|---|---|
| `producer`, `product`, `vintage` | the 21-char nanoid PK |
| `product_producer` | `<productId>/<producerId>` — the row's composite PK, both nanoids |
| `product_ean` | the **EAN string itself** (`VarChar(14)`), which is that table's PK — not the product's nanoid |

`Reason` is one line — enough for a reader years later to know why, not a full
incident report.
