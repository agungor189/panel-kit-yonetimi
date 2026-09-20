# Inventory and reservation (V2-07)

This P-owned module is the only V2-07 authority for physical inventory events,
received lot balances, FIFO reservations, availability, dispatch consumption,
stock-discrepancy state, and approved inventory corrections.

- Approved receipt accepts one immutable V2-06 `COSTED_PENDING_RECEIPT` snapshot
  in full and references it without changing its acquisition-cost facts.
- Base quantities are safe integers in the product's snapshotted canonical UOM.
- `on_hand` changes only through receipt, approved dispatch, or an explicitly
  authorized correction. Reserve/release/pick/pack do not change physical stock.
- Reservations fail atomically when available stock is insufficient. FIFO uses
  `received_at` then lot identity and splits only after an older usable lot is
  exhausted.
- Fulfillment remains bound to the reserved FIFO lot. Reserve stock produces a
  `REPLENISH_SAME_LOT` requirement; a reported physical miss produces
  `STOCK_DISCREPANCY` and blocks newer-lot fallback.
- `products.central_stock` is updated only as a compatibility projection for
  products onboarded to the V2 ledger. A database guard rejects divergent direct
  writes once a product has an inventory lot. Legacy products remain untouched
  until their separately approved V2-08 bootstrap/opening path.

Migration v69 is additive and does not backfill or repair legacy stock. Fresh and
supported v48/v53 upgrades converge to the same schema. Application rollback after
V2-07 events must preserve the new tables and use a compatible reader; dropping or
rewriting ledger/lot/reservation records is not an approved rollback.
