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
