# Panel / DSDST business-core rules

This repository contains the target DSDST V2 modular-monolith business core and Panel UI. The binding architecture is in the sibling Operations repository:

- `docs/architecture/ARCH-00-DSDST-OPERATIONS-V2.md`
- `docs/architecture/INVARIANTS.md`
- `docs/architecture/DOMAIN-OWNERSHIP.md`
- `docs/architecture/SOURCE-OF-TRUTH.md`
- `docs/architecture/V2-IMPLEMENTATION-ROADMAP.md`

Resolve those paths in the checked-out `dsdst-operations` repository. If the architecture and a task conflict, stop and request an explicit architecture decision; do not silently diverge.

## Ownership

P owns human identity/access, canonical catalog/UOM, procurement, acquisition cost, inventory, warehouse state, canonical sales/returns, money/finance, pricing, published kits, marketplace/shipping state, print jobs, idempotency/audit and their authoritative database records.

P does not own editable kit drafts (K), editable label templates/rendering (L), deployment/release evidence/backups (O), or Customer Hub facts.

## Required engineering rules

- All authoritative writes enter the owning domain service. Route handlers, UIs, scripts, reports and other modules must not write owned tables directly.
- Decompose the existing monolith incrementally behind regression tests; do not perform a big-bang rewrite.
- Every mutation requires authenticated actor, capability, operation key, canonical payload hash, atomic state/ledger/snapshot/audit write and replayable result.
- Inventory has one physical posting. Receipt acceptance creates IN; internal place/move/pick/pack does not change global on-hand; owner-approved dispatch creates OUT. Reservations are separate.
- Do not use `products.central_stock` as a new write authority. It becomes a projection after ledger migration; preserve it for compatibility/reconciliation until explicitly retired.
- Sales/returns keep immutable BOM, UOM, money, tax, fee, cost and FX snapshots. Never recompute history from current master data.
- Missing cost, currency, FX, UOM, tax or policy input blocks authoritative processing; never coerce it to zero or rate 1.
- K publishes only through the approved content-hash handshake. P owns the sellable SKU and published economic snapshot. Legacy kit writes must not be expanded.
- L owns editable templates. P owns print jobs and immutable template-version/payload snapshots; submission is not physical delivery.
- Marketplace/carrier input enters replay-safe inboxes and quarantine. External statuses never directly edit stock, cash or canonical tables.
- CSV may propose catalog data, opening batches or receipt intent through explicit modes. It must not overwrite physical stock, cash or history.
- Schema migrations are forward-only, fail closed and fixture-tested. They do not silently repair business data.
- Repairs require a separate approved manifest, backup, dry run, reconciliation, audit and rollback/compensation.
- Authorization is backend-enforced. Service scopes never substitute for the human capability on user actions.
- Secrets/customer data must not enter Git, fixtures, logs, errors, evidence or snapshots.
- Do not weaken or skip tests, force push, deploy, restart, migrate or touch production without explicit authorization.

Unresolved business policy is written as `DECISION REQUIRED` and blocks the dependent write path. Existing defaults are not decisions.
