import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("central stock machine and legacy headers map to central_stock", () => {
  for (const header of ["central_stock", "total_stock", "Merkez Stok", "Stok sayisi"]) {
    const resolution = resolveProductCsvHeaders(["SKU", "TÜR", header]);
    assert.equal(resolution.byField.central_stock, header);
    assert.ok(!resolution.unknownColumns.includes(header));
  }
});

test("safe numeric parser accepts currency and both decimal conventions", () => {
  assert.equal(parseCsvNumber("$1,234.50"), 1234.5);
  assert.equal(parseCsvNumber("1.234,50 €"), 1234.5);
  assert.equal(parseCsvNumber("9,55"), 9.55);
  assert.equal(parseCsvNumber(""), null);
  assert.ok(Number.isNaN(parseCsvNumber("abc")));
});

test("import persists product master data but ignores warehouse placement columns", () => {
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
      "İsim - TR": "Montaj", "Isim - EN": "Assembly", "Toplam Adet": "4", "Parça Ağırlığı": "250",
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
  assert.equal(component.central_stock, 10);

  const assembly = db.prepare("SELECT central_stock FROM products WHERE sku = 'ASM-01'").get() as any;
  assert.equal(assembly.central_stock, 4);

  assert.equal(component.warehouse_location, null);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM product_reserve_locations WHERE product_id = ?").get(component.id) as any).count, 0);
  assert.ok(applied.warnings.some((warning) => warning.includes("Depo lokasyonu kolonları")));
  assert.deepEqual(
    db.prepare("SELECT box_count, units_per_box, box_weight_kg, total_weight_kg FROM product_logistics WHERE product_id = ?").get(component.id),
    { box_count: 2, units_per_box: 5, box_weight_kg: 0.75, total_weight_kg: 1.5 },
  );
  assert.equal((db.prepare("SELECT COUNT(*) count FROM product_bom").get() as any).count, 1);
  db.close();
});

test("lotlu ürün importu merkez stoğu ve yalnız gerçek fark kadar stok hareketini günceller", () => {
  const db = database();
  runMigrations(db);
  db.prepare("INSERT INTO products (id, sku, title, name, supplier_code, central_stock, product_type) VALUES ('existing', 'SKU-LOT', 'Ürün', 'Ürün', 'SUP-LOT', 0, 'simple')").run();
  const headers = ["SKU", "Tedarik NO", "İsim - TR", "TÜR", "Toplam Adet", "Kutu sayısı", "Kutu içi adet", "Kutu Ağırlığı", "Toplam Ağırlık", "Parti/Lot"];
  const row = { SKU: "SKU-LOT", "Tedarik NO": "SUP-LOT", "İsim - TR": "Ürün", "TÜR": "simple", "Toplam Adet": "300", "Kutu sayısı": "3", "Kutu içi adet": "100", "Kutu Ağırlığı": "10", "Toplam Ağırlık": "30", "Parti/Lot": "LOT-001" };

  const created = importProductsFromCsvRows(db, [row], headers, { apply: true, actorUsername: "admin" });
  assert.equal(created.applied, true);
  assert.equal(created.lot_lines_created, 1);
  assert.equal((db.prepare("SELECT central_stock FROM products WHERE id = 'existing'").get() as any).central_stock, 300);
  assert.deepEqual(
    (db.prepare("SELECT change_amount FROM stock_movements WHERE product_id = 'existing' ORDER BY created_at, rowid").all() as any[]).map((movement) => movement.change_amount),
    [300],
  );
  assert.deepEqual(db.prepare("SELECT lot_number, product_id, package_count, units_per_package, total_units FROM inbound_lot_lines").get(), {
    lot_number: "LOT-001", product_id: "existing", package_count: 3, units_per_package: 100, total_units: 300,
  });

  const unchanged = importProductsFromCsvRows(db, [row], headers, { apply: true, actorUsername: "admin" });
  assert.equal(unchanged.applied, true);
  assert.equal(unchanged.lot_lines_updated, 1);
  assert.equal((db.prepare("SELECT central_stock FROM products WHERE id = 'existing'").get() as any).central_stock, 300);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE product_id = 'existing'").get() as any).count, 1);

  const reduced = importProductsFromCsvRows(db, [{ ...row, "Toplam Adet": "280" }], headers, { apply: true, actorUsername: "admin" });
  assert.equal(reduced.applied, true);
  assert.equal((db.prepare("SELECT central_stock FROM products WHERE id = 'existing'").get() as any).central_stock, 280);
  assert.deepEqual(
    (db.prepare("SELECT change_amount FROM stock_movements WHERE product_id = 'existing' ORDER BY created_at, rowid").all() as any[]).map((movement) => movement.change_amount),
    [300, -20],
  );
  assert.equal((db.prepare("SELECT total_units FROM inbound_lot_lines WHERE lot_number = 'LOT-001' AND product_id = 'existing'").get() as any).total_units, 280);
  db.close();
});

test("yeni SKU iki farklı lotta tek ürün ve iki kabul beklentisi olarak kalır", () => {
  const db = database();
  runMigrations(db);
  const headers = ["SKU", "Tedarik NO", "İsim - TR", "TÜR", "Lot Adedi", "Kutu sayısı", "Kutu içi adet", "Parti/Lot"];
  const base = { SKU: "NEW-SKU", "Tedarik NO": "NEW-SUP", "İsim - TR": "Yeni ürün", "TÜR": "simple", "Kutu sayısı": "2", "Kutu içi adet": "10" };
  assert.equal(importProductsFromCsvRows(db, [{ ...base, "Lot Adedi": "20", "Parti/Lot": "LOT-N1" }], headers, { apply: true }).applied, true);
  assert.equal(importProductsFromCsvRows(db, [{ ...base, "Lot Adedi": "15", "Parti/Lot": "LOT-N2" }], headers, { apply: true }).applied, true);
  assert.equal((db.prepare("SELECT COUNT(*) count FROM products WHERE sku = 'NEW-SKU'").get() as any).count, 1);
  assert.deepEqual((db.prepare("SELECT lot_number, total_units FROM inbound_lot_lines ORDER BY lot_number").all() as any[]), [
    { lot_number: "LOT-N1", total_units: 20 }, { lot_number: "LOT-N2", total_units: 15 },
  ]);
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
  db.exec(fs.readFileSync(fileURLToPath(new URL("../db/fixtures/panel-v48.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO products (id, name, title, product_type, weight)
      VALUES ('simple', 'Eski Ürün', 'Eski Başlık', 'finished', 125);
    INSERT INTO products (id, name, title, product_type, weight)
      VALUES ('assembly', 'Eski Montaj', 'Montaj Başlığı', 'finished', 250);
    INSERT INTO product_bom (parent_product_id, component_product_id)
      VALUES ('assembly', 'simple');
  `);

  try { runMigrations(db); }
  catch (error) { throw new Error(`Legacy migration failed: ${error instanceof Error ? error.message : String(error)}`); }

  const simple = db.prepare("SELECT name_tr, product_type, weight, weight_grams FROM products WHERE id = 'simple'").get() as any;
  const assembly = db.prepare("SELECT name_tr, product_type, weight, weight_grams FROM products WHERE id = 'assembly'").get() as any;
  assert.deepEqual(simple, { name_tr: "Eski Ürün", product_type: "simple", weight: 125, weight_grams: 125 });
  assert.deepEqual(assembly, { name_tr: "Eski Montaj", product_type: "assembly", weight: 250, weight_grams: 250 });
  db.close();
});
