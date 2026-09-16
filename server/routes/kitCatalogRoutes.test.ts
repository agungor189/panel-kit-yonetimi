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
    CREATE TABLE products (id TEXT PRIMARY KEY, sku TEXT, name TEXT, name_tr TEXT, name_en TEXT, title TEXT, supplier_code TEXT, material TEXT, form_code TEXT, tube_type_code TEXT, size_code TEXT, size TEXT, pipe_size TEXT, normalized_material TEXT, normalized_size TEXT, normalized_tube_type TEXT, normalized_pipe_size TEXT, normalized_model TEXT, purchase_price_usd REAL, purchase_cost REAL, exchange_rate_used REAL, sale_price REAL, weight REAL, weight_grams REAL, central_stock INTEGER, visible_in_catalog INTEGER, status TEXT, product_type TEXT, updated_at TEXT);
    CREATE TABLE exchange_rates (id TEXT PRIMARY KEY, rate REAL, fetched_at TEXT, is_active INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE product_images (id TEXT PRIMARY KEY, product_id TEXT, path TEXT, sort_order INTEGER);
    CREATE TABLE kit_profiles (id TEXT PRIMARY KEY, name TEXT, shape TEXT, dimension TEXT, material TEXT, thickness TEXT, supplier TEXT, price_per_meter REAL, weight_per_meter REAL, stock_length_mm REAL, is_active INTEGER, updated_at TEXT);
    CREATE TABLE kit_profile_offers (id TEXT PRIMARY KEY, profile_id TEXT, supplier TEXT, price_per_meter REAL, is_preferred INTEGER);
    CREATE TABLE complementary_products (id TEXT PRIMARY KEY, name TEXT, category TEXT, description TEXT, supplier_reference TEXT, cover_image TEXT, unit TEXT, purchase_price REAL, is_active INTEGER, updated_at TEXT);
    CREATE TABLE complementary_product_images (id TEXT PRIMARY KEY, complementary_product_id TEXT, path TEXT, sort_order INTEGER, created_at TEXT);
  `);
  db.prepare("INSERT INTO panel_api_keys (id,name,key_hash,status,permissions) VALUES (?,?,?,?,?)")
    .run("key-1", "Kit Studio", hashApiKey(apiKey), "active", JSON.stringify(["kit-catalog:read"]));
  db.prepare("INSERT INTO products (id,sku,name,name_tr,name_en,title,supplier_code,material,form_code,tube_type_code,size_code,size,pipe_size,normalized_material,normalized_size,normalized_tube_type,normalized_pipe_size,normalized_model,purchase_price_usd,purchase_cost,exchange_rate_used,sale_price,weight_grams,central_stock,visible_in_catalog,status,product_type,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("p-1", "AL-S20-ELB", "Dirsek", "Dirsek", "Elbow", "Dirsek", "SUP-1", "Aluminum", "ELB", "SQ", "20X20", "20x20", "20x20 mm", "Alüminyum", "20x20", "Kare", "20x20 mm", "S20", 0.44, 0, 30, 120, 325, 42, 1, "Active", "simple", "2026-01-01");
  db.prepare("INSERT INTO exchange_rates VALUES (?,?,?,?)").run("rate-1", 40, "2026-09-17T10:00:00Z", 1);
  db.prepare("INSERT INTO product_images VALUES (?,?,?,?)").run("img-1", "p-1", "/uploads/elbow.webp", 0);
  db.prepare("INSERT INTO kit_profiles VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("profile-1", "30x30 Profil", "Kare", "30x30", "Alüminyum", "2", "Metal AŞ", 80, 0.4, 6000, 1, "2026-01-01");
  db.prepare("INSERT INTO kit_profile_offers VALUES (?,?,?,?,?)").run("offer-1", "profile-1", "Teklif AŞ", 75, 1);
  db.prepare("INSERT INTO complementary_products VALUES (?,?,?,?,?,?,?,?,?,?)").run("comp-1", "Kapak", "Kapak", "Plastik kapak", "KPK-1", null, "adet", 12, 1, "2026-01-01");
  db.prepare("INSERT INTO complementary_product_images VALUES (?,?,?,?,?)").run("comp-img-1", "comp-1", "/uploads/cap.webp", 0, "2026-01-01");

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
  assert.equal(body.data[0].purchase_cost, 17.6);
  assert.equal("purchase_price_usd" in body.data[0], false);
  assert.equal(body.data[0].image, "/uploads/elbow.webp");
  assert.equal(body.data[0].form_code, "ELB");
  assert.equal(body.data[0].tube_type_code, "SQ");
  assert.equal(body.data[0].normalized_pipe_size, "20x20 mm");
  assert.equal(body.data[0].weight_grams, 325);
});

test("kit catalog connector detail returns 404 for an unknown product", async () => {
  const response = await fetch(`${baseUrl}/api/kit-catalog/connectors/missing`, { headers: { "x-api-key": apiKey } });
  assert.equal(response.status, 404);
});

test("kit catalog exposes active central profiles and complementary products", async () => {
  const headers = { "x-api-key": apiKey };
  const profiles = await (await fetch(`${baseUrl}/api/kit-catalog/profiles`, { headers })).json() as any;
  assert.equal(profiles.data[0].id, "profile-1");
  assert.equal(profiles.data[0].effective_price_per_meter, 75);
  assert.equal(profiles.data[0].effective_supplier, "Teklif AŞ");
  const complements = await (await fetch(`${baseUrl}/api/kit-catalog/complementary-products`, { headers })).json() as any;
  assert.equal(complements.data[0].id, "comp-1");
  assert.equal(complements.data[0].image, "/uploads/cap.webp");
});
