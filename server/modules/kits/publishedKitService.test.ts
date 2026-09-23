import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { SalesFinancialService } from "../sales/salesFinancialService.js";
import { ProcurementService } from "../procurement/procurementService.js";
import {
  PublishedKitService,
  PublishedKitValidationError,
  authoredKitContentHash,
  type KitPublicationProposal,
} from "./publishedKitService.js";

const setup = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  catalog.createProduct({ id: "connector", sku: "CON-1", title: "Connector", catalog_type: "connector", base_uom_code: "piece" });
  catalog.createProduct({
    id: "profile", sku: "PRO-1", title: "Profile", catalog_type: "profile", base_uom_code: "meter",
    profile: { material: "ALUMINUM", form: "square", width_mm: "40", height_mm: "40", wall_thickness_mm: "2", standard_purchase_lengths_mm: [3000], custom_length_allowed: false },
  });
  catalog.createProduct({ id: "cap", sku: "CAP-1", title: "Cap", catalog_type: "cap", base_uom_code: "piece" });
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "supplier", name: "Supplier", defaultCurrency: "TRY" });
  const addCost = (id: string, productId: string, quantity: string, unitPrice: number, quoteBasis: "piece" | "profile_bar", profileLengthMm?: number) => {
    procurement.createPurchase({
      id: `purchase-${id}`, supplierId: "supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
      invoiceNumber: `INV-${id}`, invoiceDate: "2026-09-23",
      lines: [{ id: `line-${id}`, productId, quantity, quoteBasis, profileLengthMm, supplierUnitPriceMinor: unitPrice, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }],
    });
    return procurement.finalizeAcquisitionCosts(`purchase-${id}`, { allocations: [] }).lots[0];
  };
  addCost("connector", "connector", "10", 100, "piece");
  addCost("profile", "profile", "1", 3000, "profile_bar", 3000);
  addCost("cap", "cap", "10", 50, "piece");
  return { db, service: new PublishedKitService(db) };
};

const proposal = (db: Database.Database, overrides: Partial<KitPublicationProposal> = {}): KitPublicationProposal => {
  const versionRef = (id: string) => String(db.prepare("SELECT catalog_version_ref FROM products WHERE id=?").pluck().get(id));
  const source = {
    workspaceKitId: "workspace-kit-1",
    workspaceVersionId: "workspace-version-1",
    publishedKitId: null,
    sku: "KIT-001",
    title: "Published kit",
    description: "Immutable kit",
    components: [
      { productId: "connector", catalogVersionRef: versionRef("connector"), quantityBaseInt: 4, role: "CONNECTOR" },
      { productId: "cap", catalogVersionRef: versionRef("cap"), quantityBaseInt: 2, role: "CAP" },
    ],
    profileCutPlan: {
      profileProductId: "profile", catalogVersionRef: versionRef("profile"),
      cuts: [{ quantity: 1, lengthMm: 1800, label: "upright" }],
    },
    packagingPlan: {
      packageCount: 1,
      instructionVersion: "packing:v1",
      installationGuideVersion: "guide:v4",
      packages: [{ packageNumber: 1, dimensionsMm: { length: 1850, width: 200, height: 150 }, targetWeightGrams: 5000, items: [
        { productId: "connector", quantityBaseInt: 4 },
        { productId: "cap", quantityBaseInt: 2 },
        { productId: "profile", quantityBaseInt: 1803 },
      ] }],
    },
    finalSalePriceMinor: 3000,
    currency: "TRY",
  } satisfies Omit<KitPublicationProposal, "authoredContentHash">;
  const merged = { ...source, ...overrides } as Omit<KitPublicationProposal, "authoredContentHash">;
  return { ...merged, authoredContentHash: authoredKitContentHash(merged) };
};

