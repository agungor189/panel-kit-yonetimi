# Catalog / UOM V1

Panel is the canonical owner of product identity, SKU, catalog type, base UOM,
typed profile attributes and their immutable version references.

## Canonical representation

- UOM registry: `uom-registry:v1`
- Public product contract: `dsdst.catalog-product.v1`
- Public UOM contract: `dsdst.catalog-uom.v1`
- Base UOMs: `piece`, `meter`, `square_meter`, `kg`, `roll`, `package`, `box`
- Display/conversion units: `millimeter`, `centimeter`, `gram`
- Bar, cut and purchase lengths: non-negative integer millimetres
- Profile cross-sections: canonical integer micrometres, exposed as exact
  decimal-millimetre strings (maximum three decimal places)
- Mass: non-negative integer grams
- Quantities: decimal strings converted by integer rational arithmetic to the
  declared base quantum; sub-quantum values fail closed
- Historical reference: `catalog-product:<product-id>:v<n>` plus the UOM
  registry/conversion reference returned by the UOM contract

Profiles use `meter` as their base UOM. Connectors, caps and wheels use
`piece`; complementary products may use any controlled base UOM. A product's
base UOM is immutable after creation; a different UOM requires a new product
identity. Standard profile purchase lengths are 1000, 2000, 3000 and 6000 mm;
each profile declares which are valid and whether a positive integer custom
length is allowed.

## API boundaries

- `/api/catalog/v1/*` is service-authenticated and read-only.
- `/api/catalog-admin/v1/*` is a human-authorized, operation-identified command
  boundary backed by the immutable command audit/outbox foundation.
- Warehouse receives the same read-only records through its existing
  human-plus-service boundary.
- Kit Studio stores a disposable projection with catalog/UOM version refs. It
  cannot create or edit canonical catalog records.

No procurement, receipt, price, cost, stock, cutting or remnant mutation is
part of this module.

## Migration and rollback

Migration 64 is additive. It creates the UOM registry, rational conversions,
typed profile attributes and immutable catalog-version records, then assigns
existing product IDs/SKUs a version-1 `piece` catalog snapshot. It does not
create stock, cash, price, procurement or historical transaction rows.
Migration 65 adds the complementary classification and exact micrometre
authority for profile cross-sections without changing integer length semantics.

Rollback is application rollback: keep the additive tables/columns and run the
previous application image against its supported schema. Do not delete catalog
version rows or rewrite product identities. A physical schema removal, data
reclassification or repair requires a separately approved backup, preview,
reconciliation and rollback procedure.
