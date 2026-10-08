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
  source currency and immutable FX snapshot. New manual components require an explicit `SUPPLIER` or `THIRD_PARTY` counterparty.
  Supplier surcharges use the invoice currency and extend supplier payable once;
  third-party costs never extend it. Both use the same existing LC allocation engine.
  Neither cost entry records payment. Historical counterparty metadata stays unknown.
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
without writes. SKU matches are automatic: an exact existing SKU is kept, a new
PRODUCT SKU creates a passive card, and the five explicitly approved missing
MasterInfo identities may use their fixed suggested SKUs. Ambiguous identity,
supplier alias, UOM or product type conflicts block apply with source-row errors.
Only unique verified supplier aliases are recorded; generic repeated descriptions
remain in source evidence. Identical BOMs are left intact; changed BOMs use their
previewed version under the single import approval. Later purchases may reference
existing SKUs without repeating PRODUCT or BOM rows.

`/imports/apply` requires procurement and catalog capabilities, an operation
identity and the current preview hash. It recomputes the automatic plan inside
the same transaction as catalog writes and an immutable, **INCOMPLETE** purchase
intent. Import does not accept VAT, FX, acquisition-cost policy or prior-stock
evidence. The existing flat CSV path remains.
The source text hash and supplier/invoice identity deduplicate imports independently
of the filename and operation key. The source CSV and resolved product/line IDs
are retained in the draft; no financial purchase, package plan, inventory, cash,
expense or price entry is created yet. The list/detail endpoints expose this
draft with null monetary totals, never invented zero costs or an implicit FX rate.
`/imports/drafts/:id/complete` takes the later explicit tax/cost decisions and
prior-stock evidence. It uses the existing purchase service to snapshot native
amounts and FX, then writes v98 source records and the versioned package plan
atomically. A missing FX source leaves the draft incomplete. FINAL cost and
Warehouse receipt approval remain separate steps.

Migration v98 is forward-only and adds immutable import provenance and package-plan
tables, supplier-scoped catalog aliases, pricing-history source JSON and the
component-specific activation guard. It performs no business repair/backfill.
Existing products and history remain unchanged. Tests use synthetic in-memory
databases and the supported v48/v53 upgrade fixtures. No live migration is implied.
Rollback must preserve these tables and use an application compatible with v98;
after business use, dropping source records or replaying imports is not rollback.
Migration v101 adds immutable incomplete import-draft and completion records only;
it does not backfill, reprice or modify applied migrations.
Migration v102 stages editable draft cost items with immutable revisions, and records
explicit supplier-alias retractions/reversals without deleting source evidence.
CSV import takes supplier numbers only from MasterInfo `PRODUCT.supplier_code`;
Packing List `source_supplier_code` remains source package evidence, including box
descriptions. Alias repair is an explicit dry-run manifest followed by an
authorization-gated command requiring backup and approval references; it is never
an automatic migration. Draft cost entry needs only title, positive amount, USD/TRY
and optional description. Currency conversion in the draft is a read-only estimate
from the accepted FX observation. Tax, counterparty, prior-stock evidence and
allocation approval remain mandatory at FINAL cost conversion, which uses the
existing ProcurementService engine atomically.

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

New package print jobs require an L-owned **100×150 mm** immutable template with
one `{Package_code}` Code128 barcode. Warehouse requests L's `package_identity`
contract, backed by `dsdst-package-identity-100x150-v1`; renderer previews and P print
jobs use the same contract. Historical print jobs/reprints keep their old snapshots,
and location templates remain 100×50. Approved `RECEIPT_PENDING` plan packages can
print before physical receipt: explicit lot and plan version are required; a count
observation overrides the planned quantity for that label only. Changed quantity/lot
produces a new immutable label payload version with the same package identity.
Printing never accepts goods or creates stock/packages. Completed shortage packages
cannot masquerade as pending stock. No production migration or printing is performed.

## CSV source totals and manual expenses

Synthetic example: `public/examples/procurement-import-v1.csv` (not an actual invoice).
The v1 columns and PRODUCT/TÜR/BOM/LINE/PACKAGE_GROUP/PACKAGE_ITEM semantics remain.
Only LINE merchandise prices/amounts enter the draft. EXPENSE rows remain immutable
source evidence with no canonical expense ID, no expense-policy approval and no form
prefill. Preview states “Giderler aktarılmadı, manuel girilecek”. Every expense,
including supplier invoice surcharges, is entered manually in Satın Alma with its
counterparty, source amount/currency and explicit VAT policy; LC allocation is then
approved separately. Source `invoice_total_usd` is never replaced with merchandise.
Source reconciliation still checks merchandise + source invoice expenses against
that original total; the draft payable starts with merchandise only. Example:
200.00 USD merchandise, 19.51 USD source expense, 219.51 USD original total. Import
creates no expense; manually entering 19.51 USD as SUPPLIER extends payable to 219.51.

Migration v99 adds nullable counterparty metadata to existing cost details. It does
not infer historical counterparties or rewrite source invoice money or payments.
Supplier payable is the immutable original amount plus explicit supplier surcharges;
the existing payment command enforces that amount. Existing LC component IDs ensure
one allocation per component, independently of counterparty.

New goods receipt always sends `damagedQuantityBaseInt: 0`. P rejects positive damage
or a DAMAGED package instead of converting it to accepted stock. Actual counts,
shortage/excess approvals and mixed-carton child weighing remain. Return quarantine
is a separate flow and is unchanged. Assembly pricing references hash actual BOM
quantities, component FINAL sources and formula version, never catalog display versions.
