import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { createPanelApiAuth } from "../middleware/panelApiAuth.js";
import { createKitCatalogRouter } from "./kitCatalogRoutes.js";

let db: Database.Database;
let baseUrl = "";
let server: ReturnType<express.Express["listen"]>;
const apiKey = "kit-studio-test-key";
const hashApiKey = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

before(async () => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE panel_api_keys (id TEXT PRIMARY KEY, name TEXT, key_hash TEXT, status TEXT, permissions TEXT, allowed_ips TEXT, expires_at TEXT, deleted_at TEXT, last_used_at TEXT, last_used_ip TEXT);
    CREATE TABLE products (id TEXT PRIMARY KEY, sku TEXT, name TEXT, name_tr TEXT, name_en TEXT, title TEXT, supplier_code TEXT, material TEXT, form_code TEXT, tube_type_code TEXT, size_code TEXT, size TEXT, pipe_size TEXT, normalized_material TEXT, normalized_size TEXT, normalized_tube_type TEXT, normalized_pipe_size TEXT, purchase_cost REAL, sale_price REAL, central_stock INTEGER, visible_in_catalog INTEGER, status TEXT, product_type TEXT, updated_at TEXT);
    CREATE TABLE product_images (id TEXT PRIMARY KEY, product_id TEXT, path TEXT, sort_order INTEGER);
  `);
  db.prepare("INSERT INTO panel_api_keys (id,name,key_hash,status,permissions) VALUES (?,?,?,?,?)")
    .run("key-1", "Kit Studio", hashApiKey(apiKey), "active", JSON.stringify(["kit-catalog:read"]));
  db.prepare("INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("p-1", "AL-S20-ELB", "Dirsek", "Dirsek", "Elbow", "Dirsek", "SUP-1", "Aluminum", "ELB", "SQ", "20X20", "20x20", "20x20 mm", "Alüminyum", "20x20", "Kare", "20x20 mm", 70, 120, 42, 1, "Active", "simple", "2026-01-01");
  db.prepare("INSERT INTO product_images VALUES (?,?,?,?)").run("img-1", "p-1", "/uploads/elbow.webp", 0);

  const app = express();
  const auth = createPanelApiAuth({ db, hashApiKey, logActivity: () => undefined });
  app.use("/api/kit-catalog", createKitCatalogRouter({ db, authenticate: auth("kit-catalog:read") }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server?.close();
  db?.close();
});

test("kit catalog rejects requests without Panel API authentication", async () => {
  const response = await fetch(`${baseUrl}/api/kit-catalog/connectors`);
  assert.equal(response.status, 401);
});

test("kit catalog returns read-only connector fields", async () => {
  const response = await fetch(`${baseUrl}/api/kit-catalog/connectors`, { headers: { "x-api-key": apiKey } });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.data[0].sku, "AL-S20-ELB");
  assert.equal(body.data[0].sale_price, 120);
  assert.equal(body.data[0].image, "/uploads/elbow.webp");
  assert.equal(body.data[0].form_code, "ELB");
  assert.equal(body.data[0].tube_type_code, "SQ");
  assert.equal(body.data[0].normalized_pipe_size, "20x20 mm");
});

test("kit catalog connector detail returns 404 for an unknown product", async () => {
  const response = await fetch(`${baseUrl}/api/kit-catalog/connectors/missing`, { headers: { "x-api-key": apiKey } });
  assert.equal(response.status, 404);
});