test("preview fails closed for incomplete, unknown-cost, duplicate-SKU and below-cost proposals", () => {
  const { db, service } = setup();
  assert.throws(() => service.preview(proposal(db, { title: "" })), (error: unknown) => error instanceof PublishedKitValidationError && error.code === "INCOMPLETE_KIT");
  assert.throws(() => service.preview(proposal(db, { finalSalePriceMinor: 2302 })), (error: unknown) => error instanceof PublishedKitValidationError && error.code === "SALE_PRICE_BELOW_COST");

  new CatalogService(db).createProduct({ id: "unknown", sku: "UNKNOWN", title: "Unknown", catalog_type: "product", base_uom_code: "piece" });
  const unknownProposal = proposal(db, { components: [{
    productId: "unknown", catalogVersionRef: String(db.prepare("SELECT catalog_version_ref FROM products WHERE id='unknown'").pluck().get()), quantityBaseInt: 1, role: "PART",
  }] });
  assert.throws(() => service.preview(unknownProposal), (error: unknown) => error instanceof PublishedKitValidationError && error.code === "COST_UNKNOWN");

  new CatalogService(db).createProduct({ id: "taken", sku: "TAKEN", title: "Taken", catalog_type: "product", base_uom_code: "piece" });
  assert.throws(() => service.preview(proposal(db, { sku: "TAKEN" })), (error: unknown) => error instanceof PublishedKitValidationError && error.code === "DUPLICATE_SKU");
  db.close();
});

test("valid publication creates a canonical KIT and immutable BOM/cut/package/cost snapshots", () => {
  const { db, service } = setup();
  const input = proposal(db);
  const preview = service.preview(input);
  assert.equal(preview.cost.canonicalCostMinor, 2303);
  assert.equal(preview.cutPlan?.effectiveKerfMm, 3);
  assert.equal(preview.cutPlan?.consumedLengthMm, 1803);
  const published = service.publish({
    proposal: input,
    approvedContentHash: preview.contentHash,
    approvedPolicyHash: preview.corePolicyHash,
    operationId: "publish-operation-1",
    actor: { id: "approver", name: "Approver" },
    service: { id: "kit-studio", name: "Kit Studio" },
    publishedAt: "2026-09-23T10:00:00.000Z",
  });
  assert.equal(published.versionNumber, 1);
  assert.deepEqual(db.prepare("SELECT sku,CASE WHEN product_type='kit' THEN 'KIT' ELSE catalog_type END AS catalog_type,product_type,is_sellable,visible_in_catalog FROM products WHERE id=?").get(published.productId), {
    sku: "KIT-001", catalog_type: "KIT", product_type: "kit", is_sellable: 1, visible_in_catalog: 1,
  });
  assert.deepEqual(db.prepare("SELECT component_product_id,quantity_base_int FROM published_kit_version_components WHERE published_kit_version_id=? ORDER BY component_sequence").all(published.versionId), [
    { component_product_id: "cap", quantity_base_int: 2 },
    { component_product_id: "connector", quantity_base_int: 4 },
    { component_product_id: "profile", quantity_base_int: 1803 },
  ]);
  assert.equal(db.prepare("SELECT installation_guide_version FROM published_kit_versions WHERE id=?").pluck().get(published.versionId), "guide:v4");
  assert.equal(db.prepare("SELECT COUNT(*) FROM published_kit_version_packages WHERE published_kit_version_id=?").pluck().get(published.versionId), 1);
  assert.throws(() => db.prepare("UPDATE published_kit_versions SET title_snapshot='changed' WHERE id=?").run(published.versionId), /immutable/i);
  db.close();
});

