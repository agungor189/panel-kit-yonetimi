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
- Each freight, customs, cutting/labor, or other acquisition component has its own
  source currency and immutable FX snapshot. Components are not added to the goods
  supplier payable; that payable contains merchandise from the goods invoice only.
- Every purchase explicitly snapshots either
  `VAT_EXCLUDED_FROM_INVENTORY_COST` or `VAT_INCLUDED_IN_INVENTORY_COST`.
  Net, VAT, and gross remain separate in both cases; the selected basis alone enters
  the immutable lot cost.
- Shared acquisition costs produce a deterministic purchase-value suggestion. Nothing
  is allocated until finalization explicitly accepts the suggestion, supplies manual
  values, or leaves the component unallocated.
- Finalization creates immutable `COSTED_PENDING_RECEIPT` snapshots. These are cost
  contracts for future receipt lots; they are not inventory lots and never post stock.
- There is no provisional valuation path. Panel may move an order through draft,
  ordered, in-transit, and cost-pending states, but explicit receipt approval is
  rejected until every line has its immutable final landed-cost snapshot.
- Only the explicit `RECEIPT_PENDING` approval exposes an intent to Warehouse.
  Warehouse receipt remains the physical stock posting; completion is projected only
  after all purchase snapshots have a final authoritative receipt.
- Purchase payments must use the purchase and cash-account currency. Each payment and
  exact minor-unit procurement posting is immutable. The same atomic transaction adds
  one protected `procurement_purchase_payment` compatibility row to the existing
  `cash_transactions` ledger, so established cash balances decrease exactly once.
  Purchase creation/finalization creates no cash movement.

TRY and USD are currently executable because USD/TRY is the accepted FX mechanism.
Other supplier currencies fail closed until an owner-approved current-rate source is
configured. Cross-currency cash settlement remains outside V2-06.

## Schema and rollback impact

Migration v67 is forward-only. It adds procurement, rational FX, cost allocation,
planned lot-cost, payment, and integer cash-posting tables plus immutability triggers.
It does not rewrite catalog, stock, historical costs, cash history, or legacy purchases.
An existing active legacy USD/TRY display rate is copied once into a provenance-marked
current observation; historical acquisition records do not exist before V2-06.

Migration v68 is also forward-only and preserves the v67 checksum. It adds the VAT
policy snapshots, clarifies acquisition-component source/base currency fields, and
protects the unique cash-ledger projection. It does not silently synthesize cash-ledger
rows for any pre-existing v67 payment; if such records exist outside test environments,
they require the separately approved repair workflow with preview and reconciliation.

Application rollback before any V2-06 business use may leave the additive tables in
place. After V2-06 records exist, rollback requires preserving those tables and using a
compatible application; dropping or rewriting them is not an approved rollback or data
repair. No production migration or repair is performed by this change.

Migration v94 is forward-only. It adds the Panel workflow, immutable procurement
documents and cost-component details, plus the traceable current finalized landed-cost
projection. It deliberately does not infer workflow state or synthesize approvals for
legacy purchases. Existing records that need participation require a separate approved
manifest, backup, dry run and reconciliation; the migration itself performs no repair.

V2-07 goods receipt references these immutable cost snapshots; it does not update
or recalculate them.

## Versioned single-file import and package projection

`POST /api/procurement/v1/imports/preview` parses `dsdst.procurement.import.v1`
without writes. `/imports/apply` requires procurement and catalog capabilities,
an operation identity, the current preview hash, explicit catalog/BOM/source
approvals, tax policy and prior-stock evidence. The existing flat CSV path remains.
The source text hash and supplier/invoice identity deduplicate imports independently
of the filename and operation key. Catalog commands, purchase draft, aliases,
source references, immutable package plan and command result commit together.
Import does not call the legacy MasterInfo importer or post stock/cash/prices.

Migration v98 is forward-only and adds immutable import provenance and package-plan
tables, supplier-scoped catalog aliases, pricing-history source JSON and the
component-specific activation guard. It performs no business repair/backfill.
Existing products and history remain unchanged. Tests use synthetic in-memory
databases and the supported v48/v53 upgrade fixtures. No live migration is implied.
Rollback must preserve these tables and use an application compatible with v98;
after business use, dropping source records or replaying imports is not rollback.

Receipt intents gain optional `packagePlan` with a version, backend package IDs,
per-package quantities, immutable catalog snapshots and source-carton references.
Mixed cartons produce single-SKU children sharing a source identity; parent gross
weight is not copied to children. Warehouse records measured child weight and split
confirmation. A final receipt submits all observed packages for one original cost
snapshot; incorrect IDs, line bindings and versions fail closed. Direct Inventory
receipt cannot bypass the imported plan. Reprint/scan never posts stock.

Pricing reads the purchase's total FINAL cost divided by its total base quantity.
Multi-line references hash every contributing immutable snapshot. Assembly pricing
uses the canonical product BOM and component FINAL sources only. BOM/source changes
invalidate approval; receipt still uses original per-line snapshots. Buffers, margin,
fixed TRY, rounding, locks and channel publication remain in Pricing/Products.

`GET /api/inventory/v1/products/:id/packages` is an authenticated, read-only projection
requested lazily by the existing product-detail panel. It reads actual execution and
previously placed legacy packages plus unreceived versioned plans. Summaries use
remaining quantities, excluding empty/cancelled/missing packages; historical rows are
retained. Finalized lines do not remain in pending plans, including shortage cases.

Imported packages require an L-owned 100×100 mm template version with a single
`{Package_code}` Code128 barcode. Existing legacy 100×150 `{SKU}` templates remain
valid for legacy packages. This change does not author or publish an L template;
until a compatible template is supplied by L, new-plan printing fails closed.
