import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { runMigrations } from "../migrations/runner.js";
import { importProductsFromCsvRows, parseCsvNumber } from "./productCsvImport.js";
import { resolveProductCsvHeaders } from "../../shared/productCsvMapping.js";

function database() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

test("header aliases tolerate spaces, case, Turkish characters and Ǒlçü", () => {
  const resolution = resolveProductCsvHeaders([
    " sku ",
    "TEDARİK no",
    "Ǒlçü",
    "İSİM - TR",
    "isim - en",
    "toplama lokasyonu",
    "TÜR",
  ]);

  assert.equal(resolution.byField.sku, " sku ");
  assert.equal(resolution.byField.supplier_code, "TEDARİK no");
  assert.equal(resolution.byField.size, "Ǒlçü");
  assert.equal(resolution.byField.name_tr, "İSİM - TR");
  assert.equal(resolution.byField.name_en, "isim - en");
  assert.equal(resolution.byField.warehouse_location, "toplama lokasyonu");
  assert.deepEqual(resolution.missingRequiredFields, []);
});

test("safe numeric parser accepts currency and both decimal conventions", () => {
  assert.equal(parseCsvNumber("$1,234.50"), 1234.5);
  assert.equal(parseCsvNumber("1.234,50 €"), 1234.5);
  assert.equal(parseCsvNumber("9,55"), 9.55);
  assert.equal(parseCsvNumber(""), null);
  assert.ok(Number.isNaN(parseCsvNumber("abc")));
});

test("import persists localized names, grams, logistics, multiple reserve locations and BOM", () => {
  const db = database();
  const headers = [
    "SKU", "Tedarik NO", " Olcu ", "Malzeme", "Profil Tipi", "İsim - TR", "Isim - EN",
    "Toplam Adet", "Parça Ağırlığı", "Alış Fiyatı", "TÜR", "BOM", "Açıklama",
    "Toplama Lokasyonu", "Rezerv Lokasyon", "Kutu sayısı", "Kutu içi adet", "Kutu Ağırlığı", "Toplam Ağırlık",
  ];
  const rows = [
    {
      SKU: "CMP-01", "Tedarik NO": "SUP-01", " Olcu ": "25 mm", Malzeme: "Çelik", "Profil Tipi": "Yuvarlak",
      "İsim - TR": "Bileşen", "Isim - EN": "Component", "Toplam Adet": "10", "Parça Ağırlığı": "125",
      "Alış Fiyatı": "$1.25", "TÜR": "component", BOM: "", Açıklama: "Bileşen açıklaması",
      "Toplama Lokasyonu": "A-01", "Rezerv Lokasyon": "R-01; R-02|R-01", "Kutu sayısı": "2",
      "Kutu içi adet": "5", "Kutu Ağırlığı": "0,75", "Toplam Ağırlık": "1,5",
    },
    {
      SKU: "ASM-01", "Tedarik NO": "", " Olcu ": "25 mm", Malzeme: "Çelik", "Profil Tipi": "Yuvarlak",
      "İsim - TR": "Montaj", "Isim - EN": "Assembly", "Toplam Adet": "", "Parça Ağırlığı": "250",
      "Alış Fiyatı": "2.50", "TÜR": "assembly", BOM: '{"SUP-01":2}', Açıklama: "Montaj açıklaması",
      "Toplama Lokasyonu": "", "Rezerv Lokasyon": "", "Kutu sayısı": "", "Kutu içi adet": "",
      "Kutu Ağırlığı": "", "Toplam Ağırlık": "",
    },
  ];

  const preview = importProductsFromCsvRows(db, rows, headers);
  assert.equal(preview.validation_errors.length, 0);
  assert.equal(preview.products_created, 2);
  assert.equal(preview.bom_lines_created, 1);

  const applied = importProductsFromCsvRows(db, rows, headers, { apply: true });
  assert.equal(applied.applied, true);
  const component = db.prepare("SELECT * FROM products WHERE sku = 'CMP-01'").get() as any;
  assert.equal(component.name, "Bileşen");
  assert.equal(component.name_tr, "Bileşen");
  assert.equal(component.name_en, "Component");
  assert.equal(component.model, null);
  assert.equal(component.weight, 0);
  assert.equal(component.weight_grams, 125);
  assert.equal(component.product_type, "component");

  assert.deepEqual(
    (db.prepare("SELECT location FROM product_reserve_locations WHERE product_id = ? ORDER BY sort_order").all(component.id) as any[]).map((row) => row.location),
    ["R-01", "R-02"],
  );
  assert.deepEqual(
    db.prepare("SELECT box_count, units_per_box, box_weight_kg, total_weight_kg FROM product_logistics WHERE product_id = ?").get(component.id),
    { box_count: 2, units_per_box: 5, box_weight_kg: 0.75, total_weight_kg: 1.5 },
  );
  assert.equal((db.prepare("SELECT COUNT(*) count FROM product_bom").get() as any).count, 1);
  db.close();
});

