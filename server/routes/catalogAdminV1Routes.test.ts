import { CatalogService } from '../modules/catalog/catalogService.js';
import { ProcurementService } from '../modules/procurement/procurementService.js';
import { finalLandedCostSource } from '../modules/pricing/finalLandedCostSource.js';
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { initializeDatabase } from "../db/initialize.js";
import { createCatalogAdminV1Router } from "./catalogAdminV1Routes.js";

let db: Database.Database;
let baseUrl = "";
let server: ReturnType<express.Express["listen"]>;

before(async () => {
  db = new Database(":memory:");
  initializeDatabase(db);
  const app = express();
  app.use(express.json());
  app.use("/api/catalog-admin/v1", createCatalogAdminV1Router({
    db,
    authorize: (req, _res, next) => {
      req.user = { id: "catalog-owner", username: "Catalog Owner" } as typeof req.user;
      next();
    },
  }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => { server?.close(); db?.close(); });

const product = {
  id: "cap-30",
  sku: "CAP-30",
  title: "30 mm cap",
  catalog_type: "cap",
  base_uom_code: "piece",
  mass_grams: 12,
};

test("catalog mutations require an operation identity", async () => {
  const response = await fetch(`${baseUrl}/api/catalog-admin/v1/products`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(product),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as any).error.code, "INVALID_COMMAND");
});

test("catalog create is versioned, audited and idempotently replayed", async () => {
  const request = () => fetch(`${baseUrl}/api/catalog-admin/v1/products`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operation-id": "catalog-create-cap-30" },
    body: JSON.stringify(product),
  });
  const first = await (await request()).json() as any;
  const replay = await (await request()).json() as any;
  assert.equal(first.data.catalog_version_ref, "catalog-product:cap-30:v1");
  assert.equal(first.idempotent, false);
  assert.equal(replay.idempotent, true);
  assert.equal(db.prepare("SELECT COUNT(*) FROM catalog_product_versions WHERE product_id='cap-30'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_audit_log WHERE command_type='catalog.product.create.v1'").pluck().get(), 1);
});

test("catalog update increments version and preserves the immutable old snapshot", async () => {
  const oldSnapshot = db.prepare("SELECT snapshot_json FROM catalog_product_versions WHERE product_id=? AND catalog_version=1").pluck().get(product.id) as string;
  const response = await fetch(`${baseUrl}/api/catalog-admin/v1/products/${product.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-operation-id": "catalog-update-cap-30-v2" },
    body: JSON.stringify({ expected_catalog_version: 1, product: { ...product, title: "30 mm cap v2" } }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.data.catalog_version, 2);
  assert.equal(payload.data.catalog_version_ref, "catalog-product:cap-30:v2");
  assert.equal(db.prepare("SELECT snapshot_json FROM catalog_product_versions WHERE product_id=? AND catalog_version=1").pluck().get(product.id), oldSnapshot);
  assert.match(oldSnapshot, /30 mm cap/);
  assert.doesNotMatch(oldSnapshot, /30 mm cap v2/);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_audit_log WHERE command_type='catalog.product.update.v1'").pluck().get(), 1);
});

test("catalog product edit cannot bypass FINAL Landed Cost pricing approval", async () => {
  const response = await fetch(`${baseUrl}/api/catalog-admin/v1/products/${product.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-operation-id": "catalog-price-bypass-cap-30" },
    body: JSON.stringify({
      expected_catalog_version: 2,
      product: { ...product, title: "30 mm cap v2" },
      operational: { sale_price: 999 },
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as any).error.code, "PRICING_FORMULA_APPROVAL_REQUIRED");
  assert.equal(db.prepare("SELECT sale_price FROM products WHERE id=?").pluck().get(product.id), 0);
});

test("catalog channel edit preserves visibility but cannot bypass authoritative pricing", async () => {
  db.prepare(`INSERT INTO product_platforms (id,product_id,platform_name,stock,price,is_listed)
    VALUES ('platform-cap-30','cap-30','Website',0,125,0)`).run();
  const bypass = await fetch(`${baseUrl}/api/catalog-admin/v1/products/${product.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-operation-id": "catalog-platform-price-bypass-cap-30" },
    body: JSON.stringify({
      expected_catalog_version: 2,
      product: { ...product, title: "30 mm cap v2" },
      operational: { platforms: [{ name: "Website", price: 999, is_listed: true }] },
    }),
  });
  assert.equal(bypass.status, 409);
  assert.equal((await bypass.json() as any).error.code, "PLATFORM_PRICE_PRICING_FLOW_REQUIRED");
  assert.deepEqual(db.prepare("SELECT price,is_listed FROM product_platforms WHERE id='platform-cap-30'").get(), { price: 125, is_listed: 0 });

  const visibility = await fetch(`${baseUrl}/api/catalog-admin/v1/products/${product.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-operation-id": "catalog-platform-visibility-cap-30" },
    body: JSON.stringify({
      expected_catalog_version: 2,
      product: { ...product, title: "30 mm cap v2" },
      operational: { platforms: [{ name: "Website", price: 125, is_listed: true }] },
    }),
  });
  assert.equal(visibility.status, 200);
  assert.deepEqual(db.prepare("SELECT price,is_listed FROM product_platforms WHERE id='platform-cap-30'").get(), { price: 125, is_listed: 1 });
});


test('assembly single edit saves renamed catalog and approved price; real BOM or FINAL source changes return 409 atomically', async () => {
  const catalog = new CatalogService(db), procurement = new ProcurementService(db);
  const part = catalog.createProduct({ sku: 'ASSEMBLY-PART', title: 'Part', catalog_type: 'product', base_uom_code: 'piece', product_type: 'component' });
  const fields = { sku: 'ASSEMBLY-PRICE', title: 'Assembly', catalog_type: 'product' as const, base_uom_code: 'piece' as const, product_type: 'assembly' as const };
  const assembly = catalog.createProduct(fields);
  catalog.replaceBom(assembly.id, catalog.readBom(assembly.id).version, [{ componentId: part.id, quantity: 2 }]);
  procurement.registerSupplier({ id: 'assembly-supplier', name: 'Fixture', defaultCurrency: 'TRY' });
  const finalize = (price: number) => {
    const p = procurement.createPurchase({ supplierId: 'assembly-supplier', acquisitionCostVatPolicy: 'VAT_EXCLUDED_FROM_INVENTORY_COST', lines: [{ productId: part.id, quantity: '1', quoteBasis: 'piece', supplierUnitPriceMinor: price, currency: 'TRY', vatMode: 'EXCLUDED', vatRateBps: 0 }] });
    procurement.finalizeAcquisitionCosts(p.id, { allocations: [] });
  };
  finalize(1000);
  const cost = finalLandedCostSource(db, assembly.id)!;
  const save = (key: string, reference = cost, price = 20) => fetch(`${baseUrl}/api/catalog-admin/v1/products/${assembly.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-operation-id': key },
    body: JSON.stringify({ expected_catalog_version: catalog.getProduct(assembly.id)!.catalog_version, product: { ...fields, title: 'New display name' }, operational: { description: 'New description', pricing_formula_approved: true, sale_price: price, buffer_percentage: 0, profit_percentage: 0, fixed_price_adjustment_try: 0, price_rounding_increment: 1, pricing_preview: { landedCostSnapshotId: reference.reference, landedCostNumerator: reference.numerator, landedCostDenominator: reference.denominator, salePrice: Number((db.prepare('SELECT sale_price FROM products WHERE id=?').get(assembly.id) as any).sale_price), priceLocked: false } } }),
  });
  const saved = await save('assembly-single-save');
  assert.equal(saved.status, 200, JSON.stringify(await saved.json()));
  assert.equal(finalLandedCostSource(db, assembly.id)!.reference, cost.reference);
  assert.equal(db.prepare('SELECT sale_price FROM products WHERE id=?').pluck().get(assembly.id), 20);
  catalog.replaceBom(assembly.id, catalog.readBom(assembly.id).version, [{ componentId: part.id, quantity: 3 }]);
  const changedBom = await save('assembly-bom-stale');
  assert.equal(changedBom.status, 409);
  assert.equal((await changedBom.json() as any).error.code, 'PRICING_PREVIEW_STALE');
  const currentCost = finalLandedCostSource(db, assembly.id)!;
  finalize(2000);
  const changedCost = await save('assembly-cost-stale', currentCost, 30);
  assert.equal(changedCost.status, 409);
  assert.equal((await changedCost.json() as any).error.code, 'PRICING_PREVIEW_STALE');
  assert.equal(db.prepare('SELECT COUNT(*) FROM pricing_history WHERE product_id=?').pluck().get(assembly.id), 1);
});
