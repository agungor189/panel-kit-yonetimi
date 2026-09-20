# Procurement and acquisition cost (V2-06)

This P-owned module is the only V2-06 authority for suppliers, purchase documents,
transaction FX snapshots, acquisition-cost allocation decisions, planned lot-cost
snapshots, purchase payments, and their integer cash postings.

## Contracts and boundaries

- `POST /api/procurement/v1/fx/usd-try` records an authorized current USD/TRY
  observation. The legacy `exchange_rates` row is maintained only as a display and
  simulation projection; purchase accounting reads the immutable rational snapshot.
- Supplier, purchase, cost-finalization, and payment commands require a human session,
  a capability, `X-Operation-Id`, command audit, and atomic outbox/result persistence.
- Purchase lines preserve catalog version, original quote basis/quantity, native
  integer amounts, VAT basis/rate, and exact FX numerator/denominator/source/time.
- Shared acquisition costs produce a deterministic purchase-value suggestion. Nothing
  is allocated until finalization explicitly accepts the suggestion, supplies manual
  values, or leaves the component unallocated.
- Finalization creates immutable `COSTED_PENDING_RECEIPT` snapshots. These are cost
  contracts for future receipt lots; they are not inventory lots and never post stock.
- Purchase payments must use the purchase and cash-account currency. Each payment and
  cash posting is immutable; purchase creation/finalization creates no cash movement.

TRY and USD are currently executable because USD/TRY is the accepted FX mechanism.
Other supplier currencies fail closed until an owner-approved current-rate source is
configured. Cross-currency cash settlement remains outside V2-06.

## Schema and rollback impact

Migration v67 is forward-only. It adds procurement, rational FX, cost allocation,
planned lot-cost, payment, and integer cash-posting tables plus immutability triggers.
It does not rewrite catalog, stock, historical costs, cash history, or legacy purchases.
An existing active legacy USD/TRY display rate is copied once into a provenance-marked
current observation; historical acquisition records do not exist before V2-06.

Application rollback before any V2-06 business use may leave the additive tables in
place. After V2-06 records exist, rollback requires preserving those tables and using a
compatible application; dropping or rewriting them is not an approved rollback or data
repair. No production migration or repair is performed by this change.

V2-07 inventory/reservation behavior is intentionally absent.
