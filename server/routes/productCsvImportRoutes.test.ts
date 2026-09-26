import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { initializeDatabase } from "../db/initialize.js";
import { runMigrations } from "../migrations/runner.js";
import { rejectLegacyCatalogMutation } from "../modules/catalog/legacyCatalogGuard.js";
import { createProductCsvImportRouter } from "./productCsvImportRoutes.js";

const db = new Database(":memory:");
let baseUrl = "";
let server: ReturnType<express.Express["listen"]>;

const validBody = {
  headers: ["SKU", "İsim - TR", "TÜR", "Toplam Adet"],
  rows: [{ SKU: "CSV-001", "İsim - TR": "CSV Ürünü", "TÜR": "simple", "Toplam Adet": "25" }],
  source_name: "products.csv",
};

before(async () => {
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  runMigrations(db);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "admin-1", username: "admin" } as any;
    next();
  });
  app.use("/api/products/import", createProductCsvImportRouter({ db, authorize: (_req, _res, next) => next() }));
  app.use("/api/products", rejectLegacyCatalogMutation);
  app.use("/api/products", (_req, res) => res.json({ passed: true }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
  db.close();
});

const postImport = (body: object, operationId?: string) => fetch(`${baseUrl}/api/products/import`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(operationId ? { "x-operation-id": operationId } : {}),
  },
  body: JSON.stringify(body),
});

test("CSV dry-run is mutation-free and valid apply is atomic, audited and idempotent", async () => {
  const preview = await postImport({ ...validBody, dry_run: true });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json() as any).applied, false);
  assert.equal(db.prepare("SELECT COUNT(*) FROM products").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_operations").pluck().get(), 0);

  const missingOperation = await postImport({ ...validBody, dry_run: false });
  assert.equal(missingOperation.status, 400);
  assert.equal((await missingOperation.json() as any).error.code, "INVALID_COMMAND");
  assert.equal(db.prepare("SELECT COUNT(*) FROM products").pluck().get(), 0);

  const applied = await postImport({ ...validBody, dry_run: false }, "csv-import-1");
  assert.equal(applied.status, 200);
  assert.equal((await applied.json() as any).applied, true);
  assert.equal(db.prepare("SELECT COUNT(*) FROM products WHERE sku='CSV-001'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT central_stock FROM products WHERE sku='CSV-001'").pluck().get(), 0);
  assert.equal(db.prepare("SELECT catalog_version FROM products WHERE sku='CSV-001'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM catalog_product_versions WHERE product_id=(SELECT id FROM products WHERE sku='CSV-001')").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_audit_log WHERE command_type='catalog.product.csv-import.v1'").pluck().get(), 1);

  const replay = await postImport({ ...validBody, dry_run: false }, "csv-import-1");
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as any).idempotent, true);
  assert.equal(db.prepare("SELECT COUNT(*) FROM products WHERE sku='CSV-001'").pluck().get(), 1);
});

test("invalid and duplicate-SKU apply leaves the catalog unchanged", async () => {
  const before = db.prepare("SELECT COUNT(*) FROM products").pluck().get();
  const invalid = await postImport({
    headers: validBody.headers,
    rows: [
      validBody.rows[0],
      { ...validBody.rows[0], "İsim - TR": "Tekrar" },
    ],
    dry_run: false,
    source_name: "invalid.csv",
  }, "csv-import-invalid");

  assert.equal(invalid.status, 422);
  const report = await invalid.json() as any;
  assert.ok(report.validation_errors.some((error: any) => error.code === "DUPLICATE_SKU"));
  assert.equal(db.prepare("SELECT COUNT(*) FROM products").pluck().get(), before);
});

test("unsafe legacy product create and update remain blocked", async () => {
  for (const [method, path] of [["POST", ""], ["POST", "/bulk-import"], ["PUT", "/CSV-001"]] as const) {
    const response = await fetch(`${baseUrl}/api/products${path}`, { method });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as any).error.code, "CANONICAL_CATALOG_COMMAND_REQUIRED");
  }
});
