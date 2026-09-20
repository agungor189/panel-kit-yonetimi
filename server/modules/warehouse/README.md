# Warehouse execution (V2-08)

Panel is the sole owner of warehouse topology, receipts, packages, locations,
replenishment tasks, discrepancies, counts, inventory balances and ledger
effects. Warehouse clients call `/api/warehouse/v1/execution/*`; they never
receive a database handle and never calculate authoritative stock.

Topology is persisted configuration. A topology command supplies every rack,
level, position and depth row plus effective role, mixed-SKU/lot policy,
weight limit, placement priority, last-resort flag and active state. The
service materializes that configuration into queryable slots. Rack shapes and
depth counts therefore change through data, not code. No business topology is
seeded by migration.

Goods receipt references an approved V2-06 acquisition-cost snapshot. The
immutable cost/FX snapshot is not edited. The receipt records expected,
accepted, damaged, shortage and approved excess quantities; only accepted
quantity posts one V2-07 `RECEIPT` ledger event. Damaged packages remain
`QUARANTINE` and do not enter available inventory. Stage/series/final fields
are present for a future partial-receipt policy, but the service currently
rejects every non-final or later stage with `PARTIAL_RECEIPT_DISABLED`.

Placement and movement transfer the exact lot balance between receiving and
configured slots. They never write the inventory ledger or change product
on-hand. Counts record expected/observed difference first; only the separately
authorized approval posts an explicit `CORRECTION`. Negative or
below-reserved results fail closed.

Every public mutation is wrapped by the V2-04 command executor in the route
layer. Matching retries replay the committed result; mismatched payloads
conflict. Audit and warehouse outbox rows commit atomically with the domain
change. The older `/admin/placements`, `/admin/moves` and
`/admin/stock-counts` writers return `410` and cannot compete with this path.

## Migration and rollback

Migration v71 is additive and starts all V2-08 business/configuration tables
empty. It performs no topology seed, receipt backfill or stock repair. A
pre-v71 binary must not open a v71 database. Rollback after real V2-08 commands
requires a whole compatible pre-v71 recovery point; otherwise fix forward.