test("duplicates, invalid types, invalid numbers and bad BOM block apply", () => {
  const db = database();
  const headers = ["SKU", "Tedarik NO", "İsim - TR", "TÜR", "Toplam Adet", "BOM"];
  const rows = [
    { SKU: "DUP", "Tedarik NO": "SUP", "İsim - TR": "Bir", "TÜR": "finished", "Toplam Adet": "x", BOM: "" },
    { SKU: "dup", "Tedarik NO": "SUP", "İsim - TR": "İki", "TÜR": "assembly", "Toplam Adet": "", BOM: "not-json" },
  ];

  const report = importProductsFromCsvRows(db, rows, headers, { apply: true });
  assert.equal(report.applied, false);
  const codes = new Set(report.validation_errors.map((error) => error.code));
  assert.ok(codes.has("DUPLICATE_SKU"));
  assert.ok(codes.has("DUPLICATE_SUPPLIER_CODE"));
  assert.ok(codes.has("INVALID_PRODUCT_TYPE"));
  assert.ok(codes.has("INVALID_NON_NEGATIVE_INTEGER"));
  assert.ok(codes.has("INVALID_BOM_JSON"));
  assert.equal((db.prepare("SELECT COUNT(*) count FROM products").get() as any).count, 0);
  db.close();
});

test("v50 preserves legacy names and weights while standardizing BOM parents", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT,
      title TEXT NOT NULL,
      product_type TEXT DEFAULT 'finished',
      weight REAL DEFAULT 0,
      weight_grams REAL DEFAULT 0
    );
    CREATE TABLE product_bom (
      parent_product_id TEXT NOT NULL,
      component_product_id TEXT NOT NULL
    );
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO products (id, name, title, product_type, weight)
      VALUES ('simple', 'Eski Ürün', 'Eski Başlık', 'finished', 125);
    INSERT INTO products (id, name, title, product_type, weight)
      VALUES ('assembly', 'Eski Montaj', 'Montaj Başlığı', 'finished', 250);
    INSERT INTO product_bom (parent_product_id, component_product_id)
      VALUES ('assembly', 'simple');
  `);
  const markApplied = db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
  for (let version = 1; version <= 49; version++) markApplied.run(version, `legacy-${version}`);

  runMigrations(db);

  const simple = db.prepare("SELECT name_tr, product_type, weight, weight_grams FROM products WHERE id = 'simple'").get() as any;
  const assembly = db.prepare("SELECT name_tr, product_type, weight, weight_grams FROM products WHERE id = 'assembly'").get() as any;
  assert.deepEqual(simple, { name_tr: "Eski Ürün", product_type: "simple", weight: 125, weight_grams: 125 });
  assert.deepEqual(assembly, { name_tr: "Eski Montaj", product_type: "assembly", weight: 250, weight_grams: 250 });
  db.close();
});
