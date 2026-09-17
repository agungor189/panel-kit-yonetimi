import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { createProductStockModule, resolveCentralStock, stockQuantity } from "./stock.js";

test("product stock module preserves central and BOM-derived availability", () => {
  assert.equal(stockQuantity("5.9"), 5);
  assert.equal(resolveCentralStock({ platforms: [{ stock: 2 }, { stock: 3 }] }), 5);

  const db = new Database(":memory:");
  applySchema(db);
  db.prepare("INSERT INTO products (id, sku, title, product_type, central_stock, purchase_cost, weight_grams) VALUES ('parent', 'KIT', 'Kit', 'assembly', 0, 0, 0)").run();
  db.prepare("INSERT INTO products (id, sku, title, product_type, central_stock, purchase_cost, weight_grams) VALUES ('part', 'PART', 'Part', 'component', 9, 2, 100)").run();
  db.prepare("INSERT INTO product_bom (parent_product_id, component_product_id, quantity_per_unit, component_role) VALUES ('parent', 'part', 2, 'body')").run();

  const stock = createProductStockModule(db);
  const parent = db.prepare("SELECT * FROM products WHERE id = 'parent'").get();
  const hydrated = stock.hydrateProductStock(parent, true);
  assert.equal(hydrated.available_stock, 4);
  assert.equal(hydrated.purchase_cost, 4);
  assert.equal(hydrated.weight_grams, 200);
  assert.equal(hydrated.bom_components.length, 1);
  db.close();
});

