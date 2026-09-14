import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import Database from "better-sqlite3";
import { WarehouseService, WarehouseServiceError } from "./warehouseService.js";
import { applySchema } from "../db/schema.js";
import { runMigrations } from "../migrations/runner.js";

const alper = { id: "user-1", username: "Alper" };
const ayse = { id: "user-2", username: "Ayşe" };
let db: Database.Database;
let activities: Array<{ action: string; actorId?: string; details?: unknown }>;
let service: WarehouseService;

const createSchema = () => db.exec(`
  CREATE TABLE sales (
    id TEXT PRIMARY KEY, order_code TEXT, external_order_id TEXT, platform TEXT,
    customer_name TEXT, customer_phone TEXT, customer_address TEXT,
    shipping_company TEXT, tracking_number TEXT, status TEXT,
    total_quantity REAL, total_weight REAL,
    warehouse_picker_user_id TEXT, warehouse_picker_name TEXT,
    warehouse_picking_started_at TEXT, warehouse_picking_completed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE products (
    id TEXT PRIMARY KEY, sku TEXT, barcode TEXT, name TEXT, title TEXT,
    warehouse_location TEXT, central_stock REAL, product_type TEXT, status TEXT
  );
  CREATE TABLE sale_items (
    id TEXT PRIMARY KEY, sale_id TEXT, product_id TEXT, product_name TEXT,
    quantity REAL, weight REAL
  );
  CREATE TABLE product_bom (
    parent_product_id TEXT, component_product_id TEXT, quantity_per_unit REAL
  );
  CREATE TABLE product_images (
    id TEXT PRIMARY KEY, product_id TEXT, path TEXT, sort_order INTEGER
  );
  CREATE TABLE warehouse_pick_progress (
    order_id TEXT NOT NULL, product_id TEXT NOT NULL, sku TEXT,
    required_quantity REAL NOT NULL, picked_quantity REAL NOT NULL DEFAULT 0,
    picker_user_id TEXT NOT NULL, picker_name TEXT NOT NULL, verified_by TEXT,
    verified_code_type TEXT, completed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (order_id, product_id)
  );
`);

const seed = (stock = 20) => {
  db.prepare("INSERT INTO sales (id, order_code, status, total_quantity) VALUES (?, ?, ?, ?)")
    .run("order-1", "DS-1042", "Hazırlanıyor", 12);
  db.prepare("INSERT INTO products (id, sku, barcode, name, title, warehouse_location, central_stock, product_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("product-1", "SKU-1", "8690001", "Ürün", "Test ürünü", "A1-K2-P3", stock, "simple", "Active");
  db.prepare("INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, weight) VALUES (?, ?, ?, ?, ?, ?)")
    .run("item-1", "order-1", "product-1", "Test ürünü", 12, 0);
  db.prepare("INSERT INTO product_images (id, product_id, path, sort_order) VALUES (?, ?, ?, ?)")
    .run("image-2", "product-1", "/uploads/second.jpg", 2);
  db.prepare("INSERT INTO product_images (id, product_id, path, sort_order) VALUES (?, ?, ?, ?)")
    .run("image-1", "product-1", "/uploads/first.jpg", 1);
};

const expectServiceError = (fn: () => unknown, code: string, statusCode = 409) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof WarehouseServiceError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  });
};

beforeEach(() => {
  db = new Database(":memory:");
  activities = [];
  createSchema();
  service = new WarehouseService(db, (action, _entityType, _entityId, details, actorId) => {
    activities.push({ action, details, actorId });
  });
});

