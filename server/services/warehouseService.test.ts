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
    warehouse_location TEXT, central_stock REAL, product_type TEXT, status TEXT,
    weight REAL DEFAULT 0, weight_grams REAL DEFAULT 0
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
  CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
  CREATE TABLE pick_sessions (
    id TEXT PRIMARY KEY, pick_number TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL UNIQUE,
    order_code_snapshot TEXT, external_order_id_snapshot TEXT, status TEXT NOT NULL,
    started_by_user_id TEXT NOT NULL, started_by_name_snapshot TEXT NOT NULL,
    completed_by_user_id TEXT NOT NULL, completed_by_name_snapshot TEXT NOT NULL,
    started_at TEXT NOT NULL, completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    total_product_types INTEGER NOT NULL DEFAULT 0, total_sale_product_quantity REAL NOT NULL DEFAULT 0,
    total_physical_item_quantity REAL NOT NULL DEFAULT 0, total_net_weight_g REAL NOT NULL DEFAULT 0,
    note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE pick_session_items (
    id TEXT PRIMARY KEY, pick_session_id TEXT NOT NULL, sale_item_id TEXT, product_id TEXT,
    sku_snapshot TEXT NOT NULL, product_name_snapshot TEXT NOT NULL, product_type_snapshot TEXT NOT NULL,
    ordered_quantity REAL NOT NULL, picked_quantity REAL NOT NULL,
    unit_weight_g_snapshot REAL NOT NULL DEFAULT 0, total_weight_g REAL NOT NULL DEFAULT 0,
    total_component_quantity REAL NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE pick_session_components (
    id TEXT PRIMARY KEY, pick_session_item_id TEXT NOT NULL, component_product_id TEXT,
    component_sku_snapshot TEXT NOT NULL, component_name_snapshot TEXT NOT NULL,
    quantity_per_product REAL NOT NULL, picked_product_quantity REAL NOT NULL,
    total_component_quantity REAL NOT NULL, unit_weight_g_snapshot REAL NOT NULL DEFAULT 0,
    total_weight_g REAL NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const seed = (stock = 20) => {
  db.prepare("INSERT OR IGNORE INTO users (id, username) VALUES (?, ?), (?, ?)")
    .run(alper.id, alper.username, ayse.id, ayse.username);
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

const completeCurrentPlan = (picker = alper) => {
  service.startPicking("order-1", picker);
  const plan = service.buildPickPlan("order-1")!;
  for (const item of plan.items) {
    service.verifyPick("order-1", item.product_id, item.sku, picker);
    service.completePickItem("order-1", item.product_id, item.required_quantity, picker);
  }
  return service.completePicking("order-1", picker);
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

  test("normal ürün toplaması kalıcı geçmiş, parça adedi ve gram ağırlığı üretir", () => {
    seed();
    db.prepare("UPDATE sale_items SET quantity = 5 WHERE id = 'item-1'").run();
    db.prepare("UPDATE products SET weight_grams = 850 WHERE id = 'product-1'").run();
    completeCurrentPlan();

    const history = service.listPickHistory({ page: 1, limit: 25 });
    assert.equal(history.sessions.length, 1);
    assert.equal(history.sessions[0].total_sale_product_quantity, 5);
    assert.equal(history.sessions[0].total_physical_item_quantity, 5);
    assert.equal(history.sessions[0].total_net_weight_g, 4250);
    const detail = service.getPickHistory(history.sessions[0].id)!;
    assert.equal(detail.items[0].picked_quantity, 5);
    assert.equal(detail.items[0].components[0].total_component_quantity, 5);
  });

  test("iki kit BOM üzerinden 18 fiziksel parça ve doğru ağırlık snapshot'ı üretir", () => {
    seed();
    db.prepare("DELETE FROM sale_items WHERE id = 'item-1'").run();
    db.prepare("INSERT INTO products (id, sku, name, title, warehouse_location, central_stock, product_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("kit-1", "KIT-001", "Kit", "Test kit", "K1", 10, "assembly", "Active");
    const insertProduct = db.prepare("INSERT INTO products (id, sku, name, title, warehouse_location, central_stock, product_type, status, weight_grams) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insertProduct.run("elb", "ELB", "Dirsek", "Dirsek", "A1", 100, "component", "Active", 320);
    insertProduct.run("tee", "TEE", "T parça", "T parça", "A2", 100, "component", "Active", 410);
    insertProduct.run("profile", "PROFILE", "Profil", "Profil", "A3", 100, "component", "Active", 900);
    db.prepare("INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, weight) VALUES (?, ?, ?, ?, ?, ?)")
      .run("kit-item", "order-1", "kit-1", "Test kit", 2, 0);
    const insertBom = db.prepare("INSERT INTO product_bom (parent_product_id, component_product_id, quantity_per_unit) VALUES (?, ?, ?)");
    insertBom.run("kit-1", "elb", 4);
    insertBom.run("kit-1", "tee", 2);
    insertBom.run("kit-1", "profile", 3);

    completeCurrentPlan();
    const session = service.listPickHistory({ page: 1, limit: 25 }).sessions[0];
    assert.equal(session.total_sale_product_quantity, 2);
    assert.equal(session.total_physical_item_quantity, 18);
    assert.equal(session.total_net_weight_g, 9600);
  });

  test("BOM değişikliği tamamlanmış toplamanın component snapshot'ını değiştirmez", () => {
    seed();
    db.prepare("UPDATE products SET product_type = 'assembly' WHERE id = 'product-1'").run();
    db.prepare("INSERT INTO products (id, sku, name, title, warehouse_location, central_stock, product_type, status, weight_grams) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("component-1", "CMP-1", "Parça", "Snapshot parçası", "B1", 100, "component", "Active", 100);
    db.prepare("INSERT INTO product_bom (parent_product_id, component_product_id, quantity_per_unit) VALUES (?, ?, ?)")
      .run("product-1", "component-1", 4);
    db.prepare("UPDATE sale_items SET quantity = 2 WHERE id = 'item-1'").run();
    completeCurrentPlan();
    const sessionId = service.listPickHistory({ page: 1, limit: 25 }).sessions[0].id;

    db.prepare("UPDATE product_bom SET quantity_per_unit = 6 WHERE parent_product_id = 'product-1'").run();
    const detail = service.getPickHistory(sessionId)!;
    assert.equal(detail.items[0].components[0].quantity_per_product, 4);
    assert.equal(detail.items[0].components[0].total_component_quantity, 8);
  });

  test("aynı siparişi ikinci kez tamamlama duplicate geçmiş üretmez", () => {
    seed();
    completeCurrentPlan();
    const duplicate = service.completePicking("order-1", alper);
    assert.equal(duplicate.idempotent, true);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM pick_sessions").get() as { count: number }).count, 1);
  });

  test("geçmiş tarih aralığı ve kullanıcı filtresini uygular", () => {
    seed();
    completeCurrentPlan();
    db.prepare("UPDATE pick_sessions SET completed_at = '2026-09-14 12:00:00'").run();
    assert.equal(service.listPickHistory({
      page: 1, limit: 25, dateFrom: "2026-09-14T00:00:00Z", dateTo: "2026-09-15T00:00:00Z", pickerUserId: alper.id,
    }).sessions.length, 1);
    assert.equal(service.listPickHistory({
      page: 1, limit: 25, dateFrom: "2026-09-15T00:00:00Z", dateTo: "2026-09-16T00:00:00Z",
    }).sessions.length, 0);
  });

  test("iki farklı kullanıcının tamamladığı toplamaları doğru kullanıcıyla gösterir", () => {
    seed();
    completeCurrentPlan(alper);
    db.prepare("INSERT INTO sales (id, order_code, status, total_quantity) VALUES (?, ?, ?, ?)")
      .run("order-2", "DS-1043", "Hazırlanıyor", 3);
    db.prepare("INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, weight) VALUES (?, ?, ?, ?, ?, ?)")
      .run("item-2", "order-2", "product-1", "Test ürünü", 3, 0);
    service.startPicking("order-2", ayse);
    service.verifyPick("order-2", "product-1", "SKU-1", ayse);
    service.completePickItem("order-2", "product-1", 3, ayse);
    service.completePicking("order-2", ayse);

    const sessions = service.listPickHistory({ page: 1, limit: 25 }).sessions;
    assert.equal(sessions.find((row) => row.order_code === "DS-1042")?.completed_by.name, "Alper");
    assert.equal(sessions.find((row) => row.order_code === "DS-1043")?.completed_by.name, "Ayşe");
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
  assert.ok((legacy.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).some(({ name }) => name === "length_mm"));
  assert.ok(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'warehouse_pick_progress'").get());
  assert.ok(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pick_sessions'").get());
  assert.ok(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'packaging_types'").get());
  assert.equal((legacy.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count, 1);
  legacy.close();
});

test("v54-v55 mevcut aktif mal kabulü snapshot, katalog ve kullanıcı işiyle kayıpsız yükseltir", () => {
  const legacy = new Database(":memory:");
  applySchema(legacy);
  runMigrations(legacy);
  legacy.prepare("INSERT INTO users (id, username, password_hash) VALUES ('legacy-user', 'Legacy', 'hash')").run();
  legacy.prepare("INSERT INTO products (id, title, sku, warehouse_location) VALUES ('legacy-product', 'Legacy ürün', 'LEG-1', 'A3-K2-P5')").run();
  legacy.prepare("INSERT INTO product_reserve_locations (id, product_id, location, sort_order) VALUES ('legacy-reserve', 'legacy-product', 'A3-K2-P6', 0)").run();
  legacy.prepare("INSERT INTO inbound_batches (id, batch_number, supplier_code, created_by) VALUES ('legacy-batch', 'LEGACY-BATCH', 'SUP-1', 'legacy-user')").run();
  legacy.prepare(`INSERT INTO inbound_batch_lines (
    id, batch_id, line_number, supplier_code, product_id, sku_snapshot, product_name_snapshot,
    expected_package_count, units_per_package, last_package_units, total_units
  ) VALUES ('legacy-line', 'legacy-batch', 1, 'SUP-1', 'legacy-product', 'LEG-1', 'Legacy ürün', 1, 5, 5, 5)`).run();
  legacy.prepare("DELETE FROM schema_migrations WHERE version = 54").run();

  runMigrations(legacy);

  const line = legacy.prepare("SELECT planned_location_snapshot, reserve_locations_snapshot FROM inbound_batch_lines WHERE id = 'legacy-line'").get() as any;
  assert.equal(line.planned_location_snapshot, "A3-K2-P5");
  assert.deepEqual(JSON.parse(line.reserve_locations_snapshot), ["A3-K2-P6"]);
  legacy.prepare(`INSERT INTO warehouse_packages (
    id, package_code, batch_id, batch_line_id, product_id, supplier_code,
    package_number, total_packages, planned_quantity, remaining_quantity, status, claimed_by
  ) VALUES ('legacy-package', 'PKG-LEGACY', 'legacy-batch', 'legacy-line', 'legacy-product', 'SUP-1', 1, 1, 5, 5, 'LABELED', 'legacy-user')`).run();
  legacy.prepare("UPDATE inbound_batch_lines SET planned_location_snapshot = ' a3 - k2 - p5 '").run();
  legacy.prepare("DELETE FROM schema_migrations WHERE version = 55").run();

  runMigrations(legacy);

  assert.ok(legacy.prepare("SELECT id FROM warehouse_locations WHERE code = 'A3-K2-P5'").get());
  const activePackage = legacy.prepare("SELECT receiving_work_started_at, receiving_last_activity_at FROM warehouse_packages WHERE id = 'legacy-package'").get() as any;
  assert.ok(activePackage.receiving_work_started_at);
  assert.ok(activePackage.receiving_last_activity_at);
  legacy.close();
});

test("v56 yalnız otomatik senkronize edilmiş kapasitesi 1 olan rafları 4'e yükseltir", () => {
  const legacy = new Database(":memory:");
  applySchema(legacy);
  runMigrations(legacy);
  legacy.prepare(`INSERT INTO warehouse_locations (id, code, package_capacity, notes)
    VALUES ('auto-location', 'A8-K1-P1', 1, 'Mal Kabul V2 master lokasyon senkronizasyonu')`).run();
  legacy.prepare(`INSERT INTO warehouse_locations (id, code, package_capacity, notes)
    VALUES ('manual-location', 'A8-K1-P2', 1, 'Kullanıcı tarafından tanımlandı')`).run();
  legacy.prepare(`INSERT INTO warehouse_locations (id, code, package_capacity, notes)
    VALUES ('customized-auto-location', 'A8-K1-P3', 2, 'Mal Kabul V2 master lokasyon senkronizasyonu')`).run();
  legacy.prepare("DELETE FROM schema_migrations WHERE version = 56").run();

  runMigrations(legacy);

  assert.equal((legacy.prepare("SELECT package_capacity FROM warehouse_locations WHERE id = 'auto-location'").get() as any).package_capacity, 4);
  assert.equal((legacy.prepare("SELECT package_capacity FROM warehouse_locations WHERE id = 'manual-location'").get() as any).package_capacity, 1);
  assert.equal((legacy.prepare("SELECT package_capacity FROM warehouse_locations WHERE id = 'customized-auto-location'").get() as any).package_capacity, 2);
  legacy.close();
});
