import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { ProcurementService } from "../procurement/procurementService.js";
import { ProductPricingService, ProductPricingValidationError, type ProductPricingApproval } from "./productPricingService.js";

const settings = { bufferPercentage: 20, profitPercentage: 50, fixedTry: 3, roundingIncrement: 5 as const };

const setup = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  new CatalogService(db).createProduct({
    id: "priced-product",
    sku: "PRICED-PRODUCT",
    title: "Priced product",
    catalog_type: "product",
    base_uom_code: "piece",
  });
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "supplier", name: "Supplier", defaultCurrency: "TRY" });
  finalizeCost(procurement, "first", 1_000);
  return { db, procurement, pricing: new ProductPricingService(db) };
};

const finalizeCost = (procurement: ProcurementService, suffix: string, supplierUnitPriceMinor: number) => {
  procurement.createPurchase({
    id: `purchase-${suffix}`,
    supplierId: "supplier",
    acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
    lines: [{
      id: `line-${suffix}`,
      productId: "priced-product",
      quantity: "1",
      quoteBasis: "piece",
      supplierUnitPriceMinor,
      currency: "TRY",
      vatMode: "EXCLUDED",
      vatRateBps: 0,
    }],
  });
  procurement.finalizeAcquisitionCosts(`purchase-${suffix}`, { allocations: [] });
};

const approval = (db: Database.Database, approvedSalePrice: number): ProductPricingApproval => {
  const row = db.prepare(`SELECT p.sale_price,p.price_locked,lc.acquisition_cost_snapshot_id,
    lc.cost_try_numerator,lc.cost_try_denominator FROM products p
    JOIN current_product_landed_costs lc ON lc.product_id=p.id WHERE p.id='priced-product'`).get() as any;
  return {
    productId: "priced-product",
    approvedSalePrice,
    expectedLandedCostSnapshotId: row.acquisition_cost_snapshot_id,
    expectedLandedCostNumerator: row.cost_try_numerator,
    expectedLandedCostDenominator: row.cost_try_denominator,
    expectedSalePrice: row.sale_price,
    expectedPriceLocked: Boolean(row.price_locked),
  };
};

const assertStale = (action: () => unknown) => assert.throws(action, (error: any) =>
  error instanceof ProductPricingValidationError
  && error.statusCode === 409
  && error.code === "PRICING_PREVIEW_STALE");

test("approved preview saves only the price recalculated from the current FINAL Landed Cost", () => {
  const { db, pricing } = setup();
  const calculated = pricing.preview("priced-product", settings);
  assert.equal(calculated.willUpdate, true);
  const result = pricing.applyMany({
    approvals: [approval(db, calculated.newSalePrice!)],
    settings,
    actorId: "pricing-owner",
    reason: "approved-preview",
    operationId: "approved-preview",
  });
  assert.equal(result.updatedCount, 1);
  assert.equal(db.prepare("SELECT sale_price FROM products WHERE id='priced-product'").pluck().get(), calculated.newSalePrice);
  db.close();
});

test("changed FINAL Landed Cost invalidates an older approved preview", () => {
  const { db, procurement, pricing } = setup();
  const oldPrice = pricing.preview("priced-product", settings).newSalePrice!;
  const oldApproval = approval(db, oldPrice);
  finalizeCost(procurement, "second", 2_000);

  assertStale(() => pricing.applyMany({
    approvals: [oldApproval], settings, reason: "stale-cost", operationId: "stale-cost",
  }));
  assert.equal(db.prepare("SELECT sale_price FROM products WHERE id='priced-product'").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM pricing_history").pluck().get(), 0);
  db.close();
});

test("changed price lock invalidates an older approved preview", () => {
  const { db, pricing } = setup();
  const oldApproval = approval(db, pricing.preview("priced-product", settings).newSalePrice!);
  db.prepare("UPDATE products SET price_locked=1 WHERE id='priced-product'").run();

  assertStale(() => pricing.applyMany({
    approvals: [oldApproval], settings, reason: "stale-lock", operationId: "stale-lock",
  }));
  assert.equal(db.prepare("SELECT sale_price FROM products WHERE id='priced-product'").pluck().get(), 0);
  db.close();
});

test("changed current sale price invalidates an older approved preview", () => {
  const { db, pricing } = setup();
  const oldApproval = approval(db, pricing.preview("priced-product", settings).newSalePrice!);
  db.prepare("UPDATE products SET sale_price=77 WHERE id='priced-product'").run();

  assertStale(() => pricing.applyMany({
    approvals: [oldApproval], settings, reason: "stale-price", operationId: "stale-price",
  }));
  assert.equal(db.prepare("SELECT sale_price FROM products WHERE id='priced-product'").pluck().get(), 77);
  db.close();
});

test("tampered approved price is rejected even when the preview snapshot is current", () => {
  const { db, pricing } = setup();
  const calculated = pricing.preview("priced-product", settings).newSalePrice!;
  assert.throws(() => pricing.applyMany({
    approvals: [approval(db, calculated + 1)], settings, reason: "tampered-price", operationId: "tampered-price",
  }), (error: any) => error instanceof ProductPricingValidationError
    && error.statusCode === 409
    && error.code === "PRICING_PREVIEW_MISMATCH");
  assert.equal(db.prepare("SELECT sale_price FROM products WHERE id='priced-product'").pluck().get(), 0);
  db.close();
});