test("a changed published kit creates a new version while old economics and recipe remain exact", () => {
  const { db, service } = setup();
  const firstProposal = proposal(db);
  const firstPreview = service.preview(firstProposal);
  const first = service.publish({ proposal: firstProposal, approvedContentHash: firstPreview.contentHash, approvedPolicyHash: firstPreview.corePolicyHash, operationId: "publish-1", actor: { id: "owner" }, publishedAt: "2026-09-23T10:00:00.000Z" });
  const oldSnapshot = db.prepare("SELECT * FROM published_kit_versions WHERE id=?").get(first.versionId);

  db.prepare("UPDATE products SET purchase_cost=999999 WHERE id='connector'").run();
  const secondProposal = proposal(db, {
    workspaceVersionId: "workspace-version-2", publishedKitId: first.publishedKitId,
    components: [
      { productId: "connector", catalogVersionRef: String(db.prepare("SELECT catalog_version_ref FROM products WHERE id='connector'").pluck().get()), quantityBaseInt: 6, role: "CONNECTOR" },
      { productId: "cap", catalogVersionRef: String(db.prepare("SELECT catalog_version_ref FROM products WHERE id='cap'").pluck().get()), quantityBaseInt: 2, role: "CAP" },
    ],
    packagingPlan: {
      ...firstProposal.packagingPlan,
      packages: firstProposal.packagingPlan.packages.map((pkg) => ({
        ...pkg,
        items: pkg.items.map((item) => item.productId === "connector" ? { ...item, quantityBaseInt: 6 } : item),
      })),
    },
    finalSalePriceMinor: 4000,
  });
  const secondPreview = service.preview(secondProposal);
  const second = service.publish({ proposal: secondProposal, approvedContentHash: secondPreview.contentHash, approvedPolicyHash: secondPreview.corePolicyHash, operationId: "publish-2", actor: { id: "owner" }, publishedAt: "2026-09-23T11:00:00.000Z" });
  assert.equal(second.versionNumber, 2);
  assert.notEqual(second.versionId, first.versionId);
  assert.deepEqual(db.prepare("SELECT * FROM published_kit_versions WHERE id=?").get(first.versionId), oldSnapshot);
  assert.equal(db.prepare("SELECT current_version_id FROM published_kits WHERE id=?").pluck().get(first.publishedKitId), second.versionId);
  db.close();
});

test("substitute or alternative BOM fields are rejected", () => {
  const { db, service } = setup();
  const input = proposal(db) as KitPublicationProposal & { substitutes?: unknown[] };
  input.substitutes = [{ productId: "cap" }];
  assert.throws(() => service.preview(input), (error: unknown) => error instanceof PublishedKitValidationError && error.code === "SUBSTITUTES_FORBIDDEN");
  db.close();
});

test("sale snapshot remains bound to the exact sold kit version after a newer publication", () => {
  const { db, service } = setup();
  const firstProposal = proposal(db);
  const firstPreview = service.preview(firstProposal);
  const first = service.publish({ proposal: firstProposal, approvedContentHash: firstPreview.contentHash, approvedPolicyHash: firstPreview.corePolicyHash, operationId: "history-publish-1", actor: { id: "owner" } });
  db.prepare("INSERT INTO sales (id,customer_name,total_amount,platform) VALUES ('sale-kit-history','Customer',30,'Mağaza')").run();
  db.prepare(`INSERT INTO sale_items (id,sale_id,product_id,product_name,quantity,unit_price)
    VALUES ('sale-line-kit-history','sale-kit-history',?,'Published kit',1,30)`).run(first.productId);
  const financial = new SalesFinancialService(db).createOrderSnapshot({
    saleId: "sale-kit-history", currency: "TRY", sourceChannel: "Mağaza", discountMinor: 0,
    commissionRatePercent: 0, commissionCalculationBasis: "GROSS_AFTER_DISCOUNT", commissionTerms: { source: "test" },
    lines: [{ saleLineId: "sale-line-kit-history", productId: first.productId, quantity: 1, unitGrossMinor: 3000, vatRateBps: 2000 }],
    operationId: "sale-history-operation", actor: { id: "seller" }, createdAt: "2026-09-23T12:00:00.000Z",
  });
  assert.equal(financial.lines[0].kitVersion.publishedKitVersionId, first.versionId);
  assert.equal(financial.lines[0].kitVersion.current, true);

  const secondProposal = proposal(db, { workspaceVersionId: "history-workspace-2", publishedKitId: first.publishedKitId, finalSalePriceMinor: 3500 });
  const secondPreview = service.preview(secondProposal);
  const second = service.publish({ proposal: secondProposal, approvedContentHash: secondPreview.contentHash, approvedPolicyHash: secondPreview.corePolicyHash, operationId: "history-publish-2", actor: { id: "owner" } });
  assert.notEqual(second.versionId, first.versionId);
  const historical = new SalesFinancialService(db).getSaleFinancial("sale-kit-history");
  assert.equal(historical.lines[0].kitVersion.publishedKitVersionId, first.versionId);
  assert.equal(historical.lines[0].kitVersion.versionNumber, 1);
  assert.equal(historical.lines[0].kitVersion.current, false);
  assert.equal(historical.lines[0].kitVersion.snapshot.version.final_sale_price_minor, 3000);
  db.close();
});
