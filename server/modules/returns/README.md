# Returns, refunds, and financial reversals (V2-10)

P is the sole authority for the `dsdst.returns.v1` contract. A return request
freezes selected V2-09 line economics and original dispatched FIFO/COGS
allocations. It never changes stock or cash.

Warehouse receipt uses `dsdst.warehouse-return-acceptance.v1` and records one of
`SELLABLE`, `DAMAGED`, or `MISSING_NOT_RECEIVED` for every inspected quantity.
Only `SELLABLE` posts an immutable `RETURN` inventory event. `DAMAGED` is stored
in a quarantine location and creates an exact historical `RETURN_LOSS`.

Refunds require the `returns:approve_refund` human capability and an explicit
approval reference. Direct refunds post integer minor units to a selected active
cash/bank account. Marketplace refunds create `PENDING_SETTLEMENT` receivable
facts and do not post physical cash. Customer shipping refund is a separate
return fact; V2-09 seller shipping and general Marketing/advertising expenses
are never reversed.

All V2-10 facts are append-only. Migration v75 has no legacy backfill or data
repair. Old `İade Edildi` rows without V2-10 facts remain `legacyUnknown`, and
the direct post-dispatch status shortcut fails closed.