describe("WarehouseService güvenli toplama akışı", () => {
  test("başlatma siparişi kullanıcıya kilitler ve başlangıç zamanını yazar", () => {
    seed();
    service.startPicking("order-1", alper);
    const row = db.prepare("SELECT * FROM sales WHERE id = ?").get("order-1") as any;
    assert.equal(row.status, "Toplanıyor");
    assert.equal(row.warehouse_picker_user_id, alper.id);
    assert.equal(row.warehouse_picker_name, alper.username);
    assert.ok(row.warehouse_picking_started_at);
  });

  test("aynı kullanıcı farklı cihazdan devam ettiğinde start idempotent olur", () => {
    seed();
    service.startPicking("order-1", alper);
    assert.equal(service.startPicking("order-1", alper).idempotent, true);
  });

  test("başka kullanıcı kilitli siparişi başlatamaz", () => {
    seed();
    service.startPicking("order-1", alper);
    expectServiceError(() => service.startPicking("order-1", ayse), "ORDER_LOCKED");
  });

  test("stok eksiği varsa start override olmadan engellenir", () => {
    seed(11);
    expectServiceError(() => service.startPicking("order-1", alper), "INSUFFICIENT_STOCK");
  });

  for (const [code, matchType] of [["SKU-1", "sku"], ["8690001", "barcode"], ["A1-K2-P3", "location"]] as const) {
    test(`${matchType} doğru kod olarak doğrulanır`, () => {
      seed();
      service.startPicking("order-1", alper);
      assert.equal(service.verifyPick("order-1", "product-1", code, alper).match_type, matchType);
    });
  }

  for (const [label, code] of [["SKU", "WRONG-SKU"], ["barcode", "1111111"], ["location", "Z9-X9"]] as const) {
    test(`yanlış ${label} tek ve net hata verir`, () => {
      seed();
      service.startPicking("order-1", alper);
      expectServiceError(() => service.verifyPick("order-1", "product-1", code, alper), "PICK_CODE_MISMATCH");
    });
  }

  test("doğrulama yapılmadan adet kaydı kabul edilmez", () => {
    seed();
    service.startPicking("order-1", alper);
    expectServiceError(() => service.completePickItem("order-1", "product-1", 12, alper), "PICK_NOT_VERIFIED");
  });

  test("11 adet eksik olarak reddedilir", () => {
    seed();
    service.startPicking("order-1", alper);
    service.verifyPick("order-1", "product-1", "SKU-1", alper);
    expectServiceError(() => service.completePickItem("order-1", "product-1", 11, alper), "PICK_QUANTITY_SHORT");
  });

  test("13 adet fazla olarak reddedilir", () => {
    seed();
    service.startPicking("order-1", alper);
    service.verifyPick("order-1", "product-1", "SKU-1", alper);
    expectServiceError(() => service.completePickItem("order-1", "product-1", 13, alper), "PICK_QUANTITY_EXCESS");
  });

  test("12 adet kabul edilir ve ilerleme yeni servis örneğinden okunur", () => {
    seed();
    service.startPicking("order-1", alper);
    service.verifyPick("order-1", "product-1", "SKU-1", alper);
    service.completePickItem("order-1", "product-1", 12, alper);
    const reloaded = new WarehouseService(db, () => {}).buildPickPlan("order-1")!;
    assert.equal(reloaded.items[0].picked_quantity, 12);
    assert.ok(reloaded.items[0].completed_at);
  });

  test("eksik fiziksel ürün varken sipariş tamamlanamaz", () => {
    seed();
    service.startPicking("order-1", alper);
    expectServiceError(() => service.completePicking("order-1", alper), "PICKING_INCOMPLETE");
  });

  test("tam akış picker ve tarihçeyi korur ve üç aktiviteyi üretir", () => {
    seed();
    service.startPicking("order-1", alper);
    service.verifyPick("order-1", "product-1", "A1-K2-P3", alper);
    service.completePickItem("order-1", "product-1", 12, alper);
    service.completePicking("order-1", alper);
    const order = service.getOrder("order-1")!;
    assert.equal(order.status, "Toplandı");
    assert.equal(order.picker?.user_id, alper.id);
    assert.ok(order.picker?.started_at);
    assert.ok(order.picker?.completed_at);
    assert.deepEqual(activities.map(({ action }) => action), [
      "WAREHOUSE_PICKING_STARTED", "WAREHOUSE_ITEM_PICKED", "WAREHOUSE_PICKING_COMPLETED",
    ]);
  });

  test("pick plan ilk sıralı ürün görselini güvenli API yolu olarak döndürür", () => {
    seed();
    const plan = service.buildPickPlan("order-1")!;
    assert.equal(plan.items[0].image_url, "/api/warehouse/v1/products/product-1/image");
    assert.equal(service.getProductImagePath("product-1"), "/uploads/first.jpg");
  });
});

test("v49 mevcut email kolonu olmayan panel veritabanını güvenle yükseltir", () => {
  const legacy = new Database(":memory:");
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
    INSERT INTO users (id, username, password_hash) VALUES ('legacy-user', 'Alper', 'hash');
  `);
  applySchema(legacy);
  const insertApplied = legacy.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
  for (let version = 1; version <= 48; version++) insertApplied.run(version, `legacy-${version}`);
  runMigrations(legacy);

  const userColumns = legacy.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const saleColumns = legacy.prepare("PRAGMA table_info(sales)").all() as Array<{ name: string }>;
  assert.ok(userColumns.some(({ name }) => name === "email"));
  assert.ok(saleColumns.some(({ name }) => name === "warehouse_picker_user_id"));
  assert.ok(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'warehouse_pick_progress'").get());
  assert.equal((legacy.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count, 1);
  legacy.close();
});
