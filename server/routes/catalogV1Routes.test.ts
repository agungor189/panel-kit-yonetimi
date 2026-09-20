import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { initializeDatabase } from "../db/initialize.js";
import { CatalogService } from "../modules/catalog/catalogService.js";
import { createPanelApiAuth } from "../middleware/panelApiAuth.js";
import { createCatalogV1Router } from "./catalogV1Routes.js";

let db: Database.Database;
let baseUrl = "";
let server: ReturnType<express.Express["listen"]>;
const apiKey = "catalog-contract-key";

before(async () => {
  db = new Database(":memory:");
  initializeDatabase(db);
  db.prepare("INSERT INTO panel_api_keys (id,name,key_prefix,key_hash,last4,status,permissions) VALUES (?,?,?,?,?,?,?)")
    .run("catalog-reader", "Catalog reader", "catalog", crypto.createHash("sha256").update(apiKey).digest("hex"), "-key", "active", JSON.stringify(["catalog:read"]));
  new CatalogService(db).createProduct({
    id: "connector-1", sku: "AL-SQ30-ELB", title: "30 mm dirsek", catalog_type: "connector", base_uom_code: "piece", mass_grams: 325,
  });
  const app = express();
  const auth = createPanelApiAuth({ db, hashApiKey: (value) => crypto.createHash("sha256").update(value).digest("hex"), logActivity: () => undefined });
  app.use("/api/catalog/v1", createCatalogV1Router({ db, authenticate: auth("catalog:read") }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => { server?.close(); db?.close(); });

test("catalog v1 requires scoped service authentication", async () => {
  assert.equal((await fetch(`${baseUrl}/api/catalog/v1/products`)).status, 401);
});

test("catalog v1 publishes controlled UOMs and immutable product references", async () => {
  const headers = { "x-api-key": apiKey };
  const uoms = await (await fetch(`${baseUrl}/api/catalog/v1/uoms`, { headers })).json() as any;
  assert.equal(uoms.contract, "dsdst.catalog-uom.v1");
  assert.deepEqual(uoms.data.units.filter((row: any) => ["piece", "meter", "square_meter", "kg", "roll", "package", "box"].includes(row.code)).map((row: any) => row.code).sort(), ["box", "kg", "meter", "package", "piece", "roll", "square_meter"]);
  const products = await (await fetch(`${baseUrl}/api/catalog/v1/products`, { headers })).json() as any;
  assert.equal(products.contract, "dsdst.catalog-product.v1");
  assert.equal(products.data[0].id, "connector-1");
  assert.equal(products.data[0].base_uom.code, "piece");
  assert.equal(products.data[0].catalog_version_ref, "catalog-product:connector-1:v1");
  assert.equal(products.data[0].uom_registry_version, "uom-registry:v1");
});
